// 仮想スイッチ（ハブ / L2 スイッチ）のコアを Node で確かめる。時計・乱数・タイマーは差し替える。
//
//   node --test toys/v86-link/test/switch.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualSwitch, formatMac } from '../switch.js';

const BCAST = 'ff:ff:ff:ff:ff:ff';
const macOf = (n) => `02:00:0a:05:00:${n.toString(16).padStart(2, '0')}`;
const bytes = (mac) => mac.split(':').map((h) => parseInt(h, 16));

/** 宛先・送り元 MAC と ethertype（IPv4）だけのフレーム */
function frame(dst, src, payload = 46) {
  return Uint8Array.from([...bytes(dst), ...bytes(src), 0x08, 0x00, ...new Array(payload).fill(0)]);
}

/** フレームを送ったり受けたりするだけの VmNode の代わり */
function fakeNode(name) {
  const node = {
    name, got: [], handlers: new Set(),
    on(type, fn) { node.handlers.add(fn); return () => node.handlers.delete(fn); },
    send(f) { for (const fn of node.handlers) fn(f); },
    injectFrame(f) { node.got.push(f); },
  };
  return node;
}

/** n ポートのスイッチ。clock は now を進めて使う */
function setup(n, options = {}) {
  const clock = { now: 1_000_000 };
  const timers = [];
  const sw = new VirtualSwitch({ clock: () => clock.now, schedule: (fn, ms) => timers.push({ fn, ms }), ...options });
  const nodes = Array.from({ length: n }, (_, i) => fakeNode('vm' + i));
  const ports = nodes.map((node) => sw.addPort(node));
  const events = [];
  sw.onFrame((e) => events.push(e));
  const last = () => events.at(-1);
  return { sw, clock, timers, nodes, ports, events, last };
}

test('ハブ: 入ってきたポート以外の全ポートへ（宛先を知っていても）', () => {
  const { sw, nodes, last } = setup(4, { mode: 'hub' });
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1, 2, 3]);
  assert.equal(last().decision, 'hub');
  nodes[1].send(frame(macOf(2), macOf(3)));
  assert.deepEqual(last().outPorts, [0, 2, 3]);
  // 何度送っても全ポート。MAC は覚えない
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1, 2, 3]);
  assert.equal(sw.macTable.size, 0);
  assert.deepEqual(nodes.map((n) => n.got.length), [1, 2, 3, 3]);
});

test('スイッチ: 送り元 MAC を学習し、知っている宛先へはそのポートだけ', () => {
  const { sw, nodes, last, clock } = setup(3);
  nodes[0].send(frame(macOf(3), macOf(2)));        // 3 はまだ知らない → フラッディング
  assert.deepEqual(last().outPorts, [1, 2]);
  assert.equal(last().decision, 'flood');
  clock.now += 500;
  nodes[1].send(frame(macOf(2), macOf(3)));        // 2 はポート0 で覚えた → ポート0 だけ
  assert.deepEqual(last().outPorts, [0]);
  assert.equal(last().decision, 'known');
  nodes[0].send(frame(macOf(3), macOf(2)));        // 3 もポート1 で覚えた
  assert.deepEqual(last().outPorts, [1]);
  // 第三者（ポート2）には、最初のフラッディングしか届いていない
  assert.equal(nodes[2].got.length, 1);
  assert.deepEqual(sw.entries().map((e) => [e.mac, e.port]), [[macOf(2), 0], [macOf(3), 1]]);
  const e2 = sw.entries()[0];
  assert.equal(e2.updatedAt, clock.now - 500 + 500);   // 最後に見た時刻で更新される
  assert.equal(e2.remainingMs, 300_000);
});

test('スイッチ: 知らない宛先・ブロードキャスト・マルチキャストはフラッディング', () => {
  const { nodes, last } = setup(4);
  nodes[1].send(frame(macOf(2), macOf(3)));        // 3 を覚える
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual(last().outPorts, [1, 2, 3]);
  assert.equal(last().decision, 'broadcast');
  nodes[0].send(frame('33:33:00:00:00:16', macOf(2)));   // IPv6 マルチキャスト
  assert.deepEqual(last().outPorts, [1, 2, 3]);
  assert.equal(last().decision, 'broadcast');
  nodes[0].send(frame('01:00:5e:00:00:01', macOf(2)));   // IPv4 マルチキャスト
  assert.deepEqual(last().outPorts, [1, 2, 3]);
  nodes[0].send(frame(macOf(99), macOf(2)));             // 知らないユニキャスト
  assert.deepEqual(last().outPorts, [1, 2, 3]);
  assert.equal(last().decision, 'flood');
});

test('スイッチ: 送り元がマルチキャスト MAC のフレームは学習しない', () => {
  const { sw, nodes } = setup(2);
  nodes[0].send(frame(BCAST, '01:00:5e:00:00:01'));
  assert.equal(sw.macTable.size, 0);
});

test('同じポートには送り返さない（宛先が入ってきたポートの先にいる）', () => {
  const { nodes, last } = setup(3);
  nodes[0].send(frame(BCAST, macOf(2)));
  nodes[0].send(frame(BCAST, macOf(7)));          // ポート0 の先に、もう1台いる（例: 下にハブがある）
  const before = nodes.map((n) => n.got.length);
  nodes[0].send(frame(macOf(7), macOf(2)));
  assert.deepEqual(last().outPorts, []);
  assert.equal(last().decision, 'filtered');
  assert.equal(last().reason, 'filtered');
  assert.deepEqual(nodes.map((n) => n.got.length), before);
  // フラッディングでも、入ってきたポートには返さない
  nodes[1].send(frame(BCAST, macOf(3)));
  assert.ok(!last().outPorts.includes(1));
});

test('MAC が別のポートへ移ったら、新しいポートで覚え直す', () => {
  const { sw, nodes, last } = setup(3);
  nodes[0].send(frame(BCAST, macOf(2)));
  nodes[2].send(frame(BCAST, macOf(2)));
  assert.equal(sw.entries()[0].port, 2);
  nodes[1].send(frame(macOf(2), macOf(3)));
  assert.deepEqual(last().outPorts, [2]);
});

test('エージング: 300 秒（既定）たつと忘れてフラッディングに戻る。時間は変えられる', () => {
  const { sw, nodes, last, clock } = setup(3);
  assert.equal(sw.agingMs, 300_000);
  nodes[1].send(frame(BCAST, macOf(3)));
  clock.now += 299_999;
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1]);
  assert.equal(sw.entries().find((e) => e.mac === macOf(3)).remainingMs, 1);
  clock.now += 1;
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1, 2]);
  assert.equal(last().decision, 'flood');
  // 送り続けていれば（更新されれば）忘れない
  nodes[1].send(frame(BCAST, macOf(3)));
  for (let i = 0; i < 5; i++) {
    clock.now += 200_000;
    nodes[1].send(frame(BCAST, macOf(3)));
  }
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1]);
  // エージングを 10 秒にすると、10 秒たったものはすぐ消える
  clock.now += 10_000;
  sw.setAging(10_000);
  assert.equal(sw.entries().some((e) => e.mac === macOf(3)), false);
  nodes[1].send(frame(BCAST, macOf(3)));
  assert.equal(sw.entries().find((e) => e.mac === macOf(3)).remainingMs, 10_000);
});

test('上限: いっぱいなら新しい MAC は覚えず（更新は続ける）、その宛先はフラッディング', () => {
  const { sw, nodes, last, clock } = setup(3, { maxEntries: 1024 });
  nodes[1].send(frame(BCAST, macOf(3)));            // 正規の B を先に覚える
  // ポート2 から、送り元 MAC を偽って大量に送る（MAC フラッディング）
  for (let i = 0; i < 5000; i++) {
    const m = `02:66:00:00:${((i >> 8) & 0xff).toString(16).padStart(2, '0')}:${(i & 0xff).toString(16).padStart(2, '0')}`;
    nodes[2].send(frame(BCAST, m));
  }
  assert.equal(sw.macTable.size, 1024);
  assert.equal(sw.tableFull, true);
  assert.equal(sw.learnRejected, 5000 - 1023);
  // 覚えていた B へはポート1 だけ（追い出されない）
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1]);
  // A（10.5.0.2）は覚えられない → A 宛ては全ポートへ（攻撃者のポート2 にも届く = 盗聴できる）
  assert.equal(sw.entries().some((e) => e.mac === macOf(2)), false);
  nodes[1].send(frame(macOf(2), macOf(3)));
  assert.deepEqual(last().outPorts, [0, 2]);
  assert.equal(last().decision, 'flood');
  // エージングで偽のエントリが消えれば、また覚えられる
  clock.now += 300_000;
  nodes[1].send(frame(BCAST, macOf(3)));
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual(sw.entries().map((e) => e.mac).sort(), [macOf(2), macOf(3)]);
  nodes[1].send(frame(macOf(2), macOf(3)));
  assert.deepEqual(last().outPorts, [0]);
});

test('上限: 大量の偽 MAC でも処理が重くならない（エージングの掃除は 1 秒に1回まで）', () => {
  const { sw, nodes } = setup(2, { maxEntries: 1024 });
  const t0 = performance.now();
  for (let i = 0; i < 100_000; i++) {
    const f = frame(BCAST, macOf(0));
    f[8] = i >> 16; f[9] = i >> 8; f[10] = i & 0xff; f[11] = 1;
    nodes[0].send(f);
  }
  assert.equal(sw.macTable.size, 1024);
  assert.ok(performance.now() - t0 < 3000, `${performance.now() - t0}ms`);
});

test('壊れたフレームでも例外を投げない（どこにも届けない）', () => {
  const { nodes, events } = setup(3);
  const bad = [new Uint8Array(0), Uint8Array.from([1, 2, 3]), new Uint8Array(13), null, undefined, 'abc', 42, {}, new ArrayBuffer(4), new Uint16Array(3)];
  for (const f of bad) assert.doesNotThrow(() => nodes[0].send(f));
  for (const mode of ['hub', 'switch']) {
    assert.equal(events.filter((e) => e.reason === 'runt').length >= bad.length, true, mode);
  }
  assert.ok(events.every((e) => e.outPorts.length === 0 && e.reason === 'runt'));
  assert.deepEqual(nodes.map((n) => n.got.length), [0, 0, 0]);
  // ちょうど 14 バイト（ヘッダだけ）は届ける。Uint16Array などのビューはバイト列として扱う
  nodes[0].send(new Uint8Array(14).fill(0xff));
  assert.deepEqual(events.at(-1).outPorts, [1, 2]);
  nodes[0].send(new Uint16Array(7).fill(0xffff));
  assert.deepEqual(events.at(-1).outPorts, [1, 2]);
});

test('ポートを外すと、番号が空き、そのポートの MAC が消え、もう届けない', () => {
  const { sw, nodes, ports, last } = setup(3);
  nodes[1].send(frame(BCAST, macOf(3)));
  nodes[2].send(frame(BCAST, macOf(4)));
  assert.equal(sw.macTable.size, 2);
  assert.equal(sw.removePort(ports[1]), true);
  assert.deepEqual(sw.entries().map((e) => [e.mac, e.port]), [[macOf(4), 2]]);
  assert.deepEqual([...sw.ports.keys()], [0, 2]);
  // 外したポートの node が送っても無視する（購読もやめている）
  assert.equal(nodes[1].handlers.size, 0);
  const n = sw.removePort(ports[1]);
  assert.equal(n, false);
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual(last().outPorts, [2]);
  assert.equal(nodes[1].got.length, 1);           // 外す前のブロードキャスト（ポート2 から）だけ
  // 新しくつなぐと、空いた番号（1）を使う
  const extra = fakeNode('new');
  assert.equal(sw.addPort(extra).id, 1);
  assert.equal(sw.addPort(fakeNode('x')).id, 3);
});

test('ポートの上限', () => {
  const sw = new VirtualSwitch({ maxPorts: 2, clock: () => 0 });
  assert.ok(sw.addPort(fakeNode('a')));
  assert.ok(sw.addPort(fakeNode('b')));
  assert.equal(sw.addPort(fakeNode('c')), null);
});

test('モード切替: テーブルを空にする。実行中に切り替えられる', () => {
  const { sw, nodes, last } = setup(3);
  nodes[1].send(frame(BCAST, macOf(3)));
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1]);
  sw.setMode('hub');
  assert.equal(sw.macTable.size, 0);
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1, 2]);
  sw.setMode('switch');
  assert.equal(sw.macTable.size, 0);
  nodes[0].send(frame(macOf(3), macOf(2)));        // 学習し直す: まずはフラッディング
  assert.deepEqual(last().outPorts, [1, 2]);
  assert.throws(() => sw.setMode('router'));
});

test('ケーブルを抜く: そのポートとの間は捨て、そのポートの MAC は忘れる', () => {
  const { sw, nodes, ports, last } = setup(3);
  nodes[1].send(frame(BCAST, macOf(3)));
  sw.setLinked(ports[1], false);
  assert.equal(sw.macTable.size, 0);
  nodes[1].send(frame(BCAST, macOf(3)));
  assert.deepEqual([last().outPorts, last().reason], [[], 'cable']);
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().outPorts, last().reason], [[2], 'cable']);   // 一部だけ捨てた
});

test('ポートごとの遅延（送り元 + 届け先）と損失', () => {
  let r = 0.5;
  const { sw, nodes, ports, timers, last } = setup(3, { random: () => r });
  sw.setPortOptions(ports[0], { delayMs: 30 });
  sw.setPortOptions(ports[2], { delayMs: 100 });
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual(timers.map((t) => t.ms), [30, 130]);
  assert.equal(nodes[1].got.length, 0);
  timers.forEach((t) => t.fn());
  assert.deepEqual(nodes.map((n) => n.got.length), [0, 1, 1]);
  // 遅延中にポートを外したら届けない
  timers.length = 0;
  nodes[0].send(frame(BCAST, macOf(2)));
  sw.removePort(ports[2]);
  timers.forEach((t) => t.fn());
  assert.equal(nodes[2].got.length, 1);
  // 損失: 送り元で捨てたらどこにも届かない。届け先ごとにも判定する
  sw.setPortOptions(ports[0], { delayMs: 0, lossRate: 0.6 });
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().outPorts, last().reason], [[], 'loss']);
  sw.setPortOptions(ports[0], { lossRate: 0 });
  sw.setPortOptions(ports[1], { lossRate: 0.6 });
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().outPorts, last().reason], [[], 'loss']);
  r = 0.9;
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().outPorts, last().reason], [[1], null]);
});

test('届けるフレームはポートごとの複製（受け取った側が書き換えても、ほかに影響しない）', () => {
  const { nodes } = setup(3, { mode: 'hub' });
  const f = frame(BCAST, macOf(2));
  nodes[0].send(f);
  nodes[1].got[0][20] = 0xaa;
  assert.equal(nodes[2].got[0][20], 0);
  assert.equal(f[20], 0);
});

test('formatMac', () => {
  assert.equal(formatMac(0x02000a050002), '02:00:0a:05:00:02');
  assert.equal(formatMac(0xffffffffffff), BCAST);
  assert.equal(formatMac(1), '00:00:00:00:00:01');
});

test('ポートの番号を指定してつなぐ（使用中・範囲外なら null）', () => {
  const sw = new VirtualSwitch({ maxPorts: 8, clock: () => 0 });
  assert.equal(sw.addPort(fakeNode('c'), { id: 2 }).id, 2);
  assert.equal(sw.addPort(fakeNode('x'), { id: 2 }), null);
  assert.equal(sw.addPort(fakeNode('x'), { id: 8 }), null);
  assert.equal(sw.addPort(fakeNode('a')).id, 0);
});

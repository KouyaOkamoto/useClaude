// 仮想スイッチ（ハブ / L2 スイッチ）のコアを Node で確かめる。時計・乱数・タイマーは差し替える。
//
//   node --test toys/v86-link/test/switch.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualSwitch, formatMac, parseVlanList, readTag, tag, untag, classify } from '../switch.js';

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
  assert.equal(sw.tableSize, 0);
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
  assert.equal(sw.tableSize, 0);
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
  assert.equal(sw.tableSize, 1024);
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
  assert.equal(sw.tableSize, 1024);
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
  assert.equal(sw.tableSize, 2);
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
  assert.equal(sw.tableSize, 0);
  nodes[0].send(frame(macOf(3), macOf(2)));
  assert.deepEqual(last().outPorts, [1, 2]);
  sw.setMode('switch');
  assert.equal(sw.tableSize, 0);
  nodes[0].send(frame(macOf(3), macOf(2)));        // 学習し直す: まずはフラッディング
  assert.deepEqual(last().outPorts, [1, 2]);
  assert.throws(() => sw.setMode('router'));
});

test('ケーブルを抜く: そのポートとの間は捨て、そのポートの MAC は忘れる', () => {
  const { sw, nodes, ports, last } = setup(3);
  nodes[1].send(frame(BCAST, macOf(3)));
  sw.setLinked(ports[1], false);
  assert.equal(sw.tableSize, 0);
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

// ------------------------------------------------------------------ VLAN（802.1Q）

/** タグ付きフレーム（tpid 既定 0x8100） */
function tagged(dst, src, vid, { pcp = 0, tpid = 0x8100, inner = [0x08, 0x00], payload = 46 } = {}) {
  return Uint8Array.from([...bytes(dst), ...bytes(src), tpid >> 8, tpid & 255, (pcp << 5) | (vid >> 8), vid & 255, ...inner, ...new Array(payload).fill(0)]);
}
const tagOf = (f) => (((f[12] << 8) | f[13]) === 0x8100 ? ((f[14] << 8) | f[15]) & 0xfff : null);

test('VLAN: 既定はすべてアクセス VLAN 1（以前と同じ。タグは付かない）', () => {
  const { nodes, last, ports } = setup(3);
  assert.deepEqual(ports.map((p) => p.vlan), ports.map(() => ({ mode: 'access', access: 1, allowed: null, native: 1 })));
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().vlan, last().inTag, last().outPorts, last().outTags], [1, null, [1, 2], [null, null]]);
  assert.equal(tagOf(nodes[1].got[0]), null);
});

test('VLAN: アクセスポートは同じ VLAN のポートにだけ届ける（VLAN をまたがない）', () => {
  const { sw, nodes, ports, last } = setup(4);
  sw.setPortVlan(ports[0], { access: 10 });
  sw.setPortVlan(ports[1], { access: 10 });
  sw.setPortVlan(ports[2], { access: 20 });
  sw.setPortVlan(ports[3], { access: 20 });
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().vlan, last().outPorts], [10, [1]]);
  nodes[2].send(frame(BCAST, macOf(4)));
  assert.deepEqual([last().vlan, last().outPorts], [20, [3]]);
  // VLAN 20 の MAC あてでも、VLAN 10 からは届かない（VLAN 10 では知らない宛先 → VLAN 10 の中だけでフラッディング）
  nodes[0].send(frame(macOf(4), macOf(2)));
  assert.deepEqual([last().decision, last().outPorts], ['flood', [1]]);
  assert.deepEqual(nodes.map((n) => n.got.length), [0, 2, 0, 1]);
});

test('VLAN: トランクへはタグを付け（ネイティブ VLAN はタグなし）、トランクから受けたタグは外してアクセスへ', () => {
  const { sw, nodes, ports, last } = setup(4);
  sw.setPortVlan(ports[0], { access: 10 });
  sw.setPortVlan(ports[1], { access: 20 });
  sw.setPortVlan(ports[2], { access: 1 });
  sw.setPortVlan(ports[3], { mode: 'trunk', allowed: [1, 10, 20], native: 1 });
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual([last().outPorts, last().outTags], [[3], [10]]);
  const out = nodes[3].got.at(-1);
  assert.equal(out.length, 64);
  assert.deepEqual([...out.subarray(12, 18)], [0x81, 0x00, 0x00, 0x0a, 0x08, 0x00]);
  nodes[2].send(frame(BCAST, macOf(4)));     // ネイティブ VLAN 1 → タグなし
  assert.deepEqual([last().outPorts, last().outTags], [[3], [null]]);
  assert.equal(tagOf(nodes[3].got.at(-1)), null);
  // トランクから VLAN 20 のタグ付きで来たら、タグを外して VLAN 20 のアクセスポートへ
  nodes[3].send(tagged(BCAST, macOf(9), 20));
  assert.deepEqual([last().vlan, last().inTag, last().outPorts, last().outTags], [20, 20, [1], [null]]);
  const got = nodes[1].got.at(-1);
  assert.equal(got.length, 60);
  assert.deepEqual([...got.subarray(12, 14)], [0x08, 0x00]);
  // トランクから タグなしで来たら、ネイティブ VLAN（1）
  nodes[3].send(frame(BCAST, macOf(9)));
  assert.deepEqual([last().vlan, last().outPorts], [1, [2]]);
  // ネイティブ VLAN のタグ付きで来ても受ける（VLAN 1 として）
  nodes[3].send(tagged(BCAST, macOf(9), 1));
  assert.deepEqual([last().vlan, last().outPorts], [1, [2]]);
});

test('VLAN: トランクは許可されていない VLAN を捨てる（入り・出）', () => {
  const { sw, nodes, ports, last } = setup(3);
  sw.setPortVlan(ports[0], { access: 30 });
  sw.setPortVlan(ports[1], { mode: 'trunk', allowed: [10, 20], native: 1 });
  sw.setPortVlan(ports[2], { access: 30 });
  nodes[1].send(tagged(BCAST, macOf(9), 30));
  assert.deepEqual([last().outPorts, last().reason], [[], 'vlan-not-allowed']);
  // ネイティブ VLAN 1 が許可に無ければ、タグなしも捨てる
  nodes[1].send(frame(BCAST, macOf(9)));
  assert.deepEqual([last().outPorts, last().reason], [[], 'vlan-not-allowed']);
  // VLAN 30 のフレームは、許可の無いトランクには出さない
  nodes[0].send(frame(BCAST, macOf(2)));
  assert.deepEqual(last().outPorts, [2]);
  assert.equal(nodes[1].got.length, 0);
});

test('VLAN: 優先度（PCP）は保つ。VLAN ID 0（優先度だけのタグ）はタグなしと同じ', () => {
  const { sw, nodes, ports, last } = setup(3);
  sw.setPortVlan(ports[0], { mode: 'trunk', allowed: [10], native: 1 });
  sw.setPortVlan(ports[1], { mode: 'trunk', allowed: [10], native: 1 });
  sw.setPortVlan(ports[2], { access: 10 });
  nodes[0].send(tagged(BCAST, macOf(2), 10, { pcp: 5 }));
  assert.equal(nodes[1].got.at(-1)[14] >> 5, 5);
  // アクセスポートに VLAN ID 0 のタグ付きで来たら、アクセス VLAN（10）として受ける
  nodes[2].send(tagged(BCAST, macOf(4), 0, { pcp: 3 }));
  assert.deepEqual([last().vlan, last().inTag, last().outPorts, last().outTags], [10, 0, [0, 1], [10, 10]]);
  assert.equal(nodes[0].got.at(-1)[14] >> 5, 3);
});

test('VLAN: アクセスポートにタグ付き（VLAN ID が 0 以外）で来たら捨てる', () => {
  const { nodes, last } = setup(2);
  nodes[0].send(tagged(BCAST, macOf(2), 1));
  assert.deepEqual([last().outPorts, last().reason], [[], 'vlan-tagged-access']);
  nodes[0].send(tagged(BCAST, macOf(2), 20));
  assert.deepEqual([last().outPorts, last().reason], [[], 'vlan-tagged-access']);
});

test('VLAN: 二重タグ・802.1Q 以外のタグ・壊れたタグ・VLAN ID 4095 は捨てる（例外を投げない）', () => {
  const { sw, nodes, ports, events } = setup(3);
  sw.setPortVlan(ports[0], { mode: 'trunk' });
  const cases = [
    [tagged(BCAST, macOf(2), 10, { inner: [0x81, 0x00, 0x00, 0x14, 0x08, 0x00] }), 'double-tag'],
    [tagged(BCAST, macOf(2), 10, { inner: [0x88, 0xa8, 0x00, 0x14, 0x08, 0x00] }), 'double-tag'],
    [tagged(BCAST, macOf(2), 10, { tpid: 0x88a8 }), 'vlan-unsupported'],
    [tagged(BCAST, macOf(2), 10, { tpid: 0x9100 }), 'vlan-unsupported'],
    [tagged(BCAST, macOf(2), 4095), 'vlan-invalid'],
    [tagged(BCAST, macOf(2), 10, { inner: [], payload: 0 }).subarray(0, 15), 'vlan-malformed'],
    [tagged(BCAST, macOf(2), 10, { inner: [], payload: 0 }).subarray(0, 16), 'vlan-malformed'],
    [tagged(BCAST, macOf(2), 10, { inner: [0x08], payload: 0 }), 'vlan-malformed'],
  ];
  for (const [f, why] of cases) {
    assert.doesNotThrow(() => nodes[0].send(f));
    assert.deepEqual([events.at(-1).outPorts, events.at(-1).reason], [[], why], why);
  }
  // ちょうど 18 バイト（タグ + タイプだけ）は受ける
  nodes[0].send(tagged(BCAST, macOf(2), 1, { payload: 0 }));
  assert.deepEqual(events.at(-1).outPorts, [1, 2]);
  assert.deepEqual(nodes.map((n) => n.got.length), [0, 1, 1]);
  assert.equal(sw.tableSize, 1);
});

test('VLAN: MAC アドレステーブルは VLAN ごと（同じ MAC が別の VLAN にあっても混ざらない）', () => {
  const { sw, nodes, ports, last } = setup(4);
  sw.setPortVlan(ports[0], { mode: 'trunk' });
  sw.setPortVlan(ports[1], { access: 10 });
  sw.setPortVlan(ports[2], { access: 20 });
  sw.setPortVlan(ports[3], { access: 20 });
  // 同じ MAC（ルーターの MAC のつもり）が、VLAN 10 ではポート1、VLAN 20 ではポート0（トランク）
  nodes[1].send(frame(BCAST, macOf(1)));
  nodes[0].send(tagged(BCAST, macOf(1), 20));
  assert.deepEqual(sw.entries().map((e) => [e.vlan, e.mac, e.port]).sort(), [[10, macOf(1), 1], [20, macOf(1), 0]]);
  nodes[2].send(frame(macOf(1), macOf(4)));
  assert.deepEqual([last().decision, last().outPorts, last().outTags], ['known', [0], [20]]);
  nodes[0].send(tagged(macOf(1), macOf(5), 10));
  assert.deepEqual([last().decision, last().outPorts], ['known', [1]]);
  // ポートの VLAN を変えたら、そのポートで覚えた MAC は消す
  sw.setPortVlan(ports[1], { access: 20 });
  assert.equal(sw.entries().some((e) => e.port === 1), false);
});

test('VLAN: テーブルの上限は VLAN ごと + 全体（ある VLAN があふれても、ほかの VLAN は覚えられる）', () => {
  const { sw, nodes, ports, last } = setup(4, { maxEntries: 300, maxEntriesPerVlan: 100 });
  sw.setPortVlan(ports[0], { mode: 'trunk' });
  sw.setPortVlan(ports[1], { access: 10 });
  sw.setPortVlan(ports[2], { access: 20 });
  sw.setPortVlan(ports[3], { access: 20 });
  const fake = (i) => `02:66:00:00:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`;
  for (let i = 0; i < 500; i++) nodes[0].send(tagged(BCAST, fake(i), 10));
  assert.equal(sw.table(10).size, 100);
  assert.deepEqual(sw.fullVlans(), [10]);
  assert.equal(sw.isFull(10), true);
  assert.equal(sw.isFull(20), false);
  // VLAN 20 はふつうに学習する
  nodes[3].send(frame(BCAST, macOf(4)));
  nodes[2].send(frame(macOf(4), macOf(3)));
  assert.deepEqual([last().decision, last().outPorts], ['known', [3]]);
  // 全体の上限: VLAN 30〜 に入れていっても、全体で 300 を超えない
  for (let v = 30; v < 40; v++) for (let i = 0; i < 100; i++) nodes[0].send(tagged(BCAST, fake(i), v));
  assert.equal(sw.tableSize, 300);
  assert.equal(sw.tableFull, true);
  assert.equal(sw.entries().length, 300);
});

test('VLAN: ハブは VLAN を見ない（タグもそのまま全ポートへ）', () => {
  const { sw, nodes, ports, last } = setup(3, { mode: 'hub' });
  sw.setPortVlan(ports[1], { access: 20 });
  const f = tagged(BCAST, macOf(2), 10);
  nodes[0].send(f);
  assert.deepEqual([last().vlan, last().outPorts, last().outTags], [null, [1, 2], [null, null]]);
  assert.deepEqual([...nodes[1].got[0]], [...f]);
});

test('VLAN: 設定の確かめ（不正なら例外で、何も変えない）・VLAN の並びの読み取り', () => {
  const { sw, ports } = setup(1);
  for (const bad of [{ mode: 'hybrid' }, { access: 0 }, { access: 4095 }, { native: 5000 }, { allowed: [1, 4095] }, { access: 'x' }]) {
    assert.throws(() => sw.setPortVlan(ports[0], bad));
  }
  assert.deepEqual(ports[0].vlan, { mode: 'access', access: 1, allowed: null, native: 1 });
  sw.setPortVlan(ports[0], { mode: 'trunk', allowed: [20, 10, 10] });
  assert.deepEqual(ports[0].vlan, { mode: 'trunk', access: 1, allowed: [10, 20], native: 1 });
  assert.deepEqual(parseVlanList('10, 20 30-32'), [10, 20, 30, 31, 32]);
  assert.equal(parseVlanList(''), null);
  assert.equal(parseVlanList('all'), null);
  for (const bad of ['0', '4095', 'a', '10-5', '1-9999', '<img>']) assert.throws(() => parseVlanList(bad), bad);
});

test('VLAN: タグの読み書き', () => {
  const f = frame(BCAST, macOf(2));
  const t = tag(f, 300, 6);
  assert.deepEqual(readTag(t), { vid: 300, pcp: 6, dei: 0, innerType: 0x0800 });
  assert.deepEqual([...untag(t)], [...f]);
  assert.equal(readTag(f), null);
  assert.deepEqual(readTag(new Uint8Array(3)), { error: 'runt' });
  // モニタの種類分けは、タグを読み飛ばして中を見る
  assert.equal(classify(f), 'IPv4');
  assert.equal(classify(t), 'IPv4');
});

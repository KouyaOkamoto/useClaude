// スナップショット起動のテンプレートの管理（snapshot.js）と、スイッチの「NET-OK まで捨てる」（switch.js の setHold）を Node で確かめる。
//
//   node --test toys/v86-link/test/snapshot.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateStore, templateKey, entropyCommand, clockCommand, restorePrelude } from '../snapshot.js';
import { VirtualSwitch } from '../switch.js';

const KEY = templateKey({ image: 'v86net', memoryMB: 64, uart1: true, kind: 'free' });
const state = (n = 16) => new Uint8Array(n).fill(7).buffer;
/** Promise が、いま（マイクロタスクを回したあと）決まっているか */
async function settled(p) {
  let done = false;
  let value;
  p.then((v) => { done = true; value = v; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done ? { done, value } : { done };
}

test('templateKey: 種類・uart1 で別のキーになる。不正な値は例外', () => {
  const k = (o) => templateKey({ image: 'v86net', memoryMB: 64, uart1: true, kind: 'free', ...o });
  assert.notEqual(k({}), k({ kind: 'scenario' }));
  assert.notEqual(k({}), k({ uart1: false }));
  assert.notEqual(k({}), k({ memoryMB: 128 }));
  assert.notEqual(k({}), k({ image: 'buildroot68' }));
  assert.throws(() => k({ kind: 'other' }));
  assert.throws(() => k({ image: '../x y' }));
  assert.throws(() => k({ memoryMB: 0 }));
});

test('最初の 1 台が作る役。2 台目以降は待ち、provide で全台が復元に進む', async () => {
  const s = new TemplateStore();
  assert.deepEqual(await s.acquire(KEY, 'A'), { role: 'maker' });
  const b = s.acquire(KEY, 'B');
  const c = s.acquire(KEY, 'C');
  assert.equal((await settled(b)).done, false, 'テンプレートができるまで待つ');
  assert.deepEqual(s.status(KEY).waiting, ['B', 'C']);
  assert.equal(s.isMaker(KEY, 'A'), true);
  const data = state();
  assert.equal(s.provide(KEY, 'A', data), true);
  assert.deepEqual(await b, { role: 'restore', state: data });
  assert.deepEqual(await c, { role: 'restore', state: data });
  // あとから来た VM はすぐ復元
  assert.deepEqual(await s.acquire(KEY, 'D'), { role: 'restore', state: data });
  assert.equal(s.has(KEY), true);
  assert.equal(s.status(KEY).bytes, 16);
});

test('作る役でない VM の provide は無視する（復元した VM がまた保存しない）', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  const b = s.acquire(KEY, 'B');
  assert.equal(s.provide(KEY, 'B', state()), false);
  assert.equal(s.status(KEY).state, 'making');
  s.provide(KEY, 'A', state());
  await b;
  assert.equal(s.provide(KEY, 'A', state(32)), false, 'できたあとは上書きしない');
  assert.equal(s.status(KEY).bytes, 16);
});

test('作る役が保存の前にいなくなったら、待っている先頭の VM が代わりに作る役になる', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  const b = s.acquire(KEY, 'B');
  const c = s.acquire(KEY, 'C');
  assert.equal(s.abandon(KEY, 'A'), true);
  assert.deepEqual(await b, { role: 'maker' });
  assert.equal((await settled(c)).done, false, 'C は待ったまま');
  assert.equal(s.isMaker(KEY, 'B'), true);
  s.provide(KEY, 'B', state());
  assert.equal((await c).role, 'restore');
});

test('作る役がいなくなり、待っている VM も無ければ、次に来た VM が作る役', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  s.abandon(KEY, 'A');
  assert.equal(s.status(KEY).state, 'none');
  assert.deepEqual(await s.acquire(KEY, 'B'), { role: 'maker' });
  assert.equal(s.abandon(KEY, 'A'), false, '作る役でない VM の abandon は無視');
});

test('待っている VM が削除されたら cancelled で待ちをやめる。作る役の cancel は abandon と同じ', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  const b = s.acquire(KEY, 'B');
  const c = s.acquire(KEY, 'C');
  assert.equal(s.cancel(KEY, 'B'), true);
  assert.deepEqual(await b, { role: 'cancelled' });
  assert.equal(s.cancel(KEY, 'A'), true);
  assert.deepEqual(await c, { role: 'maker' });
  assert.equal(s.cancel(KEY, 'X'), false);
});

test('復元に失敗したら discard: テンプレートを捨て、待っている VM も以降の VM も通常の起動', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  s.provide(KEY, 'A', state());
  // B は復元に失敗した。そのとき C は待っていない（ready なので）。新しく作り直しの途中の待ちも、boot になる
  s.discard(KEY, 'Invalid header');
  assert.equal(s.has(KEY), false);
  assert.equal(s.status(KEY).state, 'failed');
  assert.equal(s.status(KEY).reason, 'Invalid header');
  assert.deepEqual(await s.acquire(KEY, 'C'), { role: 'boot' });
  // 待っている途中で捨てられた場合
  const s2 = new TemplateStore();
  await s2.acquire(KEY, 'A');
  const b = s2.acquire(KEY, 'B');
  s2.discard(KEY);
  assert.deepEqual(await b, { role: 'boot' });
  assert.equal(s2.provide(KEY, 'A', state()), false, '捨てたあとは受け取らない');
});

test('空の状態を provide したら捨てる', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  const b = s.acquire(KEY, 'B');
  assert.equal(s.provide(KEY, 'A', new ArrayBuffer(0)), false);
  assert.deepEqual(await b, { role: 'boot' });
});

test('キーごとに別々（自由構成とシナリオ）', async () => {
  const s = new TemplateStore();
  const K2 = templateKey({ image: 'v86net', memoryMB: 64, uart1: true, kind: 'scenario' });
  assert.equal((await s.acquire(KEY, 'A')).role, 'maker');
  assert.equal((await s.acquire(K2, 'B')).role, 'maker');
  s.provide(K2, 'B', state());
  assert.equal(s.has(K2), true);
  assert.equal(s.has(KEY), false);
});

test('?snapshot=off（enabled: false）なら、いつも通常の起動', async () => {
  const s = new TemplateStore({ enabled: false });
  assert.deepEqual(await s.acquire(KEY, 'A'), { role: 'boot' });
  assert.deepEqual(await s.acquire(KEY, 'B'), { role: 'boot' });
});

test('replace: テスト用に壊れたテンプレートを差し込める（待っている VM にも届く）', async () => {
  const s = new TemplateStore();
  await s.acquire(KEY, 'A');
  const b = s.acquire(KEY, 'B');
  const bad = new Uint8Array([1, 2, 3]).buffer;
  s.replace(KEY, bad);
  assert.deepEqual(await b, { role: 'restore', state: bad });
  assert.equal(s.has(KEY), true);
});

test('乱数と時計のコマンド', () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i * 4);
  const e = entropyCommand(bytes);
  assert.match(e, /^printf '(\\x[0-9a-f]{2}){64}' > \/dev\/urandom$/);
  assert.ok(e.includes('\\x00\\x04\\x08'));
  assert.throws(() => entropyCommand(new Uint8Array(4)));
  assert.throws(() => entropyCommand('abc'));
  assert.equal(clockCommand(1_700_000_000_499), 'date -s @1700000000 >/dev/null');
  assert.equal(clockCommand(1_700_000_000_500), 'date -s @1700000001 >/dev/null');
  assert.throws(() => clockCommand(NaN));
  const p = restorePrelude(bytes, 1_700_000_000_000);
  assert.ok(p.startsWith('printf '));
  assert.ok(p.endsWith('date -s @1700000000 >/dev/null; '));
});

// ---------------------------------------------------------------- switch.js: NET-OK まで捨てる

const macOf = (n) => `00:22:15:00:00:${n.toString(16).padStart(2, '0')}`;
const bytesOf = (mac) => mac.split(':').map((h) => parseInt(h, 16));
const frame = (dst, src) => Uint8Array.from([...bytesOf(dst), ...bytesOf(src), 0x08, 0x00, ...new Array(46).fill(0)]);
function fakeNode() {
  const node = { got: [], handlers: new Set(),
    on(type, fn) { node.handlers.add(fn); return () => node.handlers.delete(fn); },
    send(f) { for (const fn of node.handlers) fn(f); },
    injectFrame(f) { node.got.push(f); } };
  return node;
}

test('setHold: 止めたポートから入ったフレームは not-ready で捨て、MAC を覚えない。出ていく方は止めない', () => {
  let now = 1000;
  const sw = new VirtualSwitch({ clock: () => now, schedule: (fn) => fn() });
  const a = fakeNode(), b = fakeNode();
  const pa = sw.addPort(a, { hold: true });
  sw.addPort(b);
  const events = [];
  sw.onFrame((ev) => events.push(ev));
  a.send(frame('ff:ff:ff:ff:ff:ff', macOf(1)));
  assert.equal(events.at(-1).reason, 'not-ready');
  assert.deepEqual(events.at(-1).outPorts, []);
  assert.equal(b.got.length, 0);
  assert.equal(sw.entries().length, 0, '同じ MAC を覚えない');
  // 止めているポートへは届く（B から A へのブロードキャスト）
  b.send(frame('ff:ff:ff:ff:ff:ff', macOf(2)));
  assert.equal(a.got.length, 1);
  // 戻すと、ふつうに転送して覚える
  sw.setHold(pa, false);
  now += 10;
  a.send(frame(macOf(2), macOf(1)));
  assert.equal(events.at(-1).reason, null);
  assert.equal(events.at(-1).decision, 'known');
  assert.equal(b.got.length, 1);
  assert.deepEqual(sw.entries().map((e) => e.mac).sort(), [macOf(1), macOf(2)]);
});

test('setHold: ケーブルが抜けているときは、理由は cable のまま', () => {
  const sw = new VirtualSwitch({ clock: () => 0, schedule: (fn) => fn() });
  const a = fakeNode();
  const pa = sw.addPort(a, { hold: true, linked: false });
  sw.addPort(fakeNode());
  const events = [];
  sw.onFrame((ev) => events.push(ev));
  a.send(frame('ff:ff:ff:ff:ff:ff', macOf(1)));
  assert.equal(events.at(-1).reason, 'cable');
  sw.setLinked(pa, true);
  a.send(frame('ff:ff:ff:ff:ff:ff', macOf(1)));
  assert.equal(events.at(-1).reason, 'not-ready');
});

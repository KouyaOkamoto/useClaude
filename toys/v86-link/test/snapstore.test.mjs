// スナップショット起動 段2: 保存した起動イメージ（snapstore.js）を Node で確かめる。保存先はメモリの偽物。
// 圧縮とハッシュは本物（Node の CompressionStream・crypto.subtle）。
//
//   node --test toys/v86-link/test/snapstore.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapStore, memoryBackend, persistKey, parsePersistKey, sha256Hex, V86_VERSION, STATE_VERSION } from '../snapstore.js';
import { templateKey } from '../snapshot.js';

const IMG = 'a'.repeat(64);
const BASE = templateKey({ image: 'v86net', memoryMB: 64, uart1: true, kind: 'free' });
const KEY = persistKey(BASE, { imageSha256: IMG });
/** 状態の代わり（それらしく、0 が多く圧縮が効く） */
function fakeState(n = 200_000, seed = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 97) b[i] = (i * seed) & 0xff;
  return b.buffer;
}
const quiet = () => { const logs = []; return { logs, log: (...a) => logs.push(a.join(' ')) }; };

test('persistKey: イメージの SHA-256・v86 の版・状態の版を足す。分解できる', () => {
  assert.equal(KEY, `${BASE}|img=${IMG}|v86=${V86_VERSION}|state=${STATE_VERSION}`);
  assert.deepEqual(parsePersistKey(KEY), { base: BASE, image: 'v86net', imageSha256: IMG, v86Version: V86_VERSION, stateVersion: STATE_VERSION });
  assert.notEqual(persistKey(BASE, { imageSha256: 'b'.repeat(64) }), KEY);
  assert.notEqual(persistKey(BASE, { imageSha256: IMG, v86Version: '0.5.999' }), KEY);
  assert.throws(() => persistKey(BASE, { imageSha256: 'xyz' }));
  assert.equal(parsePersistKey('nonsense'), null);
});

test('保存して読み出す: 圧縮して書き、展開して SHA-256 を確かめる', async () => {
  const backend = memoryBackend();
  const s = new SnapStore({ backend, now: () => 1234 });
  const st = fakeState();
  const meta = await s.save(KEY, st, { kind: 'free', image: 'v86net' });
  assert.deepEqual({ ...meta, gzBytes: meta.gzBytes > 0 && meta.gzBytes < st.byteLength }, { key: KEY, kind: 'free', image: 'v86net', bytes: st.byteLength, gzBytes: true, savedAt: 1234 });
  const rec = backend.map.get(KEY);
  assert.equal(rec.sha256, await sha256Hex(st));
  const got = await s.load(KEY);
  assert.equal(got.state.byteLength, st.byteLength);
  assert.equal(await sha256Hex(got.state), rec.sha256);
  assert.deepEqual((await s.list()).map((r) => [r.key, r.kind, r.bytes, r.savedAt]), [[KEY, 'free', st.byteLength, 1234]]);
  assert.equal('gz' in (await s.list())[0], false, '一覧に状態の本体は入れない');
  assert.equal(await s.load(persistKey(BASE, { imageSha256: 'c'.repeat(64) })), null, '無いキーは null');
});

test('ハッシュが合わない（本文を書き換えた）・展開に失敗・形が違う → そのエントリを消して state: null', async () => {
  for (const corrupt of [
    async (rec) => { const d = new Uint8Array(await new Response(new Blob([rec.gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); d[5000] ^= 0xff;
      rec.gz = await new Response(new Blob([d]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); },
    async (rec) => { rec.gz = new Uint8Array([1, 2, 3, 4]).buffer; },
    async (rec) => { rec.bytes += 1; },
    async (rec) => { rec.sha256 = '0'.repeat(64); },
    async (rec) => { rec.gz = 'not a buffer'; },
  ]) {
    const backend = memoryBackend();
    const q = quiet();
    const s = new SnapStore({ backend, log: q.log });
    await s.save(KEY, fakeState());
    await corrupt(backend.map.get(KEY));
    const r = await s.load(KEY);
    assert.equal(r.state, null);
    assert.ok(r.error);
    assert.equal(backend.map.has(KEY), false, '壊れたエントリは消す');
    assert.equal(s.disabled, false, '壊れていただけなら、保存先は使い続ける');
    assert.ok(q.logs.some((l) => /壊れている/.test(l)));
  }
});

test('保存先の例外 → disabled にして、以後はメモリだけ（何もしない）。理由を出す', async () => {
  for (const which of ['get', 'put', 'list', 'delete']) {
    const backend = memoryBackend();
    const q = quiet();
    const s = new SnapStore({ backend, log: q.log });
    if (which !== 'put') await s.save(KEY, fakeState());
    backend.fail.add(which);
    if (which === 'get') assert.equal(await s.load(KEY), null);
    if (which === 'put') assert.equal(await s.save(KEY, fakeState()), null);
    if (which === 'list') assert.deepEqual(await s.list(), []);
    if (which === 'delete') assert.equal(await s.remove(KEY), false);
    assert.equal(s.disabled, true, which);
    assert.ok(q.logs.some((l) => /メモリだけ/.test(l)), which);
    backend.fail.clear();
    assert.equal(await s.load(KEY), null, '以後は使わない');
    assert.equal(await s.save(KEY, fakeState()), null);
  }
  // 保存先が無い（IndexedDB が使えない）
  const none = new SnapStore({ backend: null });
  assert.equal(none.disabled, true);
  assert.equal(await none.load(KEY), null);
  assert.equal(await none.save(KEY, fakeState()), null);
  assert.deepEqual(await none.list(), []);
});

test('prune: 同じイメージ名で版が違うもの（イメージの SHA-256・v86 の版・状態の版）だけを消す', async () => {
  const backend = memoryBackend();
  const s = new SnapStore({ backend });
  const scen = templateKey({ image: 'v86net', memoryMB: 64, uart1: true, kind: 'scenario' });
  const old68 = templateKey({ image: 'buildroot68', memoryMB: 64, uart1: false, kind: 'free' });
  const keep = [KEY, persistKey(scen, { imageSha256: IMG }), persistKey(old68, { imageSha256: 'd'.repeat(64) })];
  const stale = [persistKey(BASE, { imageSha256: 'e'.repeat(64) }), persistKey(BASE, { imageSha256: IMG, v86Version: '0.5.100' }), persistKey(scen, { imageSha256: IMG, stateVersion: 5 }), 'garbage-key'];
  for (const k of [...keep, ...stale]) backend.map.set(k, { key: k, kind: 'x', image: 'v86net', bytes: 1, gzBytes: 1, savedAt: 0, gz: new ArrayBuffer(1) });
  assert.equal(await s.prune({ image: 'v86net', imageSha256: IMG }), stale.length);
  assert.deepEqual([...backend.map.keys()].sort(), [...keep].sort());
  assert.equal(await s.clear(), keep.length);
  assert.equal(backend.map.size, 0);
});

test('同じキーへの保存が重なっても、どちらかが残り、読める', async () => {
  const backend = memoryBackend();
  const a = new SnapStore({ backend }), b = new SnapStore({ backend });
  await Promise.all([a.save(KEY, fakeState(150_000, 3)), b.save(KEY, fakeState(150_000, 5))]);
  const r = await a.load(KEY);
  assert.equal(r.state.byteLength, 150_000);
  assert.equal(await sha256Hex(r.state), backend.map.get(KEY).sha256);
});

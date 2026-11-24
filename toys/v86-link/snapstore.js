// スナップショット起動 段2: テンプレート（save_state の状態）を、ページの外（IndexedDB）に保存する層。
// テンプレートの役（作る役・待ち・復元）は snapshot.js の TemplateStore。ここは「保存と読み出し」だけ。
// DOM にも v86 にも依存しない（保存先・圧縮・ハッシュは差し替えられる。Node でテストできる）。
//
//   保存先（backend）は { get(key), put(record), delete(key), list() } を持つもの（どれも Promise）。
//   既定は IndexedDB（idbBackend()）。単体テストではメモリの偽物（memoryBackend()）を使う。
//
//   保存するもの（record）:
//     { key, kind, image, gz（gzip した状態の ArrayBuffer）, sha256（圧縮前の SHA-256。16 進）, bytes（圧縮前）, gzBytes, savedAt（UNIX ミリ秒） }
//   キー（persistKey）は、メモリのキー（イメージ名・memory_size・uart1・種類）に、次を足したもの:
//     イメージの中身の SHA-256（同じ名前でもファイルが変われば別物）・v86 の版（V86_VERSION）・状態のヘッダの版（STATE_VERSION）
//
//   load(key)  → { state, record } / null。展開して SHA-256 を確かめる（v86 は状態のメモリ部分の壊れを検出しないため）。
//                合わない・展開に失敗 → そのエントリを消して null（呼んだ側は通常の起動に戻る）
//   save(key, state, meta) → 圧縮して書く（呼んだ側は待たない。裏で動かす）
//   remove(key) / clear() / list()
//   prune(current)  → 同じイメージ名で、版（イメージの SHA-256・v86 の版・状態の版・テンプレートの中身の版）が今と違うエントリを消す
//
//   保存先が使えない（IndexedDB が無い・プライベートモード・容量不足・例外）ときは、disabled にして以後は何もしない
//   （呼んだ側はメモリだけ = 段1 と同じ動きになる）。理由は console に出す。

// lib/v86/libv86.js の版（lib/README.md と合わせる）と、その v86 の状態の版（restore_state のヘッダ。合わないと Version mismatch）
export const V86_VERSION = '0.5.472';
export const STATE_VERSION = 6;
// テンプレートの中身の版。2: 自由構成のテンプレートに、ネットワーク設定の関数 v86net が定義されている（依頼6。netcmd.js）。
// 1（段2）のテンプレートには関数が無く、復元した VM の短い呼び出しが通らないので使わない（消す）
export const TEMPLATE_FORMAT = 2;

/** 保存のキー。base は snapshot.js の templateKey() */
export function persistKey(base, { imageSha256, v86Version = V86_VERSION, stateVersion = STATE_VERSION, format = TEMPLATE_FORMAT }) {
  if (typeof base !== 'string' || !base) throw new Error('キーが無い');
  if (!/^[0-9a-f]{64}$/.test(imageSha256 ?? '')) throw new Error(`イメージの SHA-256 が不正: ${imageSha256}`);
  return `${base}|img=${imageSha256}|v86=${v86Version}|state=${stateVersion}|tpl=${format}`;
}

/** persistKey を分解する（prune のため）。読めなければ null */
export function parsePersistKey(key) {
  const m = /^(.*)\|img=([0-9a-f]{64})\|v86=([^|]+)\|state=(\d+)(?:\|tpl=(\d+))?$/.exec(String(key ?? ''));
  if (!m) return null;
  // tpl が無いキーは段2（版 1）のもの
  return { base: m[1], image: m[1].split('|')[0], imageSha256: m[2], v86Version: m[3], stateVersion: Number(m[4]), format: Number(m[5] ?? 1) };
}

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf instanceof ArrayBuffer ? buf : new Uint8Array(buf));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const pipe = (buf, stream) => new Response(new Blob([buf]).stream().pipeThrough(stream)).arrayBuffer();
export const gzip = (buf) => pipe(buf, new CompressionStream('gzip'));
export const gunzip = (buf) => pipe(buf, new DecompressionStream('gzip'));

export class SnapStore {
  /**
   * @param {{ backend: object|null, compress?: Function, decompress?: Function, sha256?: Function, now?: Function, log?: Function }} o
   */
  constructor({ backend, reason = null, compress = gzip, decompress = gunzip, sha256 = sha256Hex, now = () => Date.now(), log = (...a) => console.warn(...a) }) {
    this.backend = backend;
    this.compress = compress;
    this.decompress = decompress;
    this.sha256 = sha256;
    this.now = now;
    this.log = log;
    this.disabled = !backend;
    this.reason = backend ? null : reason ?? 'no-backend';
  }

  /** 保存先の例外: 以後は使わない（メモリだけにする） */
  fail(where, e) {
    if (!this.disabled) this.log(`保存した起動イメージ: ${where}に失敗したので、以後はメモリだけで動く:`, e?.message ?? e);
    this.disabled = true;
    this.reason = `${where}: ${e?.message ?? e}`;
    return null;
  }

  /** 読み出す。無い・使えない → null。壊れている → 消して null（reason を返す） */
  async load(key) {
    if (this.disabled) return null;
    let rec;
    try {
      rec = await this.backend.get(key);
    } catch (e) {
      return this.fail('読み出し', e);
    }
    if (!rec) return null;
    let state;
    try {
      if (rec.key !== key || !(rec.gz instanceof ArrayBuffer)) throw new Error('記録の形が違う');
      state = await this.decompress(rec.gz);
      if (state.byteLength !== rec.bytes) throw new Error(`大きさが違う（${state.byteLength} / ${rec.bytes}）`);
      const h = await this.sha256(state);
      if (h !== rec.sha256) throw new Error('SHA-256 が合わない');
    } catch (e) {
      const why = e?.message || e?.name || String(e) || '読めない';
      this.log('保存した起動イメージが壊れているので消す:', why);
      await this.remove(key);
      return { state: null, record: rec, error: why };
    }
    return { state, record: rec };
  }

  /** 保存する（圧縮して書く）。書けたら記録の要約、書けなければ null */
  async save(key, state, { kind = '', image = '' } = {}) {
    if (this.disabled) return null;
    try {
      const [sha, gz] = await Promise.all([this.sha256(state), this.compress(state)]);
      const rec = { key, kind, image, gz, sha256: sha, bytes: state.byteLength, gzBytes: gz.byteLength, savedAt: this.now() };
      await this.backend.put(rec);
      return { key, kind, image, bytes: rec.bytes, gzBytes: rec.gzBytes, savedAt: rec.savedAt };
    } catch (e) {
      return this.fail('保存', e);
    }
  }

  async remove(key) {
    if (this.disabled) return false;
    try {
      await this.backend.delete(key);
      return true;
    } catch (e) {
      this.fail('削除', e);
      return false;
    }
  }

  /** 保存してあるものの要約（状態の本体は含めない） */
  async list() {
    if (this.disabled) return [];
    try {
      return (await this.backend.list()).map((r) => ({ key: r.key, kind: r.kind, image: r.image, bytes: r.bytes, gzBytes: r.gzBytes, savedAt: r.savedAt }));
    } catch (e) {
      return this.fail('一覧', e) ?? [];
    }
  }

  async clear() {
    const all = await this.list();
    for (const r of all) await this.remove(r.key);
    return all.length;
  }

  /** 同じイメージ名で、版が今と違うエントリを消す。消した数 */
  async prune({ image, imageSha256, v86Version = V86_VERSION, stateVersion = STATE_VERSION, format = TEMPLATE_FORMAT }) {
    let n = 0;
    for (const r of await this.list()) {
      const k = parsePersistKey(r.key);
      const stale = !k || (k.image === image && (k.imageSha256 !== imageSha256 || k.v86Version !== v86Version || k.stateVersion !== stateVersion || k.format !== format));
      if (stale && (await this.remove(r.key))) n++;
    }
    return n;
  }
}

// ---------------------------------------------------------------- 保存先

/** メモリの保存先（単体テスト用）。fail にメソッド名を入れると、そのメソッドが例外を投げる */
export function memoryBackend() {
  const m = new Map();
  const fail = new Set();
  const check = (name) => { if (fail.has(name)) throw new Error(`${name} failed (test)`); };
  return {
    map: m, fail,
    async get(key) { check('get'); return m.get(key); },
    async put(rec) { check('put'); m.set(rec.key, rec); },
    async delete(key) { check('delete'); m.delete(key); },
    async list() { check('list'); return [...m.values()]; },
  };
}

/**
 * IndexedDB の保存先。使えなければ null（呼んだ側はメモリだけにする）。
 * 1 つのストア（キー = record.key）。同じキーへの書き込みが複数のタブで重なっても、どれか 1 つが残る（put は上書き）
 */
export async function idbBackend({ name = 'v86-link-snapshots', store = 'templates', idb = globalThis.indexedDB } = {}) {
  if (!idb) return null;
  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const open = idb.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(store, { keyPath: 'key' });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('blocked'));
    });
  } catch (e) {
    console.warn('保存した起動イメージ: IndexedDB を開けないので、メモリだけで動く:', e?.message ?? e);
    return null;
  }
  // 別のタブが版を上げようとしたら閉じる（このページはメモリだけで続ける）
  db.onversionchange = () => db.close();
  const tx = (mode) => db.transaction(store, mode).objectStore(store);
  return {
    get: (key) => req(tx('readonly').get(key)),
    put: (rec) => req(tx('readwrite').put(rec)).then(() => undefined),
    delete: (key) => req(tx('readwrite').delete(key)).then(() => undefined),
    // 一覧は要約だけ欲しいが、IndexedDB では値ごと読むしかない（数件・各 10MB 弱なので許容）
    list: () => req(tx('readonly').getAll()),
  };
}

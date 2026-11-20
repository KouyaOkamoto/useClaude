// スナップショットによる高速起動: テンプレート（v86 の save_state の状態）の管理。DOM にも v86 にも依存しない。
// 調査は docs/snapshot-step0.md。
//
//   最初に起動する 1 台（作る役）は通常の起動をして、決まった時点で save_state し、provide() で渡す。
//   2 台目以降は acquire() でテンプレートを待ち、届いたらそこから復元する（restore_state。main.js・vm.js）。
//
//   テンプレートは「種類」ごとに 1 つずつ、ページの中（メモリ）だけに持つ（各 約 34MB。圧縮しない）:
//     free     … 自由構成。プロンプトが出た時点（configureNet の前。eth0 は DOWN）
//     scenario … シナリオ。setupVm で ttyS1 のシェルを起動し、VmShell.alive() が通った時点
//   キーは「イメージ名・memory_size・uart1・種類」。uart1 の有無が違う状態は復元できない（調査の項目 4）。
//   v86 の版が変わると、状態の版（v86 0.5.472 では 6）が合わず Version mismatch になる。
//   テンプレートはページの中だけに持つので、ページを読み直せば作り直される（版が混ざることはない）。
//
//   acquire(key, id) → Promise<{ role }>
//     'maker'     … この VM が作る役。通常の起動をして、決まった時点で provide(key, id, state) する
//     'restore'   … テンプレートがある。{ role, state }（state は呼ぶ側で slice(0) して渡す）
//     'boot'      … 通常の起動（スナップショットが無効・テンプレートが失敗した）
//     'cancelled' … 待っている間に cancel() された（VM が削除された）
//   作る役が保存の前に削除・起動失敗したら abandon(key, id): 待っている VM の 1 台が、代わりに作る役になる。
//   テンプレートからの復元に失敗したら discard(key): テンプレートを捨て、以降はずっと通常の起動にする。

export const KINDS = ['free', 'scenario'];

/** テンプレートのキー */
export function templateKey({ image, memoryMB, uart1, kind }) {
  if (typeof image !== 'string' || !/^[\w.-]{1,64}$/.test(image)) throw new Error(`テンプレートのキーに使えないイメージ名: ${image}`);
  if (!Number.isInteger(memoryMB) || memoryMB <= 0) throw new Error(`テンプレートのキーに使えない memoryMB: ${memoryMB}`);
  if (!KINDS.includes(kind)) throw new Error(`知らないテンプレートの種類: ${kind}`);
  return `${image}|${memoryMB}MB|uart1=${uart1 ? 1 : 0}|${kind}`;
}

export class TemplateStore {
  /** @param {{ enabled?: boolean }} o  enabled: false なら、いつも 'boot'（?snapshot=off） */
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.entries = new Map();   // キー → { state: 'none'|'making'|'ready'|'failed', maker, data, waiters: [{ id, resolve }], reason }
  }

  entry(key) {
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { state: 'none', maker: null, data: null, waiters: [], reason: null }));
    return e;
  }

  /** いまの状態（画面・テスト用） */
  status(key) {
    const e = this.entries.get(key);
    return e ? { state: e.state, maker: e.maker, waiting: e.waiters.map((w) => w.id), reason: e.reason, bytes: e.data?.byteLength ?? 0 } : { state: 'none', maker: null, waiting: [], reason: null, bytes: 0 };
  }

  /** 起動する VM の役を決める。テンプレートを作っている途中なら、できるまで（か、役が回ってくるまで）待つ */
  acquire(key, id) {
    if (!this.enabled) return Promise.resolve({ role: 'boot' });
    const e = this.entry(key);
    if (e.state === 'ready') return Promise.resolve({ role: 'restore', state: e.data });
    if (e.state === 'failed') return Promise.resolve({ role: 'boot' });
    if (e.state === 'none') {
      e.state = 'making';
      e.maker = id;
      return Promise.resolve({ role: 'maker' });
    }
    if (e.maker === id) return Promise.resolve({ role: 'maker' });
    return new Promise((resolve) => e.waiters.push({ id, resolve }));
  }

  isMaker(key, id) {
    const e = this.entries.get(key);
    return !!e && e.state === 'making' && e.maker === id;
  }

  /** 作る役が、保存した状態を渡す。待っている VM はみな復元に進む。作る役でなければ何もしない（false） */
  provide(key, id, data) {
    const e = this.entries.get(key);
    if (!e || e.state !== 'making' || e.maker !== id) return false;
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
      this.discard(key, 'empty-state');
      return false;
    }
    e.state = 'ready';
    e.maker = null;
    e.data = data;
    for (const w of e.waiters.splice(0)) w.resolve({ role: 'restore', state: data });
    return true;
  }

  /** 作る役が、保存の前にいなくなった（削除・起動失敗）。待っている VM の先頭が、代わりに作る役になる */
  abandon(key, id) {
    const e = this.entries.get(key);
    if (!e || e.state !== 'making' || e.maker !== id) return false;
    const next = e.waiters.shift();
    if (next) {
      e.maker = next.id;
      next.resolve({ role: 'maker' });
    } else {
      e.state = 'none';
      e.maker = null;
    }
    return true;
  }

  /** 待っている VM が削除された（待ちをやめる）。作る役なら abandon と同じ */
  cancel(key, id) {
    const e = this.entries.get(key);
    if (!e) return false;
    if (e.state === 'making' && e.maker === id) return this.abandon(key, id);
    const i = e.waiters.findIndex((w) => w.id === id);
    if (i < 0) return false;
    e.waiters.splice(i, 1)[0].resolve({ role: 'cancelled' });
    return true;
  }

  /** テンプレートからの復元に失敗した。テンプレートを捨て、待っている VM も以降の VM も通常の起動にする */
  discard(key, reason = 'restore-failed') {
    const e = this.entry(key);
    e.state = 'failed';
    e.maker = null;
    e.data = null;
    e.reason = reason;
    for (const w of e.waiters.splice(0)) w.resolve({ role: 'boot' });
  }

  /** テンプレートを持っているか */
  has(key) {
    return this.entries.get(key)?.state === 'ready';
  }

  /** テストで、壊れたテンプレートを差し込むため */
  replace(key, data) {
    const e = this.entry(key);
    for (const w of e.waiters.splice(0)) w.resolve({ role: 'restore', state: data });
    Object.assign(e, { state: 'ready', maker: null, data, reason: null });
  }
}

// ---------------------------------------------------------------- 復元した VM に入れるコマンド

/**
 * ゲストの乱数を混ぜる: ホストの乱数（crypto.getRandomValues）を printf で /dev/urandom に書く。
 * 書いた値は、次の crng の再シード（復元から約 1 秒）で効く（すぐには分かれない。調査の項目 5）
 */
export function entropyCommand(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > 256) throw new Error('乱数は 16〜256 バイトの Uint8Array');
  const esc = [...bytes].map((b) => '\\x' + b.toString(16).padStart(2, '0')).join('');
  return `printf '${esc}' > /dev/urandom`;
}

/** ゲストの時計を合わせる（テンプレートを保存してからの時間だけ遅れているため） */
export function clockCommand(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error(`時刻が不正: ${nowMs}`);
  return `date -s @${Math.round(nowMs / 1000)} >/dev/null`;
}

/** 復元した VM の netCommand（シナリオでは MAC の設定）の先頭に付けるもの */
export function restorePrelude(bytes, nowMs) {
  return `${entropyCommand(bytes)}; ${clockCommand(nowMs)}; `;
}

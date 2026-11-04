// AI が書いた JavaScript を、隔離した iframe（サンドボックス）の中で実行する。
//
// 隔離のしかた:
//   - iframe は sandbox="allow-scripts" だけ（allow-same-origin を付けない）。中のページは「どこでもない origin」になり、
//     このページ（親）の DOM・localStorage・Cookie には触れない。親へのナビゲーション・ポップアップ・フォーム送信・alert もできない
//   - 中のページに CSP（default-src 'none'）を付け、ネットワーク（fetch・外部の画像やスクリプト）を使えなくする
//   - 親とのやりとりは postMessage だけ。親は、送り主がこの iframe であることと、メッセージの形を確かめ、文字として表示する
//
// 実行のしかた:
//   - コードは iframe の中で間接 eval（グローバルで実行）。const/let は次の実行に残らないので、残したい値は window に入れる
//   - for・while・do のループには見張り（__lp）を差し込み、2 秒以上、イベントループに戻らずに回り続けたらエラーにする（無限ループ対策）
//   - 実行のあと 0.6 秒待って、あとから起きたエラー（タイマー・Promise）も集める
//   - 結果: 成功か・エラー・console の出力・ページの要約（HTML の頭・要素の数など）
//   - 決まった時間（既定 8 秒）結果が返らなければ（止まった・実行の仕組みが消えた）、iframe を作り直す

const BOOT = String.raw`
(() => {
  const logs = [];
  const asyncErrors = [];
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  for (const k of ['log', 'info', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...args) => {
      logs.push('[' + k + '] ' + args.map(fmt).join(' ').slice(0, 300));
      if (logs.length > 40) logs.shift();
      orig(...args);
    };
  }
  addEventListener('error', (e) => { asyncErrors.push(String(e.error?.name ? e.error.name + ': ' + e.error.message : e.message)); });
  addEventListener('unhandledrejection', (e) => { asyncErrors.push('Promise: ' + String(e.reason?.message ?? e.reason)); });
  // ループの見張り: イベントループが回っている間は __lpTick が更新される。更新されずに 2 秒たったら、ループを止める
  let tick = performance.now();
  const beat = () => { tick = performance.now(); setTimeout(beat, 50); };
  beat();
  Object.defineProperty(window, '__lp', { value: () => {
    if (performance.now() - tick > 2000) { tick = performance.now(); throw new Error('ループが 2 秒以上終わりませんでした（無限ループの可能性があるので止めました）'); }
  } });
  const snapshot = () => {
    const b = document.body;
    const all = b ? b.querySelectorAll('*') : [];
    const tags = {};
    for (const el of all) tags[el.tagName.toLowerCase()] = (tags[el.tagName.toLowerCase()] || 0) + 1;
    const html = b ? b.innerHTML.replace(/\s+/g, ' ') : '';
    return {
      title: document.title,
      elements: all.length,
      tags,
      text: (b ? b.innerText : '').replace(/\s+/g, ' ').slice(0, 300),
      html: html.length > 1500 ? html.slice(0, 1500) + '…（' + html.length + ' 文字のうち 1500 文字）' : html,
    };
  };
  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.type !== 'run') return;
    const { id, code } = e.data;
    logs.length = 0;
    asyncErrors.length = 0;
    tick = performance.now();
    let error = null;
    try {
      const r = (0, eval)(code);
      if (r && typeof r.then === 'function') await Promise.race([r, new Promise((res) => setTimeout(res, 3000))]);
    } catch (err) {
      error = err && err.name ? err.name + ': ' + err.message : String(err);
    }
    await new Promise((res) => setTimeout(res, 600));
    let snap = null;
    try { snap = snapshot(); } catch (err) { snap = { error: String(err) }; }
    parent.postMessage({ type: 'result', id, error, asyncErrors: asyncErrors.slice(0, 5), logs: logs.slice(-20), snapshot: snap }, '*');
  });
  parent.postMessage({ type: 'ready' }, '*');
})();
`;

// 中のページ。CSP でネットワークを止める（スクリプトは、このページの中に書いたものと eval だけ）
const SRCDOC = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;}</style>
<script>${BOOT}<\/script></head><body></body></html>`;

/**
 * ループに見張りを差し込む（for (...) { / while (...) { / do { の直後に __lp(); を入れる）。
 * 文字列やコメントの中の「for (」にも入ることがあるが、その場合も __lp(); が文字として増えるだけで、動作は壊れにくい。
 * 本体が空のループ（while (x);）と、波かっこの無い1文のループ（while (x) y++;。文が1行に収まるもの）にも入れる。
 * それ以外の形（複数行にまたがる1文など）や、ループの無い重い処理は見張れない。そのときは実行の時間切れで iframe を作り直すが、
 * iframe がこのページと同じスレッドで動くブラウザ（ヘッドレス Chromium で確認）では、ページ全体が止まる（README の既知の制約）
 */
export function instrument(code) {
  const head = /\b(for|while)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/;
  return String(code)
    // 波かっこのループ: for (…) { / while (…) {
    .replace(new RegExp(head.source + '\\s*\\{', 'g'), (m) => m + '__lp();')
    // 本体が空のループ: while (…); / for (…); → while (…) { __lp(); }
    .replace(new RegExp(head.source + '\\s*;', 'g'), (m) => m.replace(/;\s*$/, '{__lp();}'))
    // 波かっこの無い1文のループ（1行の文）: while (…) x++; → while (…) { __lp(); x++; }
    .replace(new RegExp(head.source + '(\\s*)(?![{;\\s]|(?:for|while|do|if|else|switch|try)\\b)([^;{}\\n]+;)', 'g'), (m, kw, cond, sp, body) => m.slice(0, m.length - body.length - sp.length) + ' {__lp();' + body + '}')
    .replace(/\bdo\s*\{/g, (m) => m + '__lp();');
}

export class Sandbox {
  /**
   * @param {HTMLElement} host  iframe を入れる要素
   * @param {{ timeoutMs?: number }} o
   */
  constructor(host, { timeoutMs = 8000 } = {}) {
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.frame = null;
    this.ready = null;
    this.pending = new Map(); // id → resolve
    this.seq = 0;
    this.loads = 0;
    this.onNavigate = null; // 中のページが別のページへ移動しようとしたとき
    addEventListener('message', (e) => this.onMessage(e));
    this.reset();
  }

  /** 中のページを空に戻す（iframe を作り直す） */
  reset() {
    for (const [, r] of this.pending) r({ error: '実行中にページを初期化しました', reset: true, asyncErrors: [], logs: [], snapshot: null });
    this.pending.clear();
    this.frame?.remove();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('title', 'AI が操作するページ（サンドボックス）');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.className = 'sandbox-frame';
    this.loads = 0;
    this.ready = new Promise((res) => { this.readyResolve = res; });
    f.addEventListener('load', () => {
      // 最初の読み込みのあとにまた load が来たら、中のページが別のページへ移動した（location の書き換えなど）
      if (++this.loads > 1) this.onNavigate?.();
    });
    f.srcdoc = SRCDOC;
    this.host.replaceChildren(f);
    this.frame = f;
    return this.ready;
  }

  onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'ready') { this.readyResolve?.(); return; }
    if (d.type === 'result' && this.pending.has(d.id)) {
      const resolve = this.pending.get(d.id);
      this.pending.delete(d.id);
      resolve(sanitizeResult(d));
    }
  }

  /** コードを実行して、結果を返す（時間切れなら iframe を作り直して timedOut） */
  async run(code) {
    await this.ready;
    const id = ++this.seq;
    const frame = this.frame;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.reset();
        resolve({ error: null, timedOut: true, asyncErrors: [], logs: [], snapshot: null });
      }, this.timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      frame.contentWindow.postMessage({ type: 'run', id, code: instrument(code) }, '*');
    });
  }
}

/** iframe から来た結果を、決まった形・長さにする（中身は信用しない） */
function sanitizeResult(d) {
  const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : x == null ? null : String(x).slice(0, n));
  const arr = (x, n, m) => (Array.isArray(x) ? x.slice(0, n).map((y) => str(y, m)) : []);
  const s = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : null;
  return {
    error: str(d.error, 500),
    asyncErrors: arr(d.asyncErrors, 5, 300),
    logs: arr(d.logs, 20, 300),
    snapshot: s ? {
      title: str(s.title, 100) ?? '',
      elements: Number(s.elements) || 0,
      tags: s.tags && typeof s.tags === 'object' ? Object.fromEntries(Object.entries(s.tags).slice(0, 30).map(([k, v]) => [str(k, 20), Number(v) || 0])) : {},
      text: str(s.text, 300) ?? '',
      html: str(s.html, 1600) ?? '',
      error: str(s.error, 200),
    } : null,
  };
}

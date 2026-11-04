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
//   - 実行のあと 0.8 秒待って、あとから起きたエラー（タイマー・Promise）も集め、そのあいだのページの重さを測る
//   - 結果: 成功か・エラー・console の出力・ページの要約（HTML の頭・要素の数・canvas）・重さ・こちらで止めたもの
//
// ページを重くし続けないための仕組み（AI が毎回 canvas やアニメーションを足していくと、観察できないほど重くなるため）:
//   - requestAnimationFrame・setInterval・setTimeout を包み、どのステップで始めたものかを数える。同時に動かせる数
//     （アニメーション 6・setInterval 6）を超えたら、いちばん古いステップのものから止めて、次の結果で伝える
//   - canvas は 8 個まで（それ以上作ろうとするとエラー。使い回してもらう）
//   - resetPage(): AI が自分で呼べる片付けの関数（ページを空にして、アニメーションとタイマーをすべて止める）
//   - 1 秒ごとに重さ（処理で埋まっている時間の割合・フレーム数・動いているもの）を親に知らせる（onHealth）
//   - 決まった時間（既定 8 秒）結果が返らなければ（止まった・実行の仕組みが消えた）、iframe を作り直す

const BOOT = String.raw`
(() => {
  // 元の関数（見張り・計測は、AI のコードから数えられない元の関数を使う）
  const _raf = requestAnimationFrame.bind(window), _caf = cancelAnimationFrame.bind(window);
  const _st = setTimeout.bind(window), _ct = clearTimeout.bind(window);
  const _si = setInterval.bind(window), _ci = clearInterval.bind(window);
  const MAX_LOOPS = 6, MAX_INTERVALS = 6, MAX_TIMEOUTS = 300, MAX_CANVAS = 8;
  const logs = [];
  const asyncErrors = [];
  const notices = []; // こちらで止めたもの・片付けたもの（次の結果で AI に伝える）
  const notice = (t) => { if (!notices.includes(t)) notices.push(t); if (notices.length > 6) notices.shift(); };
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

  // ---- 動き続けるもの（アニメーション・タイマー）を、どのステップで始めたか付きで数える
  // ステップ n のコードの中や、そこから続くコールバックの中で頼んだものは「ステップ n のもの」。
  // 同時に動かせる数を超えたら、いちばん古いステップのものから止める（ページが重くなり続けないように）
  let origin = null, lastStep = 0;
  const frames = new Map(), intervals = new Map(), timeouts = new Map(); // id → ステップ
  const wrap = (cb, o, done) => function (...a) {
    done?.();
    const prev = origin;
    origin = o;
    try { return typeof cb === 'function' ? cb.apply(this, a) : (0, eval)(String(cb)); } finally { origin = prev; }
  };
  const trim = (map, max, cancel, what) => {
    if (map.size <= max) return;
    let newest = 0;
    for (const o of map.values()) if (o > newest) newest = o;
    const old = [...new Set(map.values())].filter((o) => o < newest).sort((a, b) => a - b);
    for (const o of old) {
      if (map.size <= max) break;
      for (const [id, x] of map) if (x === o) { cancel(id); map.delete(id); }
      notice('同時に動かせる' + what + 'は ' + max + ' 個までなので、ステップ ' + o + ' で始めた' + what + 'を止めました');
    }
  };
  window.requestAnimationFrame = (cb) => {
    const o = origin ?? lastStep;
    const id = _raf(wrap(cb, o, () => frames.delete(id)));
    frames.set(id, o);
    trim(frames, MAX_LOOPS, _caf, 'アニメーション（requestAnimationFrame）');
    return id;
  };
  window.cancelAnimationFrame = (id) => { frames.delete(id); _caf(id); };
  window.setTimeout = (cb, ms, ...a) => {
    const o = origin ?? lastStep;
    const id = _st(wrap(cb, o, () => timeouts.delete(id)), ms, ...a);
    timeouts.set(id, o);
    trim(timeouts, MAX_TIMEOUTS, _ct, 'タイマー（setTimeout）');
    return id;
  };
  window.setInterval = (cb, ms, ...a) => {
    const o = origin ?? lastStep;
    const id = _si(wrap(cb, o), ms, ...a);
    intervals.set(id, o);
    trim(intervals, MAX_INTERVALS, _ci, '繰り返しタイマー（setInterval）');
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => { timeouts.delete(id); intervals.delete(id); _ct(id); _ci(id); };
  // canvas は MAX_CANVAS 個まで（毎回新しく作って増え続けるのを止める）
  const _ce = Document.prototype.createElement;
  Document.prototype.createElement = function (tag, ...rest) {
    const n = document.getElementsByTagName('canvas').length;
    if (String(tag).toLowerCase() === 'canvas' && n >= MAX_CANVAS) {
      throw new Error('canvas は ' + MAX_CANVAS + ' 個までです（今 ' + n + ' 個）。新しく作らずに、今ある canvas を使い回すか、要らないものを消してください');
    }
    return _ce.call(this, tag, ...rest);
  };
  // AI が使える片付けの関数: ページを空にして、アニメーションとタイマーをすべて止める
  Object.defineProperty(window, 'resetPage', { value: () => {
    for (const id of frames.keys()) _caf(id);
    for (const id of intervals.keys()) _ci(id);
    for (const id of timeouts.keys()) _ct(id);
    frames.clear(); intervals.clear(); timeouts.clear();
    document.body.replaceChildren();
    for (const a of [...document.body.attributes]) document.body.removeAttribute(a.name);
    document.documentElement.removeAttribute('style');
    for (const n of [...document.head.children]) if (!n.hasAttribute('data-boot')) n.remove();
    document.title = '';
    notice('resetPage() で、ページを空にして、アニメーションとタイマーをすべて止めました');
  } });

  // ---- 重さの計測: 20ms ごとのタイマーの遅れ（ページの処理で埋まっている割合）と、1 秒あたりのフレーム数
  // ループの見張り（__lp）も同じタイマーを使う。イベントループが回っている間は tick が更新される。更新されずに 2 秒たったら、ループを止める
  let tick = performance.now(), last = tick;
  const meters = new Set();
  const beat = () => {
    const now = performance.now();
    const late = Math.max(0, now - last - 20);
    for (const m of meters) m.lag += late;
    tick = last = now;
    _st(beat, 20);
  };
  beat();
  const frame = () => { for (const m of meters) m.frames++; _raf(frame); };
  _raf(frame);
  const meter = () => {
    const m = { t0: performance.now(), lag: 0, frames: 0 };
    meters.add(m);
    return () => {
      meters.delete(m);
      const dt = Math.max(1, performance.now() - m.t0);
      return { fps: Math.round((m.frames * 1000) / dt), busy: Math.min(1, m.lag / dt), visible: document.visibilityState === 'visible' };
    };
  };
  const count = (map) => { const c = {}; for (const o of map.values()) c[o] = (c[o] || 0) + 1; return c; };
  const load = (m) => ({ ...m, loops: count(frames), intervals: count(intervals), timeouts: timeouts.size });
  // 1 秒ごとに、重さを親に知らせる（親は、重すぎる状態が続いたらページを初期化する）
  let health = meter();
  _si(() => { const m = health(); health = meter(); parent.postMessage({ type: 'health', load: load(m) }, '*'); }, 1000);

  Object.defineProperty(window, '__lp', { value: () => {
    if (performance.now() - tick > 2000) { tick = performance.now(); throw new Error('ループが 2 秒以上終わりませんでした（無限ループの可能性があるので止めました）'); }
  } });
  const snapshot = () => {
    const b = document.body;
    const all = b ? b.querySelectorAll('*') : [];
    const tags = {};
    for (const el of all) tags[el.tagName.toLowerCase()] = (tags[el.tagName.toLowerCase()] || 0) + 1;
    const html = b ? b.innerHTML.replace(/\s+/g, ' ') : '';
    const canvases = [...document.getElementsByTagName('canvas')];
    return {
      title: document.title,
      elements: all.length,
      tags,
      canvases: canvases.slice(0, 10).map((c) => ({ id: c.id, w: c.width, h: c.height })),
      canvasCount: canvases.length,
      text: (b ? b.innerText : '').replace(/\s+/g, ' ').slice(0, 300),
      html: html.length > 1500 ? html.slice(0, 1500) + '…（' + html.length + ' 文字のうち 1500 文字）' : html,
    };
  };
  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.type !== 'run') return;
    const { id, code, step } = e.data;
    logs.length = 0;
    asyncErrors.length = 0;
    tick = performance.now();
    lastStep = Number(step) || lastStep + 1;
    let error = null;
    origin = lastStep;
    try {
      const r = (0, eval)(code);
      origin = null;
      if (r && typeof r.then === 'function') await Promise.race([r, new Promise((res) => _st(res, 3000))]);
    } catch (err) {
      error = err && err.name ? err.name + ': ' + err.message : String(err);
    } finally {
      origin = null;
    }
    // 実行のあと少し待って、あとから起きたエラーを集め、そのあいだの重さを測る
    const m = meter();
    await new Promise((res) => _st(res, 800));
    let snap = null;
    try { snap = snapshot(); } catch (err) { snap = { error: String(err) }; }
    parent.postMessage({ type: 'result', id, error, asyncErrors: asyncErrors.slice(0, 5), logs: logs.slice(-20), snapshot: snap, load: load(m()), notices: notices.splice(0) }, '*');
  });
  parent.postMessage({ type: 'ready' }, '*');
})();
`;

// 中のページ。CSP でネットワークを止める（スクリプトは、このページの中に書いたものと eval だけ）
const SRCDOC = `<!doctype html><html lang="ja"><head><meta charset="utf-8" data-boot>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:" data-boot>
<meta name="viewport" content="width=device-width, initial-scale=1" data-boot>
<style data-boot>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;}</style>
<script data-boot>${BOOT}<\/script></head><body></body></html>`;

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
    this.onHealth = null; // 1 秒ごとの重さ（load）
    addEventListener('message', (e) => this.onMessage(e));
    this.reset();
  }

  /** 中のページを空に戻す（iframe を作り直す） */
  reset() {
    for (const [, r] of this.pending) r({ error: '実行中にページを初期化しました', reset: true, asyncErrors: [], logs: [], snapshot: null, load: null, notices: [] });
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
    if (d.type === 'health') { this.onHealth?.(sanitizeLoad(d.load)); return; }
    if (d.type === 'result' && this.pending.has(d.id)) {
      const resolve = this.pending.get(d.id);
      this.pending.delete(d.id);
      resolve(sanitizeResult(d));
    }
  }

  /** コードを実行して、結果を返す（時間切れなら iframe を作り直して timedOut）。step: 何ステップ目のコードか（動き続けるものの持ち主） */
  async run(code, { step } = {}) {
    await this.ready;
    const id = ++this.seq;
    const frame = this.frame;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.reset();
        resolve({ error: null, timedOut: true, asyncErrors: [], logs: [], snapshot: null, load: null, notices: [] });
      }, this.timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      frame.contentWindow.postMessage({ type: 'run', id, step, code: instrument(code) }, '*');
    });
  }
}

const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : x == null ? null : String(x).slice(0, n));
const arr = (x, n, m) => (Array.isArray(x) ? x.slice(0, n).map((y) => str(y, m)) : []);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
/** { ステップ: 数 } の形にする */
const counts = (x) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).slice(0, 50).map(([k, v]) => [String(num(k)), num(v)])) : {});

/** 重さ（iframe から来たもの。中身は信用しない） */
export function sanitizeLoad(l) {
  if (!l || typeof l !== 'object') return null;
  return {
    fps: num(l.fps),
    busy: Math.min(1, Math.max(0, num(l.busy))),
    visible: l.visible === true,
    loops: counts(l.loops),
    intervals: counts(l.intervals),
    timeouts: num(l.timeouts),
  };
}

/** iframe から来た結果を、決まった形・長さにする（中身は信用しない） */
function sanitizeResult(d) {
  const s = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : null;
  return {
    error: str(d.error, 500),
    asyncErrors: arr(d.asyncErrors, 5, 300),
    logs: arr(d.logs, 20, 300),
    load: sanitizeLoad(d.load),
    notices: arr(d.notices, 6, 200),
    snapshot: s ? {
      title: str(s.title, 100) ?? '',
      elements: num(s.elements),
      canvases: Array.isArray(s.canvases) ? s.canvases.slice(0, 10).map((c) => ({ id: str(c?.id, 40) ?? '', w: num(c?.w), h: num(c?.h) })) : [],
      canvasCount: num(s.canvasCount),
      tags: s.tags && typeof s.tags === 'object' ? Object.fromEntries(Object.entries(s.tags).slice(0, 30).map(([k, v]) => [str(k, 20), Number(v) || 0])) : {},
      text: str(s.text, 300) ?? '',
      html: str(s.html, 1600) ?? '',
      error: str(s.error, 200),
    } : null,
  };
}

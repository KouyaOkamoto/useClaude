// AI が書いた JavaScript を、隔離した iframe（サンドボックス）の中の「キャンバス 1 枚」で動かす。
//
// 隔離のしかた:
//   - iframe は sandbox="allow-scripts" だけ（allow-same-origin を付けない）。中のページは「どこでもない origin」になり、
//     このページ（親）の DOM・localStorage・Cookie には触れない。親へのナビゲーション・ポップアップ・フォーム送信・alert もできない
//   - 中のページに CSP（default-src 'none'）を付け、ネットワーク（fetch・外部の画像やスクリプト）を使えなくする
//   - 親とのやりとりは postMessage だけ。親は、送り主がこの iframe であることと、メッセージの形を確かめ、文字として表示する
//
// 遊び方（キャンバス 1 枚・プログラムの上書き）:
//   - 中のページには 640×480 のキャンバスが 1 枚だけある。DOM は使わせない（document・window などは、使うと分かりやすいエラーになる）
//   - 1 回のコード = 1 つのプログラム。実行するたびに、前のプログラム（draw の繰り返し・タイマー・入力の受け取り）を止め、
//     キャンバスを黒で消してから動かす。残るのは memo（オブジェクト）だけ
//   - 描くための関数（background・fill・circle・rect・line・text など）、計算の関数（random・noise・lerp・map など）、
//     入力（mouse・keys・onClick・onKey）、文字の表示（say）を用意する（名前は p5.js に寄せた。モデルが慣れているので）
//   - setup(関数) は 1 回、draw(関数) は毎フレーム呼ぶ。function setup() {…} / function draw() {…} と書いても動く
//
// 実行のしかた:
//   - コードは関数の中で動かす（"use strict"。const・let・function はその回だけのもの）
//   - for・while・do のループには見張り（__lp）を差し込み、2 秒以上、イベントループに戻らずに回り続けたらエラーにする（無限ループ対策）
//   - setup・draw・タイマー・入力の関数の中のエラーは捕まえて返す（draw の中でエラーが出たら、繰り返しを止める）
//   - 実行のあと 0.8 秒動かしてから、結果を返す: 成功か・エラー・console の出力・絵のようす（文字で描いた縮小図・多い色・動いているか）・
//     重さ（1 秒あたりのフレーム数・draw にかかった時間・処理で埋まっている時間）
//   - 1 秒ごとに重さを親に知らせる（onHealth）。決まった時間（既定 8 秒）結果が返らなければ、iframe を作り直す

const BOOT = String.raw`
(() => {
  // 元の関数（プログラムの止め方・計測は、AI のコードから見えない元の関数で行う）
  const _raf = requestAnimationFrame.bind(window), _caf = cancelAnimationFrame.bind(window);
  const _st = setTimeout.bind(window), _ct = clearTimeout.bind(window);
  const _si = setInterval.bind(window), _ci = clearInterval.bind(window);
  const W = 640, H = 480, MAX_TIMERS = 20;
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
  const errText = (err) => (err && err.name ? err.name + ': ' + err.message : String(err));
  const pushAsync = (t) => { if (asyncErrors.length < 10) asyncErrors.push(t); };
  addEventListener('error', (e) => { pushAsync(String(e.error?.name ? e.error.name + ': ' + e.error.message : e.message)); });
  addEventListener('unhandledrejection', (e) => { pushAsync('Promise: ' + String(e.reason?.message ?? e.reason)); });

  const cv = document.getElementById('cv');
  const ov = document.getElementById('say');
  const ctx = cv.getContext('2d');

  // ---- プログラム（1 回のコード）。新しいコードを実行するたびに作り直す
  let prog = null;
  let gen = 0;
  const style = { fill: true, stroke: false };
  const timers = new Map(); // id → 'timeout' | 'interval'
  const resetCanvas = () => {
    if (ctx.reset) ctx.reset(); else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.font = '16px system-ui, sans-serif';
    style.fill = true;
    style.stroke = false;
  };
  const stopProgram = () => {
    if (prog) _caf(prog.raf);
    prog = null;
    for (const [id] of timers) { _ct(id); _ci(id); }
    timers.clear();
    ov.textContent = '';
  };
  // 関数を呼び、エラーなら知らせる（true: 成功）
  const guard = (where, fn) => {
    try { fn(); return true; } catch (err) { pushAsync(where + ' の中でエラー: ' + errText(err)); return false; }
  };
  const loop = (now) => {
    const p = prog;
    if (!p || !p.draw) return;
    if (!p.t0) p.t0 = now;
    const t = (now - p.t0) / 1000;
    const dt = p.last ? (now - p.last) / 1000 : 0;
    p.last = now;
    p.frame++;
    const s = performance.now();
    const ok = guard('draw()', () => p.draw(t, dt, p.frame));
    p.ms.push(performance.now() - s);
    if (p.ms.length > 60) p.ms.shift();
    if (!ok) { p.draw = null; p.stopped = true; pushAsync('draw() の繰り返しを止めました'); return; }
    if (prog === p) p.raf = _raf(loop);
  };

  // ---- 入力（キャンバスの座標に直す。キャンバスは枠いっぱいに、縦横比を保って表示している）
  const mouse = { x: W / 2, y: H / 2, down: false };
  const held = new Set();
  const keys = { last: '', isDown: (k) => held.has(k) };
  const toCanvas = (e) => {
    const r = cv.getBoundingClientRect();
    const s = Math.min(r.width / W, r.height / H) || 1;
    const ox = r.left + (r.width - W * s) / 2, oy = r.top + (r.height - H * s) / 2;
    mouse.x = (e.clientX - ox) / s;
    mouse.y = (e.clientY - oy) / s;
  };
  addEventListener('pointermove', toCanvas);
  addEventListener('pointerdown', (e) => {
    toCanvas(e);
    mouse.down = true;
    for (const f of prog?.clicks ?? []) guard('onClick()', () => f(mouse.x, mouse.y));
  });
  addEventListener('pointerup', () => { mouse.down = false; });
  addEventListener('keydown', (e) => {
    keys.last = e.key;
    held.add(e.key);
    if (e.key.startsWith('Arrow') || e.key === ' ') e.preventDefault();
    for (const f of prog?.keys ?? []) guard('onKey()', () => f(e.key));
  });
  addEventListener('keyup', (e) => { held.delete(e.key); });
  addEventListener('blur', () => { held.clear(); mouse.down = false; });

  // ---- 色: fill('red') / fill(255, 0, 0) / fill(255, 0, 0, 0.5) / fill(128)（灰色）/ fill(128, 0.5) / fill([r, g, b, a])
  const colorOf = (...c) => {
    if (c.length === 1 && Array.isArray(c[0])) c = c[0];
    if (c.length === 0) return '#fff';
    if (c.length === 1) return typeof c[0] === 'number' ? 'rgb(' + c[0] + ',' + c[0] + ',' + c[0] + ')' : String(c[0]);
    if (c.length === 2) return 'rgba(' + c[0] + ',' + c[0] + ',' + c[0] + ',' + c[1] + ')';
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] ?? 1) + ')';
  };
  const paint = () => { if (style.fill) ctx.fill(); if (style.stroke) ctx.stroke(); };
  const need = (name, ...v) => { for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(name + '() には数を渡してください（' + String(x) + ' が来ました）'); };

  // ---- なめらかな乱数（パーリンノイズ。0〜1）
  const P = new Uint8Array(512);
  {
    const p = [...Array(256).keys()];
    for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
    for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const mix = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y, z) => { const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
  const noise = (x = 0, y = 0, z = 0) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
    const r = mix(
      mix(mix(grad(P[AA] & 15, x, y, z), grad(P[BA] & 15, x - 1, y, z), u), mix(grad(P[AB] & 15, x, y - 1, z), grad(P[BB] & 15, x - 1, y - 1, z), u), v),
      mix(mix(grad(P[AA + 1] & 15, x, y, z - 1), grad(P[BA + 1] & 15, x - 1, y, z - 1), u), mix(grad(P[AB + 1] & 15, x, y - 1, z - 1), grad(P[BB + 1] & 15, x - 1, y - 1, z - 1), u), v),
      w);
    return Math.min(1, Math.max(0, (r + 1) / 2));
  };

  const memo = {}; // プログラムをまたいで残る、ただ 1 つの入れ物

  // ---- AI が使える関数
  const api = {
    W, H, ctx, memo, mouse, keys, PI: Math.PI, TAU: Math.PI * 2,
    setup: (fn) => { if (typeof fn !== 'function') throw new TypeError('setup() には関数を渡してください'); prog.setup = fn; },
    draw: (fn) => { if (typeof fn !== 'function') throw new TypeError('draw() には関数を渡してください'); prog.draw = fn; },
    onClick: (fn) => { if (typeof fn !== 'function') throw new TypeError('onClick() には関数を渡してください'); prog.clicks.push(fn); },
    onKey: (fn) => { if (typeof fn !== 'function') throw new TypeError('onKey() には関数を渡してください'); prog.keys.push(fn); },
    say: (...lines) => { ov.textContent = lines.map((x) => (typeof x === 'string' ? x : fmt(x))).join('\n').slice(0, 600); },
    background: (...c) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = colorOf(...c); ctx.fillRect(0, 0, W, H); ctx.restore(); },
    clear: () => api.background(0),
    fill: (...c) => { ctx.fillStyle = colorOf(...c); style.fill = true; },
    noFill: () => { style.fill = false; },
    stroke: (...c) => { ctx.strokeStyle = colorOf(...c); style.stroke = true; },
    strokeWeight: (w) => { need('strokeWeight', w); ctx.lineWidth = w; style.stroke = true; },
    noStroke: () => { style.stroke = false; },
    circle: (x, y, r) => { need('circle', x, y, r); ctx.beginPath(); ctx.arc(x, y, Math.abs(r), 0, Math.PI * 2); paint(); },
    ellipse: (x, y, rx, ry = rx) => { need('ellipse', x, y, rx, ry); ctx.beginPath(); ctx.ellipse(x, y, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2); paint(); },
    rect: (x, y, w, h = w) => { need('rect', x, y, w, h); ctx.beginPath(); ctx.rect(x, y, w, h); paint(); },
    // 線は、stroke() が無ければ fill の色で引く（noStroke のままで線が見えない、を避ける）
    line: (x1, y1, x2, y2) => {
      need('line', x1, y1, x2, y2);
      ctx.save();
      if (!style.stroke) ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.restore();
    },
    poly: (points, close = true) => {
      if (!Array.isArray(points) || points.length < 2) throw new TypeError('poly() には [[x, y], [x, y], …] を渡してください');
      ctx.beginPath();
      points.forEach((pt, i) => { const [x, y] = Array.isArray(pt) ? pt : [pt.x, pt.y]; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      if (close) ctx.closePath();
      if (close) paint(); else { ctx.save(); if (!style.stroke) ctx.strokeStyle = ctx.fillStyle; ctx.stroke(); ctx.restore(); }
    },
    text: (s, x, y, size = 16, align = 'left') => {
      need('text', x, y, size);
      ctx.font = size + 'px system-ui, sans-serif';
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(typeof s === 'string' ? s : fmt(s), x, y);
    },
    push: () => ctx.save(),
    pop: () => ctx.restore(),
    translate: (x, y) => { need('translate', x, y); ctx.translate(x, y); },
    rotate: (a) => { need('rotate', a); ctx.rotate(a); },
    scale: (x, y = x) => { need('scale', x, y); ctx.scale(x, y); },
    random: (a, b) => {
      if (Array.isArray(a)) return a[Math.floor(Math.random() * a.length)];
      if (a === undefined) return Math.random();
      if (b === undefined) return Math.random() * a;
      return a + Math.random() * (b - a);
    },
    randInt: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
    noise,
    lerp: (a, b, t) => a + (b - a) * t,
    map: (v, a, b, c, d) => c + ((v - a) * (d - c)) / (b - a),
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    dist: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1),
    hsl: (h, s = 70, l = 55, a = 1) => 'hsla(' + h + ',' + s + '%,' + l + '%,' + a + ')',
    rgb: (r, g, b, a = 1) => 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')',
    // タイマー（プログラムを上書きすると止まる。同時に MAX_TIMERS 個まで）
    setTimeout: (fn, ms, ...a) => {
      if (typeof fn !== 'function') throw new TypeError('setTimeout() には関数を渡してください');
      if (timers.size >= MAX_TIMERS) throw new Error('タイマーは同時に ' + MAX_TIMERS + ' 個までです。繰り返しは draw() の中で行ってください');
      const g = gen;
      const id = _st(() => { timers.delete(id); if (g === gen) guard('setTimeout()', () => fn(...a)); }, ms);
      timers.set(id, 'timeout');
      return id;
    },
    setInterval: (fn, ms, ...a) => {
      if (typeof fn !== 'function') throw new TypeError('setInterval() には関数を渡してください');
      if (timers.size >= MAX_TIMERS) throw new Error('タイマーは同時に ' + MAX_TIMERS + ' 個までです。繰り返しは draw() の中で行ってください');
      const g = gen;
      const id = _si(() => { if (g === gen) guard('setInterval()', () => fn(...a)); }, Math.max(10, Number(ms) || 0));
      timers.set(id, 'interval');
      return id;
    },
    clearTimeout: (id) => { if (timers.has(id)) { _ct(id); _ci(id); timers.delete(id); } },
  };
  api.clearInterval = api.clearTimeout;
  // 使えないもの: 触ると、何を使えばいいかを書いたエラーになる
  const banned = (name, hint) => new Proxy(function () {}, {
    get: (_, k) => { if (k === Symbol.toPrimitive || k === 'toString') return () => '[使えない ' + name + ']'; throw new Error(name + ' は使えません。' + hint); },
    set: () => { throw new Error(name + ' は使えません。' + hint); },
    apply: () => { throw new Error(name + ' は使えません。' + hint); },
    construct: () => { throw new Error(name + ' は使えません。' + hint); },
  });
  const DOM_HINT = 'DOM（HTML の要素）は使えません。絵はキャンバスの関数（background・circle・rect・text など。細かいことは ctx）で、文字は say() で出してください';
  for (const n of ['document', 'window', 'globalThis', 'self', 'parent', 'top', 'frames', 'location', 'history', 'navigator', 'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt', 'open', 'fetch', 'XMLHttpRequest', 'Image']) api[n] = banned(n, DOM_HINT);
  for (const n of ['requestAnimationFrame', 'cancelAnimationFrame']) api[n] = banned(n, 'アニメーションは draw(関数) を使ってください（毎フレーム呼ばれます。止めるときは次のコードで上書きします）');
  const NAMES = Object.keys(api);
  const VALUES = NAMES.map((k) => api[k]);

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
      const ms = prog?.ms ?? [];
      return {
        fps: Math.round((m.frames * 1000) / dt),
        busy: Math.min(1, m.lag / dt),
        visible: document.visibilityState === 'visible',
        running: !!prog?.draw,
        drawMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0,
        drawMsMax: ms.length ? Math.max(...ms) : 0,
        timers: timers.size,
      };
    };
  };
  let health = meter();
  _si(() => { const m = health(); health = meter(); parent.postMessage({ type: 'health', load: m }, '*'); }, 1000);
  Object.defineProperty(window, '__lp', { value: () => {
    if (performance.now() - tick > 2000) { tick = performance.now(); throw new Error('ループが 2 秒以上終わりませんでした（無限ループの可能性があるので止めました）'); }
  } });

  // ---- 絵のようす（モデルは画像を見られないので、文字にする）
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const sample = (w, h) => {
    small.width = w; small.height = h;
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, w, h);
    sctx.drawImage(cv, 0, 0, w, h);
    return sctx.getImageData(0, 0, w, h).data;
  };
  const RAMP = ' .:-=+*#%@';
  const TW = 32, TH = 12;
  const thumb = () => {
    const d = sample(TW, TH);
    const lum = [];
    for (let i = 0; i < d.length; i += 4) lum.push((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255);
    return lum;
  };
  const picture = (before) => {
    const lum = thumb();
    const rows = [];
    for (let y = 0; y < TH; y++) {
      let r = '';
      for (let x = 0; x < TW; x++) r += RAMP[Math.min(RAMP.length - 1, Math.floor(lum[y * TW + x] * RAMP.length))];
      rows.push(r);
    }
    let changed = 0;
    for (let i = 0; i < lum.length; i++) if (Math.abs(lum[i] - before[i]) > 0.03) changed++;
    // 多い色（各色 4 段階に丸めて数える）
    const d = sample(64, 48);
    const count = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const q = (v) => Math.round(v / 85) * 85;
      const hex = '#' + [q(d[i]), q(d[i + 1]), q(d[i + 2])].map((v) => v.toString(16).padStart(2, '0')).join('');
      count.set(hex, (count.get(hex) || 0) + 1);
    }
    const total = d.length / 4;
    const colors = [...count].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([hex, n]) => ({ hex, pct: Math.round((n * 100) / total) }));
    return { thumb: rows, colors, moving: Math.round((changed * 100) / lum.length), say: ov.textContent };
  };

  addEventListener('message', async (e) => {
    if (e.source !== parent || !e.data || e.data.type !== 'run') return;
    const { id, code } = e.data;
    logs.length = 0;
    asyncErrors.length = 0;
    tick = performance.now();
    // 前のプログラムを止めて、キャンバスを消す
    stopProgram();
    gen++;
    resetCanvas();
    const p = prog = { setup: null, draw: null, stopped: false, clicks: [], keys: [], raf: 0, t0: 0, last: 0, frame: 0, ms: [] };
    let error = null;
    try {
      // 内側の関数の中で動かす: AI が const draw や function draw() {…} と書いても、こちらの名前とぶつからない
      const run = new Function(...NAMES, '"use strict";\nreturn (() => {\n' + code + '\n;return { setup: typeof setup === "function" ? setup : undefined, draw: typeof draw === "function" ? draw : undefined };\n})();');
      const found = run(...VALUES);
      // function setup() {…} / function draw() {…} の書き方（こちらの setup・draw を呼ばずに、同じ名前の関数を作った）
      if (found?.setup && found.setup !== api.setup && !p.setup) p.setup = found.setup;
      if (found?.draw && found.draw !== api.draw && !p.draw) p.draw = found.draw;
      if (p.setup) {
        try { p.setup(); } catch (err) { error = 'setup() の中でエラー: ' + errText(err); }
      }
    } catch (err) {
      error = errText(err);
    }
    if (p.draw && prog === p) p.raf = _raf(loop);
    // 少し動かしてから、絵のようすと重さを返す（あとから起きたエラーも集める）
    const m = meter();
    await new Promise((res) => _st(res, 300));
    const before = thumb();
    await new Promise((res) => _st(res, 500));
    let snap = null;
    try { snap = picture(before); } catch (err) { snap = { error: String(err) }; }
    snap && Object.assign(snap, { drawStopped: !!p.stopped, hasDraw: !!(p.draw || p.stopped), hasSetup: !!p.setup, clicks: p.clicks.length, keys: p.keys.length, frames: p.frame });
    parent.postMessage({ type: 'result', id, error, asyncErrors: asyncErrors.slice(0, 5), logs: logs.slice(-20), snapshot: snap, load: m() }, '*');
  });
  resetCanvas();
  parent.postMessage({ type: 'ready' }, '*');
})();
`;

// 中のページ。CSP でネットワークを止める（スクリプトは、このページの中に書いたものと eval だけ）
const SRCDOC = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;font-family:system-ui,sans-serif;}
#cv{display:block;width:100%;height:100%;object-fit:contain;touch-action:none;}
#say{position:absolute;left:8px;top:8px;max-width:calc(100% - 32px);color:#fff;background:rgba(0,0,0,.6);font-size:14px;line-height:1.5;padding:4px 10px;border-radius:6px;white-space:pre-wrap;pointer-events:none;}
#say:empty{display:none;}
</style></head><body><canvas id="cv" width="640" height="480" tabindex="0"></canvas><div id="say"></div>
<script>${BOOT}<\/script></body></html>`;

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

  /** 中のページを初期化する（iframe を作り直す。memo も消える） */
  reset() {
    for (const [, r] of this.pending) r({ error: '実行中にページを初期化しました', reset: true, asyncErrors: [], logs: [], snapshot: null, load: null });
    this.pending.clear();
    this.frame?.remove();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.setAttribute('title', 'AI が描くキャンバス（サンドボックス）');
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

  /** コード（1 つのプログラム）を実行して、結果を返す（時間切れなら iframe を作り直して timedOut） */
  async run(code) {
    await this.ready;
    const id = ++this.seq;
    const frame = this.frame;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.reset();
        resolve({ error: null, timedOut: true, asyncErrors: [], logs: [], snapshot: null, load: null });
      }, this.timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      frame.contentWindow.postMessage({ type: 'run', id, code: instrument(code) }, '*');
    });
  }
}

const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : x == null ? null : String(x).slice(0, n));
const arr = (x, n, m) => (Array.isArray(x) ? x.slice(0, n).map((y) => str(y, m)) : []);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** 重さ（iframe から来たもの。中身は信用しない） */
export function sanitizeLoad(l) {
  if (!l || typeof l !== 'object') return null;
  return {
    fps: num(l.fps),
    busy: Math.min(1, Math.max(0, num(l.busy))),
    visible: l.visible === true,
    running: l.running === true,
    drawMs: num(l.drawMs),
    drawMsMax: num(l.drawMsMax),
    timers: num(l.timers),
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
    snapshot: s ? {
      // 縮小図は決まった文字だけ（' .:-=+*#%@'）
      thumb: arr(s.thumb, 12, 32).map((r) => r.replace(/[^ .:\-=+*#%@]/g, ' ')),
      colors: Array.isArray(s.colors) ? s.colors.slice(0, 4).map((c) => ({ hex: /^#[0-9a-f]{6}$/.test(c?.hex) ? c.hex : '#??????', pct: num(c?.pct) })) : [],
      moving: num(s.moving),
      say: str(s.say, 600) ?? '',
      hasDraw: s.hasDraw === true,
      drawStopped: s.drawStopped === true,
      hasSetup: s.hasSetup === true,
      clicks: num(s.clicks),
      keys: num(s.keys),
      frames: num(s.frames),
      error: str(s.error, 200),
    } : null,
  };
}

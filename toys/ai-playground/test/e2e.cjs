// AI の遊び場の通し確認（ヘッドレス Chromium）。
//
//   sh toys/ai-playground/test/setup.sh       # 初回だけ
//   python3 -m http.server 8000               # リポジトリのルートで
//   node toys/ai-playground/test/e2e.cjs [ページの URL]
//
// 確かめること:
//   - サンドボックス（キャンバス 1 枚）: 描いて、絵のようす（縮小図・色・動き）を返す / memo だけが次のプログラムに残る / DOM は使えない /
//     draw・setup・タイマー・入力 / プログラムを上書きすると前のものは止まる / エラー（setup・draw・タイマーの中も）を返す /
//     このページ（親）・localStorage・ネットワーク・親の移動には触れない / 無限ループを止める / 重さを測り、重すぎたら初期化する
//   - 繰り返し（偽のモデルで、決まった答えを返す）: 思考とコードを表示・実行 / エラーをモデルに返し、次で直させる / コードが無いとき・失敗が続いたときの知らせ /
//     直近のステップだけを渡す / 一時停止・再開・止める
//   - 本物の Qwen3 4B のトークナイザ: 思考モードの切り替え（enable_thinking）がチャットテンプレートに効く
//   - 小さなテスト用モデル（本物の推論の流れ）: 読み込んで、ステップが回る
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:8000/toys/ai-playground/').replace(/\/?$/, '/');
const CHAT_CACHE = path.join(__dirname, '../../tinyswallow-chat/test/.cache');
const TJS_DIST = path.join(CHAT_CACHE, 'transformers/package/dist');
const ORT_DIST = path.join(CHAT_CACHE, 'ort/package/dist');
const TINY = path.join(CHAT_CACHE, 'tiny-model');
const QWEN3 = path.join(__dirname, '.cache/qwen3');

const t0 = Date.now();
const say = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; say(ok ? 'PASS' : 'FAIL', label); };
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const serve = (route, file) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
  return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' } });
};
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`時間切れ: ${label}`)), ms))]);

async function main() {
  for (const d of [TJS_DIST, ORT_DIST, TINY, QWEN3]) if (!fs.existsSync(d)) throw new Error(`${d} がありません。先に test/setup.sh を実行してください`);
  const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const outside = new Set();
  await ctx.route('https://cdn.jsdelivr.net/**', (route) => {
    const u = new URL(route.request().url());
    let m = /^\/npm\/@huggingface\/transformers@4\.3\.2(\/.*)?$/.exec(u.pathname);
    if (m) return serve(route, path.join(TJS_DIST, m[1] ? path.basename(m[1]) : 'transformers.min.js'));
    m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/([\w.-]+)$/.exec(u.pathname);
    if (m) return serve(route, path.join(ORT_DIST, m[1]));
    return route.fulfill({ status: 404, body: '' });
  });
  await ctx.route('https://huggingface.co/**', (route) => {
    const m = /^\/([\w.-]+\/[\w.-]+)\/resolve\/main\/(.+)$/.exec(new URL(route.request().url()).pathname);
    if (m && m[1] === 'test-org/tiny-qwen2') return serve(route, path.join(TINY, m[2]));
    if (m && m[1] === 'onnx-community/Qwen3-4B-ONNX' && !m[2].startsWith('onnx/')) return serve(route, path.join(QWEN3, m[2]));
    return route.fulfill({ status: 404, body: 'Entry not found', headers: { 'access-control-allow-origin': '*' } });
  });
  ctx.on('request', (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host && !['cdn.jsdelivr.net', 'huggingface.co'].includes(u.host)) outside.add(u.host);
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(e.message); say('pageerror', e.message); });
  p.on('console', (m) => { if (m.type() === 'error') say('console.error', m.text().slice(0, 200)); });
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForFunction(() => !!window.__playground);
  const run = (code) => withTimeout(p.evaluate((c) => window.__playground.sandbox.run(c), code), 20000, code.slice(0, 40));

  // ---------------------------------------------------------------- サンドボックス
  check(await p.evaluate(() => {
    const f = document.querySelector('.sandbox-frame');
    return f.getAttribute('sandbox') === 'allow-scripts' && !!f.srcdoc.includes("default-src 'none'");
  }), '右のページは sandbox="allow-scripts"（allow-same-origin なし）の iframe で、CSP でネットワークを止めている');

  // 描く・memo・say・console
  let r = await run("background('#000'); fill('white'); circle(320, 240, 120); say('こんにちは'); memo.n = 41; console.log('ok', {a: 1});");
  say('絵', '\n' + (r.snapshot?.thumb ?? []).join('\n'));
  check(!r.error && /[#%@]/.test(r.snapshot.thumb[6].slice(12, 20)) && !r.snapshot.thumb[0].trim() && r.snapshot.colors.some((c) => c.hex === '#ffffff') && r.snapshot.say === 'こんにちは' && r.logs[0] === '[log] ok {"a":1}' && !r.snapshot.hasDraw && r.snapshot.moving === 0,
    `キャンバスに描き、文字の縮小図・多い色・say・console の出力を返す（${JSON.stringify(r.snapshot.colors)}）`);
  r = await run('memo.n += 1; console.log(memo.n);');
  check(!r.error && r.logs[0] === '[log] 42' && r.snapshot.thumb.every((x) => !x.trim()) && r.snapshot.say === '', 'memo は次のプログラムに残る。キャンバスと say は、新しいプログラムで消える');
  r = await run('const a = 1; let b = 2; function f() {} console.log(a + b);');
  r = await run('const a = 5; const draw = 3; console.log(a, draw);');
  check(!r.error && r.logs[0] === '[log] 5 3', 'const・let・function はその回だけ（もう一度宣言しても、用意した関数と同じ名前でもエラーにならない）');
  // DOM は使えない
  r = await run("document.body.innerHTML = 'x';");
  check(/document は使えません。DOM/.test(r.error ?? ''), `document は使えない（何を使えばいいかをエラーで伝える: ${r.error?.slice(0, 60)}）`);
  r = await run('window.foo = 1;');
  check(/window は使えません/.test(r.error ?? ''), 'window も使えない');
  r = await run('requestAnimationFrame(() => {});');
  check(/draw\(関数\) を使ってください/.test(r.error ?? ''), `requestAnimationFrame は使えず、draw を案内する（${r.error?.slice(0, 50)}）`);
  r = await run('x = 1;');
  check(/ReferenceError/.test(r.error ?? ''), '宣言しない変数への代入はエラー（"use strict"。window に値が漏れない）');
  // アニメーション（draw）
  r = await run("draw((t, dt) => { background(0); fill('red'); circle(80 + (t * 300) % 480, 240, 40); memo.frames = (memo.frames || 0) + 1; });");
  check(!r.error && r.snapshot.hasDraw && r.snapshot.frames > 5 && r.snapshot.moving > 0 && r.load.running && r.load.drawMs >= 0, `draw で毎フレーム描き、動いていることを返す（${r.snapshot.frames} フレーム・変化 ${r.snapshot.moving}%・draw ${r.load.drawMs.toFixed(2)} ms）`);
  r = await run("setInterval(() => { memo.iv = (memo.iv || 0) + 1; }, 20); fill('blue'); rect(10, 10, 50, 50);");
  r = await run("const f = memo.frames, iv = memo.iv; setTimeout(() => console.log(memo.frames === f, memo.iv === iv), 300);");
  check(!r.error && r.logs[0] === '[log] true true' && !r.snapshot.hasDraw && r.load.timers <= 1, `新しいプログラムを実行すると、前の draw とタイマーは止まる（${r.logs.join(' / ')}）`);
  // p5.js ふうの書き方
  r = await run("function setup() { memo.setupRan = true; }\nfunction draw() { background(40); fill(255); rect(100, 100, 200, 200); }");
  check(!r.error && r.snapshot.hasSetup && r.snapshot.hasDraw && r.snapshot.frames > 0, 'function setup() {…} / function draw() {…} と書いても動く');
  r = await run('setup(() => { memo.s2 = memo.setupRan; }); console.log(typeof memo.s2);');
  check(!r.error && r.logs[0] === '[log] undefined' && r.snapshot.hasSetup, 'setup(関数) は、コードのあとに 1 回呼ぶ');
  // エラー
  r = await run('undefinedFunction();');
  check(/ReferenceError: undefinedFunction is not defined/.test(r.error), `エラーを返す（${r.error}）`);
  r = await run("setup(() => { nope(); });");
  check(/setup\(\) の中でエラー: ReferenceError/.test(r.error ?? ''), `setup の中のエラーを返す（${r.error}）`);
  r = await run("draw(() => { background(0); circle(320, 240, 'big'); });");
  check(r.asyncErrors.some((x) => /draw\(\) の中でエラー: TypeError: circle\(\) には数を渡してください/.test(x)) && r.snapshot.drawStopped, `draw の中のエラーを返し、繰り返しを止める（${r.asyncErrors.join(' / ')}）`);
  r = await run("setTimeout(() => { throw new Error('あとで失敗'); }, 10); Promise.resolve().then(() => { throw new Error('あとの約束'); });");
  check(r.asyncErrors.some((x) => /setTimeout\(\) の中でエラー: Error: あとで失敗/.test(x)) && r.asyncErrors.some((x) => /Promise: あとの約束/.test(x)), `タイマーの中のエラー・処理されなかった Promise の失敗も返す（${r.asyncErrors.join(' / ')}）`);
  r = await run('function f() { f(); } f();');
  check(/RangeError/.test(r.error), '再帰が深すぎるときもエラーを返す');
  r = await run('for (let i = 0; i < 21; i++) setInterval(() => {}, 1000);');
  check(/タイマーは同時に 20 個まで/.test(r.error ?? ''), 'タイマーは同時に 20 個まで');
  // 入力（クリック・キー）
  r = await run("onClick((x, y) => { memo.click = [Math.round(x), Math.round(y)]; }); onKey((k) => { memo.key = k; }); draw(() => { memo.down = keys.isDown('ArrowLeft') || memo.down; });");
  check(r.snapshot.clicks === 1 && r.snapshot.keys === 1, 'onClick・onKey を受け取る');
  const box = await p.locator('.sandbox-frame').boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.keyboard.down('ArrowLeft');
  await p.waitForTimeout(100);
  await p.keyboard.up('ArrowLeft');
  r = await run('console.log(JSON.stringify(memo.click), memo.key, memo.down);');
  const [cx, cy] = JSON.parse(r.logs[0]?.split(' ')[1] ?? '[0,0]');
  check(Math.abs(cx - 320) <= 3 && Math.abs(cy - 240) <= 3 && /ArrowLeft true$/.test(r.logs[0]), `クリックの位置をキャンバスの座標で渡し、キーも受け取る（${r.logs[0]}）`);

  // 隔離: 用意した名前を通らずに（間接 eval で）触っても、親・localStorage・ネットワーク・親の移動には届かない
  const before = await p.evaluate(() => document.title);
  r = await run("(0, eval)(\"parent.document.body.innerHTML = 'のっとり'\");");
  check(/SecurityError|Blocked a frame|cross-origin/i.test(r.error) && (await p.evaluate(() => document.title)) === before && !(await p.evaluate(() => document.body.textContent.includes('のっとり'))), `このページ（親）の DOM には触れない（${r.error?.slice(0, 80)}）`);
  r = await run("(0, eval)(\"localStorage.setItem('x', '1')\");");
  check(/SecurityError|denied|sandbox/i.test(r.error ?? ''), `localStorage は使えない（${r.error?.slice(0, 80)}）`);
  r = await run("(0, eval)('fetch')('https://example.com/x').then(() => console.log('届いた'), (e) => console.log('止められた', e.name));");
  check(r.logs.some((x) => /止められた/.test(x)) && !outside.has('example.com'), `ネットワークは使えない（${r.logs.join(' / ')}）`);
  r = await run("(0, eval)(\"top.location.href = 'https://example.com/'\");");
  check(!!r.error && new URL(p.url()).host === new URL(BASE).host, `このページを別のページへ移動させられない（${r.error?.slice(0, 80)}）`);

  // 無限ループ: 波かっこあり・本体が空・1文・draw の中
  let t = Date.now();
  r = await run('let i = 0; while (true) { i++; }');
  check(/無限ループ/.test(r.error ?? '') && Date.now() - t < 8000, `無限ループ（while (true) { … }）を約 2 秒で止める（${Date.now() - t}ms）`);
  t = Date.now();
  r = await run('for (;;);');
  check(/無限ループ/.test(r.error ?? ''), `本体が空の無限ループ（for (;;);）も止める（${Date.now() - t}ms）`);
  t = Date.now();
  r = await run('let k = 0; while (k >= 0) k++;');
  check(/無限ループ/.test(r.error ?? ''), `波かっこの無い1文の無限ループ（while (k >= 0) k++;）も止める（${Date.now() - t}ms）`);
  t = Date.now();
  r = await run('draw(() => { let q = 0; while (q >= 0) { q++; } });');
  check(r.asyncErrors.some((x) => /draw\(\) の中でエラー: .*無限ループ/.test(x)) && r.snapshot.drawStopped, `draw の中の無限ループも止め、繰り返しを止める（${Date.now() - t}ms）`);
  r = await run('let s = 0;\nfor (let i = 0; i < 5; i++)\n  for (let j = 0; j < 5; j++) s += i * j;\nconsole.log(s);');
  check(!r.error && r.logs[0] === '[log] 100', `見張りを入れても、入れ子のループの答えは変わらない（${r.logs[0] ?? r.error}）`);
  r = await run('console.log("生きている");');
  check(!r.error && r.logs[0] === '[log] 生きている', '無限ループを止めたあとも、続けて実行できる');

  // 中のページの移動・document.write（間接 eval で無理にやっても、止まらない）
  r = await run("(0, eval)(\"location.href = 'about:blank'\");");
  await p.waitForTimeout(800);
  check(await p.evaluate(() => window.__playground.state.navigated), '中のページが移動しようとしたら、気づいて初期化する');
  r = await run("console.log('初期化のあと');");
  check(r.logs[0] === '[log] 初期化のあと', '移動のあとも、初期化したページで続けられる');
  r = await run("(0, eval)(\"document.open(); document.write('<p>書き換え</p>'); document.close();\");");
  r = await run("console.log('書き換えのあと');");
  say('document.write のあと', JSON.stringify(r).slice(0, 160));
  check(r.timedOut === true || r.logs[0] === '[log] 書き換えのあと', 'document.write のあとは、そのまま続くか、応答なしで初期化する（どちらでも止まらない）');
  if (r.timedOut || r.error) await p.evaluate(() => window.__playground.sandbox.reset());
  r = await run("console.log('その次');");
  check(r.logs[0] === '[log] その次', 'その次の実行はできる');
  await p.evaluate(() => window.__playground.state.navigated = false);

  // ---------------------------------------------------------------- 重さ
  await p.evaluate(() => window.__playground.sandbox.reset());
  r = await run("memo.keep = 1; draw(() => { background(0); circle(320, 240, 50); });");
  await p.waitForTimeout(1300);
  check(/\d+ fps・draw [\d.]+ ms・負荷 \d+%/.test(await p.textContent('#load')), `重さを 1 秒ごとに表示する（${await p.textContent('#load')}）`);
  // 重すぎる状態が続いたら、ページを初期化する（実行していないときも）
  r = await run('draw(() => { const t = performance.now(); while (performance.now() - t < 120) {} });');
  say('重い draw の重さ', JSON.stringify(r.load));
  check(r.load.busy >= 0.5 && r.load.drawMs >= 100, `重い draw のあとの結果に、重さ（処理で埋まっている時間 ${Math.round(r.load.busy * 100)}%・draw ${Math.round(r.load.drawMs)} ms）が入る`);
  await p.waitForFunction(() => !!window.__playground.state.autoReset, null, { timeout: 15000 }).catch(() => {});
  const auto = await p.evaluate(() => window.__playground.state.autoReset);
  r = await run('console.log(JSON.stringify(memo));');
  check(/固まりかけていた/.test(auto ?? '') && r.logs[0] === '[log] {}', `重すぎる状態が続いたら、ページを初期化する（memo も消える: ${auto}）`);
  await p.evaluate(() => { window.__playground.state.autoReset = null; });
  // 知らせの文
  const fb = await p.evaluate(() => {
    const pg = window.__playground;
    const thumb = Array.from({ length: 12 }, (_, i) => (i === 5 ? '              @@@@              ' : ' '.repeat(32)));
    const snap = { thumb, colors: [{ hex: '#000000', pct: 95 }, { hex: '#ffffff', pct: 5 }], moving: 12, say: '点数 3', hasDraw: true, drawStopped: false, hasSetup: true, clicks: 1, keys: 0, frames: 48 };
    const load = { fps: 20, busy: 0.5, visible: true, running: true, drawMs: 31.2, drawMsMax: 40, timers: 2 };
    const step = { code: 'x', result: { error: null, asyncErrors: [], logs: [], snapshot: snap, load } };
    const blank = { ...snap, thumb: Array(12).fill(' '.repeat(32)), colors: [{ hex: '#000000', pct: 100 }], moving: 0, hasDraw: false, hasSetup: false, clicks: 0, say: '' };
    return {
      heavy: pg.feedbackFor(step, {}),
      short: pg.feedbackFor(step, { short: true, seeds: ['時計'] }),
      light: pg.feedbackFor({ code: 'x', result: { ...step.result, load: { ...load, busy: 0.05, fps: 60, drawMs: 1.2 } } }, {}),
      blank: pg.summarize(blank),
      hard: pg.tooHeavy(snap, { ...load, busy: 0.9 }),
      reset: pg.feedbackFor(step, { autoReset: 'テストの理由', seeds: ['時計', '迷路'] }),
      repeat: pg.feedbackFor(step, { repeatOf: 3, seeds: ['数独'] }),
      sim: [pg.similarity('ctx.arc(10, 10, 5, 0, 7); ctx.fill();', 'ctx.arc(10,10,5,0,7);ctx.fill();'), pg.similarity('ctx.arc(10, 10, 5, 0, 7);', 'document.title = "時計";')],
      first: [pg.firstPrompt(), pg.firstPrompt()],
      older: pg.olderHistory([1, 2, 3, 4, 5, 6].map((n) => ({ n, say: `ステップ${n}の説明です。続き。`, code: 'x', failed: n === 2 })), 4),
    };
  });
  check(/絵（32×12 に縮めた図。暗い ' ' 〜 明るい '@'）:\n\| {32}\|/.test(fb.heavy) && /\| {14}@@@@ {14}\|/.test(fb.heavy) && /多い色: #000000 95%、#ffffff 5%/.test(fb.heavy) && /動き: 0.5 秒で 12% が変わった（動いている）/.test(fb.heavy) && /プログラム: setup あり、draw あり（48 フレーム）、クリックを受け取る/.test(fb.heavy) && /say の文字: 点数 3/.test(fb.heavy), '知らせに、絵の縮小図・多い色・動き・プログラムのようす・say の文字を入れる');
  check(/重さ: 1 秒あたり 20 フレーム、draw 1 回 平均 31.2 ms（最大 40.0 ms）、処理で埋まっている時間 50%、タイマー 2 個/.test(fb.heavy) && /重くなっています（draw 1 回に平均 31.2 ms かかっています、処理で埋まっている時間が 50% です）/.test(fb.heavy), '重さを伝え、重いときは軽くするよう促す');
  check(!/重くなっています/.test(fb.light), '軽いときは、促さない');
  check(!/絵（|重さ:|思いつきのたね/.test(fb.short) && /実行しました（エラーなし）/.test(fb.short), '履歴に入れる前のステップの知らせは短くする（絵・重さ・たねを省く）');
  check(/キャンバスは真っ黒のままです/.test(fb.blank) && /動き: 変わらない（止まっている）/.test(fb.blank) && /draw なし（止まった絵）/.test(fb.blank), '何も描いていないときは、真っ黒のままと伝える');
  check(/固まりかけていた/.test(fb.hard ?? '') && /重すぎたので（テストの理由）、プログラムを止めてページを初期化しました（memo も消えました）/.test(fb.reset) && !/絵（/.test(fb.reset) && /思いつきのたね: 時計・迷路/.test(fb.reset), '重すぎて初期化したときは、そう伝え、思いつきのたねを添える');
  check(/ステップ 3 のコードとほとんど同じ/.test(fb.repeat) && /思いつきのたね: 数独/.test(fb.repeat), '前とほとんど同じコードなら、そう伝え、思いつきのたねを添える');
  check(fb.sim[0] >= 0.95 && fb.sim[1] < 0.3, `コードの似ている度合い（空白の違いは同じ扱い: ${fb.sim.map((x) => x.toFixed(2)).join(' / ')}）`);
  check(fb.first.every((x) => /^キャンバスは真っ黒です/.test(x) && /思いつきのたね: [^・]+・[^・]+・[^。]+。/.test(x)), `最初の知らせに、思いつきのたねを 3 つ添える（${fb.first[0].split('\n')[1]}）`);
  check(/- ステップ 1: ステップ1の説明です。\n- ステップ 2: ステップ2の説明です。（失敗）$/.test(fb.older), `直近より前のステップは、1行ずつにまとめて渡す（${JSON.stringify(fb.older)}）`);
  await p.evaluate(() => window.__playground.sandbox.reset());

  // ---------------------------------------------------------------- 繰り返し（偽のモデル）
  await p.evaluate(() => {
    const answers = [
      // 1: 思考 → エラーになるコード
      '<think>まずは見出しを出そう。関数名を間違えるかも。</think>\n見出しを出してみます。\n```js\nsay(makeTitle("遊び場"));\n```',
      // 2: 前のエラーを直す
      '<think>makeTitle は無かった。自分で作る。</think>\n関数を作って直します。\n```js\nconst makeTitle = (t) => "【" + t + "】";\nsay(makeTitle("遊び場"));\n```',
      // 3: コードを書き忘れる
      '<think>次は色を変えたい。</think>\n背景を青くしたいです。',
      // 4: 動くコード（アニメーション）
      '<think>色を変えて、点を動かす。</think>\n背景を変えて、点を動かします。\n```javascript\ndraw((t) => { background("#123"); fill("white"); circle(320 + Math.sin(t * 3) * 200, 240, 30); });\nconsole.log("dot", 1);\n```',
      // 5〜7: 失敗が続く
      '```js\nnope1();\n```', '```js\nnope2();\n```', '```js\nnope3();\n```',
      '```js\nconsole.log("立ち直った");\n```',
    ];
    window.__asked = [];
    window.__playground.setGenerator(async (messages, onText) => {
      window.__asked.push(messages);
      const a = answers[Math.min(window.__asked.length - 1, answers.length - 1)];
      // 少しずつ返す（ストリーミングのまね）
      for (let i = 10; i < a.length; i += 10) { onText(a.slice(0, i)); await new Promise((r) => setTimeout(r, 15)); }
      onText(a);
      return a;
    });
    const s = window.__playground.settings; s.wait = 0;
  });
  await p.evaluate(() => window.__playground.sandbox.reset());
  await p.click('#start');
  await p.waitForFunction(() => window.__playground.state.steps.length >= 8, null, { timeout: 60000 });
  await p.click('#pause');
  await p.waitForFunction(() => window.__playground.state.phase === 'paused', null, { timeout: 30000 });
  const loop = await p.evaluate(() => ({
    steps: window.__playground.state.steps.map((s) => ({ code: !!s.code, result: s.resultText.split('\n')[0] })),
    asked: window.__asked.map((m) => ({ n: m.length, last: m.at(-1).content, users: m.filter((x) => x.role === 'user').map((x) => x.content) })),
    views: [...document.querySelectorAll('.step')].map((v) => ({ think: v.querySelector('.think-text').textContent, cls: v.querySelector('.result').className, state: v.querySelector('.step-state').textContent })),
    dot: null,
  }));
  say('ステップ', JSON.stringify(loop.steps.slice(0, 8)));
  check(/ReferenceError: makeTitle is not defined/.test(loop.steps[0].result) && loop.steps[1].result === '成功', '1 回目のエラーのあと、2 回目で直す（偽のモデル）');
  check(/エラーが出ました:\n- ReferenceError: makeTitle is not defined\n原因を考えて、直してください。/.test(loop.asked[1].last) && /絵（32×12/.test(loop.asked[1].last), 'エラーと絵のようすを、次のステップでモデルに返す');
  check(loop.steps[2].code === false && /コードが見つかりませんでした/.test(loop.asked[3].last), 'コードが無いときは、そう知らせて書き直させる');
  check(/console の出力:\n\[log\] dot 1/.test(loop.asked[4].last) && /draw あり/.test(loop.asked[4].last) && /動いている/.test(loop.asked[4].last), 'console の出力と、絵が動いていることを返す');
  check(loop.asked[7].users.slice(0, -1).every((u) => !/絵（32×12/.test(u)) && /絵（32×12/.test(loop.asked[7].last), '絵のようすは、いまの知らせだけに入れる（前のステップの知らせは短い形）');
  check(/失敗が続いています/.test(loop.asked[7].last) && loop.steps[7].result === '成功', '失敗が続いたら、別のやり方を促す');
  check(/（参考: もっと前のステップでしたこと）\n- ステップ 1: 見出しを出してみます。（失敗）\n- ステップ 2: 関数を作って直します。\n- ステップ 3: 背景を青くしたいです。（失敗）\n\n/.test(loop.asked[7].last), `直近 4 ステップより前にしたことを、1行ずつ添える（${JSON.stringify(loop.asked[7].last.slice(0, 120))}）`);
  check(loop.asked.every((m) => m.n <= 1 + 1 + 2 * 4) && loop.asked[7].n === 10, `モデルには直近 4 ステップだけを渡す（${loop.asked.map((m) => m.n).join(',')}）`);
  check(loop.views[0].think === 'まずは見出しを出そう。関数名を間違えるかも。' && /err/.test(loop.views[0].cls) && /ok/.test(loop.views[1].cls), '思考ログに思考を出し、結果を成功・失敗で色分けする');
  const asst = await p.evaluate(() => window.__asked[2][4].content);
  check(!/<think>|makeTitle は無かった/.test(asst) && /```js\nconst makeTitle/.test(asst), `履歴には思考を入れない（${JSON.stringify(asst.slice(0, 40))}）`);
  // 一時停止中は進まない → 再開 → 止める
  const nPaused = await p.evaluate(() => window.__playground.state.steps.length);
  await p.waitForTimeout(800);
  check(await p.evaluate((n) => window.__playground.state.steps.length === n, nPaused) && await p.textContent('#pause') === '再開', '一時停止中は、次のステップを始めない');
  await p.click('#pause');
  await p.waitForFunction((n) => window.__playground.state.steps.length > n, nPaused, { timeout: 30000 });
  await p.click('#stop');
  await p.waitForTimeout(500);
  const nStop = await p.evaluate(() => window.__playground.state.steps.length);
  await p.waitForTimeout(800);
  check(await p.evaluate((n) => window.__playground.state.phase === 'stopped' && window.__playground.state.steps.length <= n + 1, nStop) && await p.isVisible('#start'), '「止める」で止まり、「続きから始める」が出る');
  await p.click('#copy');
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  check(/## ステップ 1/.test(copied) && /\[思考\]\nまずは見出しを出そう/.test(copied) && /\[結果\]\nエラー: ReferenceError/.test(copied), '「ログをコピー」で思考・コード・結果をコピーできる');
  check(await p.evaluate(() => !document.body.textContent.includes('のっとり') && location.pathname.endsWith('/ai-playground/')), 'このページ自体は、ずっと変わらない');

  // ---------------------------------------------------------------- 本物の Qwen3 4B のトークナイザ（思考モードの切り替え）
  const tmpl = await withTimeout(p.evaluate(async () => {
    const { AutoTokenizer, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2');
    env.allowLocalModels = false;
    const tok = await AutoTokenizer.from_pretrained('onnx-community/Qwen3-4B-ONNX');
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }, { role: 'assistant', content: 'A' }, { role: 'user', content: 'U2' }];
    const on = tok.apply_chat_template(msgs, { add_generation_prompt: true, tokenize: false, enable_thinking: true });
    const off = tok.apply_chat_template(msgs, { add_generation_prompt: true, tokenize: false, enable_thinking: false });
    return { on: on.slice(-60), off: off.slice(-60), think: tok.convert_tokens_to_ids(['<think>', '</think>', '<|im_start|>', '<|im_end|>']) };
  }), 60000, 'Qwen3 のトークナイザ');
  say('Qwen3 のテンプレート', JSON.stringify(tmpl));
  check(/<\|im_start\|>assistant\n$/.test(tmpl.on) && /<\|im_start\|>assistant\n<think>\n\n<\/think>\n\n$/.test(tmpl.off), '本物の Qwen3 4B のチャットテンプレートで、思考モードの切り替え（enable_thinking）が効く');

  // ---------------------------------------------------------------- 小さなテスト用モデル（本物の推論の流れ）
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => { errors.push(e.message); say('pageerror', e.message); });
  await p2.goto(BASE + '?model=test-org/tiny-qwen2&dtype=q4&device=wasm');
  await p2.evaluate(() => { const s = window.__playground.settings; s.wait = 0; s.max_new_tokens = 64; s.thinking = false; });
  await p2.click('#start');
  await p2.waitForFunction(() => window.__playground.state.steps.length >= 2, null, { timeout: 120000 });
  await p2.click('#stop');
  const tiny = await p2.evaluate(() => ({ steps: window.__playground.state.steps.map((s) => s.resultText), badge: document.querySelector('#backend').textContent }));
  check(tiny.steps.length >= 2 && tiny.steps.every((x) => x === 'コードなし') && /WebAssembly/.test(tiny.badge), `小さなテスト用モデルでも、読み込んでステップが回る（重みがランダムなのでコードは書けない: ${tiny.steps.join(', ')}）`);
  await p2.close();

  // スマホ幅でも、横にはみ出さない（左右は上下に並ぶ）
  await p.setViewportSize({ width: 390, height: 844 });
  check(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'スマホ幅で横にはみ出さない');

  check(outside.size === 0, `CDN と Hugging Face 以外へは通信しない（${[...outside].join(', ') || 'なし'}）`);
  // サンドボックスの中でわざと起こしたエラー（タイマーの中の throw など）は除く
  const real = errors.filter((x) => !/あとで失敗|あとの約束|約束の失敗/.test(x));
  check(real.length === 0, `ページのエラーが無い（サンドボックスの中でわざと起こしたもの以外 ${real.length} 件）`);

  await b.close();
  say(failures ? `${failures} 件失敗` : 'すべて成功');
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });

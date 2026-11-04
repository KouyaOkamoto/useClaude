// AI の遊び場の通し確認（ヘッドレス Chromium）。
//
//   sh toys/ai-playground/test/setup.sh       # 初回だけ
//   python3 -m http.server 8000               # リポジトリのルートで
//   node toys/ai-playground/test/e2e.cjs [ページの URL]
//
// 確かめること:
//   - サンドボックス: DOM を変えられる / window の値が次の実行に残る / console の出力・エラー・あとから起きたエラーを返す /
//     このページ（親）・localStorage・ネットワーク・親の移動には触れない / 無限ループを止める / 中のページの移動・document.write のあとも続けられる
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

  let r = await run("document.body.innerHTML = '<h1 id=\"t\">こんにちは</h1><canvas></canvas>'; window.counter = 41; console.log('ok', {a: 1});");
  check(!r.error && r.snapshot.elements === 2 && r.snapshot.tags.h1 === 1 && /こんにちは/.test(r.snapshot.text) && r.logs[0] === '[log] ok {"a":1}', `DOM を変え、console の出力とページの要約を返す（${JSON.stringify(r.snapshot.tags)}）`);
  r = await run('window.counter += 1; console.log(window.counter);');
  check(!r.error && r.logs[0] === '[log] 42', 'window に入れた値は、次の実行に残る');
  r = await run('const a = 1; let b = 2; console.log(a + b);');
  r = await run('const a = 5; console.log(a);');
  check(!r.error && r.logs[0] === '[log] 5', 'const/let は実行ごとに別（もう一度宣言してもエラーにならない）');
  r = await run('undefinedFunction();');
  check(/ReferenceError: undefinedFunction is not defined/.test(r.error), `エラーを返す（${r.error}）`);
  r = await run("setTimeout(() => { throw new Error('あとで失敗'); }, 10); Promise.reject(new Error('約束の失敗'));");
  // Promise.reject(...) は最後の式（eval の値）なので、待って「エラー」として返る。タイマーの中の throw は、あとから起きたエラーとして返る
  check(/約束の失敗/.test(r.error ?? '') && r.asyncErrors.some((x) => /あとで失敗/.test(x)), `あとから起きたエラー（タイマー）も返し、Promise の失敗も返す（${r.error} / ${r.asyncErrors.join(' / ')}）`);
  r = await run("Promise.resolve().then(() => { throw new Error('あとの約束'); }); console.log('つづく');");
  check(!r.error && r.asyncErrors.some((x) => /Promise: あとの約束/.test(x)), `処理されなかった Promise の失敗も、あとから起きたエラーとして返す（${r.asyncErrors.join(' / ')}）`);
  r = await run('function f() { f(); } f();');
  check(/RangeError/.test(r.error), '再帰が深すぎるときもエラーを返す');

  // 隔離: 親・localStorage・ネットワーク・親の移動
  const before = await p.evaluate(() => document.title);
  r = await run("parent.document.body.innerHTML = 'のっとり';");
  check(/SecurityError|Blocked a frame|cross-origin/i.test(r.error) && (await p.evaluate(() => document.title)) === before && !(await p.evaluate(() => document.body.textContent.includes('のっとり'))), `このページ（親）の DOM には触れない（${r.error?.slice(0, 80)}）`);
  r = await run("localStorage.setItem('x', '1');");
  check(/SecurityError|denied|sandbox/i.test(r.error ?? ''), `localStorage は使えない（${r.error?.slice(0, 80)}）`);
  r = await run("fetch('https://example.com/x').then(() => console.log('届いた'), (e) => console.log('止められた', e.name));");
  check(r.logs.some((x) => /止められた/.test(x)) && !outside.has('example.com'), `ネットワークは使えない（${r.logs.join(' / ')}）`);
  r = await run("top.location.href = 'https://example.com/';");
  check(!!r.error && new URL(p.url()).host === new URL(BASE).host, `このページを別のページへ移動させられない（${r.error?.slice(0, 80)}）`);

  // 無限ループ: 波かっこあり・本体が空
  let t = Date.now();
  r = await run('let i = 0; while (true) { i++; }');
  check(/無限ループ/.test(r.error ?? '') && Date.now() - t < 8000, `無限ループ（while (true) { … }）を約 2 秒で止める（${Date.now() - t}ms）`);
  t = Date.now();
  r = await run('for (;;);');
  check(/無限ループ/.test(r.error ?? ''), `本体が空の無限ループ（for (;;);）も止める（${Date.now() - t}ms）`);
  t = Date.now();
  r = await run('let k = 0; while (k >= 0) k++;');
  check(/無限ループ/.test(r.error ?? ''), `波かっこの無い1文の無限ループ（while (k >= 0) k++;）も止める（${Date.now() - t}ms）`);
  r = await run('let s = 0;\nfor (let i = 0; i < 5; i++)\n  for (let j = 0; j < 5; j++) s += i * j;\nconsole.log(s);');
  check(!r.error && r.logs[0] === '[log] 100', `見張りを入れても、入れ子のループの答えは変わらない（${r.logs[0] ?? r.error}）`);
  r = await run('document.body.dataset.alive = "yes"; console.log("生きている");');
  check(!r.error && r.logs[0] === '[log] 生きている', '無限ループを止めたあとも、続けて実行できる');

  // 中のページの移動・document.write
  r = await run("location.href = 'about:blank';");
  await p.waitForTimeout(800);
  check(await p.evaluate(() => window.__playground.state.navigated), '中のページが移動しようとしたら、気づいて初期化する');
  r = await run("console.log('初期化のあと');");
  check(r.logs[0] === '[log] 初期化のあと', '移動のあとも、初期化したページで続けられる');
  r = await run("document.open(); document.write('<p>書き換え</p>'); document.close();");
  r = await run("console.log('書き換えのあと');");
  say('document.write のあと', JSON.stringify(r).slice(0, 160));
  check(r.timedOut === true || r.logs[0] === '[log] 書き換えのあと', 'document.write のあとは、そのまま続くか、応答なしで初期化する（どちらでも止まらない）');
  r = await run("console.log('その次');");
  check(r.logs[0] === '[log] その次', 'その次の実行はできる');
  await p.evaluate(() => window.__playground.state.navigated = false);

  // ---------------------------------------------------------------- 繰り返し（偽のモデル）
  await p.evaluate(() => {
    const answers = [
      // 1: 思考 → エラーになるコード
      '<think>まずは見出しを出そう。関数名を間違えるかも。</think>\n見出しを出してみます。\n```js\ndocument.body.append(makeTitle("遊び場"));\n```',
      // 2: 前のエラーを直す
      '<think>makeTitle は無かった。自分で作る。</think>\n関数を作って直します。\n```js\nwindow.makeTitle = (t) => Object.assign(document.createElement("h1"), { textContent: t });\ndocument.body.append(makeTitle("遊び場"));\n```',
      // 3: コードを書き忘れる
      '<think>次は色を変えたい。</think>\n背景を青くしたいです。',
      // 4: 動くコード（アニメーション）
      '<think>色を変えて、点を動かす。</think>\n背景を変えて、点を動かします。\n```javascript\ndocument.body.style.background = "#123";\nconst d = document.createElement("div"); d.id = "dot"; document.body.append(d);\nconsole.log("dot", document.querySelectorAll("#dot").length);\n```',
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
    asked: window.__asked.map((m) => ({ n: m.length, last: m.at(-1).content })),
    views: [...document.querySelectorAll('.step')].map((v) => ({ think: v.querySelector('.think-text').textContent, cls: v.querySelector('.result').className, state: v.querySelector('.step-state').textContent })),
    dot: null,
  }));
  say('ステップ', JSON.stringify(loop.steps.slice(0, 8)));
  check(/ReferenceError: makeTitle is not defined/.test(loop.steps[0].result) && loop.steps[1].result === '成功', '1 回目のエラーのあと、2 回目で直す（偽のモデル）');
  check(/エラーが出ました:\n- ReferenceError: makeTitle is not defined\n原因を考えて、直してください。/.test(loop.asked[1].last) && /今のページ:/.test(loop.asked[1].last), 'エラーと今のページのようすを、次のステップでモデルに返す');
  check(loop.steps[2].code === false && /コードが見つかりませんでした/.test(loop.asked[3].last), 'コードが無いときは、そう知らせて書き直させる');
  check(/console の出力:\n\[log\] dot 1/.test(loop.asked[4].last) && /div 1/.test(loop.asked[4].last), 'console の出力とページの要素（div など）を返す');
  check(/失敗が続いています/.test(loop.asked[7].last) && loop.steps[7].result === '成功', '失敗が続いたら、別のやり方を促す');
  check(loop.asked.every((m) => m.n <= 1 + 1 + 2 * 4) && loop.asked[7].n === 10, `モデルには直近 4 ステップだけを渡す（${loop.asked.map((m) => m.n).join(',')}）`);
  check(loop.views[0].think === 'まずは見出しを出そう。関数名を間違えるかも。' && /err/.test(loop.views[0].cls) && /ok/.test(loop.views[1].cls), '思考ログに思考を出し、結果を成功・失敗で色分けする');
  const asst = await p.evaluate(() => window.__asked[2][4].content);
  check(!/<think>|makeTitle は無かった/.test(asst) && /```js\nwindow.makeTitle/.test(asst), `履歴には思考を入れない（${JSON.stringify(asst.slice(0, 40))}）`);
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

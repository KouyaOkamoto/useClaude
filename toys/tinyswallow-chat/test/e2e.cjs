// TinySwallow チャットの通し確認（ヘッドレス Chromium）。
//
//   sh toys/tinyswallow-chat/test/setup.sh       # 初回だけ（test/.cache/ に Transformers.js・ONNX Runtime Web・小さなモデル）
//   python3 -m http.server 8000                  # リポジトリのルートで
//   node toys/tinyswallow-chat/test/e2e.cjs [ページの URL]
//
// 本物のモデル（約 1GB）は使わない。CDN（jsDelivr）と Hugging Face への通信を、Playwright で横取りして、
//   - Transformers.js・ONNX Runtime Web → npm から取った同じ版のファイル
//   - モデル（https://huggingface.co/test-org/tiny-qwen2/resolve/main/...）→ test/make-tiny-model.py で作った小さなモデル（重みはランダム）
// を返す。読み込み・進み具合・ストリーミング・停止・会話の続き・文脈の切り詰め・フォールバック・エラー・保存（キャッシュ）を確かめる。
// 本物のモデルの返答の質・速さは、ここでは確かめられない（README の「確認のしかた」）。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8000/toys/tinyswallow-chat/';
const CACHE = path.join(__dirname, '.cache');
const TJS_DIST = path.join(CACHE, 'transformers/package/dist');
const ORT_DIST = path.join(CACHE, 'ort/package/dist');
const MODEL_DIR = path.join(CACHE, 'tiny-model');
const MODEL = 'test-org/tiny-qwen2';
const Q = `?model=${MODEL}&dtype=q4`;

const t0 = Date.now();
const say = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; say(ok ? 'PASS' : 'FAIL', label); };

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream' };
const serve = (route, file) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
  return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' } });
};

async function main() {
  for (const d of [TJS_DIST, ORT_DIST, MODEL_DIR]) if (!fs.existsSync(d)) throw new Error(`${d} がありません。先に test/setup.sh を実行してください`);
  const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const requests = { model: 0, other: new Set() };
  // CDN と Hugging Face の代わり
  await ctx.route('https://cdn.jsdelivr.net/**', (route) => {
    const u = new URL(route.request().url());
    let m = /^\/npm\/@huggingface\/transformers@4\.3\.2(\/.*)?$/.exec(u.pathname);
    if (m) return serve(route, path.join(TJS_DIST, m[1] ? path.basename(m[1]) : 'transformers.min.js'));
    m = /^\/npm\/onnxruntime-web@[^/]+\/dist\/([\w.-]+)$/.exec(u.pathname);
    if (m) return serve(route, path.join(ORT_DIST, m[1]));
    return route.fulfill({ status: 404, body: '' });
  });
  await ctx.route('https://huggingface.co/**', (route) => {
    const u = new URL(route.request().url());
    const m = /^\/([\w.-]+\/[\w.-]+)\/resolve\/main\/(.+)$/.exec(u.pathname);
    if (m && m[1] === MODEL) { requests.model++; return serve(route, path.join(MODEL_DIR, m[2])); }
    return route.fulfill({ status: 404, body: 'Entry not found', headers: { 'access-control-allow-origin': '*' } });
  });
  ctx.on('request', (r) => {
    const u = new URL(r.url());
    if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host && !['cdn.jsdelivr.net', 'huggingface.co'].includes(u.host)) requests.other.add(u.host);
  });
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => { errors.push(e.message); say('pageerror', e.message); });
    p.on('console', (m) => { if (m.type() === 'error') say('console.error', m.text().slice(0, 200)); });
  };

  // ---------------------------------------------------------------- 実行環境の判定と読み込み
  const p = await ctx.newPage();
  watch(p);
  await p.goto(BASE + Q + '&device=wasm');
  await p.waitForFunction(() => !document.querySelector('#load').disabled && document.querySelector('#env-cache').textContent !== '…', null, { timeout: 60000 });
  const probe = await p.evaluate(() => ({ backend: document.querySelector('#backend').textContent, device: document.querySelector('#env-device').textContent, cache: document.querySelector('#env-cache').textContent, model: document.querySelector('#model-id').textContent }));
  say('実行環境の表示', JSON.stringify(probe));
  check(/WebAssembly/.test(probe.backend) && /q4/.test(probe.backend) && probe.model === MODEL, '?device=wasm&dtype=q4 で、WebAssembly・q4 を選ぶ（モデル名は ?model= のもの）');
  check(/初回/.test(probe.cache), '初回はダウンロードが必要と表示する');
  check(await p.isDisabled('#input') && await p.isDisabled('#send'), '読み込むまでは入力できない');

  await p.click('#load');
  await p.waitForFunction(() => !document.querySelector('#input').disabled, null, { timeout: 120000 });
  await p.waitForFunction(() => /保存済み/.test(document.querySelector('#env-cache').textContent), null, { timeout: 5000 }).catch(() => {});
  const ready = await p.evaluate(() => ({ status: document.querySelector('#setup-status').textContent, progressHidden: document.querySelector('#progress-box').hidden, cache: document.querySelector('#env-cache').textContent }));
  say('読み込み', JSON.stringify(ready));
  check(/準備ができました/.test(ready.status) && ready.progressHidden && requests.model >= 4, `モデルを読み込み、チャットできる状態になる（モデルのファイルの要求 ${requests.model} 件）`);
  check(/保存済み/.test(ready.cache), '読み込んだモデルはブラウザに保存される（Cache API）');

  // 診断情報: 端末・WebGPU・段階・準備完了が記録され、コピーできる
  {
    const log = await p.textContent('#diag-log');
    check(/端末: /.test(log) && /WebGPU: (あり|なし)/.test(log) && /段階: モデルを読み込んでいます/.test(log) && /ウォームアップ: KV キャッシュから続けて/.test(log) && /準備完了: wasm・q4/.test(log),
      '診断情報に、端末・WebGPU・読み込みの段階・ウォームアップ・準備完了が記録される');
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    await p.click('#diag-box summary');
    await p.click('#diag-copy');
    const copied = await p.evaluate(() => navigator.clipboard.readText());
    check(/端末: / .test(copied) && /準備完了/.test(copied) && (await p.textContent('#diag-copied')) === 'コピーしました', '「診断情報をコピー」でクリップボードにコピーできる');
  }

  // ---------------------------------------------------------------- 送信とストリーミング
  // temperature 0（毎回同じ）・最大 128 トークン
  await p.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); };
    set('temp', 0); set('max', 128);
  });
  await p.fill('#input', '日本の四季の魅力を教えて');
  // 日本語入力の変換中の Enter では送らない
  await p.evaluate(() => document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  await p.waitForTimeout(300);
  check(await p.$$eval('.msg.user', (l) => l.length) === 0, '日本語入力の変換を確定する Enter（isComposing）では送らない');
  // テキストの長さを、生成中に何度も記録する（少しずつ増えていけばストリーミング）
  await p.evaluate(() => {
    window.__lens = [];
    new MutationObserver(() => { const b = document.querySelector('.msg.assistant.streaming .text'); if (b) window.__lens.push(b.textContent.length); })
      .observe(document.querySelector('#messages'), { subtree: true, childList: true, characterData: true });
  });
  await p.press('#input', 'Enter');
  check(await p.isVisible('#stop') && await p.isHidden('#send'), '生成中は「停止」ボタンになる');
  await p.waitForFunction(() => !document.querySelector('.msg.assistant.streaming') && !document.querySelector('#input').disabled, null, { timeout: 120000 });
  const turn1 = await p.evaluate(() => ({
    user: [...document.querySelectorAll('.msg.user')].map((x) => x.textContent),
    text: document.querySelector('.msg.assistant .text').textContent,
    meta: document.querySelector('.msg.assistant .meta').textContent,
    lens: [...new Set(window.__lens)].length,
    stats: document.querySelector('#stats').textContent,
  }));
  say('1回目', JSON.stringify({ ...turn1, text: turn1.text.slice(0, 40) }));
  check(turn1.user.length === 1 && turn1.user[0] === '日本の四季の魅力を教えて', '入力した文がユーザーの吹き出しに出る');
  check(turn1.text.length > 0 && turn1.lens >= 5, `返答が少しずつ表示される（ストリーミング。途中の長さ ${turn1.lens} 種類）`);
  check(/128 トークン/.test(turn1.meta) && /トークン\/秒/.test(turn1.meta), `返答のあとにトークン数と速さを出す（${turn1.meta}）`);
  const prompt1 = Number(/入力 (\d+)/.exec(turn1.stats)?.[1]);

  // 同じ入力・temperature 0 なら同じ返答（設定が効いている）
  // 会話の続き: 2回目の入力は、1回目のやりとりを含む（入力のトークン数が増える）
  await p.fill('#input', '<img src=x onerror="window.__pwned=1">もう少し詳しく');
  await p.press('#input', 'Enter');
  await p.waitForFunction(() => document.querySelectorAll('.msg.assistant').length === 2 && !document.querySelector('.msg.assistant.streaming'), null, { timeout: 120000 });
  const turn2 = await p.evaluate(() => ({ stats: document.querySelector('#stats').textContent, img: !!document.querySelector('#messages img'), pwned: !!window.__pwned, userText: document.querySelectorAll('.msg.user')[1].textContent }));
  const prompt2 = Number(/入力 (\d+)/.exec(turn2.stats)?.[1]);
  check(prompt2 > prompt1 + 128, `2回目は前のやりとりも入力に含める（入力 ${prompt1} → ${prompt2} トークン）`);
  check(!turn2.img && !turn2.pwned && turn2.userText.startsWith('<img'), '入力の HTML は文字として表示する（要素にならない）');

  // ---------------------------------------------------------------- 停止
  await p.evaluate(() => { const e = document.getElementById('max'); e.value = '2048'; e.dispatchEvent(new Event('input')); });
  await p.fill('#input', '長く話して');
  await p.press('#input', 'Enter');
  await p.waitForFunction(() => (document.querySelector('.msg.assistant.streaming .text')?.textContent.length ?? 0) > 20, null, { timeout: 60000 });
  const tStop = Date.now();
  await p.click('#stop');
  await p.waitForFunction(() => !document.querySelector('.msg.assistant.streaming'), null, { timeout: 30000 });
  const stopped = await p.evaluate(() => [...document.querySelectorAll('.msg.assistant .meta')].at(-1).textContent);
  check(/途中で停止/.test(stopped) && !/2048 トークン/.test(stopped) && Date.now() - tStop < 10000, `「停止」で生成が止まる（${stopped}、${Date.now() - tStop}ms）`);
  check(!(await p.isDisabled('#input')) && await p.isVisible('#send'), '止めたあとは、また入力できる');

  // ---------------------------------------------------------------- 文脈の切り詰め（最大 2048 トークンのとき、入力の上限は 2048）
  await p.fill('#input', '春夏秋冬の話。'.repeat(700));
  await p.press('#input', 'Enter');
  await p.waitForFunction(() => !document.querySelector('.msg.assistant.streaming') && document.querySelectorAll('.msg.assistant').length === 4, null, { timeout: 120000 }).catch(() => {});
  // 長い返答は待たずに止める
  if (await p.isVisible('#stop')) { await p.click('#stop'); await p.waitForFunction(() => !document.querySelector('.msg.assistant.streaming'), null, { timeout: 30000 }); }
  const notice = await p.$$eval('.msg.notice', (l) => l.map((x) => x.textContent));
  check(notice.some((t) => /古いやりとり \d+ 件を除いて/.test(t)), `文脈が長くなったら、古いやりとりを除いて答え、そう表示する（${notice.join(' / ')}）`);

  // ---------------------------------------------------------------- 会話のリセット・設定の保存
  await p.click('summary');
  await p.click('#reset');
  check(await p.$$eval('.msg', (l) => l.length) === 0 && await p.isVisible('#empty'), '「会話をリセット」で会話が消える');
  await p.fill('#system', 'テスト用のシステムプロンプト');
  await p.reload();
  await p.waitForFunction(() => !document.querySelector('#load').disabled && document.querySelector('#env-cache').textContent !== '…', null, { timeout: 60000 });
  check(await p.inputValue('#system') === 'テスト用のシステムプロンプト' && await p.inputValue('#temp') === '0', '設定（システムプロンプト・temperature）は再読み込みしても残る');
  const cached = await p.textContent('#env-cache');
  check(/保存済み/.test(cached) && await p.isVisible('#clear-cache'), `再読み込み後は「保存済み」と出る（${cached}）`);
  const before = requests.model;
  await p.click('#load');
  await p.waitForFunction(() => !document.querySelector('#input').disabled, null, { timeout: 120000 });
  check(requests.model === before, `2回目の読み込みはダウンロードしない（保存済みのファイルを使う。要求 ${requests.model - before} 件）`);
  await p.reload();
  await p.waitForFunction(() => !document.querySelector('#load').disabled && document.querySelector('#env-cache').textContent !== '…', null, { timeout: 60000 });
  p.once('dialog', (d) => d.accept());
  await p.click('#clear-cache');
  await p.waitForFunction(() => /初回/.test(document.querySelector('#env-cache').textContent), null, { timeout: 10000 }).catch(() => {});
  check(/初回/.test(await p.textContent('#env-cache')), '「保存したモデルを削除」で保存を消せる');
  await p.evaluate(() => localStorage.clear());
  await p.close();

  // ---------------------------------------------------------------- WebGPU が使えないときのフォールバック
  const p2 = await ctx.newPage();
  watch(p2);
  await p2.goto(BASE + `?model=${MODEL}`);
  await p2.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
  const auto = await p2.textContent('#backend');
  const hasGpu = await p2.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
  say('自動の選択', auto, 'WebGPU のアダプタ:', hasGpu);
  check(hasGpu ? /WebGPU/.test(auto) : /WebAssembly/.test(auto) && /q4/.test(auto), `WebGPU のアダプタが${hasGpu ? 'ある' : '無い'}ので、${hasGpu ? 'WebGPU' : 'WebAssembly（q4）'}を選ぶ（${auto}）`);
  await p2.close();
  // WebGPU を指定したのに使えないとき（または読み込みに失敗したとき）、wasm で読み直す
  const p3 = await ctx.newPage();
  watch(p3);
  await p3.goto(BASE + `?model=${MODEL}&device=webgpu&dtype=q4`);
  await p3.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
  await p3.click('#load');
  await p3.waitForFunction(() => !document.querySelector('#input').disabled || /読み込めませんでした/.test(document.querySelector('#setup-status').textContent), null, { timeout: 120000 });
  const fb = await p3.evaluate(() => ({ backend: document.querySelector('#backend').textContent, input: !document.querySelector('#input').disabled, status: document.querySelector('#setup-status').textContent }));
  say('フォールバック', JSON.stringify(fb));
  if (!hasGpu) check(/WebAssembly/.test(fb.backend) && fb.input, `WebGPU で読み込めないときは、WebAssembly で読み直して使える（${fb.backend}）`);
  else say('（この環境では WebGPU が使えるので、フォールバックの確認は省略）', JSON.stringify(fb));
  await p3.close();

  // 量子化の版で読み込めないとき（ここでは q4f16 のファイルが無い）、同じ実行環境の q4 で読み直す
  {
    const pq = await ctx.newPage();
    watch(pq);
    await pq.goto(BASE + `?model=${MODEL}&device=wasm&dtype=q4f16`);
    await pq.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
    await pq.click('#load');
    await pq.waitForFunction(() => !document.querySelector('#input').disabled || /読み込めませんでした/.test(document.querySelector('#setup-status').textContent), null, { timeout: 120000 });
    const r = await pq.evaluate(() => ({ backend: document.querySelector('#backend').textContent, input: !document.querySelector('#input').disabled, status: document.querySelector('#setup-status').textContent }));
    check(r.input && /q4$/.test(r.backend) && /q4f16 では動かなかったので、wasm・q4 で動いています/.test(r.status), `q4f16 で読み込めないときは、q4 で読み直して使える（${r.status}）`);
    await pq.close();
  }

  // ---------------------------------------------------------------- 読み込めないモデル
  const p4 = await ctx.newPage();
  watch(p4);
  await p4.goto(BASE + '?model=test-org/missing&device=wasm');
  await p4.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
  await p4.click('#load');
  await p4.waitForFunction(() => /読み込めませんでした/.test(document.querySelector('#setup-status').textContent), null, { timeout: 60000 }).catch(() => {});
  check(/読み込めませんでした/.test(await p4.textContent('#setup-status')) && !(await p4.isDisabled('#load')), 'モデルが見つからないときは、理由を出して、もう一度試せる');
  check((await p4.goto(BASE + '?model=../../evil').then(() => p4.textContent('#model-id'))) === 'onnx-community/TinySwallow-1.5B-Instruct-ONNX', '?model= の形が違えば、既定のモデルを使う');
  await p4.close();

  // 前回、読み込みの途中でページが終わっていたら（メモリ不足で落ちた・再読み込みされた）、次に開いたときに知らせる
  {
    const pc = await ctx.newPage();
    watch(pc);
    await pc.goto(BASE + Q + '&device=wasm');
    await pc.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
    // 読み込みを始めた直後に、ブラウザに残る記録を取っておく（ここでページが落ちたのと同じ記録）
    const saved = await pc.evaluate(() => { document.querySelector('#load').click(); return localStorage.getItem('tinyswallow-chat-diag'); });
    check(JSON.parse(saved).phase === 'loading', '読み込みを始めると、その段階をブラウザに記録する');
    await pc.waitForFunction(() => !document.querySelector('#input').disabled, null, { timeout: 120000 });
    await pc.evaluate((x) => localStorage.setItem('tinyswallow-chat-diag', x), saved);
    await pc.reload();
    await pc.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
    const r = await pc.evaluate(() => ({ warn: document.querySelector('#mem-warn').textContent, hidden: document.querySelector('#mem-warn').hidden, open: document.querySelector('#diag-box').open, log: document.querySelector('#diag-log').textContent }));
    check(!r.hidden && /の途中で終わっていました/.test(r.warn) && r.open && /前回の記録/.test(r.log), `前回、読み込みの途中で終わっていたら知らせ、前回の記録を出す（${r.warn.slice(0, 60)}…）`);
    // 最後まで読み込めば、次に開いたときは知らせない
    await pc.click('#load');
    await pc.waitForFunction(() => !document.querySelector('#input').disabled, null, { timeout: 120000 });
    await pc.reload();
    await pc.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
    check(await pc.evaluate(() => document.querySelector('#mem-warn').hidden), '最後まで読み込めたあとは、前回の失敗を知らせない');
    await pc.close();
  }
  // ---------------------------------------------------------------- モデルの選択（PC は TinySwallow、スマホは Qwen2.5 0.5B）
  {
    const pm = await ctx.newPage();
    watch(pm);
    await pm.goto(BASE);
    await pm.evaluate(() => localStorage.clear());
    await pm.reload();
    await pm.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
    const def = await pm.evaluate(() => ({ sel: document.querySelector('#model-select').value, n: document.querySelectorAll('#model-select option').length, size: document.querySelector('#env-size').textContent }));
    check(def.sel === 'onnx-community/TinySwallow-1.5B-Instruct-ONNX' && def.n === 4 && /GB/.test(def.size), `PC の既定は TinySwallow 1.5B（選べるモデル ${def.n} 個・大きさ ${def.size}）`);
    // 選び直すと、覚えてページを読み直す
    await Promise.all([pm.waitForNavigation(), pm.selectOption('#model-select', 'onnx-community/Qwen2.5-0.5B-Instruct')]);
    await pm.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
    check(await pm.textContent('#model-id') === 'onnx-community/Qwen2.5-0.5B-Instruct' && /約 (461|750) MB/.test(await pm.textContent('#env-size')), 'モデルを選び直すと、ページを読み直して、そのモデルになる（次に開いても覚えている）');
    // 前回、そのモデルの読み込みの途中でページが終わっていたら、ひとつ小さいモデルにする
    await pm.evaluate(() => localStorage.setItem('tinyswallow-chat-diag', JSON.stringify({ at: new Date().toISOString(), phase: 'loading', stage: 'モデルを読み込んでいます', model: 'onnx-community/Qwen2.5-0.5B-Instruct', lines: ['x'] })));
    await pm.reload();
    await pm.waitForFunction(() => document.querySelector('#model-id').textContent === 'onnx-community/LFM2-350M-ONNX', null, { timeout: 30000 }).catch(() => {});
    const down = await pm.evaluate(() => ({ id: document.querySelector('#model-id').textContent, warn: document.querySelector('#mem-warn').textContent }));
    check(down.id === 'onnx-community/LFM2-350M-ONNX' && /ひとつ小さい LFM2 350M/.test(down.warn), `前回の途中終了のあとは、ひとつ小さいモデルを選ぶ（${down.id}）`);
    // LFM2 は WebGPU でしか動かない。WebGPU が無ければ読み込まず、別のモデルを選ぶよう知らせる
    await pm.waitForFunction(() => /WebGPU でしか動きません/.test(document.querySelector('#mem-warn').textContent), null, { timeout: 30000 }).catch(() => {});
    const lfm = await pm.evaluate(() => ({ warn: document.querySelector('#mem-warn').textContent, load: document.querySelector('#load').disabled }));
    check(/WebGPU でしか動きません/.test(lfm.warn) && lfm.load, 'WebGPU が無いときに LFM2 350M を選ぶと、読み込まずに別のモデルを選ぶよう知らせる');
    await pm.evaluate(() => localStorage.clear());
    await pm.close();
  }

  // ---------------------------------------------------------------- スマホ幅
  const p5 = await ctx.newPage();
  // スマホのブラウザとして開く（User-Agent）
  await p5.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' }));
  await p5.setViewportSize({ width: 390, height: 844 });
  await p5.goto(BASE + Q + '&device=wasm');
  await p5.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
  const overflow = await p5.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `スマホ幅（390px）で横にはみ出さない（${overflow}px）`);
  const warn = await p5.evaluate(() => ({ hidden: document.querySelector('#mem-warn').hidden, text: document.querySelector('#mem-warn').textContent, log: document.querySelector('#diag-log').textContent }));
  check(!warn.hidden && /メモリが足りないと/.test(warn.text) && /スマホ\/タブレット: はい/.test(warn.log), 'スマホでは、読み込む前にメモリの注意を出す');
  await p5.goto(BASE);
  await p5.waitForFunction(() => !document.querySelector('#load').disabled, null, { timeout: 60000 });
  check(await p5.inputValue('#model-select') === 'onnx-community/Qwen2.5-0.5B-Instruct', 'スマホの既定は Qwen2.5 0.5B');
  await p5.close();

  check(requests.other.size === 0, `CDN と Hugging Face 以外へは通信しない（${[...requests.other].join(', ') || 'なし'}）`);
  check(errors.length === 0, `ページのエラーが無い（${errors.length} 件）`);
  await b.close();
  say(failures ? `${failures} 件失敗` : 'すべて成功');
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });

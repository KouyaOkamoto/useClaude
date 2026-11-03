// ディスカッションの通し確認（ヘッドレス Chromium）。e2e.cjs と同じく、CDN と Hugging Face を横取りして、小さなテスト用モデルを返す。
//
//   sh toys/tinyswallow-chat/test/setup.sh       # 初回だけ
//   python3 -m http.server 8000                  # リポジトリのルートで
//   node toys/tinyswallow-chat/test/discussion-e2e.cjs [ページの URL]
//
// 確かめること: 議題が無いと始めない / 交互に話す / 回数で終わる / 同じモデルは1つだけ読み込む・別のモデルは2つ読み込む /
// モデルに渡す会話（自分は assistant・相手は user・議題は system）/ 一時停止（発言の区切りで止まる）と再開 / いますぐ止める /
// 終了 / 最初から / コピー / 設定の保存 / HTML を文字として表示 / ページのエラーが無い
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:8000/toys/tinyswallow-chat/').replace(/\/?$/, '/');
const PAGE = BASE + 'discussion.html';
const CACHE = path.join(__dirname, '.cache');
const TJS_DIST = path.join(CACHE, 'transformers/package/dist');
const ORT_DIST = path.join(CACHE, 'ort/package/dist');
const MODEL_DIR = path.join(CACHE, 'tiny-model');
// 2つの別のモデルの代わり（中身は同じ小さなモデル）
const MA = 'test-org/tiny-qwen2', MB = 'test-org/tiny-qwen2-b';

const t0 = Date.now();
const say = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; say(ok ? 'PASS' : 'FAIL', label); };
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const serve = (route, file) => {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found', headers: { 'access-control-allow-origin': '*' } });
  return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' } });
};

async function main() {
  for (const d of [TJS_DIST, ORT_DIST, MODEL_DIR]) if (!fs.existsSync(d)) throw new Error(`${d} がありません。先に test/setup.sh を実行してください`);
  const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 } });
  const modelReq = new Map(); // リポジトリ → onnx の要求の数
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
    if (m && (m[1] === MA || m[1] === MB)) {
      if (m[2].startsWith('onnx/')) modelReq.set(m[1], (modelReq.get(m[1]) ?? 0) + 1);
      return serve(route, path.join(MODEL_DIR, m[2]));
    }
    return route.fulfill({ status: 404, body: 'Entry not found', headers: { 'access-control-allow-origin': '*' } });
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { errors.push(e.message); say('pageerror', e.message); });
  p.on('console', (m) => { if (m.type() === 'error') say('console.error', m.text().slice(0, 200)); });

  const set = (id, v) => p.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input')); }, [id, v]);
  const phase = () => p.evaluate(() => window.__discussion.state.phase);
  const turns = () => p.evaluate(() => window.__discussion.state.turns.map((t) => t.speaker));
  const waitPhase = (ph, timeout = 120000) => p.waitForFunction((ph) => window.__discussion.state.phase === ph, ph, { timeout });

  await p.goto(PAGE + `?a=${MA}&b=${MA}&device=wasm&dtype=q4`);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  check(await p.getAttribute('a.nav-link', 'href') === './', 'ディスカッションからチャットへのリンクがある');
  check(/同じモデルなので、1つだけ読み込んで共有/.test(await p.textContent('#mem-note')), 'A と B が同じモデルなら、1つだけ読み込むと表示する');

  // 議題が無いと始めない
  await p.click('#start');
  check(/議題を書いてください/.test(await p.textContent('#status')) && (await phase()) === 'setup', '議題が無いと始めない');

  // 交互に話し、回数で終わる（同じモデルは1つだけ読み込む）
  await set('temp', 0); await set('max', 128); await set('turns', 4);
  await p.fill('#a-name', '<b>アオイ</b>');
  await p.fill('#b-name', 'ソラ');
  await p.fill('#topic', '朝型と夜型、どちらがよいか');
  await p.fill('#a-stance', '朝型に賛成');
  await p.click('#start');
  await waitPhase('finished');
  const r1 = await p.evaluate(() => ({
    speakers: window.__discussion.state.turns.map((t) => t.speaker),
    who: [...document.querySelectorAll('.msg.turn .who')].map((x) => x.textContent),
    cls: [...document.querySelectorAll('.msg.turn')].map((x) => x.classList.contains('a') ? 'a' : 'b'),
    texts: window.__discussion.state.turns.map((t) => t.text.length),
    status: document.querySelector('#status').textContent,
    runners: window.__discussion.state.runners.size,
    bold: !!document.querySelector('#transcript b'),
  }));
  say('1回目', JSON.stringify(r1));
  check(JSON.stringify(r1.speakers) === '[0,1,0,1]' && JSON.stringify(r1.cls) === '["a","b","a","b"]', 'A と B が交互に話す（4 回）');
  check(r1.texts.every((n) => n > 0) && /議論が終わりました（4 回）/.test(r1.status), '決めた回数で終わる');
  check(r1.who[0] === '<b>アオイ</b>' && !r1.bold, '名前の HTML は文字として表示する');
  check(r1.runners === 1 && modelReq.get(MA) >= 1 && !modelReq.has(MB), `同じモデルは1つだけ読み込む（読み込んだモデル ${r1.runners} 個）`);

  // モデルに渡す会話: 議題・立場は system、自分の発言は assistant、相手の発言は user（交互）
  const m = await p.evaluate(() => [window.__discussion.messagesFor(0), window.__discussion.messagesFor(1)]);
  const roles = (x) => x.map((y) => y.role).join(',');
  check(roles(m[0]) === 'system,user,assistant,user,assistant,user' && roles(m[1]) === 'system,user,assistant,user,assistant'
    && /議題: 朝型と夜型/.test(m[0][0].content) && /朝型に賛成/.test(m[0][0].content) && !/朝型に賛成/.test(m[1][0].content),
    `モデルに渡す会話の形（A: ${roles(m[0])} / B: ${roles(m[1])}）`);

  // 討論の台本として渡す: 最初は司会の言葉、相手の発言には名前を付ける。立場が空なら、相手と反対の立場を自動で割り当てる
  check(/^司会: これから「朝型と夜型、どちらがよいか」について討論を始めます。<b>アオイ<\/b>さん、最初の意見をどうぞ。$/.test(m[0][1].content)
    && m[1][1].content.startsWith('<b>アオイ</b>: ') && m[0][3].content.startsWith('ソラ: ')
    && /安易に同意したりほめたりしない/.test(m[0][0].content),
    '最初は司会の言葉、相手の発言には名前を付け、空の立場は相手と反対にする');
  if (failures) say('  渡した会話', JSON.stringify(m.map((x) => x.slice(0, 3).map((y) => y.content.slice(0, 120)))));
  // 発言のあと始末: 次の発言まで書いていたら切る・名前や「（以上）」を外す
  const cleaned = await p.evaluate(() => {
    const c = window.__discussion.cleanTurn;
    return [
      c('<b>アオイ</b>: 朝型がよいです。\n理由は二つあります。\nuser\nありがとうございました！', 0),
      c('夜型にも利点があります。\n（以上）\nご参考までに。', 1),
      c('【ソラ】集中できます。\n<b>アオイ</b>：それは違います。', 1),
      c('司会進行の役ではなく、意見です。\n司会: 次の方どうぞ。', 0),
    ];
  });
  check(JSON.stringify(cleaned) === JSON.stringify(['朝型がよいです。\n理由は二つあります。', '夜型にも利点があります。\nご参考までに。', '集中できます。', '司会進行の役ではなく、意見です。']),
    `発言のあと始末（次の発言・名前・（以上）を外す）: ${JSON.stringify(cleaned)}`);

  // 議題から、対立する2つの考えを取り出す（立場の自動割り当て）
  const splits = await p.evaluate(() => ['ご飯は三食がいいか二食がいいか', '朝型と夜型、どちらがよいか', '猫派 vs 犬派', '朝ごはんを食べるべきか食べないべきか', 'AIは人類を幸せにするか'].map(window.__discussion.splitTopic));
  check(JSON.stringify(splits) === JSON.stringify([['三食', '二食'], ['朝型', '夜型'], ['猫派', '犬派'], ['朝ごはんを食べる', '食べない'], null]), `議題から2つの考えを取り出す: ${JSON.stringify(splits)}`);
  check(/「朝型」を支持する/.test(m[0][0].content) === false && /朝型に賛成/.test(m[0][0].content) && /「夜型」を支持する/.test(m[1][0].content)
    && /立場: <b>アオイ<\/b>「朝型に賛成」・ソラ「夜型（自動）」/.test(await p.textContent('#topic-view')),
    '書いた立場はそのまま使い、空の立場は議題から取り出した考えを割り当て、画面に出す');

  // コピー
  await p.click('#copy');
  const copied = await p.evaluate(() => navigator.clipboard.readText());
  check(/^議題: 朝型と夜型/.test(copied) && /【<b>アオイ<\/b>】/.test(copied) && /【ソラ】/.test(copied), '「会話をコピー」で議題と発言をコピーできる');

  // 一時停止（発言の区切りで止まる）→ 再開 → いますぐ止める → 終了
  await set('max', 2048); await set('turns', 10);
  await p.click('#start');
  await p.waitForFunction(() => window.__discussion.state.phase === 'running' && (document.querySelector('.msg.turn.streaming .text')?.textContent.length ?? 0) > 5, null, { timeout: 60000 });
  await p.click('#pause');
  check(await p.isVisible('#stop-now') && /いまの発言が終わったところで/.test(await p.textContent('#status')), '一時停止を押すと、発言の区切りで止まると知らせ、「いますぐ止める」が出る');
  await waitPhase('paused');
  const n1 = (await turns()).length;
  await p.waitForTimeout(1500);
  check(n1 === 1 && (await turns()).length === n1 && await p.textContent('#pause') === '再開', `一時停止すると、次の発言を始めない（${n1} 回で停止）`);
  await p.click('#pause'); // 再開
  await p.waitForFunction(() => document.querySelector('.msg.turn.streaming .text')?.textContent.length > 5, null, { timeout: 60000 });
  check((await phase()) === 'running' && (await turns()).length === 1, '再開すると、次の人（B）の発言から続ける');
  await p.click('#pause');
  const tStop = Date.now();
  await p.click('#stop-now');
  await waitPhase('paused', 30000);
  const lastMeta = await p.evaluate(() => [...document.querySelectorAll('.msg.turn .meta')].at(-1).textContent);
  check(/途中で停止/.test(lastMeta) && Date.now() - tStop < 10000 && JSON.stringify(await turns()) === '[0,1]', `「いますぐ止める」で、いまの発言を途中で止めて一時停止する（${lastMeta}、${Date.now() - tStop}ms）`);
  await p.click('#finish');
  await p.waitForTimeout(500);
  check((await phase()) === 'finished' && (await turns()).length === 2 && await p.isVisible('#restart'), '「終了」で議論を終える');

  // 最初から
  await p.click('#restart');
  check((await phase()) === 'setup' && await p.isVisible('#empty') && !(await p.isDisabled('#topic')), '「最初から」で、議論を消して、設定を変えられる状態に戻る');

  // 設定は保存される
  await p.reload();
  check(await p.inputValue('#topic') === '朝型と夜型、どちらがよいか' && await p.inputValue('#b-name') === 'ソラ' && await p.inputValue('#turns') === '10', '名前・議題・回数は、再読み込みしても残る');

  // 別のモデルどうし: 2つとも読み込む
  await p.goto(PAGE + `?a=${MA}&b=${MB}&device=wasm&dtype=q4`);
  check(/別のモデルなので、2つとも読み込みます/.test(await p.textContent('#mem-note')), 'A と B が別のモデルなら、2つとも読み込むと表示する');
  await set('max', 128); await set('turns', 2);
  await p.click('#start');
  await waitPhase('finished');
  const r2 = await p.evaluate(() => ({ runners: [...window.__discussion.state.runners.keys()], speakers: window.__discussion.state.turns.map((t) => t.speaker) }));
  check(r2.runners.length === 2 && modelReq.get(MB) >= 1 && JSON.stringify(r2.speakers) === '[0,1]', `別のモデルどうしでも話す（読み込んだモデル ${r2.runners.join(', ')}）`);

  // スマホ幅
  await p.setViewportSize({ width: 390, height: 844 });
  check(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, 'スマホ幅で横にはみ出さない');

  // チャットからディスカッションへのリンク
  await p.goto(BASE);
  check(await p.getAttribute('a.nav-link', 'href') === './discussion.html', 'チャットからディスカッションへのリンクがある');

  check(errors.length === 0, `ページのエラーが無い（${errors.length} 件）`);
  await p.evaluate(() => localStorage.clear());
  await b.close();
  say(failures ? `${failures} 件失敗` : 'すべて成功');
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });

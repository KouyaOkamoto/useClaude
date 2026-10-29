// spring-sw-bridge の通し確認（実ブラウザ: ヘッドレス Chromium）
//
//   npx http-server -p 8080        # リポジトリのルートで（Range 対応のサーバー）
//   node toys/spring-sw-bridge/test/e2e.cjs [ページのURL]
//
// playwright が必要。外向きの通信にプロキシが要る環境では HTTPS_PROXY を設定しておく。
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8080/toys/spring-sw-bridge/';
const t0 = Date.now(), ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (...a) => console.log(ts(), ...a);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; say(ok ? 'PASS' : 'FAIL', label); };

(async () => {
  const b = await chromium.launch({ args: process.env.HTTPS_PROXY ? ['--proxy-server=' + process.env.HTTPS_PROXY] : [] });
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 1000 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => say('pageerror', e.message));
  const apiResponses = [];
  p.on('response', r => { if (r.url().includes('/api/')) apiResponses.push({ url: r.url(), sw: r.fromServiceWorker(), status: r.status() }); });

  await p.goto(BASE);
  await p.waitForFunction(() => document.getElementById('sw').textContent.includes('有効'), null, { timeout: 30000 });
  say('SW:', await p.textContent('#sw'), '| Spring:', await p.textContent('#backend'));

  // --- 起動中のリクエスト: 待たされて、起動後に Spring が答える
  const during = p.evaluate(async () => {
    const t = performance.now();
    const r = await fetch('api/health');
    return { status: r.status, servedBy: r.headers.get('x-served-by'), waitedMs: performance.now() - t, state: document.getElementById('backend').textContent };
  });
  say('起動中に GET api/health を送信（Spring:', await p.textContent('#backend'), ')');

  await p.waitForFunction(() => /実行中|起動失敗/.test(document.getElementById('backend').textContent), null, { timeout: 300000 });
  say('Spring:', await p.textContent('#backend'));
  say('steps:', (await p.$$eval('#steps li', l => l.map(x => x.className + ' ' + x.textContent.trim()))).join(' | '));
  const d = await during;
  say('起動中に送った health →', JSON.stringify(d));
  check(d.status === 200 && d.servedBy === 'spring-boot (CheerpJ)', '起動中のリクエストは待たされ、起動後に Spring が 200 で答えた');
  say('role:', await p.textContent('#role'));

  // --- APIコンソールのプリセット（サンプル投入から順に）
  const preset = async (label) => {
    await p.evaluate(l => [...document.querySelectorAll('#presets button')].find(b => b.textContent === l).click(), label);
    await p.waitForFunction(() => !/…/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    const status = await p.textContent('#status');
    const headers = await p.textContent('#headers');
    const body = (await p.textContent('#body')).replace(/\s+/g, ' ').slice(0, 110);
    return { status: parseInt(status), headers, body };
  };
  const expect = [['サンプル投入', 204], ['一覧', 200], ['未完了のみ', 200], ['検索', 200], ['作成', 201], ['1件取得', 200],
    ['更新(PATCH)', 200], ['削除', 204], ['不正なボディ', 400], ['存在しないID', 404], ['health', 200]];
  for (const [label, code] of expect) {
    const r = await preset(label);
    const spring = /x-served-by: spring-boot \(CheerpJ\)/.test(r.headers);
    check(r.status === code && spring, `プリセット「${label}」→ ${r.status}（期待 ${code}）${spring ? '' : ' x-served-by なし'} ${r.body}`);
    if (label === '作成') check(/location: \/toys\/spring-sw-bridge\/api\/todos\/4/.test(r.headers), '作成の Location がページの場所に合わせて書き換わる: ' + (r.headers.match(/location: .*/) || [''])[0]);
    if (label === '未完了のみ') check(!/"done": true/.test(r.body), '未完了のみ（?done=false）が効く');
    if (label === '検索') check(/APIを作る/.test(r.body) && !/IndexedDB/.test(r.body), '検索（?q=api）が効く');
  }
  // 405 と Allow ヘッダ
  const m405 = await p.evaluate(async () => { const r = await fetch('api/todos', { method: 'DELETE' }); return [r.status, r.headers.get('allow')]; });
  check(m405[0] === 405 && m405[1] === 'GET, POST', '405 + Allow: ' + m405.join(' / '));

  // --- ToDo UI: 追加・完了切替・削除
  const items = () => p.$$eval('#list li', l => l.map(x => (x.className === 'done' ? '[x] ' : '[ ] ') + x.querySelector('span').textContent));
  await p.fill('#title', 'UIから追加したTodo');
  await p.click('#add button');
  await p.waitForFunction(() => document.getElementById('list').innerText.includes('UIから追加したTodo'), null, { timeout: 30000 });
  check((await items()).includes('[ ] UIから追加したTodo'), 'UI: 追加 → ' + (await items()).join(', '));
  await p.locator('#list li', { hasText: 'UIから追加したTodo' }).locator('input[type=checkbox]').check();
  await p.waitForFunction(() => [...document.querySelectorAll('#list li.done span')].some(s => s.textContent === 'UIから追加したTodo'), null, { timeout: 30000 });
  check(true, 'UI: 完了切替 → ' + (await items()).join(', '));
  await p.locator('#list li', { hasText: 'UIから追加したTodo' }).locator('button').click();
  await p.waitForFunction(() => !document.getElementById('list').innerText.includes('UIから追加したTodo'), null, { timeout: 30000 });
  check(true, 'UI: 削除 → ' + (await items()).join(', '));

  const notSW = apiResponses.filter(r => !r.sw);
  check(notSW.length === 0, `api/* の応答 ${apiResponses.length} 件がすべて Service Worker 経由（fromServiceWorker=true）`);
  if (process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/bridge-ready.png', fullPage: true });

  // --- 2つ目のタブ: 宛先は先に ready になったタブ1つに絞られる
  const p2 = await ctx.newPage();
  await p2.goto(BASE);
  await p2.waitForFunction(() => /実行中|起動失敗/.test(document.getElementById('backend').textContent), null, { timeout: 300000 });
  say('tab2 role:', await p2.textContent('#role'), '| tab1 role:', await p.textContent('#role'));
  await p.evaluate(() => fetch('api/todos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"title":"タブ1から"}' }));
  const seen = await p2.evaluate(async () => (await (await fetch('api/todos')).json()).map(t => t.title));
  check(seen.includes('タブ1から') && /別のタブ/.test(await p2.textContent('#role')), 'タブ2の API もタブ1の Spring に届く: ' + seen.join(', '));

  // タブ1を閉じると、宛先はタブ2へ移る（データはタブ2の Spring のもの）
  await p.close();
  await new Promise(r => setTimeout(r, 1000));
  const after = await p2.evaluate(async () => { const r = await fetch('api/todos'); return [r.status, (await r.json()).length]; });
  check(after[0] === 200, 'タブ1を閉じた後はタブ2の Spring が答える: ' + JSON.stringify(after));
  await p2.close();

  // --- 起動失敗: 原因が表示され、再試行でき、その間の API は待たずに 503
  const p3 = await ctx.newPage();
  await p3.goto(BASE + '?jar=/app/no-such.jar');
  await p3.waitForFunction(() => /実行中|起動失敗/.test(document.getElementById('backend').textContent), null, { timeout: 300000 });
  const err = await p3.textContent('#error');
  const btn = await p3.evaluate(() => [document.getElementById('boot').disabled, document.getElementById('boot').textContent]);
  check(/起動失敗/.test(await p3.textContent('#backend')) && err.length > 0 && btn[0] === false,
    `起動失敗の表示: "${err.split('\n')[0].slice(0, 120)}" / ボタン ${btn[1]} 押せる=${!btn[0]}`);
  const u = await p3.evaluate(async () => { const t = performance.now(); const r = await fetch('api/todos'); return [r.status, r.headers.get('retry-after'), Math.round(performance.now() - t), (await r.json()).reason]; });
  check(u[0] === 503 && u[1] === '15' && u[2] < 5000, `バックエンドが無いときは待たずに 503: status=${u[0]} Retry-After=${u[1]} ${u[2]}ms reason=${u[3]}`);
  if (process.env.SHOT_DIR) await p3.screenshot({ path: process.env.SHOT_DIR + '/bridge-failed.png', fullPage: true });
  // 再試行（jar の段階の失敗なのでページを読み込み直す。パスは同じなので、もう一度失敗するが固まらないこと）
  check(btn[1] === 'ページを読み込み直して再試行', 'jar の段階の失敗では、再試行はページの読み込み直しになる: ' + btn[1]);
  await Promise.all([p3.waitForNavigation(), p3.click('#boot')]);
  await p3.waitForFunction(() => /起動失敗|実行中/.test(document.getElementById('backend').textContent) && !document.getElementById('boot').disabled, null, { timeout: 120000 });
  check(true, '再試行で読み込み直して再度起動を試み、失敗してもボタンが戻る: ' + await p3.textContent('#backend'));

  say(failures ? `${failures} 件失敗` : 'すべて成功');
  await b.close();
})();

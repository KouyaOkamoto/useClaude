// スナップショットの調査（ステップ0）のブラウザ版: 本体と同じ CSP のページで、時間とレンダラーのメモリを測る
//   node toys/v86-link/test/snapshot-step0/browser.cjs（5〜10 分）
// サーバーは立てない: Playwright の route で、toys/v86-link/ のファイルをそのまま返す（BASE を渡せば、そのサーバーを使う）
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const ORIGIN = 'http://v86-link.test';
const BASE = process.env.BASE || `${ORIGIN}/test/snapshot-step0/browser.html`;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

async function rendererRssMB(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  let kb = 0;
  for (const pr of processInfo.filter((x) => x.type === 'renderer')) {
    try { kb += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pr.id}/status`, 'utf8'))[1]); } catch { /* 終わったプロセス */ }
  }
  return Math.round(kb / 1024);
}

(async () => {
  // window.gc を使えるようにする（メモリを測る前にゴミを集める）
  const b = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
  const ctx = await b.newContext();
  if (!process.env.BASE) {
    await ctx.route(`${ORIGIN}/**`, (route) => {
      const file = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname));
      if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not found' });
      route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] ?? 'application/octet-stream' });
    });
  }
  const p = await ctx.newPage();
  const errors = [];
  await ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.message));
  const external = new Set();
  ctx.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host) external.add(u.host); });
  const cdp = await b.newBrowserCDPSession();
  const gc = () => p.evaluate(() => { window.gc?.(); });
  const rss = async () => { await gc(); await new Promise((r) => setTimeout(r, 500)); await gc(); return rendererRssMB(cdp); };
  const r = {};
  await p.goto(BASE);
  await p.waitForFunction(() => window.snap);
  r.rssStart = await rss();
  r.template = await p.evaluate(() => window.snap.template());
  r.rssTemplate = await rss();
  console.log('template', JSON.stringify(r.template));
  for (const n of [2, 4, 8]) {
    r[`restore${n}`] = await p.evaluate((n) => window.snap.restore(n, 'R'), n);
    r[`rssWith${n}Restored`] = await rss();
    await p.evaluate(() => window.snap.destroy('R'));
    r[`rssAfterDestroy${n}`] = await rss();
    console.log(n, JSON.stringify(r[`restore${n}`]), r[`rssWith${n}Restored`], r[`rssAfterDestroy${n}`]);
  }
  // 比べる: 普通の起動で 2・4・8 台（テンプレートの 1 台は動いたまま）
  for (const n of [2, 4, 8]) {
    r[`boot${n}`] = await p.evaluate((n) => window.snap.bootNormal(n, 'N'), n);
    await p.evaluate(() => window.snap.destroy('N'));
    console.log('boot', n, JSON.stringify(r[`boot${n}`]));
  }
  r.rssAfterBootDestroy = await rss();
  // 作る → 壊すを 10 回（4 台ずつ）
  r.cycles = [];
  for (let i = 0; i < 10; i++) {
    await p.evaluate(() => window.snap.restore(4, 'C'));
    await p.evaluate(() => window.snap.destroy('C'));
    r.cycles.push(await rss());
  }
  await p.evaluate(() => window.snap.restoreInPlace(20));
  r.rssAfterRestoreInPlace20 = await rss();
  r.errors = errors;
  r.external = [...external];
  console.log('RESULTS ' + JSON.stringify(r));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });

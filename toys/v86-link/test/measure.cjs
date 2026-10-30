// 台数ごとの負荷を測る（実ブラウザ: ヘッドレス Chromium）。README の「推奨台数」の根拠
//
//   npx http-server -p 8080        # リポジトリのルートで
//   node toys/v86-link/test/measure.cjs [ページのURL] [台数,台数,...]
//
// 台数ごとに新しいページを開き、全台を同時に起動して、次を測る:
//   ネットワーク設定まで終わる時間（全台）・レンダラーのメモリ（RSS）・シリアル入力の折り返し（エコー）の時間・
//   メインスレッドの遅れ（50ms ごとのタイマーの遅れ）
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.argv[2] || 'http://localhost:8080/toys/v86-link/';
const COUNTS = (process.argv[3] || '2,3,4,6,8').split(',').map(Number);

async function rendererRssMB(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  let kb = 0;
  for (const pr of processInfo.filter((x) => x.type === 'renderer')) {
    try { kb += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pr.id}/status`, 'utf8'))[1]); } catch { /* 終わったプロセス */ }
  }
  return Math.round(kb / 1024);
}

(async () => {
  const b = await chromium.launch();
  const cdp = await b.newBrowserCDPSession();
  const rows = [];
  for (const n of COUNTS) {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 1000 } });
    const p = await ctx.newPage();
    await p.goto(BASE);
    await p.evaluate((n) => { for (let i = 2; i < n; i++) document.getElementById('add-vm').click(); }, n);
    // 足した VM はすぐ起動を始める。残り（最初の 2 台）も「起動」で
    const t = Date.now();
    await p.evaluate(() => {
      window.__jank = [];
      let last = performance.now();
      setInterval(() => { const now = performance.now(); window.__jank.push(now - last - 50); last = now; }, 50);
      document.getElementById('boot').click();
    });
    await p.waitForFunction((n) => window.__v86link.machines.length === n && window.__v86link.machines.every((m) => m.netReady), n, { timeout: 900000, polling: 500 });
    const allReady = Date.now() - t;
    const boot = await p.evaluate(() => window.__v86link.machines.map((m) => Math.round(m.netMs)));
    const jankBoot = await p.evaluate(() => { const j = window.__jank.sort((a, z) => a - z); window.__jank = []; return { p95: Math.round(j[Math.floor(j.length * 0.95)]), max: Math.round(j.at(-1)) }; });
    await p.waitForTimeout(3000);
    // 入力の折り返し: 1 文字送って、エコーが返るまで（全台を順に）
    const echo = [];
    for (let i = 0; i < 4 * n; i++) {
      const slot = (await p.evaluate(() => window.__v86link.machines.map((m) => m.slot)))[i % n];
      echo.push(await p.evaluate(async (slot) => {
        const m = window.__v86link.bySlot(slot);
        const mark = m.log.length;
        const t0 = performance.now();
        m.node.writeSerial('x');
        while (!m.log.slice(mark).includes('x')) await new Promise((r) => setTimeout(r, 2));
        return performance.now() - t0;
      }, slot));
    }
    await p.evaluate(() => window.__v86link.machines.forEach((m) => m.node.writeSerial('\x15')));
    echo.sort((a, z) => a - z);
    await p.evaluate(() => { window.__jank = []; });
    await p.waitForTimeout(5000);
    const jankIdle = await p.evaluate(() => { const j = window.__jank.sort((a, z) => a - z); return { p95: Math.round(j[Math.floor(j.length * 0.95)]), max: Math.round(j.at(-1)) }; });
    const rss = await rendererRssMB(cdp);
    const row = {
      vms: n, allReadyMs: allReady, perVmMs: boot, rssMB: rss,
      echoMs: { median: Math.round(echo[Math.floor(echo.length / 2)]), max: Math.round(echo.at(-1)) }, jankBoot, jankIdle,
    };
    console.log(JSON.stringify(row));
    rows.push(row);
    await ctx.close();
  }
  console.log('| 台数 | 全台の準備完了 | レンダラー RSS | 入力のエコー（中央値 / 最大） | 起動中のタイマー遅れ p95 / 最大 | 起動後のタイマー遅れ p95 / 最大 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.vms} | ${(r.allReadyMs / 1000).toFixed(1)} 秒 | ${r.rssMB} MB | ${r.echoMs.median} / ${r.echoMs.max} ms | ${r.jankBoot.p95} / ${r.jankBoot.max} ms | ${r.jankIdle.p95} / ${r.jankIdle.max} ms |`);
  }
  await b.close();
})();

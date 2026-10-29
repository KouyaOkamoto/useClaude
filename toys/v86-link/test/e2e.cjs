// v86-link の通し確認（実ブラウザ: ヘッドレス Chromium）。シリアル出力の文字列で確かめる
//
//   npx http-server -p 8080        # リポジトリのルートで
//   node toys/v86-link/test/e2e.cjs [ページのURL]
//
// playwright が必要。SHOT_DIR を設定すると、画面のスクリーンショットを保存する。
// 計測値（ブート時間・メモリ・ping・HTTP・入力の遅延）も表示する（docs/results.md に記録）。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8080/toys/v86-link/';
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (...a) => console.log(ts(), ...a);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; say(ok ? 'PASS' : 'FAIL', label); };
const shot = async (p, name) => { if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, name), fullPage: true }); };

/** VM（0: 左、1: 右）のシリアル出力のうち、mark 以降に re が出るまで待つ。一致した文字列を返す */
async function waitLog(p, vm, re, mark, timeout = 60000) {
  const h = await p.waitForFunction(([vm, src, flags, mark]) => {
    const log = window.__v86link.machines[vm].log.slice(mark);
    const m = new RegExp(src, flags).exec(log);
    return m && m[0];
  }, [vm, re.source, re.flags, mark], { timeout });
  return h.jsonValue();
}
const mark = (p, vm) => p.evaluate((vm) => window.__v86link.machines[vm].log.length, vm);
const send = (p, vm, text) => p.evaluate(([vm, t]) => window.__v86link.machines[vm].node.writeSerial(t), [vm, text]);
const click = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);

/** レンダラーのメモリ（RSS）。Linux の /proc から読む */
async function rendererRssMB(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  let kb = 0;
  for (const pr of processInfo.filter((x) => x.type === 'renderer')) {
    try { kb += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pr.id}/status`, 'utf8'))[1]); } catch { /* 終わったプロセス */ }
  }
  return Math.round(kb / 1024);
}

/** メインスレッドの詰まり具合: 50ms ごとのタイマーがどれだけ遅れるか */
const startJank = (p) => p.evaluate(() => {
  window.__jank = [];
  let last = performance.now();
  clearInterval(window.__jankTimer);
  window.__jankTimer = setInterval(() => { const now = performance.now(); window.__jank.push(now - last - 50); last = now; }, 50);
});
const readJank = (p) => p.evaluate(() => {
  const j = window.__jank.slice().sort((a, b) => a - b);
  return { samples: j.length, median: Math.round(j[Math.floor(j.length / 2)]), p95: Math.round(j[Math.floor(j.length * 0.95)]), max: Math.round(j.at(-1)) };
});

async function bootBoth(p) {
  await click(p, '#boot');
  await p.waitForFunction(() => window.__v86link.machines.every((m) => m.ready), null, { timeout: 600000 });
  return p.evaluate(() => ({ download: Math.round(window.__v86link.downloadMs), boot: window.__v86link.machines.map((m) => Math.round(m.bootMs)) }));
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => say('pageerror', e.message));
  const external = new Set();
  // http(s) だけを見る（blob: や data: はホストを持たない）
  ctx.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host) external.add(u.host); });
  const cdp = await b.newBrowserCDPSession();
  const report = {};

  // --- 起動（初回） ---
  await p.goto(BASE);
  report.rssBeforeMB = await rendererRssMB(cdp);
  await startJank(p);
  report.firstBoot = await bootBoth(p);
  report.jankDuringBoot = await readJank(p);
  report.rssAfterBootMB = await rendererRssMB(cdp);
  check(true, `2台とも起動（ダウンロード ${report.firstBoot.download}ms、ブート 左 ${report.firstBoot.boot[0]}ms・右 ${report.firstBoot.boot[1]}ms）`);
  check(await p.evaluate(() => document.getElementById('state').textContent) === '2台とも起動', '起動の表示: ' + await p.evaluate(() => document.getElementById('state').textContent));

  // --- ネットワーク設定 ---
  let m0 = await mark(p, 0), m1 = await mark(p, 1);
  await click(p, '#net');
  check(!!(await waitLog(p, 0, /inet 10\.5\.0\.2\/24/, m0)) && !!(await waitLog(p, 1, /inet 10\.5\.0\.3\/24/, m1)), 'ネットワーク設定: 左 10.5.0.2/24・右 10.5.0.3/24');

  // --- ターミナルからのキー入力が、それぞれの VM に届く ---
  for (const [vm, word] of [[0, 'left'], [1, 'right']]) {
    const m = await mark(p, vm);
    await p.locator(`.vm[data-vm="${vm}"] .xterm`).click();
    await p.keyboard.type(`echo typed-${word}-$((6*7))`);
    await p.keyboard.press('Enter');
    check(!!(await waitLog(p, vm, new RegExp(`^typed-${word}-42`, 'm'), m)), `キー入力が${vm ? '右' : '左'}の VM に届く（typed-${word}-42）`);
  }

  // --- 日本語もそのまま届く（シリアルへは UTF-8 のバイト列で送る） ---
  m0 = await mark(p, 0);
  await send(p, 0, 'echo "こんにちは-$((1+1))"\n');
  check(!!(await waitLog(p, 0, /^こんにちは-2/m, m0)), 'シリアルに日本語を送っても化けない（こんにちは-2）');

  // --- ping（双方向） ---
  const rtt = {};
  for (const [preset, vm, label] of [['pingLR', 0, '左→右'], ['pingRL', 1, '右→左']]) {
    const m = await mark(p, vm);
    await click(p, `[data-preset="${preset}"]`);
    const stat = await waitLog(p, vm, /4 packets transmitted, (\d+) received[^\n]*\n[^\n]*rtt min\/avg\/max\/mdev = [\d.\/]+ ms/, m, 60000);
    rtt[label] = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stat).slice(1).map(Number);
    check(/4 received/.test(stat), `ping ${label}: ${stat.split('\n')[0].trim()}（rtt min/avg/max ${rtt[label].join('/')} ms）`);
  }
  report.pingRtt = rtt;

  // --- HTTP ---
  m1 = await mark(p, 1);
  await click(p, '[data-preset="httpServe"]');
  await waitLog(p, 1, /socat TCP-LISTEN:8080[^\n]*\n[\s\S]*% $/, m1, 30000);
  await p.waitForTimeout(1000);
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await click(p, '[data-preset="httpGet"]');
  const http = await waitLog(p, 0, /hello from right \(10\.5\.0\.3\)[\s\S]*?\(HTTP (\d+), ([\d.]+)s\)/, m0, 60000);
  const [, code, secs] = /\(HTTP (\d+), ([\d.]+)s\)/.exec(http);
  report.httpSeconds = Number(secs);
  const access = await waitLog(p, 1, /\d\d:\d\d:\d\d GET \/ HTTP\/1\.1/, m1, 10000);
  check(code === '200', `HTTP: 左が右（socat + シェルの HTTP サーバー）から取得（HTTP ${code}、${secs}s）。右のログ「${access}」`);

  // --- TCP（nc の代わりに socat） ---
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await click(p, '[data-preset="tcpOpen"]');
  await p.waitForTimeout(3000);
  await click(p, '[data-preset="tcpSend"]');
  const gotRight = await waitLog(p, 1, /^hello from left/m, m1, 20000);
  const gotLeft = await waitLog(p, 0, /^hello from right/m, m0, 20000);
  check(!!gotRight && !!gotLeft, 'TCP: 左→右「hello from left」、右→左「hello from right」が届く');
  await click(p, '[data-preset="tcpClose"]');
  await waitLog(p, 0, /left:~% $/, m0, 10000);
  await waitLog(p, 1, /right:~% $/, m1, 10000);
  await shot(p, 'v86-link-desktop.png');

  // --- ケーブルを抜く → ping 失敗、差す → 復旧 ---
  const dropped0 = await p.evaluate(() => window.__v86link.sw.stats.dropped);
  await p.check('#unplug');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 -W 1 10.5.0.3\n');
  const lost = await waitLog(p, 0, /3 packets transmitted, 0 received, 100% packet loss/, m0, 60000);
  const dropped1 = await p.evaluate(() => window.__v86link.sw.stats.dropped);
  check(!!lost && dropped1 > dropped0, `ケーブルを抜くと ping が失敗（${lost}、捨てたフレーム +${dropped1 - dropped0}）`);
  await p.uncheck('#unplug');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 4 10.5.0.3\n');
  const back = await waitLog(p, 0, /4 packets transmitted, (\d+) received/, m0, 60000);
  check(!/ 0 received/.test(back), `ケーブルを差すと復旧（${back}）`);

  // --- 遅延 ---
  await p.fill('#delay', '200');
  await p.dispatchEvent('#delay', 'input');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 10.5.0.3\n');
  const slow = await waitLog(p, 0, /rtt min\/avg\/max\/mdev = [\d.\/]+ ms/, m0, 60000);
  const avg = Number(/= [\d.]+\/([\d.]+)/.exec(slow)[1]);
  check(avg >= 380, `遅延 200ms（片道）を足すと、往復が ${avg}ms になる`);
  await p.fill('#delay', '0');
  await p.dispatchEvent('#delay', 'input');

  // --- パケットモニタ ---
  const stats = await p.evaluate(() => window.__v86link.sw.stats);
  const monitor = await p.$$eval('#monitor dt', (l) => l.map((x) => x.textContent));
  check(stats.frames > 0 && stats.types.ARP > 0 && stats.types.ICMP > 0 && stats.types.TCP > 0 && monitor.includes('ICMP'),
    `パケットモニタ: ${stats.frames} フレーム・${stats.bytes} バイト・捨てた ${stats.dropped}、種別 ${JSON.stringify(stats.types)}`);

  // --- 体感の重さ（2台が動いている間の、入力の反映までの時間とメインスレッドの遅れ） ---
  await startJank(p);
  const echo = [];
  for (let i = 0; i < 20; i++) {
    const vm = i % 2;
    const m = await mark(p, vm);
    const t = Date.now();
    await send(p, vm, 'x');
    await waitLog(p, vm, /x/, m, 5000);
    echo.push(Date.now() - t);
  }
  await send(p, 0, '\x15');   // 打った x を消す（Ctrl-U）
  await send(p, 1, '\x15');
  echo.sort((a, z) => a - z);
  report.echoMs = { median: echo[10], max: echo.at(-1) };
  report.jankIdle = await readJank(p);
  report.rssRunningMB = await rendererRssMB(cdp);
  report.jsHeapMB = await p.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));

  check([...external].length === 0, '外部への通信なし: ' + ([...external].join(', ') || '（なし）'));

  // --- 2回目（キャッシュあり）の起動 ---
  await p.reload();
  report.secondBoot = await bootBoth(p);
  check(true, `再読込後の起動（ダウンロード ${report.secondBoot.download}ms、ブート 左 ${report.secondBoot.boot[0]}ms・右 ${report.secondBoot.boot[1]}ms）`);

  // --- スマホ幅 ---
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(BASE);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const stacked = await phone.evaluate(() => {
    const [a, b2] = [...document.querySelectorAll('.vm')].map((e) => e.getBoundingClientRect());
    return b2.top >= a.bottom;
  });
  check(overflow <= 0 && stacked, `スマホ幅（390px）: 横にはみ出さず（${overflow}px）、2台のターミナルが縦に並ぶ`);
  await shot(phone, 'v86-link-phone.png');

  say('計測: ' + JSON.stringify(report));
  say(failures ? `${failures} 件失敗` : 'すべて成功');
  await b.close();
  process.exitCode = failures ? 1 : 0;
})();

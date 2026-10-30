// v86-link の通し確認（実ブラウザ: ヘッドレス Chromium）。シリアル出力の文字列で確かめる
//
//   npx http-server -p 8080        # リポジトリのルートで
//   node toys/v86-link/test/e2e.cjs [ページのURL]
//
// playwright が必要。SHOT_DIR を設定すると、画面のスクリーンショットを保存する。
// 計測値（ブート時間・メモリ・ping・HTTP・入力の遅延）も表示する（docs/results.md に記録）。
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hasTool = (cmd) => spawnSync(cmd, ['--version']).status === 0;

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
/** フィルタを入れて、表示が切り替わる（全行が条件に合う）まで待つ。cond は行の要素 r についての式の文字列 */
async function filterRows(p, text, cond, min = 1) {
  await p.fill('#cap-filter', text);
  await p.waitForFunction(([cond, min]) => {
    const rows = [...document.querySelectorAll('#cap-spacer .cap-row')];
    const ok = new Function('r', 'return ' + cond);
    return rows.length >= min && rows.every((r) => ok(r));
  }, [cond, min], { timeout: 10000 });
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
  const pageErrors = [];
  p.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
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
  const dropped0 = await p.evaluate(() => window.__v86link.stats.dropped);
  await p.check('#unplug');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 -W 1 10.5.0.3\n');
  const lost = await waitLog(p, 0, /3 packets transmitted, 0 received, 100% packet loss/, m0, 60000);
  const dropped1 = await p.evaluate(() => window.__v86link.stats.dropped);
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

  // --- パケットキャプチャ: ping・HTTP・TCP のフレームが一覧に正しく出る ---
  const rows = await p.evaluate(() => {
    const { capture, captureView } = window.__v86link;
    return capture.list().map((r) => {
      const x = captureView.parse(r);
      return { no: r.no, dropped: r.dropped, reason: r.reason, in: r.inPort, out: r.outPorts, proto: x.protocol, info: x.info, flags: x.tcp?.flags ?? null, ports: x.ports ?? null };
    });
  });
  const seen = (pred) => rows.some(pred);
  check(seen((r) => r.proto === 'ARP' && /^Who has 10\.5\.0\.3\? Tell 10\.5\.0\.2$/.test(r.info)) && seen((r) => r.proto === 'ARP' && / is at /.test(r.info)),
    'キャプチャ: ARP（who-has / is-at）');
  check(seen((r) => /^Echo \(ping\) request/.test(r.info)) && seen((r) => /^Echo \(ping\) reply/.test(r.info)), 'キャプチャ: ICMP（echo request / reply）');
  // TCP 7000（socat）の1本の接続: SYN → SYN,ACK → ACK → データ → FIN
  const t7000 = rows.filter((r) => r.proto === 'TCP' && r.ports && (r.ports.src === 7000 || r.ports.dst === 7000) && !r.dropped);
  const order = t7000.map((r) => r.flags.join(','));
  const at = (f, from = 0) => order.indexOf(f, from);
  const iSyn = at('SYN'), iSynAck = at('SYN,ACK', iSyn), iAck = at('ACK', iSynAck), iData = at('PSH,ACK', iAck), iFin = order.findIndex((f, i) => i > iData && f.includes('FIN'));
  check(iSyn >= 0 && iSyn < iSynAck && iSynAck < iAck && iAck < iData && iData < iFin,
    `キャプチャ: TCP 7000 が SYN → SYN,ACK → ACK → データ（PSH,ACK）→ FIN の順に並ぶ（${order.join(' / ')}）`);
  check(seen((r) => r.proto === 'TCP' && r.ports && r.ports.dst === 8080 && r.flags.join() === 'SYN'), 'キャプチャ: HTTP（TCP 8080）の SYN もある');
  check(seen((r) => r.dropped && r.reason === 'cable' && r.out.length === 0), `キャプチャ: ケーブルを抜いていた間に捨てたフレームが「捨てた（cable）」として記録されている（${rows.filter((r) => r.dropped).length} 件）`);
  check(rows.filter((r) => !r.dropped).every((r) => r.out.length === 1 && r.out[0] !== r.in), 'キャプチャ: 入ったポートと出たポートが記録されている');

  // 画面: フィルタ・一覧・詳細・16進ダンプ
  await filterRows(p, 'tcp port:7000', "r.dataset.proto === 'TCP' && /(^| )7000( |$)/.test(r.querySelector('.c-info').textContent)");
  await p.evaluate(() => { const s = document.getElementById('cap-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); });
  await p.waitForTimeout(300);
  const firstRow = await p.$eval('#cap-spacer .cap-row', (r) => r.textContent);
  check(/\[SYN\]/.test(firstRow) && /左 → 右/.test(firstRow), `一覧: フィルタ「tcp port:7000」の先頭は SYN（${firstRow.replace(/\s+/g, ' ').slice(0, 120)}）`);
  await filterRows(p, 'tcp port:7000 psh', "/PSH/.test(r.textContent)");
  await p.click('#cap-spacer .cap-row');
  const detail = await p.$eval('#cap-detail', (d) => d.textContent);
  // 16進ダンプの ASCII の列（16バイトずつ折り返す）をつなげて見る
  const ascii = await p.$eval('#cap-detail .hex', (h) => h.textContent.split('\n').map((l) => l.slice(55)).join(''));
  check(/TCP/.test(detail) && /hello from (left|right)/.test(ascii) && /フラグ0x18\[PSH,ACK\]/.test(detail.replace(/\s+/g, '')),
    '詳細: TCP の項目（フラグ PSH, ACK）と、16進ダンプの ASCII に送った文字列が出る');
  await shot(p, 'v86-link-capture.png');
  await filterRows(p, 'dropped', "r.classList.contains('dropped')");
  const droppedRows = await p.$$eval('#cap-spacer .cap-row', (l) => l.map((r) => [r.classList.contains('dropped'), r.querySelector('.c-path').textContent]));
  check(droppedRows.every(([d, path]) => d && /→ ✕$/.test(path)), `一覧: 捨てたフレームは区別して表示される（${droppedRows.length} 行、経路「${droppedRows[0][1]}」）`);
  await p.fill('#cap-filter', '');

  // pcap をダウンロードして、実際のツールで読む
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v86-link-e2e-'));
  // 数えるのとボタンを押すのを同じ処理の中で行う（その間に新しいフレームが入らないように）
  const savePcap = async (name) => {
    const [dl, counts] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => {
      const cap = window.__v86link.capture;
      const counts = { all: cap.size, forwarded: cap.list({ includeDropped: false }).length };
      document.getElementById('cap-download').click();
      return counts;
    })]);
    const file = path.join(tmp, name);
    await dl.saveAs(file);
    return { file, suggested: dl.suggestedFilename(), bytes: fs.readFileSync(file), counts };
  };
  const pcap1 = await savePcap('forwarded.pcap');
  const capCounts = pcap1.counts;
  const records = (buf) => { let n = 0; for (let o = 24; o + 16 <= buf.length; o += 16 + buf.readUInt32LE(o + 8)) n++; return n; };
  check(/^v86-link-\d{8}-\d{6}\.pcap$/.test(pcap1.suggested) && pcap1.bytes.readUInt32LE(0) === 0xa1b2c3d4 && pcap1.bytes.readUInt32LE(20) === 1 && records(pcap1.bytes) === capCounts.forwarded,
    `pcap: ${pcap1.suggested}（${pcap1.bytes.length} バイト、${records(pcap1.bytes)} 件 = 転送したフレーム。既定では捨てたものは入れない）`);
  if (hasTool('tcpdump')) {
    const r = spawnSync('tcpdump', ['-nn', '-r', pcap1.file], { encoding: 'utf8' });
    const lines = r.stdout.trim().split('\n');
    check(r.status === 0 && lines.length === capCounts.forwarded && lines.some((l) => /ARP, Request who-has 10\.5\.0\.3/.test(l))
      && lines.some((l) => /ICMP echo reply/.test(l)) && lines.some((l) => /\.7000: Flags \[S\]/.test(l)) && lines.some((l) => /Flags \[F\.\]/.test(l)),
      `tcpdump -r で読める（${lines.length} 行）`);
  } else {
    say('SKIP tcpdump が無いので、tcpdump -r での確認はしていない');
  }
  if (hasTool('tshark')) {
    const r = spawnSync('tshark', ['-r', pcap1.file, '-T', 'fields', '-e', '_ws.col.Protocol'], { encoding: 'utf8' });
    const protos = new Set(r.stdout.trim().split('\n'));
    check(r.status === 0 && ['ARP', 'ICMP', 'TCP', 'HTTP'].every((x) => protos.has(x)), `tshark -r で読める（プロトコル: ${[...protos].join(', ')}）`);
  } else {
    say('SKIP tshark が無いので、tshark -r での確認はしていない');
  }
  await p.check('#cap-dropped');
  const pcap2 = await savePcap('all.pcap');
  check(records(pcap2.bytes) === pcap2.counts.all && pcap2.counts.all > pcap2.counts.forwarded,
    `「捨てたフレームも pcap に入れる」にすると、捨てたものも入る（${records(pcap2.bytes)} 件 = 全 ${pcap2.counts.all} 件）`);
  await p.uncheck('#cap-dropped');

  // 壊れたフレーム・HTML を含むフレームを注入しても、画面が壊れない（右のケーブルを抜いて、VM には届けない）
  const errorsBefore = pageErrors.length;
  await p.check('#unplug');
  await p.evaluate(() => {
    const { sw } = window.__v86link;
    const left = sw.ports[0];
    const evil = new TextEncoder().encode('<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>');
    const ipv4 = (proto, payload, totalLen) => {
      const f = new Uint8Array(34 + payload.length);
      f.set([0x00, 0x22, 0x15, 0xc1, 0xfd, 0x02, 0x00, 0x22, 0x15, 0xcd, 0xe6, 0x99, 0x08, 0x00]);
      f.set([0x45, 0, totalLen >> 8, totalLen & 255, 0, 0, 0, 0, 64, proto, 0, 0, 10, 5, 0, 2, 10, 5, 0, 3], 14);
      f.set(payload, 34);
      return f;
    };
    sw.receive(left, Uint8Array.from([1, 2, 3]));                                     // 短すぎる
    sw.receive(left, ipv4(6, evil, 0xffff));                                         // 全長が嘘・TCP ヘッダが壊れている・中身は HTML
    sw.receive(left, Uint8Array.from([...new Array(12).fill(0xff), 0x88, 0xcc, ...evil]));   // 知らない ethertype
    sw.receive(left, ipv4(17, evil.slice(0, 4), 30));                                // 全長がヘッダより短い
  });
  await p.uncheck('#unplug');
  await filterRows(p, 'malformed', "r.classList.contains('malformed')", 3);
  const bad = await p.$$eval('#cap-spacer .cap-row', (l) => l.map((r) => r.textContent));
  for (const i of [0, 1, 2]) await p.click(`#cap-spacer .cap-row[data-index="${i}"]`);
  await filterRows(p, 'unknown', "r.dataset.proto === 'Unknown'");
  const unkRow = await p.$eval('#cap-spacer .cap-row', (r) => r.querySelector('.c-info').textContent);
  await p.click('#cap-spacer .cap-row');
  const xss = await p.evaluate(() => ({ flag: window.__xss ?? null, imgs: document.querySelectorAll('#capture img, #capture script').length }));
  check(pageErrors.length === errorsBefore && xss.flag === null && xss.imgs === 0 && bad.length >= 3 && unkRow === 'Unknown (ethertype=0x88cc)',
    `壊れたフレームを注入しても画面は壊れない（Malformed ${bad.length} 行、「${unkRow}」も表示。ページのエラーなし・HTML の要素は作られず実行もされない）`);
  const hexHasTag = await p.$eval('#cap-detail .hex', (h) => h.textContent.split('\n').map((l) => l.slice(55)).join('').includes('<img src'));
  check(hexHasTag, '16進ダンプの ASCII には、HTML がただの文字として出る');
  await p.fill('#cap-filter', '');

  // 記録の停止・開始・クリア
  await p.click('#cap-toggle');
  const sizeStopped = await p.evaluate(() => window.__v86link.capture.size);
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 2 10.5.0.3\n');
  await waitLog(p, 0, /2 packets transmitted/, m0, 30000);
  const sizeAfter = await p.evaluate(() => window.__v86link.capture.size);
  await p.click('#cap-toggle');
  await p.click('#cap-clear');
  const cleared = await p.evaluate(() => window.__v86link.capture.size);
  const status = await p.textContent('#cap-status');
  check(sizeAfter === sizeStopped && cleared === 0 && /上限 20,000 件・16.0MB/.test(status),
    `記録の停止中は増えない（${sizeStopped} → ${sizeAfter}）・クリアで 0 件・上限の表示「${status}」`);

  // --- パケットモニタ ---
  const stats = await p.evaluate(() => ({ frames: window.__v86link.stats.frames, bytes: window.__v86link.stats.bytes, dropped: window.__v86link.stats.dropped, types: window.__v86link.stats.types }));
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

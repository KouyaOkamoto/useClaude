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

/** VM（スロット番号 0: A、1: B、2: C …）のシリアル出力のうち、mark 以降に re が出るまで待つ。一致した文字列を返す */
async function waitLog(p, vm, re, mark, timeout = 60000) {
  const h = await p.waitForFunction(([vm, src, flags, mark]) => {
    const log = window.__v86link.bySlot(vm).log.slice(mark);
    const m = new RegExp(src, flags).exec(log);
    return m && m[0];
  }, [vm, re.source, re.flags, mark], { timeout });
  return h.jsonValue();
}
/**
 * フィルタを入れて、表示が切り替わる（全行が条件に合う）まで待つ。cond は行の要素 r についての式の文字列。
 * ページの CSP は文字列の eval を許さないので、行の中身を取り出して、条件は Node 側で評価する
 */
async function filterRows(p, text, cond, min = 1) {
  await p.fill('#cap-filter', text);
  const ok = new Function('r', 'return ' + cond);
  const end = Date.now() + 10000;
  for (;;) {
    const rows = await p.$$eval('#cap-spacer .cap-row', (l) => l.map((r) => ({
      cls: [...r.classList], proto: r.dataset.proto, text: r.textContent,
      cells: Object.fromEntries([...r.children].map((c) => ['.' + c.className, c.textContent])),
    })));
    // 行の要素と同じように書けるようにする（dataset / classList / querySelector / textContent）
    const fake = rows.map((x) => ({
      dataset: { proto: x.proto }, textContent: x.text, classList: { contains: (c) => x.cls.includes(c) },
      querySelector: (sel) => ({ textContent: x.cells[sel] ?? '' }),
    }));
    if (fake.length >= min && fake.every((r) => ok(r))) return;
    if (Date.now() > end) throw new Error(`filterRows: 「${text}」で ${cond} を満たす行が出ない（${rows.length} 行）`);
    await p.waitForTimeout(100);
  }
}
const mark = (p, vm) => p.evaluate((vm) => window.__v86link.bySlot(vm).log.length, vm);
const send = (p, vm, text) => p.evaluate(([vm, t]) => window.__v86link.bySlot(vm).node.writeSerial(t), [vm, text]);
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

/** 「起動」で全台を起動し、ネットワーク設定（自動）まで待つ */
async function bootBoth(p) {
  await click(p, '#boot');
  await p.waitForFunction(() => window.__v86link.machines.every((m) => m.netReady), null, { timeout: 600000 });
  return p.evaluate(() => ({ download: Math.round(window.__v86link.downloadMs), boot: window.__v86link.machines.map((m) => Math.round(m.bootMs)), net: window.__v86link.machines.map((m) => Math.round(m.netMs)) }));
}
/** VM を足して（自動で起動・ネットワーク設定）、準備完了まで待つ。スロット番号を返す */
async function addVm(p) {
  const slot = await p.evaluate(() => {
    const before = new Set(window.__v86link.machines.map((m) => m.slot));
    document.getElementById('add-vm').click();
    return window.__v86link.machines.find((m) => !before.has(m.slot)).slot;
  });
  await p.waitForFunction(() => window.__v86link.machines.every((m) => m.netReady), null, { timeout: 300000 });
  return slot;
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const p = await ctx.newPage();
  const pageErrors = [];
  p.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
  // CSP の違反（読み込めなかったもの）も、ページのエラーとして数える
  await ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  p.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
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
  check(true, `2台とも起動（ダウンロード ${report.firstBoot.download}ms、ブート A ${report.firstBoot.boot[0]}ms・B ${report.firstBoot.boot[1]}ms、ネットワーク設定まで ${report.firstBoot.net.join('/')}ms）`);
  check(await p.evaluate(() => document.getElementById('state').textContent) === '2 台とも起動', '起動の表示: ' + await p.evaluate(() => document.getElementById('state').textContent));

  // --- ネットワーク設定（起動後に自動。ボタンでやり直せる） ---
  check(!!(await waitLog(p, 0, /link\/ether 02:00:0a:05:00:02[\s\S]*inet 10\.5\.0\.2\/24/, 0)) && !!(await waitLog(p, 1, /link\/ether 02:00:0a:05:00:03[\s\S]*inet 10\.5\.0\.3\/24/, 0)),
    'ネットワーク設定（自動）: A 10.5.0.2/24・MAC 02:00:0a:05:00:02、B 10.5.0.3/24・MAC 02:00:0a:05:00:03');
  let m0 = await mark(p, 0), m1 = await mark(p, 1);
  await click(p, '#net');
  check(!!(await waitLog(p, 0, /inet 10\.5\.0\.2\/24\s+[^\n]*\n\s*NET-OK/, m0)) && !!(await waitLog(p, 1, /inet 10\.5\.0\.3\/24[^\n]*\n\s*NET-OK/, m1)), 'ネットワーク設定をやり直しても同じ設定になる');

  // --- ターミナルからのキー入力が、それぞれの VM に届く ---
  for (const [vm, word] of [[0, 'left'], [1, 'right']]) {
    const m = await mark(p, vm);
    await p.locator(`.vm[data-slot="${vm}"] .xterm`).click();
    await p.keyboard.type(`echo typed-${word}-$((6*7))`);
    await p.keyboard.press('Enter');
    check(!!(await waitLog(p, vm, new RegExp(`^typed-${word}-42`, 'm'), m)), `キー入力が${vm ? 'B' : 'A'}の VM に届く（typed-${word}-42）`);
  }

  // --- 日本語もそのまま届く（シリアルへは UTF-8 のバイト列で送る） ---
  m0 = await mark(p, 0);
  await send(p, 0, 'echo "こんにちは-$((1+1))"\n');
  check(!!(await waitLog(p, 0, /^こんにちは-2/m, m0)), 'シリアルに日本語を送っても化けない（こんにちは-2）');

  // --- ping（双方向） ---
  const rtt = {};
  for (const [preset, vm, label] of [['pingAB', 0, 'A→B'], ['pingBA', 1, 'B→A']]) {
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
  const http = await waitLog(p, 0, /hello from B \(10\.5\.0\.3\)[\s\S]*?\(HTTP (\d+), ([\d.]+)s\)/, m0, 60000);
  const [, code, secs] = /\(HTTP (\d+), ([\d.]+)s\)/.exec(http);
  report.httpSeconds = Number(secs);
  const access = await waitLog(p, 1, /\d\d:\d\d:\d\d GET \/ HTTP\/1\.1/, m1, 10000);
  check(code === '200', `HTTP: A が B（socat + シェルの HTTP サーバー）から取得（HTTP ${code}、${secs}s）。B のログ「${access}」`);

  // --- TCP（nc の代わりに socat） ---
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await click(p, '[data-preset="tcpOpen"]');
  await p.waitForTimeout(3000);
  await click(p, '[data-preset="tcpSend"]');
  const gotRight = await waitLog(p, 1, /^hello from A/m, m1, 20000);
  const gotLeft = await waitLog(p, 0, /^hello from B/m, m0, 20000);
  check(!!gotRight && !!gotLeft, 'TCP: A→B「hello from A」、B→A「hello from B」が届く');
  await click(p, '[data-preset="tcpClose"]');
  await waitLog(p, 0, /a:~% $/, m0, 10000);
  await waitLog(p, 1, /b:~% $/, m1, 10000);
  await shot(p, 'v86-link-desktop.png');

  // --- ケーブルを抜く → ping 失敗、差す → 復旧 ---
  const dropped0 = await p.evaluate(() => window.__v86link.stats.dropped);
  await p.check('.vm[data-slot="1"] .unplug');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 -W 1 10.5.0.3\n');
  const lost = await waitLog(p, 0, /3 packets transmitted, 0 received, 100% packet loss/, m0, 60000);
  const dropped1 = await p.evaluate(() => window.__v86link.stats.dropped);
  check(!!lost && dropped1 > dropped0, `ケーブルを抜くと ping が失敗（${lost}、捨てたフレーム +${dropped1 - dropped0}）`);
  await p.uncheck('.vm[data-slot="1"] .unplug');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 4 10.5.0.3\n');
  const back = await waitLog(p, 0, /4 packets transmitted, (\d+) received/, m0, 60000);
  check(!/ 0 received/.test(back), `ケーブルを差すと復旧（${back}）`);

  // --- 遅延 ---
  // A のポートの遅延 200ms: A から出るフレームにも A へ届くフレームにも足される
  await p.fill('.vm[data-slot="0"] .delay', '200');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 10.5.0.3\n');
  const slow = await waitLog(p, 0, /rtt min\/avg\/max\/mdev = [\d.\/]+ ms/, m0, 60000);
  const avg = Number(/= [\d.]+\/([\d.]+)/.exec(slow)[1]);
  check(avg >= 380, `A のポートに遅延 200ms を足すと、往復が ${avg}ms になる`);
  await p.fill('.vm[data-slot="0"] .delay', '0');

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
  check(/\[SYN\]/.test(firstRow) && /A → B/.test(firstRow), `一覧: フィルタ「tcp port:7000」の先頭は SYN（${firstRow.replace(/\s+/g, ' ').slice(0, 120)}）`);
  await filterRows(p, 'tcp port:7000 psh', "/PSH/.test(r.textContent)");
  await p.click('#cap-spacer .cap-row');
  const detail = await p.$eval('#cap-detail', (d) => d.textContent);
  // 16進ダンプの ASCII の列（16バイトずつ折り返す）をつなげて見る
  const ascii = await p.$eval('#cap-detail .hex', (h) => h.textContent.split('\n').map((l) => l.slice(55)).join(''));
  check(/TCP/.test(detail) && /hello from (A|B)/.test(ascii) && /フラグ0x18\[PSH,ACK\]/.test(detail.replace(/\s+/g, '')),
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
  await p.check('.vm[data-slot="1"] .unplug');
  await p.evaluate(() => {
    const { sw } = window.__v86link;
    const left = sw.port(0);
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
  await p.uncheck('.vm[data-slot="1"] .unplug');
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

  // ================================================================ 3台以上: ハブ / スイッチ
  // --- C を足す（自動で起動し、IP 設定まで進む） ---
  const tAdd = Date.now();
  const slotC = await addVm(p);
  report.addVmMs = Date.now() - tAdd;
  const cState = await p.$eval('.vm[data-slot="2"] .vm-state', (e) => e.textContent);
  check(slotC === 2 && !!(await waitLog(p, 2, /link\/ether 02:00:0a:05:00:04[\s\S]*inet 10\.5\.0\.4\/24[\s\S]*NET-OK/, 0)) && /準備完了/.test(cState),
    `VM を足す: C が自動で起動し、10.5.0.4・02:00:0a:05:00:04 まで設定（${report.addVmMs}ms、表示「${cState}」）`);
  const macs = await p.evaluate(async () => {
    const out = [];
    for (const m of window.__v86link.machines) out.push(m.mac);
    return out;
  });
  check(new Set(macs).size === macs.length, `MAC は VM ごとに違う（${macs.join(', ')}）`);

  // トポロジー図で、どのポートの線が光ったかを記録する
  await p.evaluate(() => {
    window.__lit = { in: new Set(), out: new Set() };
    window.__litObs?.disconnect();
    window.__litObs = new MutationObserver((list) => {
      for (const r of list) {
        const t = r.target;
        if (t.classList?.contains('link')) for (const c of ['in', 'out']) if (t.classList.contains(c)) window.__lit[c].add(Number(t.dataset.port));
      }
    });
    window.__litObs.observe(document.getElementById('topology'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  const lit = () => p.evaluate(() => { const r = { in: [...window.__lit.in].sort(), out: [...window.__lit.out].sort() }; window.__lit = { in: new Set(), out: new Set() }; return r; });
  // 盗聴の練習: C の tcpdump に A↔B の ICMP が出るか
  const sniff = async (preset) => {
    const mc = await mark(p, 2);
    const capFrom = await p.evaluate(() => window.__v86link.capture.nextNo);
    await lit();
    await p.evaluate((k) => window.__v86link.runPreset(k), preset);
    const end = await waitLog(p, 2, /(\d+) packets? captured/, mc, 30000);
    const log = await p.evaluate(([m]) => window.__v86link.bySlot(2).log.slice(m), [mc]);
    const icmpAB = log.split('\n').filter((l) => /IP 10\.5\.0\.[23] > 10\.5\.0\.[23]: ICMP echo/.test(l));
    // キャプチャの記録: A↔B の ICMP が、どのポートへ出たか
    const recs = await p.evaluate((from) => {
      const { capture, captureView } = window.__v86link;
      return capture.list().filter((r) => r.no >= from).map((r) => ({ r, x: captureView.parse(r) }))
        .filter(({ x }) => x.protocol === 'ICMP' && /^10\.5\.0\.[23]$/.test(x.src) && /^10\.5\.0\.[23]$/.test(x.dst))
        .map(({ r, x }) => ({ in: r.inPort, out: r.outPorts, decision: r.decision, info: x.info }));
    }, capFrom);
    return { captured: Number(/(\d+)/.exec(end)[1]), icmpAB, recs, lit: await lit() };
  };

  const hub = await sniff('sniffHub');
  check(hub.icmpAB.length >= 6 && hub.captured >= 6 && hub.icmpAB.some((l) => /10\.5\.0\.2 > 10\.5\.0\.3: ICMP echo request/.test(l)) && hub.icmpAB.some((l) => /10\.5\.0\.3 > 10\.5\.0\.2: ICMP echo reply/.test(l)),
    `ハブ: C の tcpdump に A↔B の ICMP が出る（${hub.captured} packets captured。例「${hub.icmpAB[0]?.trim()}」）`);
  check(hub.recs.length >= 6 && hub.recs.every((r) => r.decision === 'hub' && r.out.length === 2 && r.out.includes(2) && !r.out.includes(r.in)),
    `ハブ: キャプチャでも A↔B の ICMP は C のポートにも出ている（${hub.recs.length} 件、例 入 ${hub.recs[0]?.in} → 出 ${hub.recs[0]?.out}）`);
  check(hub.lit.out.includes(0) && hub.lit.out.includes(1) && hub.lit.out.includes(2), `トポロジー: ハブでは C の線も光る（出た線 ${hub.lit.out}）`);
  await filterRows(p, 'icmp out:c', "/→ .*C/.test(r.querySelector('.c-path').textContent)", 6);
  const hubRow = await p.$eval('#cap-spacer .cap-row', (r) => r.querySelector('.c-path').textContent);
  check(/^[AB] → [AB], C$/.test(hubRow), `一覧: 「icmp out:c」で C に出たフレームだけを表示（経路「${hubRow}」）`);
  await shot(p, 'v86-link-hub.png');

  const swi = await sniff('sniffSwitch');
  check(swi.captured === 0 && swi.icmpAB.length === 0, `スイッチ: C の tcpdump には A↔B の ICMP が出ない（${swi.captured} packets captured）`);
  check(swi.recs.length >= 6 && swi.recs.every((r) => r.decision === 'known' && r.out.length === 1 && !r.out.includes(2)),
    `スイッチ: キャプチャでも A↔B の ICMP は相手のポートだけ（${swi.recs.length} 件、すべて 1 ポート・C には出ない）`);
  await filterRows(p, 'icmp vm:c', 'true', 0);
  const swRows = await p.$$eval('#cap-spacer .cap-row', (l) => l.map((r) => r.querySelector('.c-info').textContent));
  check(swRows.length === hub.recs.length, `一覧: 「icmp vm:c」はハブのときの ${hub.recs.length} 件だけ（スイッチの分は C を通らない。${swRows.length} 行）`);
  await p.fill('#cap-filter', '');

  // MAC アドレステーブル（画面）
  const table = await p.$$eval('#mac-rows tr', (l) => l.map((r) => [...r.cells].map((c) => c.textContent)));
  // 列: VLAN / MAC / ポート / 最後に見た / 残り
  const row = (mac) => table.find((r) => r[1] === mac);
  check(row('02:00:0a:05:00:02')?.[2] === 'P1（A）' && row('02:00:0a:05:00:03')?.[2] === 'P2（B）' && table.every((r) => r[0] === '1' && /^\d+ 秒$/.test(r[4]) && Number.parseInt(r[4]) <= 300),
    `MAC テーブル: VLAN 1 で A は P1・B は P2（${table.map((r) => r.join(' ')).join(' / ')}）`);
  // エージング: 3 秒にすると、通信の無い MAC はすぐ消える
  await p.fill('#aging', '3');
  await p.dispatchEvent('#aging', 'change');
  await p.waitForTimeout(4000);
  const aged = await p.evaluate(() => window.__v86link.sw.entries().map((e) => e.remainingMs));
  const agedRows = await p.$$eval('#mac-rows tr', (l) => l.map((r) => r.cells[4]?.textContent));
  check(aged.every((ms) => ms <= 3000) && aged.length < table.length, `エージング 3 秒: 古いエントリが消える（${table.length} → ${aged.length} 件、残り ${agedRows.join(', ') || 'なし'}）`);
  await p.fill('#aging', '300');
  await p.dispatchEvent('#aging', 'change');

  // MAC フラッディング: 上限 1024 件で新しい MAC を覚えなくなり、スイッチでも C に見える
  const flood = await sniff('macFlood');
  const fstat = await p.textContent('#mac-status');
  const fsize = await p.evaluate(() => window.__v86link.sw.tableSize);
  check(fsize === 1024 && /いっぱい/.test(fstat) && /覚えられなかった/.test(fstat), `MAC フラッディング: テーブルは 1024 件で止まる（「${fstat}」）`);
  check(flood.icmpAB.length > 0 && flood.recs.some((r) => r.decision === 'flood' && r.out.includes(2)),
    `MAC フラッディング: スイッチでも C の tcpdump に A↔B の ICMP が出る（${flood.captured} packets captured）`);
  await p.click('#clear-table');
  const pending = await p.evaluate(() => window.__v86link.sw.tableSize);
  check(pending < 10, `テーブルを空にする（${pending} 件。空にした直後に流れたフレームの分だけ）`);

  // pcap: 1フレーム = 1件（ハブで複数のポートへ届けても重ならない）
  const pcapN = await savePcap('n-vms.pcap');
  check(records(pcapN.bytes) === pcapN.counts.forwarded, `pcap（3台）: ${records(pcapN.bytes)} 件 = キャプチャの転送したフレームの件数（フラッディングで重複しない）`);
  if (hasTool('tcpdump')) {
    const r = spawnSync('tcpdump', ['-nn', '-r', pcapN.file, 'icmp and host 10.5.0.2 and host 10.5.0.3'], { encoding: 'utf8' });
    const n = r.stdout.trim().split('\n').filter(Boolean).length;
    const want = hub.recs.length + swi.recs.length + flood.recs.length;
    check(r.status === 0 && n === want, `tcpdump -r: A↔B の ICMP は ${n} 件（キャプチャの ${want} 件と同じ。1フレーム 1件）`);
  }

  // --- 4台目を足す・1台消す ---
  const slotD = await addVm(p);
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 2 10.5.0.5\n');
  const pingD = await waitLog(p, 0, /2 packets transmitted, (\d+) received/, m0, 30000);
  check(slotD === 3 && / 2 received/.test(pingD), `4台目 D（10.5.0.5）を足して、A から ping が通る（${pingD}）`);
  // 4台それぞれのターミナルに打った文字が、その VM にだけ届く
  let routed = true;
  for (const vm of [0, 1, 2, 3]) {
    const before = await Promise.all([0, 1, 2, 3].map((x) => mark(p, x)));
    await p.locator(`.vm[data-slot="${vm}"] .xterm`).click();
    await p.keyboard.type(`echo to-$((${vm}+100))`);
    await p.keyboard.press('Enter');
    await waitLog(p, vm, new RegExp(`^to-${vm + 100}`, 'm'), before[vm]);
    for (const x of [0, 1, 2, 3]) if (x !== vm) routed &&= !(await p.evaluate(([x, m]) => window.__v86link.bySlot(x).log.slice(m).includes('to-'), [x, before[x]]));
  }
  check(routed, '4台: 各ターミナルへの入力は、その VM にだけ届く');
  await shot(p, 'v86-link-4vms.png');

  await p.evaluate(() => window.gc?.());
  const rss4 = await rendererRssMB(cdp);
  await p.click('.vm[data-slot="1"] .vm-remove');
  // トポロジー図は次の描画で更新される
  await p.waitForFunction(() => !window.__v86link.bySlot(1) && !window.__v86link.sw.port(1) && document.querySelectorAll('#topology line').length === 3);
  const afterRemove = await p.evaluate(() => ({
    n: window.__v86link.machines.length, cards: document.querySelectorAll('.vm').length,
    macB: window.__v86link.sw.entries().some((e) => e.port === 1), lines: document.querySelectorAll('#topology line').length,
  }));
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 2 -W 1 10.5.0.3\n');
  const pingGone = await waitLog(p, 0, /2 packets transmitted, (\d+) received/, m0, 30000);
  check(afterRemove.n === 3 && afterRemove.cards === 3 && !afterRemove.macB && afterRemove.lines === 3 && / 0 received/.test(pingGone),
    `B を削除: カード・ポート・MAC テーブル・トポロジー図の B が消え、B への ping は届かない（${JSON.stringify(afterRemove)}、${pingGone}）`);
  // メモリ: GC させてから、レンダラーの RSS を見る
  const pcdp = await ctx.newCDPSession(p);
  await pcdp.send('HeapProfiler.collectGarbage');
  await p.waitForTimeout(3000);
  await pcdp.send('HeapProfiler.collectGarbage');
  const rss3 = await rendererRssMB(cdp);
  report.memoryRemoveMB = { with4: rss4, afterRemove: rss3, freed: rss4 - rss3 };
  check(rss4 - rss3 >= 40, `削除で VM のメモリが解放される（レンダラーの RSS ${rss4}MB → ${rss3}MB、${rss4 - rss3}MB 減。ゲストは 64MB）`);
  // 足し直すと、空いたスロット（B・10.5.0.3）に入る
  const slotB2 = await addVm(p);
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 2 10.5.0.3\n');
  const pingBack = await waitLog(p, 0, /2 packets transmitted, (\d+) received/, m0, 30000);
  check(slotB2 === 1 && / 2 received/.test(pingBack), `足し直すと空いた B（P2・10.5.0.3）に入り、ping が通る（${pingBack}）`);
  await p.evaluate(() => window.__litObs?.disconnect());

  // ================================================================ ルーティング（L3）と VLAN
  // C と D を消して軽くしてから、A を LAN1（VLAN 10）、B を LAN2（VLAN 20）、ルーター R（P8・トランク）にする
  for (const slot of [2, 3]) await p.click(`.vm[data-slot="${slot}"] .vm-remove`);
  await p.waitForFunction(() => window.__v86link.machines.length === 2);
  await p.click('#cap-clear');
  const capL3From = await p.evaluate(() => window.__v86link.capture.nextNo);
  const tLab = Date.now();
  let ma = await mark(p, 0);
  await p.evaluate(() => window.__v86link.runPreset('routerPing'));
  report.labMs = Date.now() - tLab;
  const labState = await p.evaluate(() => window.__v86link.machines.map((m) => ({ name: m.name, role: m.role, ip: m.ip, vlan: m.port.vlan })));
  check(labState.length === 3 && labState[0].ip === '10.5.1.2' && labState[0].vlan.access === 10 && labState[1].ip === '10.5.2.2' && labState[1].vlan.access === 20
    && labState[2].role === 'router' && labState[2].vlan.mode === 'trunk' && labState[2].vlan.allowed.join() === '1,10,20',
    `L3 の構成: A 10.5.1.2（VLAN 10）・B 10.5.2.2（VLAN 20）・R はトランク（1,10,20）（${report.labMs}ms）`);
  const pingL3 = await waitLog(p, 0, /3 packets transmitted, 3 received/, ma, 30000);
  const ttlLines = await p.evaluate((m) => window.__v86link.bySlot(0).log.slice(m).split('\n').filter((l) => /bytes from 10\.5\.2\.2: icmp_seq=\d+ ttl=/.test(l)).map((l) => /ttl=(\d+)/.exec(l)[1]), ma);
  check(!!pingL3 && ttlLines.length === 3 && ttlLines.every((t) => t === '63'), `(a) 別のサブネットの B へ ping が通り、ttl=63（ルーターで 1 減る）: ${ttlLines.join(', ')}`);
  const tr = await waitLog(p, 0, /traceroute to 10\.5\.2\.2[^\n]*\n\s*1\s+10\.5\.1\.1[^\n]*\n\s*2\s+10\.5\.2\.2/, ma, 30000);
  check(!!tr, 'traceroute: 1ホップ目がルーター 10.5.1.1、2ホップ目が B 10.5.2.2');
  const te = await waitLog(p, 0, /From 10\.5\.1\.1 icmp_seq=1 Time to live exceeded/, ma, 30000);
  check(!!te, `ping -t 1: ルーターが「${te}」を返す`);
  const routes = await p.textContent('#router-routes');
  const fwdState = await p.textContent('#router-state');
  check(/10\.5\.1\.0\/24 dev eth0/.test(routes) && /10\.5\.2\.0\/24 dev eth0/.test(routes) && /ip_forward = 1/.test(fwdState),
    `ルーターのパネルに、ゲストの ip route と転送の状態（${fwdState}）がテキストで出る`);
  // キャプチャ: A→R はタグなしで入り、トランクへ VLAN 10 のタグを付けて出る。R→B は VLAN 20 のタグ付きで入り、TTL 63
  const l3recs = await p.evaluate((from) => {
    const { capture, captureView } = window.__v86link;
    return capture.list().filter((r) => r.no >= from).map((r) => ({ r, x: captureView.parse(r) })).filter(({ x }) => x.protocol === 'ICMP')
      .map(({ r, x }) => ({ in: r.inPort, out: r.outPorts, vlan: r.vlan, inTag: r.inTag, outTags: r.outTags, ttl: x.ttl, src: x.src, dst: x.dst, info: x.info, tags: x.vlans.map((v) => v.id) }));
  }, capL3From);
  const aToR = l3recs.filter((r) => r.in === 0 && r.dst === '10.5.2.2' && /request/.test(r.info));
  const rToB = l3recs.filter((r) => r.in === 7 && r.dst === '10.5.2.2' && /request/.test(r.info));
  const texc = l3recs.filter((r) => /Time exceeded/.test(r.info));
  // ping -t 1 の1件だけは TTL 1（ルーターが time exceeded を返す）
  check(aToR.filter((r) => r.ttl === 64).length >= 3 && aToR.every((r) => r.vlan === 10 && r.inTag === null && (r.ttl === 64 || r.ttl === 1) && r.out.join() === '7' && r.outTags.join() === '10'),
    `キャプチャ: A→R の echo request は VLAN 10・タグなしで入り、R のトランクへ VLAN 10 のタグ付きで出る（TTL 64、${aToR.length} 件）`);
  check(rToB.length >= 3 && rToB.every((r) => r.vlan === 20 && r.inTag === 20 && r.tags.join() === '20' && r.ttl === 63 && r.out.join() === '1' && r.outTags[0] === null),
    `キャプチャ: R→B は VLAN 20 のタグ付きで入り（TTL 63）、B へはタグを外して出る（${rToB.length} 件）`);
  check(texc.length >= 1 && texc[0].src === '10.5.1.1' && texc[0].inTag === 10 && /元: 10\.5\.1\.2 → 10\.5\.2\.2/.test(texc[0].info),
    `キャプチャ: ICMP Time exceeded（${texc[0]?.info}）`);
  await filterRows(p, 'vlan 20', "r.querySelector('.c-vlan').textContent.replace(/[\\[\\]]/g, '') === '20'");
  await filterRows(p, 'ttl:63 icmp vlan 20', "r.querySelector('.c-ttl').textContent === '63'");
  const ttlRow = await p.$eval('#cap-spacer .cap-row', (r) => [r.querySelector('.c-vlan').textContent, r.querySelector('.c-path').textContent]);
  check(ttlRow[0] === '[20]' && /^R\[20\] → B$/.test(ttlRow[1]), `一覧: VLAN 列「${ttlRow[0]}」（タグ付きで入った）・経路「${ttlRow[1]}」・フィルタ vlan 20 / ttl:63 icmp vlan 20`);
  await p.click('#cap-spacer .cap-row');
  const l3detail = await p.$eval('#cap-detail', (d) => d.textContent);
  check(/802\.1Q Virtual LAN/.test(l3detail) && /VLAN ID20/.test(l3detail) && /TTL63/.test(l3detail), '詳細: 802.1Q Virtual LAN（VLAN ID 20）と TTL 63');
  await p.fill('#cap-filter', '');
  // MAC テーブル: ルーターの MAC が VLAN 1・10・20 にそれぞれある（VLAN ごとのテーブル）
  const vrows = await p.$$eval('#mac-rows tr', (l) => l.map((r) => [...r.cells].map((c) => c.textContent)));
  const rv = vrows.filter((r) => r[1] === '02:00:0a:05:00:01').map((r) => r[0]).sort();
  check(rv.includes('10') && rv.includes('20') && vrows.some((r) => r[0] === '10' && r[1] === '02:00:0a:05:01:02') && vrows.some((r) => r[0] === '20' && r[1] === '02:00:0a:05:02:02'),
    `MAC テーブル（VLAN 列）: ルーターの MAC が VLAN ${rv.join('・')} に別々に入る`);
  await shot(p, 'v86-link-router.png');

  // (b) ip_forward OFF → 通らない、ON → 通る
  ma = await mark(p, 0);
  await p.evaluate(() => window.__v86link.runPreset('forwardOff'));
  const off = await waitLog(p, 0, /3 packets transmitted, 0 received/, ma, 30000);
  const on = await waitLog(p, 0, /2 packets transmitted, 2 received/, ma, 30000);
  check(!!off && !!on, `(b) ルーターの ip_forward を OFF にすると ping が通らない（${off}）。ON に戻すと通る`);
  // ゲートウェイを消すと Network is unreachable
  ma = await mark(p, 0);
  await p.evaluate(() => window.__v86link.runPreset('noGateway'));
  const unreach = await waitLog(p, 0, /ping: connect: Network is unreachable/, ma, 30000);
  const gwBack = await waitLog(p, 0, /2 packets transmitted, 2 received/, ma, 30000);
  check(!!unreach && !!gwBack, '(b) A のデフォルトルートを消すと「Network is unreachable」。設定し直すと通る');

  // (c) VLAN 分離（同じサブネットでも VLAN が違えば通らない）と VLAN 間ルーティング
  ma = await mark(p, 0);
  await p.evaluate(() => window.__v86link.runPreset('vlanIsolation'));
  const iso = await waitLog(p, 0, /2 packets transmitted, 0 received/, ma, 30000);
  const same = await waitLog(p, 0, /2 packets transmitted, 2 received/, ma, 30000);
  check(!!iso && !!same, '(c) VLAN 分離: A と B を同じ LAN1 にしても、B のポートが VLAN 20 だと通らない。VLAN 10 に戻すと通る');
  ma = await mark(p, 0);
  await p.evaluate(() => window.__v86link.runPreset('interVlan'));
  const noRouter = await waitLog(p, 0, /2 packets transmitted, 0 received/, ma, 30000);
  const viaRouter = await waitLog(p, 0, /3 packets transmitted, 3 received/, ma, 30000);
  const viaTtl = await p.evaluate((m) => window.__v86link.bySlot(0).log.slice(m).match(/ttl=\d+/g) ?? [], ma);
  check(!!noRouter && !!viaRouter && viaTtl.length >= 3 && viaTtl.every((t) => t === 'ttl=63'),
    `(c) VLAN 間ルーティング: R のケーブルを抜くと VLAN 10 → 20 は通らない。router-on-a-stick（R のトランク）で通る（${viaTtl.slice(0, 3).join(', ')}）`);

  // ポートの設定パネル（トポロジー図から開く）: 不正な値は反映しない・正しい値は反映する
  await p.click('#topology [data-port="1"]');
  await p.fill('#port-panel .pf-access', '5000');
  await p.click('#port-panel button[type=submit]');
  const badMsg = await p.textContent('#port-panel .pf-msg');
  const stillB = await p.evaluate(() => window.__v86link.sw.port(1).vlan.access);
  await p.selectOption('#port-panel .pf-mode', 'trunk');
  await p.fill('#port-panel .pf-allowed', '20,30');
  await p.fill('#port-panel .pf-native', '20');
  await p.click('#port-panel button[type=submit]');
  const good = await p.evaluate(() => window.__v86link.sw.port(1).vlan);
  check(/反映できません/.test(badMsg) && stillB === 20 && good.mode === 'trunk' && good.allowed.join() === '20,30' && good.native === 20,
    `ポートの設定パネル: 不正な値（5000）は「${badMsg}」で反映しない。トランク（許可 20,30・ネイティブ 20）は反映する`);
  await p.evaluate(() => window.__v86link.setVlanPlan(true));

  // (d) pcap: VLAN タグと TTL を scapy（なければ tcpdump）で確かめる
  const pcapL3 = await savePcap('l3.pcap');
  const py = process.env.PYTHON || 'python3';
  const scapy = spawnSync(py, ['-c', `
import sys
from scapy.all import rdpcap, Dot1Q, IP, ICMP
n = {}
for p in rdpcap(sys.argv[1]):
    if IP in p and ICMP in p and p[IP].src == '10.5.1.2' and p[IP].dst == '10.5.2.2' and p[ICMP].type == 8:
        k = (p[Dot1Q].vlan if Dot1Q in p else None, p[IP].ttl)
        n[k] = n.get(k, 0) + 1
print(sorted(n.items(), key=str))
`, pcapL3.file], { encoding: 'utf8' });
  if (scapy.status === 0) {
    check(/\(\(20, 63\), \d+\)/.test(scapy.stdout) && /\(\(None, 64\), \d+\)/.test(scapy.stdout),
      `(d) pcap を scapy で読むと、A→B の echo request は「タグなし・TTL 64」（A のポートで入った）と「VLAN 20・TTL 63」（R のトランクから入った）: ${scapy.stdout.trim()}`);
  } else if (hasTool('tcpdump')) {
    const r = spawnSync('tcpdump', ['-nn', '-e', '-v', '-r', pcapL3.file, 'vlan 20 and icmp'], { encoding: 'utf8' });
    check(/vlan 20/.test(r.stdout) && /ttl 63/.test(r.stdout), '(d) pcap を tcpdump -e -v で読むと VLAN 20・ttl 63 が見える（scapy は無い）');
  } else {
    say('SKIP scapy も tcpdump も無いので、pcap の VLAN タグと TTL は確かめていない');
  }

  // ゲストの出力（ip route の結果）に HTML が入っていても、ただの文字として出る
  await send(p, 7, `ip() { echo '<img src=x onerror="window.__xss=3"><b>bold</b>'; }\n`);
  await p.waitForTimeout(500);
  await p.click('#router-refresh');
  await p.waitForFunction(() => document.getElementById('router-routes').textContent.includes('<img'), null, { timeout: 15000 });
  await send(p, 7, 'unset -f ip\n');
  const rx = await p.evaluate(() => ({ flag: window.__xss ?? null, els: document.querySelectorAll('#router-routes *').length, text: document.getElementById('router-routes').textContent }));
  check(rx.flag === null && rx.els === 0 && rx.text.includes('<b>bold</b>'), 'ルーターのパネル: ゲストの出力に HTML があっても要素は作られず、文字として出る');
  await p.click('#router-refresh');

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
  check(true, `再読込後の起動（ダウンロード ${report.secondBoot.download}ms、ブート A ${report.secondBoot.boot[0]}ms・B ${report.secondBoot.boot[1]}ms）`);

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

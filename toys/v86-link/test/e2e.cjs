// v86-link の通し確認（実ブラウザ: ヘッドレス Chromium）。シリアル出力の文字列で確かめる
//
//   npx http-server -p 8080        # リポジトリのルートで
//   （URL を http://v86-link.test/ にすると、サーバーを立てずに Playwright の route でファイルを返す。SNAPSHOT=off で ?snapshot=off を付ける）
//   node toys/v86-link/test/e2e.cjs [ページのURL]
//
// playwright が必要。SHOT_DIR を設定すると、画面のスクリーンショットを保存する。
// 計測値（ブート時間・メモリ・ping・HTTP・入力の遅延）も表示する（docs/results.md に記録）。
const { chromium } = require('playwright');
const { serveLocal, withSnapshotParam } = require('./serve-route.cjs');
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
/**
 * ネットワーク設定の結果の表示（netcmd.js）。新しいイメージは ip -br（「eth0  UNKNOWN  10.5.0.2/24 …」の次の行に MAC）、
 * 以前のイメージは ip addr show | grep（link/ether … inet …）。どちらでも、その IP と MAC が出ていれば合う
 */
const netShown = (ip, mac) => {
  const i = ip.replace(/\./g, '\\.'), m = mac;
  return new RegExp(`(?:link\\/ether ${m}[\\s\\S]*inet ${i}\\/24)|(?:${i}\\/24[^\\n]*\\n[^\\n]*${m})`);
};
/** 設定の結果の表示のあとに NET-OK（やり直しで同じ設定になったか） */
const netOkAfter = (ip) => new RegExp(`${ip.replace(/\./g, '\\.')}\\/24[^\\n]*\\n(?:[^\\n]*\\n)?\\s*NET-OK`);
/** VM のシリアルでコマンドを実行して、マーカーまでの出力を返す */
async function shellOut(p, vm, cmd, timeout = 30000) {
  const tag = 'SH' + Math.random().toString(36).slice(2, 8);
  const m = await mark(p, vm);
  await send(p, vm, `${cmd}; echo "${tag}""-END"\n`);
  await waitLog(p, vm, new RegExp(`^${tag}-END`, 'm'), m, timeout);
  return p.evaluate(([vm, m]) => window.__v86link.bySlot(vm).log.slice(m).replace(/\r/g, ''), [vm, m]);
}
const send = (p, vm, text) => p.evaluate(([vm, t]) => window.__v86link.bySlot(vm).node.writeSerial(t), [vm, text]);
const click = (p, sel) => p.evaluate((s) => document.querySelector(s).click(), sel);
/** プリセットを始める（終わるのは待たない。以前のボタンを押したのと同じ） */
const preset = (p, key) => p.evaluate((k) => { window.__v86link.runPreset(k); }, key);
/** 観察のタブ（図・MAC テーブル・ルーター）を開く */
const observe = (p, tab) => p.click(`[data-tabs="observe"] [data-tab="${tab}"]`);
/** ポートの設定パネル（図の VM をクリック）で、ケーブルを抜く / 差す・遅延を変える */
async function portPanel(p, slot) {
  await observe(p, 'topology');
  await p.click(`#topology g.vm-node[data-port="${slot}"]`);
  await p.waitForSelector(`#port-panel .pf-unplug`);
}
async function cable(p, slot, plugged) {
  await portPanel(p, slot);
  if (plugged) await p.uncheck('#port-panel .pf-unplug'); else await p.check('#port-panel .pf-unplug');
}

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
  // 端末は全部並べて表示する（キー入力のテストでクリックするため）
  await p.evaluate(() => window.__v86link.setTermView(true, null));
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
  // PW_CHANNEL=chrome で、入っている Google Chrome を使う（CI。ブラウザを別に取らない）
  const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  await serveLocal(ctx, BASE);
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
  await p.goto(withSnapshotParam(BASE));
  report.rssBeforeMB = await rendererRssMB(cdp);
  await startJank(p);
  report.firstBoot = await bootBoth(p);
  report.jankDuringBoot = await readJank(p);
  report.rssAfterBootMB = await rendererRssMB(cdp);
  check(true, `2台とも起動（ダウンロード ${report.firstBoot.download}ms、ブート A ${report.firstBoot.boot[0]}ms・B ${report.firstBoot.boot[1]}ms、ネットワーク設定まで ${report.firstBoot.net.join('/')}ms）`);
  check(await p.evaluate(() => document.getElementById('state').textContent) === '2 台とも起動', '起動の表示: ' + await p.evaluate(() => document.getElementById('state').textContent));

  // --- ネットワーク設定（起動後に自動。ボタンでやり直せる） ---
  check(!!(await waitLog(p, 0, netShown('10.5.0.2', '02:00:0a:05:00:02'), 0)) && !!(await waitLog(p, 1, netShown('10.5.0.3', '02:00:0a:05:00:03'), 0)),
    'ネットワーク設定（自動）: A 10.5.0.2/24・MAC 02:00:0a:05:00:02、B 10.5.0.3/24・MAC 02:00:0a:05:00:03');
  let m0 = await mark(p, 0), m1 = await mark(p, 1);
  await click(p, '#net');
  check(!!(await waitLog(p, 0, netOkAfter('10.5.0.2'), m0)) && !!(await waitLog(p, 1, netOkAfter('10.5.0.3'), m1)), 'ネットワーク設定をやり直しても同じ設定になる');
  // 2 回続けてやり直しても NET-OK（ip のバッチは route replace・addr flush なので、何度実行しても通る）
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await click(p, '#net');
  await waitLog(p, 0, /^NET-OK/m, m0);
  await waitLog(p, 1, /^NET-OK/m, m1);
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await click(p, '#net');
  check(!!(await waitLog(p, 0, netOkAfter('10.5.0.2'), m0)) && !!(await waitLog(p, 1, netOkAfter('10.5.0.3'), m1)), 'ネットワーク設定のやり直しを 2 回続けても NET-OK');
  // ホスト名・MAC・IP・デフォルトゲートウェイが、以前のコマンドと同じ値（ip・hostname で確かめる）
  for (const [vm, host, ip, mac] of [[0, 'a', '10.5.0.2', '02:00:0a:05:00:02'], [1, 'b', '10.5.0.3', '02:00:0a:05:00:03']]) {
    const o = await shellOut(p, vm, 'echo HOST=$(hostname); ip -o -4 addr show dev eth0; ip -o link show dev eth0; ip route');
    check(new RegExp(`^HOST=${host}$`, 'm').test(o) && new RegExp(`inet ${ip.replace(/\./g, '\\.')}/24 `).test(o) && o.includes(`link/ether ${mac} `) &&
      /^default via 10\.5\.0\.1 dev eth0/m.test(o) && new RegExp(`^10\\.5\\.0\\.0/24 dev eth0 .*src ${ip.replace(/\./g, '\\.')}`, 'm').test(o),
      `${host.toUpperCase()}: ホスト名 ${host}・IP ${ip}/24・MAC ${mac}・デフォルトゲートウェイ 10.5.0.1（ip・hostname で確かめる）`);
  }

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
  for (const [key, vm, label] of [['pingAB', 0, 'A→B'], ['pingBA', 1, 'B→A']]) {
    const m = await mark(p, vm);
    await preset(p, key);
    const stat = await waitLog(p, vm, /4 packets transmitted, (\d+) received[^\n]*\n[^\n]*rtt min\/avg\/max\/mdev = [\d.\/]+ ms/, m, 60000);
    rtt[label] = /= ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stat).slice(1).map(Number);
    check(/4 received/.test(stat), `ping ${label}: ${stat.split('\n')[0].trim()}（rtt min/avg/max ${rtt[label].join('/')} ms）`);
  }
  report.pingRtt = rtt;

  // --- HTTP ---
  m1 = await mark(p, 1);
  await preset(p, 'httpServe');
  await waitLog(p, 1, /socat TCP-LISTEN:8080[^\n]*\n[\s\S]*% $/, m1, 30000);
  await p.waitForTimeout(1000);
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await preset(p, 'httpGet');
  const http = await waitLog(p, 0, /hello from B \(10\.5\.0\.3\)[\s\S]*?\(HTTP (\d+), ([\d.]+)s\)/, m0, 60000);
  const [, code, secs] = /\(HTTP (\d+), ([\d.]+)s\)/.exec(http);
  report.httpSeconds = Number(secs);
  const access = await waitLog(p, 1, /\d\d:\d\d:\d\d GET \/ HTTP\/1\.1/, m1, 10000);
  check(code === '200', `HTTP: A が B（socat + シェルの HTTP サーバー）から取得（HTTP ${code}、${secs}s）。B のログ「${access}」`);

  // --- TCP（nc の代わりに socat） ---
  m0 = await mark(p, 0); m1 = await mark(p, 1);
  await preset(p, 'tcpOpen');
  await p.waitForTimeout(3000);
  await preset(p, 'tcpSend');
  const gotRight = await waitLog(p, 1, /^hello from A/m, m1, 20000);
  const gotLeft = await waitLog(p, 0, /^hello from B/m, m0, 20000);
  check(!!gotRight && !!gotLeft, 'TCP: A→B「hello from A」、B→A「hello from B」が届く');
  await preset(p, 'tcpClose');
  await waitLog(p, 0, /a:~% $/, m0, 10000);
  await waitLog(p, 1, /b:~% $/, m1, 10000);
  await shot(p, 'v86-link-desktop.png');

  // --- ケーブルを抜く → ping 失敗、差す → 復旧 ---
  const dropped0 = await p.evaluate(() => window.__v86link.stats.dropped);
  await cable(p, 1, false);
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 -W 1 10.5.0.3\n');
  const lost = await waitLog(p, 0, /3 packets transmitted, 0 received, 100% packet loss/, m0, 60000);
  const dropped1 = await p.evaluate(() => window.__v86link.stats.dropped);
  check(!!lost && dropped1 > dropped0, `ケーブルを抜くと ping が失敗（${lost}、捨てたフレーム +${dropped1 - dropped0}）`);
  await cable(p, 1, true);
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 4 10.5.0.3\n');
  const back = await waitLog(p, 0, /4 packets transmitted, (\d+) received/, m0, 60000);
  check(!/ 0 received/.test(back), `ケーブルを差すと復旧（${back}）`);

  // --- 遅延 ---
  // A のポートの遅延 200ms: A から出るフレームにも A へ届くフレームにも足される
  await portPanel(p, 0);
  await p.fill('#port-panel .pf-delay', '200');
  m0 = await mark(p, 0);
  await send(p, 0, 'ping -c 3 10.5.0.3\n');
  const slow = await waitLog(p, 0, /rtt min\/avg\/max\/mdev = [\d.\/]+ ms/, m0, 60000);
  const avg = Number(/= [\d.]+\/([\d.]+)/.exec(slow)[1]);
  check(avg >= 380, `A のポートに遅延 200ms を足すと、往復が ${avg}ms になる`);
  await p.fill('#port-panel .pf-delay', '0');

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
  await cable(p, 1, false);
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
  await cable(p, 1, true);
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

  // --- シーケンス（ラダー図。ladder.js・ladderview.js） ---
  {
    const raf = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await p.click('[data-tabs="drawer"] [data-tab="ladder"]');
    await raf();
    // 上で注入した壊れたフレーム・HTML を含むフレームも描く。要素は作られず、実行もされない
    const lx = await p.evaluate(() => ({ flag: window.__xss ?? null, els: document.querySelectorAll('#ladder img, #ladder script, #ladder foreignObject, #ladder iframe').length, rows: document.querySelectorAll('#lad-svg g.lrow').length }));
    check(lx.flag === null && lx.els === 0 && lx.rows > 0 && pageErrors.length === errorsBefore,
      `シーケンス: 壊れたフレーム・HTML を含むフレームがあっても描ける（描いた行 ${lx.rows}。HTML の要素は作られず、実行もされない）`);
    // A→B の ping 1 回（ARP キャッシュを消してから）: ARP 2 本と ICMP 2 本が正しいレーンに出る
    await p.evaluate(() => window.__v86link.capture.clear());
    m0 = await mark(p, 0);
    await send(p, 1, 'ip neigh flush dev eth0\n');
    await send(p, 0, 'ip neigh flush dev eth0; ping -c 1 10.5.0.3\n');
    await waitLog(p, 0, /1 packets transmitted, 1 received/, m0, 30000);
    await p.waitForTimeout(300);
    await raf();
    const lad = await p.evaluate(() => {
      const v = window.__v86link.ladderView;
      return { lanes: v.layout.lanes.map((l) => l.id), rows: v.layout.rows.filter((r) => r.protocol === 'ARP' || r.protocol === 'ICMP').map((r) => ({ no: r.no, from: r.from, to: r.to, kind: r.kind, label: r.label })),
        names: [...document.querySelectorAll('#lad-head .lad-lane')].map((x) => x.textContent) };
    });
    const arp = lad.rows.filter((r) => /Who has|is at/.test(r.label));
    const icmp = lad.rows.filter((r) => /^echo /.test(r.label));
    check(arp.length === 2 && arp[0].from === 0 && JSON.stringify(arp[0].to) === '[1]' && arp[0].label === 'Who has 10.5.0.3?' && arp[0].kind === 'flood'
      && arp[1].from === 1 && JSON.stringify(arp[1].to) === '[0]' && /^10\.5\.0\.3 is at 02:00:0a:05:00:03$/.test(arp[1].label)
      && icmp.length === 2 && icmp[0].from === 0 && JSON.stringify(icmp[0].to) === '[1]' && /^echo request seq=1 ttl=64$/.test(icmp[0].label)
      && icmp[1].from === 1 && JSON.stringify(icmp[1].to) === '[0]' && /^echo reply seq=1 ttl=64$/.test(icmp[1].label)
      && lad.names.includes('A') && lad.names.includes('B'),
      `シーケンス: ping 1 回で ARP 2 本（A→B ブロードキャスト・B→A）と ICMP 2 本（A→B・B→A）が正しいレーンに出る（${JSON.stringify(lad.rows.map((r) => [r.from, r.to, r.label]))}）`);
    // 矢印のクリック → 一覧の同じ行が選ばれ、横に詳細が出る
    await p.click(`#lad-svg g.lrow[data-no="${icmp[1].no}"]`);
    await raf();
    const picked = await p.evaluate(() => ({ no: window.__v86link.captureView.selected?.no, detail: document.querySelector('#lad-detail').textContent, capDetail: document.querySelector('#cap-detail').textContent,
      highlighted: document.querySelector('#lad-svg g.lrow.selected')?.dataset.no }));
    check(picked.no === icmp[1].no && /ICMP/.test(picked.detail) && /ICMP/.test(picked.capDetail) && Number(picked.highlighted) === icmp[1].no,
      `シーケンス: 矢印をクリックすると、キャプチャの一覧で同じ行（No.${picked.no}）が選ばれ、詳細が出る`);
    // 反対向き: 一覧で選んだ行が、シーケンスで強調される
    await p.evaluate((no) => { const v = window.__v86link; v.captureView.select(v.capture.list().find((r) => r.no === no)); }, arp[0].no);
    await raf();
    const hl = await p.$eval('#lad-svg g.lrow.selected', (g) => Number(g.dataset.no)).catch(() => null);
    check(hl === arp[0].no, `シーケンス: 一覧で選んだ行（No.${arp[0].no}）がシーケンスで強調される`);
    // 「会話だけ」（A と B の間。ARP を選んだので、その 2 つの IP の間の全部）: IPv6 などは消える
    await p.click('#lad-conv');
    await raf();
    const conv = await p.evaluate(() => window.__v86link.ladderView.layout.rows.map((r) => r.protocol));
    await p.click('#lad-conv');
    await raf();
    check(conv.length === 4 && conv.every((x) => x === 'ARP' || x === 'ICMP'), `シーケンス:「会話だけ」で A⇄B のフレームだけになる（${conv.join(', ')}）`);
    await p.click('[data-tabs="drawer"] [data-tab="capture"]');
  }

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
  check(slotC === 2 && !!(await waitLog(p, 2, netShown('10.5.0.4', '02:00:0a:05:00:04'), 0)) && !!(await waitLog(p, 2, /^NET-OK/m, 0)) && /準備完了/.test(cState),
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
  await observe(p, 'mac');
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
  // シーケンス: MAC フラッディングのあと（約 1100 件）でも、タブの切り替えとスクロールが固まらない
  {
    const perf = await p.evaluate(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const v = window.__v86link;
      const t = performance.now();
      v.showTab('drawer', 'ladder');
      await raf();
      const open = performance.now() - t;
      const draws = [v.ladderView.lastDrawMs];
      const sc = document.getElementById('lad-scroll');
      for (const f of [0, 0.3, 0.6, 1]) {
        sc.scrollTop = f * (sc.scrollHeight - sc.clientHeight);
        sc.dispatchEvent(new Event('scroll'));
        await raf();
        draws.push(v.ladderView.lastDrawMs);
      }
      const drawn = document.querySelectorAll('#lad-svg g.lrow').length;
      v.showTab('drawer', 'capture');
      return { n: v.ladderView.layout.rows.length, open: Math.round(open), draws: draws.map((x) => Math.round(x * 10) / 10), layout: Math.round(v.ladderView.lastLayoutMs * 10) / 10, drawn };
    });
    report.ladderPerf = perf;
    check(perf.n >= 1000 && Math.max(...perf.draws) <= 50 && perf.drawn < 200,
      `シーケンス: ${perf.n} 件でも、1 回の描画は ${Math.max(...perf.draws)}ms 以内（タブを開くまで ${perf.open}ms、配置の計算 ${perf.layout}ms、描いた行は見えている範囲の ${perf.drawn} 行だけ）`);
  }
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
  // サブネットを変えたあとの設定（A は LAN1）と、ルーターの設定が、以前のコマンドと同じ値
  {
    const oa = await shellOut(p, 0, 'echo HOST=$(hostname); ip -o -4 addr show dev eth0; ip route');
    const or = await shellOut(p, 7, 'echo HOST=$(hostname) FWD=$(cat /proc/sys/net/ipv4/ip_forward) RA=$(cat /proc/sys/net/ipv4/conf/all/send_redirects) RE=$(cat /proc/sys/net/ipv4/conf/eth0/send_redirects); ip -o -4 addr show dev eth0; ip route');
    check(/^HOST=a$/m.test(oa) && /inet 10\.5\.1\.2\/24 /.test(oa) && /^default via 10\.5\.1\.1 dev eth0/m.test(oa) && !/10\.5\.0\.2/.test(oa),
      'サブネットを変えたあと: A は 10.5.1.2/24・デフォルトゲートウェイ 10.5.1.1（前のアドレスは残らない）');
    check(/HOST=r FWD=1 RA=0 RE=0/.test(or) && ['10.5.0.1', '10.5.1.1', '10.5.2.1'].every((ip) => or.includes(`inet ${ip}/24 `)) && !/^default/m.test(or),
      `ルーター: ホスト名 r・ip_forward 1・send_redirects 0（all・eth0）・各サブネットの .1・デフォルトルートなし（${or.split('\n').find((l) => /^HOST=/.test(l))}）`);
  }
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

  // (b) ip_forward OFF → 通らない、ON → 通る。学習の画面（選ぶ → 開始 → 手順を1つずつ実行）で行う
  ma = await mark(p, 0);
  await p.selectOption('#lesson', 'forwardOff');
  const hash = await p.evaluate(() => location.hash);
  const stepsShown = await p.$$eval('#lesson-steps .lesson-step', (l) => l.map((x) => x.querySelector('.step-title').textContent));
  const disabledBefore = await p.$eval('#lesson-steps .step-run', (b) => b.disabled);
  await p.click('#lesson-start');
  await p.waitForFunction(() => window.__v86link.lessonState.ready, null, { timeout: 120000 });
  const observeTab = await p.$eval('[data-tabs="observe"] .active', (b) => b.dataset.tab);
  for (let i = 0; i < stepsShown.length; i++) {
    await p.click(`#lesson-steps .lesson-step[data-step="${i}"] .step-run`);
    await p.waitForFunction((i) => window.__v86link.lessonState.done.has(i) && document.querySelector(`.lesson-step[data-step="${i}"]`).classList.contains('done'), i, { timeout: 60000 });
  }
  const shownTerms = await p.$$eval('.vm:not([hidden])', (l) => l.map((x) => x.dataset.slot).join());
  check(hash === '#lesson=forwardOff' && stepsShown.length === 4 && disabledBefore && observeTab === 'router' && shownTerms === '0,1,7',
    `学習の画面: 選ぶと URL が ${hash}、手順 ${stepsShown.length} 個（開始までは実行できない）。開始で構成をそろえ、観察は「ルーター」、端末は A・B・R を並べる`);
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
  await portPanel(p, 1);
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
  await observe(p, 'router');
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

  // --- スナップショット（snapshot.js。?snapshot=off なら、全台が通常の起動であることだけ確かめる） ---
  {
    const snapOn = await p.evaluate(() => window.__v86link.snapshot.enabled);
    const vmsOf = (q) => q.evaluate(() => window.__v86link.snapshot.vms());
    /** MAC テーブルに 00:22:15:…（ne2k の既定の MAC。復元した VM は全台同じ）が入ったら記録する。起動の前に付ける */
    const watchLearn = (q) => q.evaluate(() => {
      const sw = window.__v86link.sw;
      window.__ne2kLearned = [];
      const learn = sw.learn.bind(sw);
      sw.learn = (vlan, key, portId, now) => {
        if (Math.floor(key / 2 ** 24) === 0x002215) window.__ne2kLearned.push({ port: portId, mac: key.toString(16) });
        return learn(vlan, key, portId, now);
      };
    });
    const allReady = (q, n) => q.waitForFunction((n) => window.__v86link.machines.length === n && window.__v86link.machines.every((m) => m.netReady), n, { timeout: 600000, polling: 200 });
    /** VM のシリアルでコマンドを実行して、マーカーまでの出力を返す */
    const runOn = async (q, slot, cmd, timeout = 30000) => {
      const tag = 'SNAP' + Math.random().toString(36).slice(2, 8);
      const m = await q.evaluate((s) => window.__v86link.bySlot(s).log.length, slot);
      await q.evaluate(([s, t]) => window.__v86link.bySlot(s).node.writeSerial(t), [slot, `${cmd}; echo "${tag}""-END"\n`]);
      await q.waitForFunction(([s, m, t]) => window.__v86link.bySlot(s).log.slice(m).includes(t + '-END'), [slot, m, tag], { timeout });
      return q.evaluate(([s, m]) => window.__v86link.bySlot(s).log.slice(m), [slot, m]);
    };
    const v = await vmsOf(p);
    const snapMode = await p.evaluate(() => window.__v86link.snapshot.mode);
    report.snapshotFirstPage = v;
    if (!snapOn) {
      check(v.every((x) => !x.restored), `?snapshot=off: 全台が通常の起動（${JSON.stringify(v.map((x) => [x.name, x.restored]))}）`);
    } else {
      // このページは読み直したあと。既定（保存した起動イメージ）なら、1 回目に保存したものから全台が復元している
      if (snapMode === 'persist') {
        check(v.length >= 2 && v.every((x) => x.restored && x.from === 'saved') && !v.some((x) => x.savedTemplate),
          `保存した起動イメージ: 読み直すと、作る役が無く全台が保存したものから復元（${JSON.stringify(v.map((x) => [x.name, x.from, Math.round(x.netMs)]))}）`);
      } else {
        check(v.length >= 2 && v.filter((x) => x.savedTemplate).length === 1 && v.filter((x) => x.restored).length === v.length - 1,
          `スナップショット: 1 台目が通常の起動でテンプレートを作り、ほかは復元（${JSON.stringify(v.map((x) => [x.name, x.restored, x.restoreMs && Math.round(x.restoreMs)]))}）`);
      }
      const label = await p.$eval('.vm[data-slot="1"] .vm-state', (e) => e.textContent);
      check(snapMode === 'persist' ? /準備完了 .*（保存から復元）/.test(label) : /準備完了 .*（復元）/.test(label), `準備完了の表示に復元と出る（${label}）`);
      // ここから先のページ（段1 の確かめ）は、メモリだけ（?snapshot=memory）で開く。保存した起動イメージは下の別の項で確かめる
      const MEM = withSnapshotParam(BASE, 'memory');

      // 新しいページ: 4 台（1 台目がテンプレート、3 台を復元）
      const q = await ctx.newPage();
      q.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
      q.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
      await q.goto(MEM);
      await watchLearn(q);
      await q.evaluate(() => { document.getElementById('add-vm').click(); document.getElementById('add-vm').click(); document.getElementById('boot').click(); });
      await allReady(q, 4);
      const v4 = await vmsOf(q);
      report.snapshot4 = v4;
      check(v4.filter((x) => x.restored).length === 3, `4 台: 3 台を復元（${JSON.stringify(v4.map((x) => [x.name, x.restored, Math.round(x.netMs)]))}）`);
      const restoredSlots = v4.filter((x) => x.restored).map((x) => x.slot);
      // 時計: 準備完了の直後に、復元した VM の date とホストの時刻のずれを測る（参考に、通常の起動の VM も）。
      // v86 のゲストの時計は、ページが忙しいと実時間より遅れていくので、ほかの操作より先に測る
      const drift = [];
      for (const x of v4) {
        const out = await runOn(q, x.slot, 'echo UTS=$(date +%s)');
        drift.push({ name: x.name, restored: x.restored, d: Math.abs(Number(/^UTS=(\d+)\r?$/m.exec(out)?.[1]) - Date.now() / 1000) });
      }
      check(drift.filter((x) => x.restored).every((x) => x.d <= 2), `復元した VM の時計のずれが 2 秒以内（${drift.map((x) => `${x.name}${x.restored ? '' : '（通常の起動）'} ${x.d.toFixed(1)}`).join(' / ')} 秒）`);
      const ipOf = (slot) => `10.5.0.${slot + 2}`;
      // 復元した 3 台の間で ping・HTTP
      const pings = [];
      for (let i = 0; i < 3; i++) {
        const [a, b] = [restoredSlots[i], restoredSlots[(i + 1) % 3]];
        const out = await runOn(q, a, `ping -c 2 -w 5 ${ipOf(b)}`);
        pings.push(/2 packets transmitted, 2 received/.test(out));
      }
      check(pings.every(Boolean), `復元した 3 台の間で ping が通る（${pings.join('/')}）`);
      const [h, c1, c2] = restoredSlots;
      await runOn(q, h, `mkdir -p /tmp/snapw && echo snap-http-$((6*7)) > /tmp/snapw/index.html && httpd -p 80 -h /tmp/snapw`);
      const got = await Promise.all([runOn(q, c1, `wget -q -O - http://${ipOf(h)}/`), runOn(q, c2, `wget -q -O - http://${ipOf(h)}/`)]);
      check(got.every((x) => /^snap-http-42\r?$/m.test(x)), '復元した 3 台の間で HTTP が通る（BusyBox httpd → wget）');
      // 乱数: 準備完了から 3 秒以上たってから、復元した 2 台の uuid を比べる
      await q.waitForTimeout(3000);
      const uu = [];
      for (const s of [c1, c2]) uu.push(/^UUID=([0-9a-f-]{36})\r?$/m.exec(await runOn(q, s, 'echo UUID=$(cat /proc/sys/kernel/random/uuid)'))?.[1]);
      check(uu[0] && uu[1] && uu[0] !== uu[1], `復元した 2 台のゲストの乱数が違う（${uu.join(' / ')}）`);
      const learned = await q.evaluate(() => window.__ne2kLearned);
      const notReady = await q.evaluate(() => window.__v86link.capture.list().filter((r) => r.reason === 'not-ready').length);
      check(learned.length === 0, `MAC テーブルに ne2k の既定の MAC（00:22:15:…）が一度も入らない（${learned.length} 件。NET-OK の前に捨てたフレーム ${notReady} 件）`);
      check(await q.evaluate(() => [...window.__v86link.sw.ports.values()].every((x) => !x.hold)), '準備完了のあと、全ポートの入力が戻っている');
      // NET-OK まで捨てる条件: 捨てたフレームはどれも ne2k の元の MAC（00:22:15:…）から。割り当てた MAC からのフレームは通る
      const hold = await q.evaluate(() => {
        const { sw, capture, machines } = window.__v86link;
        const mac = (f) => [...f.slice(6, 12)].map((x) => x.toString(16).padStart(2, '0')).join(':');
        const dropped = capture.list().filter((r) => r.reason === 'not-ready').map((r) => mac(r.frame));
        // 確かめ: 復元した VM のポートを、もう一度 NET-OK 前と同じ状態にして、ne2k の MAC と割り当てた MAC のフレームを入れる
        const m = machines.find((x) => x.restored);
        const events = [];
        const off = sw.onFrame((ev) => events.push(ev.reason));
        sw.setHold(m.port, true, { allow: m.mac });
        const frame = (src) => Uint8Array.from([255, 255, 255, 255, 255, 255, ...src.split(':').map((x) => parseInt(x, 16)), 0x88, 0xb5, ...new Array(46).fill(0)]);
        sw.receive(m.port, frame('00:22:15:12:34:56'));
        sw.receive(m.port, frame(m.mac));
        sw.setHold(m.port, false);
        off();
        return { dropped, events };
      });
      check(hold.dropped.every((x) => x.startsWith('00:22:15:')) && JSON.stringify(hold.events) === '["not-ready",null]',
        `NET-OK まで捨てるのは ne2k の元の MAC（00:22:15:…）のフレームだけ。割り当てた MAC からのフレームは通る（捨てた ${hold.dropped.length} 件、確かめ ${JSON.stringify(hold.events)}）`);
      await q.close();

      // 壊れたテンプレート: 全台が destroy → 通常の起動で準備完了、その後の VM も通常の起動
      const r = await ctx.newPage();
      r.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
      r.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
      await r.goto(MEM);
      await r.evaluate(() => {
        const { snapshot, machines } = window.__v86link;
        const bad = new Uint8Array(4096);
        bad.set([0x01, 0x02, 0x03, 0x04]);
        snapshot.templates.replace(snapshot.keyOf(machines[0]), bad.buffer);
        document.getElementById('boot').click();
      });
      await allReady(r, 2);
      await r.evaluate(() => document.getElementById('add-vm').click());
      await allReady(r, 3);
      const vb = await vmsOf(r);
      const st = await r.evaluate(() => window.__v86link.snapshot.templates.status(window.__v86link.snapshot.keyOf(window.__v86link.machines[0])));
      check(vb.every((x) => !x.restored) && vb.filter((x) => x.restoreError).length >= 1 && st.state === 'failed',
        `壊れたテンプレート: 復元に失敗した VM は作り直して通常の起動で準備完了、その後の VM も通常の起動（${JSON.stringify(vb.map((x) => [x.name, x.restored, x.restoreError?.slice(0, 40)]))}、テンプレート ${st.state}）`);
      const pingBad = await runOn(r, 2, 'ping -c 2 -w 5 10.5.0.2');
      check(/2 received/.test(pingBad), '壊れたテンプレートのあとの VM も通信できる');
      await r.close();

      // テンプレートを作る VM を、プロンプトの前に削除する → 残りの VM が代わりに作る役になり、準備完了になる
      const s = await ctx.newPage();
      s.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
      s.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
      await s.goto(MEM);
      await s.evaluate(() => document.getElementById('add-vm').click());
      await s.evaluate(() => document.getElementById('boot').click());
      await s.waitForFunction(() => window.__v86link.machines.some((m) => m.snapMaker && m.node), null, { timeout: 60000, polling: 50 });
      const removed = await s.evaluate(() => {
        const m = window.__v86link.machines.find((x) => x.snapMaker);
        const was = { name: m.name, ready: m.ready };
        window.__v86link.removeMachine(m);
        return was;
      });
      await allReady(s, 2);
      const vr = await vmsOf(s);
      check(!removed.ready && vr.length === 2 && vr.filter((x) => x.savedTemplate).length === 1 && vr.filter((x) => x.restored).length === 1,
        `テンプレートを作る VM（${removed.name}）をプロンプトの前に削除しても、残りの 1 台が代わりに作り、もう 1 台は復元して準備完了（${JSON.stringify(vr.map((x) => [x.name, x.restored, x.savedTemplate]))}）`);
      await s.close();
    }
  }

  // --- 保存した起動イメージ（段2。snapstore.js）。新しいコンテキスト（IndexedDB が空）で確かめる ---
  if (process.env.SNAPSHOT !== 'off' && process.env.SNAPSHOT !== 'memory') {
    const ctx2 = await b.newContext({ viewport: { width: 1280, height: 1000 } });
    await serveLocal(ctx2, BASE);
    await ctx2.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
    ctx2.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host) external.add(u.host); });
    const watchPage = (q) => {
      q.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
      q.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
    };
    const a = await ctx2.newPage();
    watchPage(a);
    const boot2 = async (q) => {
      await q.evaluate(() => document.getElementById('boot').click());
      await q.waitForFunction(() => window.__v86link.machines.length === 2 && window.__v86link.machines.every((m) => m.netReady), null, { timeout: 300000, polling: 200 });
      return q.evaluate(() => window.__v86link.snapshot.vms());
    };
    const waitSaved = (q) => q.waitForFunction(() => window.__v86link.snapshot.info.saves.some((x) => x.ok), null, { timeout: 120000, polling: 200 });
    const saved = (q) => q.evaluate(() => window.__v86link.snapshot.saved());
    const ne2kLearn = (q) => q.evaluate(() => {
      const sw = window.__v86link.sw;
      window.__ne2kLearned = [];
      const learn = sw.learn.bind(sw);
      sw.learn = (vlan, key, portId, now) => { if (Math.floor(key / 2 ** 24) === 0x002215) window.__ne2kLearned.push(portId); return learn(vlan, key, portId, now); };
    });
    // 1 回目: 1 台目が作る役。全台の準備完了のあとで、IndexedDB に保存する
    await a.goto(BASE);
    const v1 = await boot2(a);
    await waitSaved(a);
    const s1 = await saved(a);
    const shaImg = await a.evaluate(() => window.__v86link.snapshot.imageSha256());
    check(v1.filter((x) => x.savedTemplate).length === 1 && s1.length === 1 && s1[0].kind === 'free' && s1[0].gzBytes > 1e6 && s1[0].gzBytes < s1[0].bytes && s1[0].key.includes(`img=${shaImg}`),
      `保存した起動イメージ: 1 回目は 1 台目がテンプレートを作り、IndexedDB に入る（${(s1[0]?.gzBytes / 1048576).toFixed(1)}MB。展開すると ${(s1[0]?.bytes / 1048576).toFixed(1)}MB。キーにイメージの SHA-256）`);
    const panel = await a.evaluate(() => { document.querySelector('[data-tabs="drawer"] [data-tab="monitor"]').click(); return document.getElementById('snap-list').textContent; });
    check(/自由構成（v86net）: [\d.]+MB/.test(panel), `モニタのタブに「保存した起動イメージ」が出る（${panel}）`);
    // 読み直す: 作る役が無く、全台が保存したものから復元。MAC テーブルに 00:22:15:… は入らない
    await a.reload();
    await ne2kLearn(a);
    const v2 = await boot2(a);
    const learned2 = await a.evaluate(() => window.__ne2kLearned.length);
    const labels2 = await a.$$eval('.vm-state', (l) => l.map((x) => x.textContent));
    check(v2.every((x) => x.restored && x.from === 'saved' && !x.savedTemplate) && labels2.every((t) => /保存から復元/.test(t)) && learned2 === 0,
      `保存した起動イメージ: 読み直すと、作る役が無く全台が保存したものから準備完了（${JSON.stringify(v2.map((x) => [x.name, Math.round(x.netMs)]))}、「${labels2[0]}」、MAC テーブルの 00:22:15:… ${learned2} 件）`);
    // 中身を壊す（状態の本文を 1 バイト書き換えて、圧縮し直す = gzip としては正しい）: SHA-256 が合わず、消して通常の起動。新しく保存し直す
    await a.evaluate(async () => {
      const open = () => new Promise((res, rej) => { const r = indexedDB.open('v86-link-snapshots', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const db = await open();
      const all = await new Promise((res) => { const r = db.transaction('templates').objectStore('templates').getAll(); r.onsuccess = () => res(r.result); });
      const rec = all[0];
      const pipe = (buf, s) => new Response(new Blob([buf]).stream().pipeThrough(s)).arrayBuffer();
      const raw = new Uint8Array(await pipe(rec.gz, new DecompressionStream('gzip')));
      raw[Math.floor(raw.length / 2)] ^= 0xff;
      rec.gz = await pipe(raw, new CompressionStream('gzip'));
      await new Promise((res) => { const r = db.transaction('templates', 'readwrite').objectStore('templates').put(rec); r.onsuccess = res; });
      db.close();
    });
    await a.reload();
    const v3 = await boot2(a);
    await waitSaved(a);
    const info3 = await a.evaluate(() => window.__v86link.snapshot.info);
    const s3 = await saved(a);
    check(info3.loads[0]?.found && !info3.loads[0]?.ok && /SHA-256/.test(info3.loads[0]?.error ?? '') && v3.filter((x) => x.savedTemplate).length === 1 && v3.every((x) => x.from !== 'saved') && s3.length === 1 && s3[0].savedAt > s1[0].savedAt,
      `保存した起動イメージ: 中身を壊すと、SHA-256 が合わないので消して通常の起動（${info3.loads[0]?.error}）。新しいテンプレートを保存し直す`);
    // イメージの SHA-256 が違うキーのエントリは使われず、消される
    await a.evaluate(async () => {
      const open = () => new Promise((res, rej) => { const r = indexedDB.open('v86-link-snapshots', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const db = await open();
      const all = await new Promise((res) => { const r = db.transaction('templates').objectStore('templates').getAll(); r.onsuccess = () => res(r.result); });
      const rec = all[0];
      const st = db.transaction('templates', 'readwrite').objectStore('templates');
      st.delete(rec.key);
      rec.key = rec.key.replace(/img=[0-9a-f]{64}/, 'img=' + 'f'.repeat(64));
      await new Promise((res) => { const r = st.put(rec); r.onsuccess = res; });
      db.close();
    });
    await a.reload();
    const v4 = await boot2(a);
    await waitSaved(a);
    const info4 = await a.evaluate(() => window.__v86link.snapshot.info);
    const s4 = await saved(a);
    check(info4.loads[0] && !info4.loads[0].found && info4.pruned === 1 && v4.filter((x) => x.savedTemplate).length === 1 && s4.length === 1 && !s4[0].key.includes('f'.repeat(64)),
      `保存した起動イメージ: イメージの SHA-256 が違うキーのエントリは使わず、消す（消した ${info4.pruned} 件。1 台目が作り直して保存）`);
    // 「消す」ボタン: IndexedDB のエントリが消え、次の起動は 1 台目が作る役になる
    await a.evaluate(() => { document.querySelector('[data-tabs="drawer"] [data-tab="monitor"]').click(); document.getElementById('snap-clear').click(); });
    await a.waitForFunction(() => window.__v86link.snapshot.saved().then((l) => l.length === 0), null, { timeout: 10000 }).catch(() => {});
    const s5 = await saved(a);
    await a.reload();
    const v5 = await boot2(a);
    check(s5.length === 0 && v5.filter((x) => x.savedTemplate).length === 1 && v5.every((x) => x.from !== 'saved'), '保存した起動イメージ:「消す」で IndexedDB のエントリが消え、次の起動は 1 台目が作る役になる');
    await a.close();
    // IndexedDB が使えない（window.indexedDB を消す）: 段1 と同じく、メモリだけで動く
    const n = await ctx2.newPage();
    watchPage(n);
    await n.addInitScript(() => { delete window.indexedDB; try { Object.defineProperty(window, 'indexedDB', { value: undefined }); } catch { /* 消せないブラウザ */ } });
    await n.goto(BASE);
    const vn = await boot2(n);
    await n.waitForTimeout(1500);
    const mode = await n.evaluate(() => document.getElementById('snap-mode').textContent);
    check(vn.filter((x) => x.savedTemplate).length === 1 && vn.filter((x) => x.restored && x.from === 'made').length === 1 && /IndexedDB が使えない/.test(mode),
      `IndexedDB が使えなくても、段1 と同じく動く（1 台目が作り、ほかはメモリから復元。「${mode}」）`);
    await n.close();
    await ctx2.close();
  }

  // --- DAI（Dynamic ARP Inspection。dai.js・daiview.js）: 実際の VM 3 台で ---
  {
    const d = await ctx.newPage();
    d.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
    d.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
    await d.goto(process.env.SNAPSHOT === 'off' ? withSnapshotParam(BASE) : withSnapshotParam(BASE, 'memory'));
    await d.evaluate(() => { document.getElementById('add-vm').click(); document.getElementById('boot').click(); });
    await d.waitForFunction(() => window.__v86link.machines.length === 3 && window.__v86link.machines.every((m) => m.netReady), null, { timeout: 300000, polling: 300 });
    await d.click('[data-tabs="observe"] [data-tab="dai"]');
    await d.click('.dai-build');
    await d.check('.dai-vlans input[data-vlan="1"]');
    const table = await d.evaluate(() => window.__v86link.sw.dai.config());
    check(table.vlans.join() === '1' && table.bindings.length === 3 && table.bindings.every((b) => /^10\.5\.0\.[234]$/.test(b.ip) && b.mac === '02:00:' + b.ip.split('.').map((x) => Number(x).toString(16).padStart(2, '0')).join(':')),
      `DAI:「いまの VM から表を作る」で 3 台の IP・MAC の表ができ、VLAN 1 で有効（${table.bindings.map((b) => b.ip).join('・')}）`);
    let o = await shellOut(d, 0, 'ip neigh flush dev eth0; ping -c 2 -W 1 10.5.0.3');
    check(/2 packets transmitted, 2 received/.test(o), 'DAI: 表に合う VM 同士は ARP が通り、ping が通る');
    // 表から B を消すと、B の ARP（応答）が捨てられて通らない
    await d.click('.dai-table tr:nth-child(2) .dai-del');
    o = await shellOut(d, 0, 'ip neigh flush dev eth0; ping -c 2 -W 1 10.5.0.3');
    const dropped = await d.evaluate(() => window.__v86link.capture.list().filter((r) => r.dai && r.inPort === 1).map((r) => r.reason));
    const recent = await d.$$eval('.dai-recent li', (l) => l.map((x) => x.textContent));
    check(/2 packets transmitted, 0 received/.test(o) && dropped.length > 0 && dropped.every((r) => r === 'arp-inspection') && recent.some((t) => /10\.5\.0\.3/.test(t) && /表に無い/.test(t)),
      `DAI: 表から B を消すと、B の ARP が arp-inspection で捨てられ、ping が通らない（捨てた ${dropped.length} 件。画面の記録「${recent[0]}」）`);
    // キャプチャのフィルタ dai と、詳細の DAI の行
    await d.fill('#cap-filter', 'dai');
    await d.evaluate(() => window.__v86link.captureView.setFilter('dai'));
    await d.evaluate(() => { const v = window.__v86link.captureView; v.select(v.rows.at(-1)); });
    const det = await d.$eval('#cap-detail', (x) => x.textContent);
    check(/DAI: ARP の sender IP と MAC の組が、バインディング表に合わない/.test(det) && /この IP は表に無い/.test(det), 'キャプチャ: フィルタ dai と、詳細に DAI で捨てた理由');
    // trusted にすると通る（ポートの設定パネル）
    await d.click('[data-tabs="observe"] [data-tab="topology"]');
    await d.click('#topology g.vm-node[data-port="1"]');
    await d.check('#port-panel .pf-trusted');
    o = await shellOut(d, 0, 'ip neigh flush dev eth0; ping -c 2 -W 1 10.5.0.3');
    check(/2 received/.test(o) && await d.evaluate(() => window.__v86link.sw.port(1).daiTrusted), 'DAI: B のポートを trusted にすると、表に無くても通る');
    // 入力欄の HTML は要素にならない（不正な値として理由を出し、反映しない）
    await d.click('[data-tabs="observe"] [data-tab="dai"]');
    await d.fill('.dai-in-ip', '<img src=x onerror="window.__daiXss=1">');
    await d.fill('.dai-in-mac', '02:00:00:00:00:01');
    await d.click('.dai-form button');
    const x = await d.evaluate(() => ({ imgs: document.querySelectorAll('#dai-panel img, #dai-panel script').length, flag: window.__daiXss ?? null, msg: document.querySelector('.dai-msg').textContent, n: window.__v86link.sw.dai.config().bindings.length }));
    check(x.imgs === 0 && x.flag === null && /反映できません/.test(x.msg) && x.n === 2, `DAI: 入力欄に <img onerror> を入れても要素は作られず、反映しない（「${x.msg.slice(0, 40)}…」）`);
    await d.close();
  }

  // --- 以前のイメージ（?image=buildroot68）: 以前のネットワーク設定のコマンド（ifconfig・route）で、起動と設定が通る ---
  {
    const o = await ctx.newPage();
    o.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
    o.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
    const u = new URL(withSnapshotParam(BASE));
    u.searchParams.set('image', 'buildroot68');
    await o.goto(u.toString());
    await o.evaluate(() => document.getElementById('boot').click());
    await o.waitForFunction(() => window.__v86link.machines.length === 2 && window.__v86link.machines.every((m) => m.netReady), null, { timeout: 600000, polling: 300 });
    const okA = await waitLog(o, 0, netShown('10.5.0.2', '02:00:0a:05:00:02'), 0, 10000).catch(() => null);
    const m = await mark(o, 0);
    await send(o, 0, 'ping -c 2 10.5.0.3\n');
    const pingOld = await waitLog(o, 0, /2 packets transmitted, (\d+) received/, m, 30000).catch(() => '');
    const cmd = await o.evaluate(() => window.__v86link.bySlot(0).log.includes('ifconfig eth0 hw ether'));
    check(!!okA && /2 received/.test(pingOld) && cmd, `以前のイメージ（buildroot68）でも、以前のコマンド（ifconfig・route）で起動とネットワーク設定が通り、ping が届く（${pingOld}）`);
    await o.close();
  }

  // --- スマホ幅 ---
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(withSnapshotParam(BASE));
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // スマホでは、下のボタンで見る場所を切り替える。端末はタブで1つずつ
  const navVisible = await phone.isVisible('.mobile-nav');
  const stepsVisible = await phone.isVisible('#steps-pane');
  await phone.click('.mobile-nav [data-pane="term"]');
  const termVisible = await phone.isVisible('#term-pane');
  const cards = await phone.$$eval('.vm', (l) => l.filter((x) => !x.hidden).length);
  await phone.click('.mobile-nav [data-pane="drawer"]');
  const capVisible = await phone.isVisible('#cap-filter');
  const overflow2 = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0 && overflow2 <= 0 && navVisible && stepsVisible && termVisible && cards === 1 && capVisible,
    `スマホ幅（390px）: 横にはみ出さない（${overflow}/${overflow2}px）。下のボタンで手順・端末（1台ずつ）・キャプチャを切り替える`);
  await shot(phone, 'v86-link-phone.png');
  // スマホ幅: シーケンスは横スクロールで見られる（ページ自体は横にはみ出さない）
  {
    await phone.evaluate(() => {
      const { capture } = window.__v86link;
      const f = new Uint8Array(60);
      f.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02, 0, 0x0a, 5, 0, 2, 0x08, 0x06]);
      for (let i = 0; i < 5; i++) capture.add({ frame: f, inPort: 0, outPorts: [1, 2, 3, 4, 5], decision: 'broadcast', vlan: 1 });
    });
    await phone.click('[data-tabs="drawer"] [data-tab="ladder"]');
    await phone.waitForFunction(() => document.querySelectorAll('#lad-svg g.lrow').length === 5, null, { timeout: 5000 }).catch(() => {});
    const m = await phone.evaluate(() => {
      const sc = document.getElementById('lad-scroll');
      return { inner: sc.scrollWidth, box: sc.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth, rows: document.querySelectorAll('#lad-svg g.lrow').length };
    });
    check(m.rows === 5 && m.inner > m.box && m.page <= 0, `スマホ幅: シーケンス（6 レーン）は横スクロールで見られ、ページははみ出さない（中身 ${m.inner}px / 枠 ${m.box}px、ページ ${m.page}px）`);
    await phone.click('[data-tabs="drawer"] [data-tab="capture"]');
  }
  // スマホ幅: 学習（端末を並べる設定）でも、タブで操作する端末を切り替えられる（以前は自由に使うときしか切り替わらなかった）
  {
    const shown = () => phone.$$eval('.vm', (l) => l.filter((x) => !x.hidden).map((x) => Number(x.dataset.slot)));
    await phone.evaluate(() => window.__v86link.selectLesson('basic'));
    await phone.click('.mobile-nav [data-pane="term"]');
    const first = await shown();
    await phone.click('.term-tab[data-slot="1"]');
    await phone.waitForFunction(() => [...document.querySelectorAll('.vm')].filter((x) => !x.hidden).map((x) => x.dataset.slot).join() === '1', null, { timeout: 3000 }).catch(() => {});
    const afterB = await shown();
    // タブは requestAnimationFrame で描き直すので、描き直されるのを待ってから読む
    await phone.waitForFunction(() => document.querySelector('.term-tab[data-slot="1"]')?.classList.contains('active'), null, { timeout: 3000 }).catch(() => {});
    const tabB = await phone.$eval('.term-tab[data-slot="1"]', (x) => x.classList.contains('active'));
    await phone.click('.term-tab[data-slot="0"]');
    await phone.waitForFunction(() => [...document.querySelectorAll('.vm')].filter((x) => !x.hidden).map((x) => x.dataset.slot).join() === '0', null, { timeout: 3000 }).catch(() => {});
    const afterA = await shown();
    check(JSON.stringify([first, afterB, afterA]) === '[[0],[1],[0]]' && tabB,
      `スマホ幅: 学習（端末を並べる設定）でも、タブで操作する端末を切り替えられる（表示 ${JSON.stringify([first, afterB, afterA])}）`);
  }

  say('計測: ' + JSON.stringify(report));
  say(failures ? `${failures} 件失敗` : 'すべて成功');
  await b.close();
  process.exitCode = failures ? 1 : 0;
})();

import { V86Node, download } from './vm.js';
import { VirtualSwitch } from './switch.js';
import { TrafficStats } from './capture.js';

const $ = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

// --- ゲスト（v86 の公式イメージ Buildroot Linux 6.8）の設定 ---
const LIB = 'lib/v86/';
const IMAGE = 'images/buildroot-bzimage68.bin';
// v86 の公式プロファイル（buildroot6）と同じコマンドライン
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
const MEMORY_MB = 64;
// シェルのプロンプト（"~% " や、ネットワーク設定後の "left:~% "）が出たら使える
const PROMPT = /% $/;

const MACHINES = [
  { key: 'left', label: '左', ip: '10.5.0.2' },
  { key: 'right', label: '右', ip: '10.5.0.3' },
];
const [LEFT, RIGHT] = MACHINES;

// --- 投入するコマンド（ボタンと「コマンド例」で同じものを使う） ---
// このイメージには nc と httpd が無い（busybox にも入っていない）ので、どちらも socat で代わりにする
const HTTPD_SCRIPT = [
  "mkdir -p /tmp/www; echo '<h1>hello from right (10.5.0.3)</h1>' > /tmp/www/index.html",
  "cat > /tmp/httpd.sh <<'EOF'",
  '#!/bin/sh',
  '# socat が1接続ごとに起動する、ごく小さな HTTP サーバー',
  "read -r req; req=$(printf %s \"$req\" | tr -d '\\r')",
  "while read -r h; do [ -z \"$(printf %s \"$h\" | tr -d '\\r')\" ] && break; done",
  'echo "$(date +%T) $req" >&2',
  "f=/tmp/www$(echo \"$req\" | cut -d' ' -f2); [ -d \"$f\" ] && f=$f/index.html",
  "if [ -f \"$f\" ]; then printf 'HTTP/1.0 200 OK\\r\\nContent-Type: text/html\\r\\nContent-Length: %s\\r\\n\\r\\n' \"$(wc -c < \"$f\")\"; cat \"$f\";",
  "else printf 'HTTP/1.0 404 Not Found\\r\\nContent-Length: 10\\r\\n\\r\\nnot found\\n'; fi",
  'EOF',
  'chmod +x /tmp/httpd.sh',
  'socat TCP-LISTEN:8080,reuseaddr,fork EXEC:/tmp/httpd.sh &',
];

const netCommand = (m) => `hostname ${m.key}; export PS1='\\h:\\w% '; ifconfig eth0 ${m.ip} netmask 255.255.255.0 up && ip -4 addr show eth0 | grep inet`;

const PRESETS = {
  pingLR: { title: 'ping 左→右', steps: [[LEFT, `ping -c 4 ${RIGHT.ip}`]] },
  pingRL: { title: 'ping 右→左', steps: [[RIGHT, `ping -c 4 ${LEFT.ip}`]] },
  httpServe: { title: 'HTTP サーバー（右）', steps: HTTPD_SCRIPT.map((c) => [RIGHT, c]) },
  httpGet: { title: 'HTTP で取得（左）', steps: [[LEFT, `curl -s -w '\\n(HTTP %{http_code}, %{time_total}s)\\n' http://${RIGHT.ip}:8080/`]] },
  tcpOpen: {
    title: 'TCP（nc の代わりに socat）',
    steps: [[RIGHT, 'socat - TCP-LISTEN:7000,reuseaddr'], ['wait', 1500], [LEFT, `socat - TCP:${RIGHT.ip}:7000`]],
  },
  tcpSend: { title: '文字列を送る', steps: [[LEFT, 'hello from left'], ['wait', 800], [RIGHT, 'hello from right']] },
  tcpClose: { title: '切る', steps: [[LEFT, '\x03', true], [RIGHT, '\x03', true]] },
};

// --- 画面 ---

const sw = new VirtualSwitch();
const machines = MACHINES.map((m, i) => {
  const el = document.querySelector(`.vm[data-vm="${i}"]`);
  const term = new Terminal({ convertEol: false, fontSize: 13, scrollback: 2000, theme: { background: '#000000' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el.querySelector('.term'));
  fit.fit();
  term.write(`\x1b[90m${m.label}（${m.ip}）: 「起動」を押すと Linux が起動します\x1b[0m\r\n`);
  return {
    ...m, el, term, fit,
    node: null, port: null,
    log: '',              // シリアル出力（自動テストと、プロンプトの検出に使う）
    ready: false, bootMs: 0,
    decoder: new TextDecoder(),
  };
});
function tellSize(m) {
  m.node?.writeSerial(`stty cols ${m.term.cols} rows ${m.term.rows}\n`);
}
let resizeTimer;
addEventListener('resize', () => {
  machines.forEach((m) => m.fit.fit());
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => machines.filter((m) => m.ready).forEach(tellSize), 300);
});

function setVmState(m, text, cls = '') {
  const s = m.el.querySelector('.vm-state');
  s.textContent = text;
  s.className = 'vm-state ' + cls;
}

function setProgress(m, value) {
  const p = m.el.querySelector('progress');
  p.hidden = value === null;
  if (value !== null) p.value = value;
}

function setBadge(text, cls = '') {
  $('state').textContent = text;
  $('state').className = 'badge ' + cls;
}

function enable(on) {
  $('net').disabled = !on;
  document.querySelectorAll('#presets button').forEach((b) => (b.disabled = !on));
}

// --- 起動 ---

async function boot() {
  $('boot').disabled = true;
  setBadge('起動中…');
  const t0 = performance.now();
  try {
    // イメージ（約10MB）は1回だけダウンロードして、2台で共有する
    machines.forEach((m) => { setVmState(m, 'ダウンロード中…'); setProgress(m, 0); });
    const image = await download(IMAGE, (loaded, total) => {
      machines.forEach((m) => {
        setProgress(m, total ? loaded / total : 0);
        setVmState(m, `ダウンロード中… ${(loaded / 1048576).toFixed(1)}MB${total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : ''}`);
      });
    });
    window.__v86link.downloadMs = performance.now() - t0;

    // 2台を同時に起動する（順番に起動しても合計時間は短くならない。docs/results.md）
    await Promise.all(machines.map((m) => startMachine(m, image, t0)));
  } catch (e) {
    console.error(e);
    setBadge('起動失敗', 'ng');
    machines.forEach((m) => setVmState(m, '起動失敗: ' + e.message, 'err'));
    $('boot').disabled = false;
  }
}

function startMachine(m, image, t0) {
  // v86 は渡した ArrayBuffer を書き換えることがあるので、それぞれに複製を渡す
  m.node = new V86Node(m.key, { libPath: LIB, bzimage: image.slice(0), cmdline: CMDLINE, memoryMB: MEMORY_MB });
  m.port = sw.attach(m.node);
  // 起動前に「ケーブルを抜く」にしてあったら、つないだ時点で反映する
  if (m === machines[1] && $('unplug').checked) sw.setLinked(m.port, false);
  m.node.on('progress', (p) => {
    if (p.phase === 'boot') {
      setProgress(m, null);
      setVmState(m, 'ブート中…');
    }
  });
  m.node.on('serial', (bytes) => {
    m.term.write(bytes);
    m.log += m.decoder.decode(bytes, { stream: true });
    if (m.log.length > 200000) m.log = m.log.slice(-100000);
    // 最初のプロンプトが出たら起動完了
    if (!m.ready && PROMPT.test(m.log)) {
      m.ready = true;
      m.bootMs = performance.now() - t0;
      // ゲストは 80 桁の端末だと思っているので、実際の大きさを教える（長い行が途中で折り返されないように）
      tellSize(m);
      setVmState(m, `準備完了（${fmt(m.bootMs)}）`, 'ok');
      if (machines.every((x) => x.ready)) {
        setBadge('2台とも起動', 'ok');
        enable(true);
      }
    }
  });
  // ターミナルへのキー入力を、その VM のシリアルへ
  m.term.onData((data) => m.node.writeSerial(data));
  return m.node.start();
}

// --- コマンドの投入 ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSteps(steps) {
  for (const [target, text, raw] of steps) {
    if (target === 'wait') {
      await sleep(text);
      continue;
    }
    const m = machines.find((x) => x.key === target.key);
    m.node.writeSerial(raw ? text : text + '\n');
    // 複数行を続けて送るときは、シェルが読み込む間を少し空ける
    if (steps.length > 1) await sleep(60);
  }
}

$('boot').addEventListener('click', boot);
$('net').addEventListener('click', () => runSteps(MACHINES.map((m) => [m, netCommand(m)])));
document.querySelectorAll('[data-preset]').forEach((b) => {
  b.addEventListener('click', () => runSteps(PRESETS[b.dataset.preset].steps));
});

// --- ケーブル・遅延・損失 ---

$('unplug').addEventListener('change', (e) => {
  const right = machines[1];
  if (right.port) sw.setLinked(right.port, !e.target.checked);
});
$('delay').addEventListener('input', (e) => { sw.delayMs = Math.max(0, Number(e.target.value) || 0); });
$('loss').addEventListener('input', (e) => { sw.lossRate = Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100; });

// --- パケットモニタ ---

// 集計は、仮想スイッチがフレームを1つ処理するたびの知らせ（onFrame）から数える。キャプチャも同じ知らせを使う
const stats = new TrafficStats();
sw.onFrame((e) => stats.add(e));
let drawPending = false;
stats.onChange(() => {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    const s = stats;
    const rows = [
      ['転送したフレーム', s.frames.toLocaleString()],
      ['転送したバイト数', s.bytes.toLocaleString() + ' B'],
      ['捨てたフレーム', s.dropped.toLocaleString() + (machines[1].port && !machines[1].port.linked ? '（ケーブルが抜けている）' : '')],
      ...['ARP', 'ICMP', 'TCP', 'UDP', 'IPv6', 'IPv4', 'other'].filter((t) => s.types[t]).map((t) => [t, s.types[t].toLocaleString()]),
    ];
    $('monitor').replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
  });
});
stats.reset();
$('reset-stats').addEventListener('click', () => stats.reset());

// --- コマンド例 ---

const examples = [
  ['ネットワーク設定（左）', [netCommand(LEFT)]],
  ['ネットワーク設定（右）', [netCommand(RIGHT)]],
  ['ping（左→右）', [PRESETS.pingLR.steps[0][1]]],
  ['HTTP サーバー（右。socat が1接続ごとに小さなシェルスクリプトを動かす）', HTTPD_SCRIPT],
  ['HTTP で取得（左）', [PRESETS.httpGet.steps[0][1], `wget -q -O - http://${RIGHT.ip}:8080/`]],
  ['TCP（nc の代わり）: 右で待ち受け → 左から接続。あとは打った行が相手に届く。Ctrl-C で終わり', ['右: socat - TCP-LISTEN:7000,reuseaddr', `左: socat - TCP:${RIGHT.ip}:7000`]],
  ['フレームを見る', ['tcpdump -n -i eth0']],
];
$('commands').replaceChildren(...examples.flatMap(([title, lines]) => {
  const h = document.createElement('h3');
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.textContent = lines.join('\n');
  return [h, pre];
}));

// 自動テストと計測のために、状態を見えるようにしておく
window.__v86link = { machines, sw, stats, PRESETS, downloadMs: 0 };

import { V86Node, download } from './vm.js';
import { VirtualSwitch } from './switch.js';
import { Capture, TrafficStats } from './capture.js';
import { CaptureView } from './captureview.js';
import { TopologyView, MacTableView } from './switchview.js';

const $ = (id) => document.getElementById(id);
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// --- ゲスト（v86 の公式イメージ Buildroot Linux 6.8）の設定 ---
const LIB = 'lib/v86/';
const IMAGE = 'images/buildroot-bzimage68.bin';
// v86 の公式プロファイル（buildroot6）と同じコマンドライン
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
const MEMORY_MB = 64;
// シェルのプロンプト（"~% " や、ネットワーク設定後の "a:~% "）が出たら使える
const PROMPT = /% $/;
// 同時に動かせる VM の数（= スイッチのポート数）。README の「推奨台数」を参照
const MAX_VMS = 8;
const INITIAL_VMS = 2;

/**
 * ポート番号（スロット）ごとに、名前・IP・MAC を決める。VM を消して足し直すと、同じスロットなら同じものになる。
 *   名前 A〜H / ホスト名 a〜h / IP 10.5.0.2〜 / MAC 02:00:0a:05:00:02〜（ローカル管理アドレス。後ろ4バイトが IP と同じ）
 * v86 の NIC（ne2k）の MAC は起動ごとにランダム（00:22:15:xx:xx:xx）で、オプションでは決められないので、
 * ネットワーク設定のときにゲストの中で変える
 */
function slotInfo(slot) {
  const n = slot + 2;
  return {
    slot,
    name: String.fromCharCode(65 + slot),
    host: String.fromCharCode(97 + slot),
    ip: `10.5.0.${n}`,
    mac: `02:00:0a:05:00:${n.toString(16).padStart(2, '0')}`,
  };
}
const SLOT = Array.from({ length: MAX_VMS }, (_, i) => slotInfo(i));
const [A, B, C] = SLOT;

// --- 投入するコマンド（ボタンと「コマンド例」で同じものを使う） ---
// このイメージには nc と httpd が無い（busybox にも入っていない）ので、どちらも socat で代わりにする
const httpdScript = (m) => [
  `mkdir -p /tmp/www; echo '<h1>hello from ${m.name} (${m.ip})</h1>' > /tmp/www/index.html`,
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

// MAC を変えるときはいったん down にする。終わったら NET-OK を出す（"NET""-OK" と分けて書くので、コマンドのエコーには出ない）
const netCommand = (m) => `hostname ${m.host}; export PS1='\\h:\\w% '; ifconfig eth0 down; ifconfig eth0 hw ether ${m.mac} && ` +
  `ifconfig eth0 ${m.ip} netmask 255.255.255.0 up && ip addr show eth0 | grep -E 'ether|inet ' && echo "NET""-OK"`;
// tcpdump は既定で promiscuous モード（自分宛てでないフレームも受け取る）にする。-l で1行ずつ出す
const SNIFF = 'tcpdump -n -l -i eth0 icmp';
const flushArp = 'ip neigh flush dev eth0';

/**
 * プリセット。steps の要素:
 *   [slot, text, raw]      その VM のシリアルへ（raw でなければ改行を足す）
 *   ['wait', ms]           待つ
 *   ['need', n]            スロット 0〜n-1 の VM がそろって、ネットワーク設定まで終わるのを待つ（足りなければ足す）
 *   ['mode', 'hub'|'switch']  ハブ / スイッチに切り替える（テーブルは空になる）
 *   ['clear']              MAC アドレステーブルを空にする
 *   ['link', slot, bool]   ケーブルを差す / 抜く
 *   ['flood', slot, n]     そのポートから、送り元 MAC を偽ったフレームを n 個（MAC フラッディング）
 */
const PRESETS = {
  pingAB: { title: 'ping A→B', steps: [['need', 2], [0, `ping -c 4 ${B.ip}`]] },
  pingBA: { title: 'ping B→A', steps: [['need', 2], [1, `ping -c 4 ${A.ip}`]] },
  httpServe: { title: 'HTTP サーバー（B）', steps: [['need', 2], ...httpdScript(B).map((c) => [1, c])] },
  httpGet: { title: 'HTTP で取得（A）', steps: [['need', 2], [0, `curl -s -w '\\n(HTTP %{http_code}, %{time_total}s)\\n' http://${B.ip}:8080/`]] },
  tcpOpen: {
    title: 'TCP（nc の代わりに socat）',
    steps: [['need', 2], [1, 'socat - TCP-LISTEN:7000,reuseaddr'], ['wait', 1500], [0, `socat - TCP:${B.ip}:7000`]],
  },
  tcpSend: { title: '文字列を送る', steps: [[0, 'hello from A'], ['wait', 800], [1, 'hello from B']] },
  tcpClose: { title: '切る', steps: [[0, '\x03', true], [1, '\x03', true]] },

  // --- 学習用 ---
  sniffHub: {
    title: 'ハブで盗聴',
    desc: [
      'A・B・C の3台をそろえ（足りなければ足して起動します）、ハブに切り替えます。',
      `C で tcpdump（${SNIFF}）を動かします。tcpdump は NIC を promiscuous モードにするので、自分宛てでないフレームも見えます。`,
      `A から B（${B.ip}）へ ping を3回。ハブは全ポートへ届けるので、C の tcpdump に A↔B の ICMP が出ます。`,
      '最後に C の tcpdump を Ctrl-C で止めます（「6 packets captured」のように数が出ます）。トポロジー図では、全ポートの線が光ります。',
    ],
    steps: [['need', 3], ['mode', 'hub'], [2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500],
      [0, flushArp], [1, flushArp], [0, `ping -c 3 ${B.ip}`], ['wait', 4500], [2, '\x03', true]],
  },
  sniffSwitch: {
    title: 'スイッチでは盗聴できない',
    desc: [
      'スイッチに切り替え、MAC アドレステーブルを空にします。',
      'A と B の ARP キャッシュを消してから ping します。ARP（ブロードキャスト）でスイッチが A と B の MAC を覚えるので、',
      'ICMP は B のポート（と A のポート）にしか届かず、C の tcpdump には出ません（「0 packets captured」）。',
      '※ ARP キャッシュを消さないと、テーブルが空のまま ICMP が来て、最初の1つだけフラッディングで C に見えることがあります。',
    ],
    steps: [['need', 3], ['mode', 'switch'], ['clear'], [2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500],
      [0, flushArp], [1, flushArp], [0, `ping -c 3 ${B.ip}`], ['wait', 4500], [2, '\x03', true]],
  },
  macTable: {
    title: 'MAC テーブルの観察',
    desc: [
      'スイッチにしてテーブルを空にし、A→B、C→A の順に ping します。',
      '送り元の MAC が、入ってきたポートと一緒に1件ずつ増えていくのを、右の「MAC アドレステーブル」で見てください。',
      '残り時間はエージング（既定 300 秒）から減っていき、0 になると消えます（短くして試せます）。',
    ],
    steps: [['need', 3], ['mode', 'switch'], ['clear'], [0, flushArp], [1, flushArp], [2, flushArp],
      [0, `ping -c 1 ${B.ip}`], ['wait', 2500], [2, `ping -c 1 ${A.ip}`]],
  },
  macFlood: {
    title: 'MAC フラッディング',
    desc: [
      'スイッチでテーブルを空にしたあと、C のポートから送り元 MAC を偽ったフレームを 1100 個送り込みます（ページの JavaScript が C の代わりに送ります）。',
      'テーブルの上限（1024 件）が埋まると、スイッチは新しい MAC を覚えません。A と B の MAC も覚えられないので、',
      'A↔B のフレームはフラッディングになり、スイッチなのに C の tcpdump に ICMP が出ます。これが MAC フラッディング攻撃です。',
      '偽のエントリはエージングで消えます（テーブルを空にするか、ハブ/スイッチを切り替えても消えます）。',
    ],
    steps: [['need', 3], ['mode', 'switch'], ['clear'], [2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500],
      ['flood', 2, 1100], [0, flushArp], [1, flushArp], [0, `ping -c 3 ${B.ip}`], ['wait', 4500], [2, '\x03', true]],
  },
  unplugB: {
    title: 'ケーブル: B を抜く',
    desc: ['B のケーブルを抜いて A→B へ ping します（届かない）。キャプチャでは「A → ✕」になります。5 秒後に差し直します。'],
    steps: [['need', 2], ['link', 1, false], [0, `ping -c 3 -W 1 ${B.ip}`], ['wait', 5000], ['link', 1, true]],
  },
};

// --- 仮想スイッチ ---

const sw = new VirtualSwitch({ maxPorts: MAX_VMS });
/** 起動している VM（カード）。スロット番号 = スイッチのポート番号 */
const machines = [];
const bySlot = (slot) => machines.find((m) => m.slot === slot);

// --- 画面 ---

function setBadge() {
  const n = machines.length;
  const ready = machines.filter((m) => m.netReady).length;
  const booting = machines.filter((m) => m.node && !m.netReady).length;
  $('state').textContent = n === 0 ? 'VM なし' : booting ? `起動中（${ready}/${n} 台）` : ready === n ? `${n} 台とも起動` : `${ready}/${n} 台起動`;
  $('state').className = 'badge ' + (n > 0 && ready === n ? 'ok' : '');
  $('add-vm').disabled = machines.length >= MAX_VMS;
  $('vm-count').textContent = `${n} / ${MAX_VMS} 台`;
  $('net').disabled = !machines.some((m) => m.ready);
}

function setVmState(m, text, cls = '') {
  m.stateEl.textContent = text;
  m.stateEl.className = 'vm-state ' + cls;
}

function setProgress(m, value) {
  m.progress.hidden = value === null;
  if (value !== null) m.progress.value = value;
}

/** VM のカードを作る（まだ起動しない） */
function createMachine(slot = firstFreeSlot()) {
  if (slot === undefined || bySlot(slot)) return null;
  const info = SLOT[slot];
  const card = el('section', 'vm');
  card.dataset.slot = String(slot);
  const head = el('div', 'vm-head');
  const stateEl = el('span', 'vm-state', '停止中');
  const remove = el('button', 'ghost vm-remove', '削除');
  remove.title = `${info.name} を止めて、スイッチから外す`;
  const progress = el('progress');
  progress.max = 1;
  progress.hidden = true;
  head.append(el('b', 'vm-name', info.name), el('code', 'vm-ip', info.ip), el('span', 'vm-port', `P${slot + 1}`), stateEl, remove, progress);
  // ポートごとのケーブル・遅延・損失
  const link = el('div', 'vm-link');
  const unplug = Object.assign(el('input'), { type: 'checkbox', className: 'unplug' });
  const delay = Object.assign(el('input'), { type: 'number', className: 'delay', min: 0, max: 2000, step: 10, value: 0 });
  const loss = Object.assign(el('input'), { type: 'number', className: 'loss', min: 0, max: 100, step: 5, value: 0 });
  const lab = (...xs) => { const l = el('label'); l.append(...xs); return l; };
  const unplugLabel = lab(unplug, ' ケーブルを抜く');
  unplugLabel.className = 'toggle';
  link.append(unplugLabel, lab('遅延 ', delay, ' ms'), lab('損失 ', loss, ' %'), el('code', 'vm-mac', info.mac));
  const termBox = el('div', 'term');
  card.append(head, link, termBox);
  // スロット順に並べる
  const after = [...$('vms').children].find((c) => Number(c.dataset.slot) > slot);
  $('vms').insertBefore(card, after ?? null);

  const term = new Terminal({ convertEol: false, fontSize: 13, scrollback: 2000, theme: { background: '#000000' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termBox);
  fit.fit();
  term.write(`\x1b[90m${info.name}（${info.ip}）: 起動すると Linux が動きます\x1b[0m\r\n`);

  const m = {
    ...info, el: card, term, fit, stateEl, progress, unplug, delay, loss,
    node: null, port: null,
    log: '',              // シリアル出力（自動テストと、プロンプトの検出に使う）
    ready: false, netReady: false, removed: false, bootMs: 0, netMs: 0,
    decoder: new TextDecoder(),
  };
  // ターミナルへのキー入力は、このカードの VM のシリアルへ（ほかの VM には行かない）
  m.disposeInput = term.onData((data) => m.node?.writeSerial(data));
  remove.addEventListener('click', () => removeMachine(m));
  unplug.addEventListener('change', () => { if (m.port) sw.setLinked(m.port, !unplug.checked); });
  const applyLink = () => {
    if (m.port) sw.setPortOptions(m.port, { delayMs: Number(delay.value), lossRate: Number(loss.value) / 100 });
  };
  delay.addEventListener('input', applyLink);
  loss.addEventListener('input', applyLink);
  machines.push(m);
  machines.sort((a, b) => a.slot - b.slot);
  setBadge();
  return m;
}

function firstFreeSlot() {
  return SLOT.find((s) => !bySlot(s.slot))?.slot;
}

function tellSize(m) {
  m.node?.writeSerial(`stty cols ${m.term.cols} rows ${m.term.rows}\n`);
}
let resizeTimer;
addEventListener('resize', () => {
  machines.forEach((m) => m.fit.fit());
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => machines.filter((m) => m.ready).forEach(tellSize), 300);
});

// --- 起動 ---

// イメージ（約10MB）は1回だけダウンロードして、全台で共有する
let imagePromise = null;
const imageWaiters = new Set();
function loadImage() {
  if (!imagePromise) {
    const t0 = performance.now();
    imagePromise = download(IMAGE, (loaded, total) => {
      for (const m of imageWaiters) {
        setProgress(m, total ? loaded / total : 0);
        setVmState(m, `ダウンロード中… ${(loaded / 1048576).toFixed(1)}MB${total ? ' / ' + (total / 1048576).toFixed(1) + 'MB' : ''}`);
      }
    }).then((image) => {
      window.__v86link.downloadMs = performance.now() - t0;
      return image;
    }, (e) => {
      imagePromise = null;
      throw e;
    });
  }
  return imagePromise;
}

/** 1台を起動し、ネットワーク設定まで進める（進み具合はカードに出す） */
async function bootMachine(m) {
  if (m.node || m.removed) return;
  const t0 = performance.now();
  m.booting = true;
  setBadge();
  try {
    setVmState(m, 'ダウンロード中…');
    setProgress(m, 0);
    imageWaiters.add(m);
    const image = await loadImage().finally(() => imageWaiters.delete(m));
    if (m.removed) return;
    // v86 は渡した ArrayBuffer を書き換えることがあるので、それぞれに複製を渡す
    m.node = new V86Node(m.host, { libPath: LIB, bzimage: image.slice(0), cmdline: CMDLINE, memoryMB: MEMORY_MB });
    m.port = sw.addPort(m.node, {
      id: m.slot, linked: !m.unplug.checked, delayMs: Number(m.delay.value), lossRate: Number(m.loss.value) / 100,
    });
    setProgress(m, null);
    setVmState(m, 'BIOS…');
    m.node.on('progress', (p) => { if (p.phase === 'boot') setVmState(m, 'ブート中…'); });
    m.node.on('serial', (bytes) => onSerial(m, bytes, t0));
    setBadge();
    await m.node.start();
  } catch (e) {
    console.error(e);
    setProgress(m, null);
    setVmState(m, '起動失敗: ' + e.message, 'err');
  } finally {
    m.booting = false;
    setBadge();
  }
}

function onSerial(m, bytes, t0) {
  if (m.removed) return;
  m.term.write(bytes);
  m.log += m.decoder.decode(bytes, { stream: true });
  if (m.log.length > 200000) m.log = m.log.slice(-100000);
  // 最初のプロンプトが出たら起動完了 → ネットワーク設定へ
  if (!m.ready && PROMPT.test(m.log)) {
    m.ready = true;
    m.bootMs = performance.now() - t0;
    // ゲストは 80 桁の端末だと思っているので、実際の大きさを教える（長い行が途中で折り返されないように）
    tellSize(m);
    configureNet(m, t0);
  }
}

/** ネットワーク設定（ホスト名・MAC・IP）。終わったら netReady */
async function configureNet(m, t0 = null) {
  if (!m.ready || m.removed) return;
  m.netReady = false;
  setBadge();
  setVmState(m, `ネットワーク設定中…（起動 ${fmt(m.bootMs)}）`);
  const mark = m.log.length;
  m.node.writeSerial(netCommand(m) + '\n');
  const ok = await until(() => m.removed || /^NET-OK\s*$/m.test(m.log.slice(mark)), 30000);
  if (m.removed) return;
  m.netReady = ok;
  // 起動からの時間（「ネットワーク設定をやり直す」のときは、最初の時間のまま）
  if (t0 !== null) m.netMs = performance.now() - t0;
  if (ok) setVmState(m, `準備完了（起動から ${fmt(m.netMs)}）`, 'ok');
  else setVmState(m, 'ネットワーク設定に失敗（「ネットワーク設定」で再実行）', 'err');
  setBadge();
}

async function until(cond, ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

/** VM を止めて、スイッチから外し、カードを消す（エミュレータのメモリを手放す） */
async function removeMachine(m) {
  if (m.removed) return;
  m.removed = true;
  machines.splice(machines.indexOf(m), 1);
  if (m.port) sw.removePort(m.port);
  m.port = null;
  imageWaiters.delete(m);
  m.disposeInput.dispose();
  m.term.dispose();
  m.el.remove();
  setBadge();
  const node = m.node;
  m.node = null;
  m.log = '';
  try {
    await node?.stop();
  } catch (e) {
    console.error(e);
  }
}

async function addMachine() {
  const m = createMachine();
  if (m) await bootMachine(m);
  return m;
}

/** スロット 0〜n-1 の VM をそろえて、ネットワーク設定まで待つ */
async function need(n) {
  const list = [];
  for (let s = 0; s < n; s++) list.push(bySlot(s) ?? createMachine(s));
  list.forEach((m) => bootMachine(m));
  await until(() => list.every((m) => m.netReady || m.removed), 300000);
  return list.every((m) => m.netReady);
}

// --- コマンドの投入 ---

async function runSteps(steps) {
  for (const [target, a, b] of steps) {
    if (target === 'wait') {
      await sleep(a);
    } else if (target === 'need') {
      if (!(await need(a))) throw new Error(`VM が ${a} 台そろいませんでした`);
    } else if (target === 'mode') {
      setMode(a);
    } else if (target === 'clear') {
      sw.clearTable();
    } else if (target === 'link') {
      const m = bySlot(a);
      if (m?.port) {
        m.unplug.checked = !b;
        sw.setLinked(m.port, b);
      }
    } else if (target === 'flood') {
      macFlood(a, b);
    } else {
      const m = bySlot(target);
      if (!m?.node) continue;
      m.node.writeSerial(b ? a : a + '\n');
      // 複数行を続けて送るときは、シェルが読み込む間を少し空ける
      if (steps.length > 1) await sleep(60);
    }
  }
}

// プリセットは押した順に1つずつ実行する（実行中に押したものは、終わってから）
let queue = Promise.resolve();
function runPreset(key) {
  const p = PRESETS[key];
  if (p.desc) showExercise(p);
  queue = queue.then(() => runSteps(p.steps)).catch((e) => console.error(e));
  return queue;
}

function showExercise(p) {
  const box = $('exercise');
  const ol = el('ol');
  ol.append(...p.desc.map((t) => el('li', '', t)));
  box.replaceChildren(el('h3', '', p.title), ol);
  box.hidden = false;
}

/**
 * MAC フラッディング: ポート slot から、送り元 MAC を偽ったフレームを count 個入れる。
 * 宛先はブロードキャストにせず、ethertype は実験用（0x88b5）にして、ゲストには無視させる
 */
function macFlood(slot, count) {
  const port = sw.port(slot);
  if (!port) return;
  for (let i = 0; i < count; i++) {
    const f = new Uint8Array(60);
    f.set([0x02, 0x00, 0x0a, 0x05, 0x00, slot + 2]);            // 宛先: 送ったポートの VM 自身
    f.set([0x02, 0x66, (i >> 24) & 0xff, (i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff], 6);
    f[12] = 0x88; f[13] = 0xb5;
    sw.receive(port, f);
  }
}

// --- ハブ / スイッチ ---

function setMode(mode) {
  sw.setMode(mode);
  document.querySelectorAll('input[name=mode]').forEach((r) => (r.checked = r.value === mode));
}
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => r.checked && setMode(r.value)));
$('aging').addEventListener('change', (e) => {
  const s = Math.min(3600, Math.max(1, Number(e.target.value) || 300));
  e.target.value = s;
  sw.setAging(s * 1000);
});
$('clear-table').addEventListener('click', () => sw.clearTable());

$('boot').addEventListener('click', () => machines.forEach((m) => bootMachine(m)));
$('add-vm').addEventListener('click', () => addMachine());
$('net').addEventListener('click', () => machines.forEach((m) => configureNet(m)));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => runPreset(b.dataset.preset)));

// --- パケットモニタ ---

// 集計は、仮想スイッチがフレームを1つ処理するたびの知らせ（onFrame）から数える。キャプチャも同じ知らせを使う
const stats = new TrafficStats();
sw.onFrame((e) => stats.add(e));

// --- パケットキャプチャ（ページを開いたときから記録する） ---

const capture = new Capture();
sw.onFrame((e) => capture.add(e));
// 表示名はスロットで決まる（ゲストのホスト名は使わない）
const portName = (id) => SLOT[id]?.name ?? `P${id + 1}`;
const resolvePort = (s) => {
  const t = s.toLowerCase();
  const byName = SLOT.find((x) => x.name.toLowerCase() === t);
  if (byName) return byName.slot;
  const p = /^p(\d+)$/.exec(t);
  return p && Number(p[1]) >= 1 ? Number(p[1]) - 1 : undefined;
};
const captureView = new CaptureView({ capture, portName, resolvePort, root: $('capture') });
captureView.select(null);

// --- トポロジー・MAC アドレステーブル ---

const topology = new TopologyView({ sw, root: $('topology'), describe: (id) => SLOT[id] ?? null, slots: MAX_VMS });
const macView = new MacTableView({ sw, root: $('mac-rows'), status: $('mac-status'), portName: (id) => `P${id + 1}（${portName(id)}）` });

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
      ['捨てたフレーム', s.dropped.toLocaleString()],
      ...['ARP', 'ICMP', 'TCP', 'UDP', 'IPv6', 'IPv4', 'other'].filter((t) => s.types[t]).map((t) => [t, s.types[t].toLocaleString()]),
    ];
    $('monitor').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
  });
});
stats.reset();
$('reset-stats').addEventListener('click', () => stats.reset());

// --- コマンド例 ---

const examples = [
  ['ネットワーク設定（A。B 以降は IP と MAC の末尾が 1 つずつ増える）', [netCommand(A)]],
  ['ping（A→B）', [`ping -c 4 ${B.ip}`]],
  ['HTTP サーバー（B。socat が1接続ごとに小さなシェルスクリプトを動かす）', httpdScript(B)],
  ['HTTP で取得（A）', [`curl -s http://${B.ip}:8080/`, `wget -q -O - http://${B.ip}:8080/`]],
  ['TCP（nc の代わり）: B で待ち受け → A から接続。あとは打った行が相手に届く。Ctrl-C で終わり', ['B: socat - TCP-LISTEN:7000,reuseaddr', `A: socat - TCP:${B.ip}:7000`]],
  ['盗聴（C）: promiscuous モードで ICMP を見る。-p を付けると promiscuous にしない', [SNIFF, `${SNIFF} -p`]],
  ['promiscuous モードかどうか（flags の 0x100 が PROMISC）', ['cat /sys/class/net/eth0/flags', 'ip link set eth0 promisc on']],
  ['ARP キャッシュ（IP → MAC）を見る・消す', ['ip neigh', flushArp]],
];
$('commands').replaceChildren(...examples.flatMap(([title, lines]) => [el('h3', '', title), el('pre', '', lines.join('\n'))]));

// 最初は 2 台（以前の 2 台構成と同じ IP）。「起動」で全台を起動する
for (let i = 0; i < INITIAL_VMS; i++) createMachine(i);
setBadge();

// 自動テストと計測のために、状態を見えるようにしておく
window.__v86link = {
  machines, sw, stats, capture, captureView, topology, macView, PRESETS, SLOT, downloadMs: 0,
  addMachine, removeMachine, bootMachine, need, runPreset, setMode, macFlood, bySlot,
};

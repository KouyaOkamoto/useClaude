import { V86Node, download } from './vm.js';
import { VirtualSwitch, parseVlanList } from './switch.js';
import { VlanLink } from './vlanlink.js';
import { Capture, TrafficStats } from './capture.js';
import { CaptureView } from './captureview.js';
import { TopologyView, MacTableView, PortPanel } from './switchview.js';

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
 * サブネット。ルーター（ゲートウェイ）は各サブネットの .1。VLAN を分けるときは、サブネットごとにこの VLAN にする
 *   LAN0 は以前の版と同じ 10.5.0.0/24（VLAN 1。最初の A・B はここ）
 */
const SUBNETS = [
  { key: 'lan0', label: 'LAN0', prefix: '10.5.0', vlan: 1 },
  { key: 'lan1', label: 'LAN1', prefix: '10.5.1', vlan: 10 },
  { key: 'lan2', label: 'LAN2', prefix: '10.5.2', vlan: 20 },
];
const subnetOf = (key) => SUBNETS.find((x) => x.key === key) ?? SUBNETS[0];
const cidrOf = (sn) => `${sn.prefix}.0/24`;
const gatewayOf = (sn) => `${sn.prefix}.1`;
// ルーターは最後のスロット（P8）に置く。ホストは P1〜P7（ルーターが無ければ P8 も）
const ROUTER_SLOT = 7;

/**
 * VM の名前・IP・MAC。
 *   ホスト   名前 A〜H（スロットで決まる）/ ホスト名 a〜h / IP はサブネットの .2 から空いているもの /
 *            MAC 02:00 + IP の4バイト（ローカル管理アドレス。IP が違えば MAC も違う）
 *   ルーター 名前 R / ホスト名 r / 各サブネットの .1 / MAC 02:00:0a:05:00:01
 * v86 の NIC（ne2k）の MAC は起動ごとにランダム（00:22:15:xx:xx:xx）で、オプションでは決められないので、
 * ネットワーク設定のときにゲストの中で変える
 */
const macOfIp = (ip) => '02:00:' + ip.split('.').map((x) => Number(x).toString(16).padStart(2, '0')).join(':');
const hostName = (slot) => ({ name: String.fromCharCode(65 + slot), host: String.fromCharCode(97 + slot) });
/** サブネットで、まだ使っていないいちばん小さいホストの IP（.2〜） */
function freeIp(sn, except = null) {
  const used = new Set(machines.filter((m) => m !== except && m.role === 'host' && m.subnet === sn.key).map((m) => m.ip));
  for (let i = 2; i < 255; i++) if (!used.has(`${sn.prefix}.${i}`)) return `${sn.prefix}.${i}`;
  return null;
}
const ipOf = (slot) => bySlot(slot)?.ip ?? `10.5.0.${slot + 2}`;
const nameOf = (slot) => bySlot(slot)?.name ?? (slot === ROUTER_SLOT && hasRouter() ? 'R' : hostName(slot).name);
const hasRouter = () => machines.some((m) => m.role === 'router');

// --- 投入するコマンド（ボタンと「コマンド例」で同じものを使う） ---
// このイメージには nc と httpd が無い（busybox にも入っていない）ので、どちらも socat で代わりにする
const httpdScript = (slot) => [
  () => `mkdir -p /tmp/www; echo '<h1>hello from ${nameOf(slot)} (${ipOf(slot)})</h1>' > /tmp/www/index.html`,
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
//   ホスト:   IP（/24）と、デフォルトゲートウェイ（サブネットの .1。ルーターが無くても設定しておく）
//   ルーター: 1枚の eth0 に各サブネットの .1。ip_forward を ON。同じ eth0 で出入りするので ICMP redirect は送らない
const netCommand = (m) => {
  const head = `hostname ${m.host}; export PS1='\\h:\\w% '; ifconfig eth0 down; ip addr flush dev eth0; ip neigh flush dev eth0; ifconfig eth0 hw ether ${m.mac} && `;
  if (m.role === 'router') {
    const [first, ...rest] = SUBNETS;
    return head + `ifconfig eth0 ${gatewayOf(first)} netmask 255.255.255.0 up && ` +
      rest.map((sn) => `ip addr add ${gatewayOf(sn)}/24 dev eth0 && `).join('') +
      'sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.all.send_redirects=0 net.ipv4.conf.eth0.send_redirects=0; ' +
      `ip addr show eth0 | grep -E 'ether|inet ' && echo "NET""-OK"`;
  }
  return head + `ifconfig eth0 ${m.ip} netmask 255.255.255.0 up && route add default gw ${gatewayOf(subnetOf(m.subnet))} && ` +
    `ip addr show eth0 | grep -E 'ether|inet ' && echo "NET""-OK"`;
};
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
  pingAB: { title: 'ping A→B', steps: [['need', 2], [0, () => `ping -c 4 ${ipOf(1)}`]] },
  pingBA: { title: 'ping B→A', steps: [['need', 2], [1, () => `ping -c 4 ${ipOf(0)}`]] },
  httpServe: { title: 'HTTP サーバー（B）', steps: [['need', 2], ...httpdScript(1).map((c) => [1, c])] },
  httpGet: { title: 'HTTP で取得（A）', steps: [['need', 2], [0, () => `curl -s -w '\\n(HTTP %{http_code}, %{time_total}s)\\n' http://${ipOf(1)}:8080/`]] },
  tcpOpen: {
    title: 'TCP（nc の代わりに socat）',
    steps: [['need', 2], [1, 'socat - TCP-LISTEN:7000,reuseaddr'], ['wait', 1500], [0, () => `socat - TCP:${ipOf(1)}:7000`]],
  },
  tcpSend: { title: '文字列を送る', steps: [[0, 'hello from A'], ['wait', 800], [1, 'hello from B']] },
  tcpClose: { title: '切る', steps: [[0, '\x03', true], [1, '\x03', true]] },

  // --- 学習用 ---
  sniffHub: {
    title: 'ハブで盗聴',
    desc: [
      'A・B・C の3台をそろえ（足りなければ足して起動します）、ハブに切り替えます。',
      `C で tcpdump（${SNIFF}）を動かします。tcpdump は NIC を promiscuous モードにするので、自分宛てでないフレームも見えます。`,
      'A から B へ ping を3回。ハブは全ポートへ届けるので、C の tcpdump に A↔B の ICMP が出ます。',
      '最後に C の tcpdump を Ctrl-C で止めます（「6 packets captured」のように数が出ます）。トポロジー図では、全ポートの線が光ります。',
    ],
    steps: [['need', 3], ['mode', 'hub'], [2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500],
      [0, flushArp], [1, flushArp], [0, () => `ping -c 3 ${ipOf(1)}`], ['wait', 4500], [2, '\x03', true]],
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
      [0, flushArp], [1, flushArp], [0, () => `ping -c 3 ${ipOf(1)}`], ['wait', 4500], [2, '\x03', true]],
  },
  macTable: {
    title: 'MAC テーブルの観察',
    desc: [
      'スイッチにしてテーブルを空にし、A→B、C→A の順に ping します。',
      '送り元の MAC が、入ってきたポートと一緒に1件ずつ増えていくのを、右の「MAC アドレステーブル」で見てください。',
      '残り時間はエージング（既定 300 秒）から減っていき、0 になると消えます（短くして試せます）。',
    ],
    steps: [['need', 3], ['mode', 'switch'], ['clear'], [0, flushArp], [1, flushArp], [2, flushArp],
      [0, () => `ping -c 1 ${ipOf(1)}`], ['wait', 2500], [2, () => `ping -c 1 ${ipOf(0)}`]],
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
      ['flood', 2, 1100], [0, flushArp], [1, flushArp], [0, () => `ping -c 3 ${ipOf(1)}`], ['wait', 4500], [2, '\x03', true]],
  },

  // --- 学習用（ルーティング・VLAN）。A を LAN1（VLAN 10）、B を LAN2（VLAN 20）にし、ルーター R（P8）を置く ---
  routerPing: {
    title: 'ルーターを越える ping',
    desc: [
      'A を LAN1（10.5.1.0/24・VLAN 10）、B を LAN2（10.5.2.0/24・VLAN 20）に置き、ルーター R（各サブネットの .1、ip_forward ON）を足します（足りなければ起動します）。',
      'A の ip route（デフォルトゲートウェイ 10.5.1.1）を見てから、B へ ping。返事の ttl=63 は、ルーターを1つ越えて TTL が 64 から 1 減ったしるしです。',
      'traceroute で、1ホップ目がルーター（10.5.1.1）、2ホップ目が B であることを見ます。',
      'ping -t 1（TTL 1）だと、ルーターが転送できずに「Time to live exceeded」を返します（キャプチャでは ICMP Time exceeded）。',
      '最後にルーターのルーティングテーブル（ip route）を、右の「ルーター」パネルにも読み込みます。',
    ],
    steps: [['lab'], [0, 'ip route'], [0, () => `ping -c 3 ${ipOf(1)}`], ['wait', 3500], [0, () => `traceroute -n -w 2 ${ipOf(1)}`], ['wait', 4000],
      [0, () => `ping -c 1 -t 1 ${ipOf(1)}`], ['wait', 1500], [ROUTER_SLOT, 'ip route'], ['routes']],
  },
  noGateway: {
    title: 'ゲートウェイ未設定の失敗',
    desc: [
      'A のデフォルトルート（ゲートウェイ）を消して、別のサブネットの B へ ping します。',
      'A は 10.5.2.2 への道を知らないので、パケットを送ることもできず「Network is unreachable」になります（キャプチャにも何も出ません）。',
      '5 秒後にゲートウェイを設定し直して（route add default gw 10.5.1.1）、もう一度 ping すると通ります。',
    ],
    steps: [['lab'], [0, 'ip route del default; ip route'], [0, () => `ping -c 2 -W 1 ${ipOf(1)}`], ['wait', 5000],
      [0, 'route add default gw 10.5.1.1; ip route'], [0, () => `ping -c 2 ${ipOf(1)}`]],
  },
  forwardOff: {
    title: 'ip_forward OFF の失敗',
    desc: [
      'ルーターで転送を止めます（echo 0 > /proc/sys/net/ipv4/ip_forward）。',
      'A の ping はルーターまでは届きますが、ルーターは自分宛てでないパケットを捨てるので、B には届きません（100% packet loss）。',
      'キャプチャでは、A → R の echo request だけが並び、R → B が出ないのが見えます。そのあと転送を ON に戻すと通ります。',
    ],
    steps: [['lab'], ['forward', false], [0, () => `ping -c 3 -W 1 ${ipOf(1)}`], ['wait', 4500], ['forward', true], [0, () => `ping -c 2 ${ipOf(1)}`]],
  },
  vlanIsolation: {
    title: 'VLAN 分離',
    desc: [
      'A と B を同じサブネット（LAN1 10.5.1.0/24）に置き、B のポートだけ VLAN 20 にします（スイッチのポートの設定）。',
      'IP では同じネットワークなのに、スイッチが VLAN 10 と 20 を分けているので、A の ARP（ブロードキャスト）が B に届かず、ping は通りません。',
      'B のポートを VLAN 10 に戻すと通ります。VLAN は、1台のスイッチを、つながらない別々のスイッチに分けるしくみです。',
    ],
    steps: [['need', 2], ['mode', 'switch'], ['vlanPlan', true], ['subnet', 0, 'lan1'], ['subnet', 1, 'lan1'], ['wait', 500],
      ['portVlan', 1, { mode: 'access', access: 20 }], [0, flushArp], [0, () => `ping -c 2 -W 1 ${ipOf(1)}`], ['wait', 3500],
      ['portVlan', 1, { mode: 'access', access: 10 }], [0, () => `ping -c 2 ${ipOf(1)}`]],
  },
  interVlan: {
    title: 'VLAN 間ルーティング',
    desc: [
      'A（LAN1・VLAN 10）と B（LAN2・VLAN 20）は、同じスイッチにつながっていても、VLAN が違うので直接は届きません。',
      'ルーター R のポートはトランク（VLAN 1・10・20 を許可）で、1本の線で全部の VLAN につながっています（router-on-a-stick）。',
      'まず R のケーブルを抜いて ping（通らない）、差し直して ping（通る。ttl=63）。キャプチャでは、R の線の上のフレームに VLAN のタグが付いています。',
      '※ このゲストの Linux は VLAN（8021q）を持たないので、R の NIC とスイッチの間のタグの付け外しは、ページの JavaScript（VlanLink）が代わりに行います（README）。',
    ],
    steps: [['lab'], ['link', ROUTER_SLOT, false], [0, () => `ping -c 2 -W 1 ${ipOf(1)}`], ['wait', 3500], ['link', ROUTER_SLOT, true],
      [0, flushArp], [0, () => `ping -c 3 ${ipOf(1)}`]],
  },
  trunkTags: {
    title: 'トランクのタグを観察',
    desc: [
      'A から B へ ping し、キャプチャのフィルタを「vlan」にして、タグ付きのフレームだけを表示します。',
      'R のトランクポートから入ってきたフレームに 802.1Q のタグ（VLAN 10 / 20）が付いています。行を選ぶと、詳細に「802.1Q Virtual LAN」（VLAN ID・優先度）が出ます。',
      '経路の列の「R[10]」のような表示は、トランクへ出たときに VLAN 10 のタグを付けたという意味です。',
      'pcap をダウンロードして Wireshark で開くと、同じタグが見えます（フィルタ vlan.id == 20 など）。',
    ],
    steps: [['lab'], ['filter', 'vlan'], [0, () => `ping -c 2 ${ipOf(1)}`]],
  },
  unplugB: {
    title: 'ケーブル: B を抜く',
    desc: ['B のケーブルを抜いて A→B へ ping します（届かない）。キャプチャでは「A → ✕」になります。5 秒後に差し直します。'],
    steps: [['need', 2], ['link', 1, false], [0, () => `ping -c 3 -W 1 ${ipOf(1)}`], ['wait', 5000], ['link', 1, true]],
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
  $('add-vm').disabled = machines.length >= MAX_VMS || firstFreeSlot() === undefined;
  $('add-router').disabled = hasRouter() || !!bySlot(ROUTER_SLOT);
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

/**
 * VM のカードを作る（まだ起動しない）。
 *   slot: スイッチのポート番号（省略すると空いているもの）/ role: "host" か "router" / subnet: ホストのサブネット（"lan0" など）
 */
function createMachine(slot = firstFreeSlot(), { role = 'host', subnet = $('add-subnet').value } = {}) {
  if (role === 'router') slot = ROUTER_SLOT;
  if (slot === undefined || bySlot(slot)) return null;
  const isRouter = role === 'router';
  const sn = subnetOf(subnet);
  const info = isRouter
    ? { slot, role, name: 'R', host: 'r', subnet: null, ip: SUBNETS.map(gatewayOf).join(' / '), mac: macOfIp(gatewayOf(SUBNETS[0])) }
    : { slot, role, ...hostName(slot), subnet: sn.key, ip: null, mac: null };
  const card = el('section', 'vm' + (isRouter ? ' router' : ''));
  card.dataset.slot = String(slot);
  const head = el('div', 'vm-head');
  const stateEl = el('span', 'vm-state', '停止中');
  const remove = el('button', 'ghost vm-remove', '削除');
  remove.title = `${info.name} を止めて、スイッチから外す`;
  const progress = el('progress');
  progress.max = 1;
  progress.hidden = true;
  const ipEl = el('code', 'vm-ip', '');
  const macEl = el('code', 'vm-mac', '');
  // ホストは所属するサブネットを選べる（変えると IP・MAC・ゲートウェイ・ポートの VLAN を設定し直す）
  const subnetSel = el('select', 'vm-subnet');
  subnetSel.title = '所属するサブネット';
  for (const x of SUBNETS) subnetSel.append(Object.assign(el('option', '', `${x.label} ${cidrOf(x)}`), { value: x.key }));
  subnetSel.value = sn.key;
  subnetSel.hidden = isRouter;
  head.append(el('b', 'vm-name', info.name), isRouter ? el('span', 'vm-role', 'ルーター') : subnetSel, ipEl, el('span', 'vm-port', `P${slot + 1}`), stateEl, remove, progress);
  // ポートごとのケーブル・遅延・損失
  const link = el('div', 'vm-link');
  const unplug = Object.assign(el('input'), { type: 'checkbox', className: 'unplug' });
  const delay = Object.assign(el('input'), { type: 'number', className: 'delay', min: 0, max: 2000, step: 10, value: 0 });
  const loss = Object.assign(el('input'), { type: 'number', className: 'loss', min: 0, max: 100, step: 5, value: 0 });
  const lab = (...xs) => { const l = el('label'); l.append(...xs); return l; };
  const unplugLabel = lab(unplug, ' ケーブルを抜く');
  unplugLabel.className = 'toggle';
  link.append(unplugLabel, lab('遅延 ', delay, ' ms'), lab('損失 ', loss, ' %'), macEl);
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

  const m = {
    ...info, el: card, term, fit, stateEl, progress, unplug, delay, loss, ipEl, macEl, subnetSel,
    node: null, link: null, port: null,
    log: '',              // シリアル出力（自動テストと、プロンプトの検出に使う）
    ready: false, netReady: false, removed: false, bootMs: 0, netMs: 0,
    decoder: new TextDecoder(),
  };
  machines.push(m);
  machines.sort((a, b) => a.slot - b.slot);
  if (!isRouter) assignAddress(m, sn);
  showAddress(m);
  term.write(`\x1b[90m${m.name}（${isRouter ? 'ルーター ' : ''}${m.ip}）: 起動すると Linux が動きます\x1b[0m\r\n`);
  // ターミナルへのキー入力は、このカードの VM のシリアルへ（ほかの VM には行かない）
  m.disposeInput = term.onData((data) => m.node?.writeSerial(data));
  remove.addEventListener('click', () => removeMachine(m));
  unplug.addEventListener('change', () => { if (m.port) sw.setLinked(m.port, !unplug.checked); });
  const applyLink = () => {
    if (m.port) sw.setPortOptions(m.port, { delayMs: Number(delay.value), lossRate: Number(loss.value) / 100 });
  };
  delay.addEventListener('input', applyLink);
  loss.addEventListener('input', applyLink);
  subnetSel.addEventListener('change', () => setSubnet(m, subnetSel.value));
  setBadge();
  return m;
}

/** ホストに、サブネットの空いている IP と、それに合わせた MAC を割り当てる */
function assignAddress(m, sn) {
  m.subnet = sn.key;
  m.ip = freeIp(sn, m);
  m.mac = macOfIp(m.ip);
}

function showAddress(m) {
  m.ipEl.textContent = m.role === 'router' ? m.ip : `${m.ip}/24 → gw ${gatewayOf(subnetOf(m.subnet))}`;
  m.macEl.textContent = m.mac;
  if (m.subnetSel.value !== (m.subnet ?? m.subnetSel.value)) m.subnetSel.value = m.subnet;
}

/** ホストのサブネットを変える: IP・MAC を割り当て直し、ポートの VLAN を合わせ、起動していればネットワーク設定をやり直す */
async function setSubnet(m, key) {
  if (m.role !== 'host' || m.removed) return;
  if (m.subnet === key && m.ip) return;
  assignAddress(m, subnetOf(key));
  showAddress(m);
  if (m.port) applyVlanPlan(m);
  if (m.ready) await configureNet(m);
}

function firstFreeSlot() {
  // ルーターのスロット（P8）は、ルーターが無ければホストにも使う
  for (let s = 0; s < MAX_VMS; s++) if (!bySlot(s) && !(s === ROUTER_SLOT && hasRouter())) return s;
  return undefined;
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
    // ルーターは、NIC とスイッチの間に VlanLink をはさむ（ゲストの代わりにタグを付け外しする。vlanlink.js）
    m.link = m.role === 'router' ? new VlanLink(m.node, { map: [], native: 1 }) : m.node;
    m.port = sw.addPort(m.link, {
      id: m.slot, linked: !m.unplug.checked, delayMs: Number(m.delay.value), lossRate: Number(m.loss.value) / 100,
    });
    applyVlanPlan(m);
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
  if (m.link && m.link !== m.node) m.link.dispose();
  m.link = null;
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

async function addMachine(opts) {
  const m = createMachine(undefined, opts);
  if (m) await bootMachine(m);
  return m;
}

async function addRouter() {
  const m = createMachine(ROUTER_SLOT, { role: 'router' });
  if (m) await bootMachine(m);
  return m;
}

// --- VLAN の割り当て ---

/**
 * 「サブネットごとに VLAN を分ける」の設定に合わせて、ポートの VLAN を決める。
 *   ON:  ホストのポートはアクセス（サブネットの VLAN）。ルーターのポートはトランク（全サブネットの VLAN を許可。ネイティブは VLAN 1）、
 *        VlanLink に「サブネット → VLAN」の対応表を渡す
 *   OFF: 全ポートがアクセス VLAN 1（1つの L2 に全サブネットが同居する。ルーターは同じ線の上で転送する）
 * ポートの設定パネルで手で変えたものは、次にこの関数が呼ばれるまで（サブネット・設定の切り替え）そのまま
 */
function applyVlanPlan(m) {
  if (!m.port) return;
  const on = $('vlan-plan').checked;
  if (m.role === 'router') {
    sw.setPortVlan(m.port, on ? { mode: 'trunk', allowed: [...new Set(SUBNETS.map((x) => x.vlan))], native: 1 } : { mode: 'access', access: 1, allowed: null, native: 1 });
    m.link.setMap(on ? SUBNETS.map((x) => ({ cidr: cidrOf(x), vlan: x.vlan })) : []);
  } else {
    sw.setPortVlan(m.port, { mode: 'access', access: on ? subnetOf(m.subnet).vlan : 1, allowed: null, native: 1 });
  }
}

function setVlanPlan(on) {
  $('vlan-plan').checked = on;
  machines.forEach(applyVlanPlan);
}

/**
 * ルーティングの演習の構成: A を LAN1（10.5.1.0/24・VLAN 10）、B を LAN2（10.5.2.0/24・VLAN 20）にし、ルーター R を置く。
 * VLAN はサブネットごとに分け、スイッチにする
 */
async function lab() {
  if (sw.mode !== 'switch') setMode('switch');
  if (!$('vlan-plan').checked) setVlanPlan(true);
  for (const [slot, key] of [[0, 'lan1'], [1, 'lan2']]) {
    const m = bySlot(slot) ?? createMachine(slot, { subnet: key });
    if (m.role === 'host' && m.subnet !== key) await setSubnet(m, key);
  }
  if (!hasRouter()) {
    if (bySlot(ROUTER_SLOT)) throw new Error('P8 にホストがいるので、ルーターを置けません');
    createMachine(ROUTER_SLOT, { role: 'router' });
  }
  const list = [bySlot(0), bySlot(1), bySlot(ROUTER_SLOT)];
  list.forEach((m) => bootMachine(m));
  await until(() => list.every((m) => m.netReady || m.removed), 300000);
  // ポートの設定パネルで変えたものがあれば、元に戻す
  list.forEach(applyVlanPlan);
  return list.every((m) => m.netReady);
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
    } else if (target === 'lab') {
      if (!(await lab())) throw new Error('ルーティングの演習の構成がそろいませんでした');
    } else if (target === 'subnet') {
      await setSubnet(bySlot(a), b);
    } else if (target === 'vlanPlan') {
      setVlanPlan(a);
    } else if (target === 'portVlan') {
      const m = bySlot(a);
      if (m?.port) sw.setPortVlan(m.port, b);
    } else if (target === 'forward') {
      bySlot(ROUTER_SLOT)?.node?.writeSerial(`echo ${a ? 1 : 0} > /proc/sys/net/ipv4/ip_forward; cat /proc/sys/net/ipv4/ip_forward\n`);
      await sleep(300);
      refreshRouter();
    } else if (target === 'filter') {
      $('cap-filter').value = a;
      captureView.setFilter(a);
    } else if (target === 'routes') {
      await refreshRouter();
    } else {
      const m = bySlot(target);
      if (!m?.node) continue;
      const text = typeof a === 'function' ? a() : a;
      m.node.writeSerial(b ? text : text + '\n');
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
  const dstMac = (bySlot(slot)?.mac ?? '02:00:00:00:00:00').split(':').map((h) => parseInt(h, 16));
  for (let i = 0; i < count; i++) {
    const f = new Uint8Array(60);
    f.set(dstMac);            // 宛先: 送ったポートの VM 自身
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
$('add-router').addEventListener('click', () => addRouter());
$('vlan-plan').addEventListener('change', (e) => setVlanPlan(e.target.checked));
$('net').addEventListener('click', () => machines.forEach((m) => configureNet(m)));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => runPreset(b.dataset.preset)));

// --- パケットモニタ ---

// 集計は、仮想スイッチがフレームを1つ処理するたびの知らせ（onFrame）から数える。キャプチャも同じ知らせを使う
const stats = new TrafficStats();
sw.onFrame((e) => stats.add(e));

// --- パケットキャプチャ（ページを開いたときから記録する） ---

const capture = new Capture();
sw.onFrame((e) => capture.add(e));
// 表示名は、このページが決めた名前（A〜H・R）。ゲストのホスト名は使わない
const portName = (id) => nameOf(id);
const resolvePort = (s) => {
  const t = s.toLowerCase();
  if (t === 'r') return hasRouter() ? ROUTER_SLOT : undefined;
  if (/^[a-h]$/.test(t)) return t.charCodeAt(0) - 97;
  const p = /^p(\d+)$/.exec(t);
  return p && Number(p[1]) >= 1 ? Number(p[1]) - 1 : undefined;
};
const captureView = new CaptureView({ capture, portName, resolvePort, root: $('capture') });
captureView.select(null);

// --- トポロジー・MAC アドレステーブル・ポートの設定 ---

const describe = (id) => {
  const m = bySlot(id);
  if (!m) return null;
  return m.role === 'router'
    ? { name: 'R', role: 'router', ip: 'ルーター', sub: SUBNETS.map((x) => `.${x.prefix.split('.')[2]}`).join(' ') }
    : { name: m.name, role: 'host', ip: m.ip, sub: subnetOf(m.subnet).label };
};
const portPanel = new PortPanel({ sw, root: $('port-panel'), portName: (id) => `P${id + 1}（${portName(id)}）`, parseVlanList });
const topology = new TopologyView({ sw, root: $('topology'), describe, slots: MAX_VMS, onSelect: (id) => portPanel.open(id) });
const macView = new MacTableView({ sw, root: $('mac-rows'), status: $('mac-status'), portName: (id) => `P${id + 1}（${portName(id)}）` });

// --- ルーター（ゲストの ip route を読んで、テキストとして表示する） ---

/**
 * ルーターのシリアルにコマンドを送り、RT-BEGIN 〜 RT-END の間の出力を取り出す。
 * ゲストの出力は信用できない入力なので、制御文字を除いて、textContent で表示する
 */
async function refreshRouter() {
  const r = bySlot(ROUTER_SLOT);
  const box = $('router-routes');
  if (!r || r.role !== 'router' || !r.ready) {
    box.textContent = 'ルーターはまだありません（「ルーターを追加」か、ルーティングの学習用ボタンで起動します）。';
    $('router-state').textContent = '';
    return;
  }
  const mark = r.log.length;
  r.node.writeSerial('echo "RT""-BEGIN"; ip route; echo "ip_forward=$(cat /proc/sys/net/ipv4/ip_forward)"; echo "RT""-END"\n');
  const ok = await until(() => /^RT-END\s*$/m.test(r.log.slice(mark)), 10000);
  if (!ok) return;
  const out = r.log.slice(mark);
  const body = out.slice(out.search(/^RT-BEGIN\s*$/m)).split('\n').slice(1);
  const lines = [];
  for (const line of body) {
    if (/^RT-END\s*$/.test(line)) break;
    // 色などのエスケープシーケンスと制御文字を除く
    lines.push(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''));
  }
  const fwd = lines.find((l) => l.startsWith('ip_forward='));
  box.textContent = lines.filter((l) => l !== fwd).join('\n').slice(0, 4000) || '（ルートなし）';
  $('router-state').textContent = fwd === 'ip_forward=1' ? '転送 ON（ip_forward = 1）' : fwd === 'ip_forward=0' ? '転送 OFF（ip_forward = 0）' : '';
  $('router-state').className = 'router-state ' + (fwd === 'ip_forward=1' ? 'ok' : 'off');
}
$('router-refresh').addEventListener('click', () => refreshRouter());
$('router-fwd-on').addEventListener('click', () => runSteps([['forward', true]]));
$('router-fwd-off').addEventListener('click', () => runSteps([['forward', false]]));

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

const exA = { role: 'host', host: 'a', mac: macOfIp('10.5.0.2'), ip: '10.5.0.2', subnet: 'lan0' };
const examples = [
  ['ネットワーク設定（A。IP はサブネットごとに .2 から。MAC は 02:00 + IP）', [netCommand(exA)]],
  ['ネットワーク設定（ルーター R。1枚の eth0 に各サブネットの .1。ip_forward ON）', [netCommand({ role: 'router', host: 'r', mac: macOfIp('10.5.0.1') })]],
  ['ping（A→B）', ['ping -c 4 10.5.0.3']],
  ['HTTP サーバー（B。socat が1接続ごとに小さなシェルスクリプトを動かす）', httpdScript(1).map((x) => (typeof x === 'function' ? x() : x))],
  ['HTTP で取得（A）', ['curl -s http://10.5.0.3:8080/', 'wget -q -O - http://10.5.0.3:8080/']],
  ['TCP（nc の代わり）: B で待ち受け → A から接続。あとは打った行が相手に届く。Ctrl-C で終わり', ['B: socat - TCP-LISTEN:7000,reuseaddr', 'A: socat - TCP:10.5.0.3:7000']],
  ['盗聴（C）: promiscuous モードで ICMP を見る。-p を付けると promiscuous にしない', [SNIFF, `${SNIFF} -p`]],
  ['promiscuous モードかどうか（flags の 0x100 が PROMISC）', ['cat /sys/class/net/eth0/flags', 'ip link set eth0 promisc on']],
  ['ARP キャッシュ（IP → MAC）を見る・消す', ['ip neigh', flushArp]],
  ['ルーティング（ホスト）: ルートを見る・ゲートウェイを消す・設定する', ['ip route', 'ip route del default', 'route add default gw 10.5.1.1']],
  ['ルーティング（別のサブネットへ）: TTL・経路・TTL 切れ', ['ping -c 3 10.5.2.2        # ttl=63', 'traceroute -n 10.5.2.2', 'ping -c 1 -t 1 10.5.2.2   # Time to live exceeded']],
  ['ルーター: 転送の ON/OFF・ルートを見る', ['cat /proc/sys/net/ipv4/ip_forward', 'echo 0 > /proc/sys/net/ipv4/ip_forward', 'sysctl -w net.ipv4.ip_forward=1', 'ip route']],
  ['VLAN のタグを見る（tcpdump -e。ゲストに届くのはタグを外したフレーム。タグはパケットキャプチャで見る）', ['tcpdump -e -n -l -i eth0']],
];
$('commands').replaceChildren(...examples.flatMap(([title, lines]) => [el('h3', '', title), el('pre', '', lines.join('\n'))]));

// 最初は 2 台（LAN0。以前の 2 台構成と同じ IP）。「起動」で全台を起動する
for (let i = 0; i < INITIAL_VMS; i++) createMachine(i, { subnet: 'lan0' });
setBadge();
refreshRouter();

// 自動テストと計測のために、状態を見えるようにしておく
window.__v86link = {
  machines, sw, stats, capture, captureView, topology, macView, portPanel, PRESETS, SUBNETS, ROUTER_SLOT, downloadMs: 0,
  addMachine, addRouter, removeMachine, bootMachine, need, lab, runPreset, runSteps, setMode, setSubnet, setVlanPlan, macFlood, bySlot, refreshRouter,
};

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

// --- ゲストの設定 ---
const LIB = 'lib/v86/';
/**
 * ゲストのイメージ。既定は v86 の公式イメージ（Buildroot Linux 6.8）。
 * URL の ?image=<名前> で、ここに登録したものにだけ切り替えられる（任意のファイルは読まない）。images/README.md
 */
const IMAGES = {
  buildroot68: 'images/buildroot-bzimage68.bin',
};
const IMAGE_NAME = Object.hasOwn(IMAGES, new URLSearchParams(location.search).get('image') ?? '') ? new URLSearchParams(location.search).get('image') : 'buildroot68';
const IMAGE = IMAGES[IMAGE_NAME];
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
 * 学習の手順で使う操作（アクション）。手順は、これを順に実行する:
 *   [slot, text, raw]      その VM のシリアルへ（raw でなければ改行を足す）。text は関数でもよい（実行するときの IP を使うため）
 *   ['wait', ms]           待つ
 *   ['need', n]            スロット 0〜n-1 の VM がそろって、ネットワーク設定まで終わるのを待つ（足りなければ足す）
 *   ['lab']                ルーティングの構成（A を LAN1、B を LAN2、ルーター R）をそろえる
 *   ['boot']               いまあるカードの VM を全部起動して、準備完了まで待つ
 *   ['mode', 'hub'|'switch']  ハブ / スイッチに切り替える（テーブルは空になる）
 *   ['clear']              MAC アドレステーブルを空にする
 *   ['link', slot, bool]   ケーブルを差す / 抜く
 *   ['flood', slot, n]     そのポートから、送り元 MAC を偽ったフレームを n 個（MAC フラッディング）
 *   ['subnet', slot, key] / ['vlanPlan', bool] / ['portVlan', slot, cfg]   サブネット・VLAN の設定
 *   ['forward', bool]      ルーターの ip_forward / ['routes'] ルーターの ip route を読む / ['filter', text] キャプチャのフィルタ
 *   ['observe', tab]       観察のタブを切り替える
 */
const ping = (from, to, opts = '-c 3') => [from, () => `ping ${opts} ${ipOf(to)}`];

/**
 * 学習。group で選択肢をまとめる。
 *   intro:   説明 / vms: 並べて表示する VM（スロット。null なら1つずつ表示）/ observe: 最初に開く観察のタブ
 *   setup:   「開始」でそろえる構成 / steps: [{ title, actions, check }]（1つずつ「実行」する。check は確認ポイント）
 */
const LESSONS = [
  {
    key: 'free', group: '基本', title: '自由に使う',
    intro: '学習の手順は無く、VM を自由に操作します。「開始」で、いまある VM（最初は A・B）を起動します。VM の追加・削除は端末の上のボタンで、ケーブル・遅延・損失・VLAN はトポロジー図の VM をクリックして変えられます。',
    vms: null, observe: 'topology', setup: [['boot']], steps: [],
  },
  {
    key: 'basic', group: '基本', title: '疎通確認（ping・HTTP・TCP）',
    intro: 'A と B（LAN0 10.5.0.0/24）で、ping・HTTP・TCP の通信を試します。このイメージには nc と httpd が無いので、どちらも socat で代わりにしています。',
    vms: [0, 1], observe: 'topology', setup: [['need', 2]],
    steps: [
      { title: 'ping A→B', actions: [ping(0, 1, '-c 4'), ['wait', 4000]], check: '4 packets transmitted, 4 received' },
      { title: 'ping B→A', actions: [ping(1, 0, '-c 4'), ['wait', 4000]], check: 'B からも届く' },
      { title: 'B で HTTP サーバーを起動', actions: httpdScript(1).map((c) => [1, c]), check: 'socat が 8080 番で待ち受ける（socat … & の行）' },
      { title: 'A から HTTP で取得', actions: [[0, () => `curl -s -w '\\n(HTTP %{http_code}, %{time_total}s)\\n' http://${ipOf(1)}:8080/`]], check: 'A に hello from B と (HTTP 200, …) が出る。B に GET / のログ' },
      { title: 'TCP でつなぐ（B で待ち受け → A から接続）', actions: [[1, 'socat - TCP-LISTEN:7000,reuseaddr'], ['wait', 1500], [0, () => `socat - TCP:${ipOf(1)}:7000`]], check: 'キャプチャに SYN → SYN,ACK → ACK' },
      { title: '文字列を送り合う', actions: [[0, 'hello from A'], ['wait', 800], [1, 'hello from B']], check: '打った行が相手の端末に出る。キャプチャで PSH,ACK の中身を見る' },
      { title: '切る（Ctrl-C）', actions: [[0, '\x03', true], [1, '\x03', true]], check: 'キャプチャに FIN' },
    ],
  },
  {
    key: 'sniffHub', group: 'L2: スイッチと盗聴', title: 'ハブで盗聴',
    intro: 'ハブは、入ってきたポート以外の全ポートにフレームを届けます。C で tcpdump を動かすと、A と B の通信が見えてしまいます。tcpdump は NIC を promiscuous モード（自分宛てでないフレームも受け取る）にします。',
    vms: [0, 1, 2], observe: 'topology', setup: [['need', 3]],
    steps: [
      { title: 'ハブに切り替える', actions: [['mode', 'hub']], check: '図の真ん中が「ハブ」になる' },
      { title: 'C で tcpdump（盗聴）を始める', actions: [[2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500]], check: 'C に listening on eth0 が出る' },
      { title: 'A から B へ ping を3回', actions: [[0, flushArp], [1, flushArp], ping(0, 1), ['wait', 4500]], check: 'C の tcpdump に IP 10.5.0.2 > 10.5.0.3: ICMP echo request が出る。図では全ポートの線が光る' },
      { title: 'C の tcpdump を止める', actions: [[2, '\x03', true]], check: '「6 packets captured」。キャプチャの経路は A → B, C' },
    ],
  },
  {
    key: 'sniffSwitch', group: 'L2: スイッチと盗聴', title: 'スイッチでは盗聴できない',
    intro: 'L2 スイッチは送り元の MAC アドレスを覚え、知っている宛先へはそのポートにだけ届けます。同じことをスイッチで試すと、C の tcpdump には A↔B の ICMP が出ません。',
    vms: [0, 1, 2], observe: 'topology', setup: [['need', 3]],
    steps: [
      { title: 'スイッチにして、MAC テーブルを空にする', actions: [['mode', 'switch'], ['clear']], check: '図の真ん中が「L2 スイッチ」' },
      { title: 'C で tcpdump（盗聴）を始める', actions: [[2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500]], check: 'C に listening on eth0' },
      { title: 'A・B の ARP キャッシュを消して、A から B へ ping', actions: [[0, flushArp], [1, flushArp], ping(0, 1), ['wait', 4500]], check: 'ARP（ブロードキャスト）でスイッチが A と B を覚え、ICMP は B のポートだけに届く' },
      { title: 'C の tcpdump を止める', actions: [[2, '\x03', true]], check: '「0 packets captured」。ARP キャッシュを消さないと、最初の1つだけフラッディングで見えることがある' },
    ],
  },
  {
    key: 'macTable', group: 'L2: スイッチと盗聴', title: 'MAC テーブルの観察',
    intro: 'スイッチが送り元の MAC アドレスを、入ってきたポートと一緒に覚えていく様子を、MAC テーブルで見ます。',
    vms: [0, 1, 2], observe: 'mac', setup: [['need', 3]],
    steps: [
      { title: 'スイッチにして、テーブルと ARP キャッシュを空にする', actions: [['mode', 'switch'], ['clear'], [0, flushArp], [1, flushArp], [2, flushArp]], check: 'MAC テーブルが空' },
      { title: 'A から B へ ping 1回', actions: [ping(0, 1, '-c 1'), ['wait', 2500]], check: 'A（P1）と B（P2）の MAC が入る' },
      { title: 'C から A へ ping 1回', actions: [ping(2, 0, '-c 1'), ['wait', 2500]], check: 'C（P3）の MAC も入る。残り時間はエージング（300 秒）から減っていく。エージングを数秒にすると消えるのが見える' },
    ],
  },
  {
    key: 'macFlood', group: 'L2: スイッチと盗聴', title: 'MAC フラッディング',
    intro: 'スイッチの MAC テーブルには上限（VLAN ごと 1024 件）があります。偽の送り元 MAC を大量に送って埋めると、新しい MAC を覚えられず、スイッチなのにフラッディングで盗聴できるようになります。',
    vms: [0, 1, 2], observe: 'mac', setup: [['need', 3]],
    steps: [
      { title: 'スイッチにして、テーブルを空にする', actions: [['mode', 'switch'], ['clear']], check: 'MAC テーブルが空' },
      { title: 'C で tcpdump を始める', actions: [[2, '\x03', true], ['wait', 300], [2, SNIFF], ['wait', 1500]], check: 'C に listening on eth0' },
      { title: 'C のポートから偽の MAC を 1100 個送る', actions: [['flood', 2, 1100]], check: 'テーブルが 1024 件で「いっぱい」になる（ページの JavaScript が C の代わりに送る）' },
      { title: 'A から B へ ping', actions: [[0, flushArp], [1, flushArp], ping(0, 1), ['wait', 4500]], check: 'A と B の MAC を覚えられないので、ICMP がフラッディングになる' },
      { title: 'C の tcpdump を止める', actions: [[2, '\x03', true]], check: 'スイッチなのに「6 packets captured」。偽のエントリはエージングか「空にする」で消える' },
    ],
  },
  {
    key: 'unplugB', group: 'L2: スイッチと盗聴', title: 'ケーブルを抜く',
    intro: 'B のケーブルを抜くと、スイッチは B のポートとの間のフレームを捨てます。どのポートのケーブルも、図の VM をクリックして抜き差しできます。',
    vms: [0, 1], observe: 'topology', setup: [['need', 2]],
    steps: [
      { title: 'B のケーブルを抜く', actions: [['link', 1, false]], check: '図の B の線が赤い点線になる' },
      { title: 'A から B へ ping', actions: [ping(0, 1, '-c 3 -W 1'), ['wait', 4000]], check: '100% packet loss。キャプチャでは A → ✕（捨てた理由: ケーブル）' },
      { title: 'B のケーブルを差し直す', actions: [['link', 1, true]], check: '線が元に戻る' },
      { title: 'もう一度 ping', actions: [ping(0, 1, '-c 2'), ['wait', 2500]], check: '通る' },
    ],
  },
  {
    key: 'routerPing', group: 'L3: ルーティング', title: 'ルーターを越える ping',
    intro: 'A を LAN1（10.5.1.0/24・VLAN 10）、B を LAN2（10.5.2.0/24・VLAN 20）に置き、ルーター R（各サブネットの .1、ip_forward ON）でつなぎます。別のサブネットへは、デフォルトゲートウェイ（ルーター）を通って届きます。',
    vms: [0, 1, 7], observe: 'router', setup: [['lab'], ['routes']],
    steps: [
      { title: 'A のルーティングテーブルを見る', actions: [[0, 'ip route']], check: 'default via 10.5.1.1（ゲートウェイ）' },
      { title: 'A から B（別のサブネット）へ ping', actions: [ping(0, 1), ['wait', 3500]], check: '返事が ttl=63。64 からルーターで 1 減った' },
      { title: 'traceroute で経路を見る', actions: [[0, () => `traceroute -n -w 2 ${ipOf(1)}`], ['wait', 4000]], check: '1 ホップ目がルーター 10.5.1.1、2 ホップ目が B' },
      { title: 'TTL 1 で ping', actions: [ping(0, 1, '-c 1 -t 1'), ['wait', 1500]], check: 'ルーターが「Time to live exceeded」を返す（キャプチャでは ICMP Time exceeded）' },
      { title: 'ルーターのルーティングテーブルを見る', actions: [[7, 'ip route'], ['routes']], check: '3つのサブネットが eth0 に直接つながっている' },
    ],
  },
  {
    key: 'noGateway', group: 'L3: ルーティング', title: 'ゲートウェイ未設定の失敗',
    intro: 'デフォルトゲートウェイが無いと、ホストは自分のサブネットの外への道を知りません。',
    vms: [0, 1, 7], observe: 'router', setup: [['lab']],
    steps: [
      { title: 'A のデフォルトルートを消す', actions: [[0, 'ip route del default; ip route']], check: 'default の行が消える' },
      { title: 'A から B へ ping', actions: [ping(0, 1, '-c 2 -W 1'), ['wait', 3000]], check: '「Network is unreachable」。送ることもできないので、キャプチャにも出ない' },
      { title: 'ゲートウェイを設定し直す', actions: [[0, 'route add default gw 10.5.1.1; ip route']], check: 'default via 10.5.1.1' },
      { title: 'もう一度 ping', actions: [ping(0, 1, '-c 2'), ['wait', 2500]], check: '通る（ttl=63）' },
    ],
  },
  {
    key: 'forwardOff', group: 'L3: ルーティング', title: 'ip_forward OFF の失敗',
    intro: 'Linux は ip_forward が 0 だと、自分宛てでないパケットを転送せずに捨てます。',
    vms: [0, 1, 7], observe: 'router', setup: [['lab'], ['routes']],
    steps: [
      { title: 'ルーターの転送を止める', actions: [['forward', false]], check: '「ルーター」タブが「転送 OFF（ip_forward = 0）」' },
      { title: 'A から B へ ping', actions: [ping(0, 1, '-c 3 -W 1'), ['wait', 4500]], check: '100% packet loss。キャプチャでは A → R の request だけで、R → B が出ない' },
      { title: '転送を ON に戻す', actions: [['forward', true]], check: '「転送 ON」' },
      { title: 'もう一度 ping', actions: [ping(0, 1, '-c 2'), ['wait', 2500]], check: '通る' },
    ],
  },
  {
    key: 'vlanIsolation', group: 'VLAN', title: 'VLAN 分離',
    intro: 'A と B を同じサブネット（LAN1 10.5.1.0/24）に置き、B のポートだけ VLAN 20 にします。IP では同じネットワークでも、スイッチが VLAN で分けていると届きません。',
    vms: [0, 1], observe: 'topology',
    setup: [['need', 2], ['mode', 'switch'], ['vlanPlan', true], ['subnet', 0, 'lan1'], ['subnet', 1, 'lan1'], ['wait', 500]],
    steps: [
      { title: 'B のポートを VLAN 20 にする', actions: [['portVlan', 1, { mode: 'access', access: 20 }]], check: '図の B の色が VLAN 20 の色になる' },
      { title: 'A から B へ ping', actions: [[0, flushArp], ping(0, 1, '-c 2 -W 1'), ['wait', 3500]], check: '届かない。A の ARP（ブロードキャスト）が VLAN 10 の中にしか流れない' },
      { title: 'B のポートを VLAN 10 に戻す', actions: [['portVlan', 1, { mode: 'access', access: 10 }]], check: '図の B の色が A と同じになる' },
      { title: 'もう一度 ping', actions: [ping(0, 1, '-c 2'), ['wait', 2500]], check: '通る' },
    ],
  },
  {
    key: 'interVlan', group: 'VLAN', title: 'VLAN 間ルーティング（router-on-a-stick）',
    intro: 'VLAN 10 と 20 は、同じスイッチにつながっていても直接は届きません。ルーター R のポートはトランク（VLAN 1・10・20）で、1本の線で全部の VLAN につながっています。※ このゲストの Linux は VLAN を持たないので、R の NIC とスイッチの間のタグの付け外しは、ページの JavaScript が代わりに行います（README）。',
    vms: [0, 1, 7], observe: 'topology', setup: [['lab']],
    steps: [
      { title: 'ルーター R のケーブルを抜く', actions: [['link', 7, false]], check: '図の R の線が赤い点線' },
      { title: 'A（VLAN 10）から B（VLAN 20）へ ping', actions: [ping(0, 1, '-c 2 -W 1'), ['wait', 3500]], check: '届かない（VLAN をまたぐ道が無い）' },
      { title: 'R のケーブルを差し直す', actions: [['link', 7, true]], check: '' },
      { title: 'もう一度 ping', actions: [[0, flushArp], ping(0, 1), ['wait', 3500]], check: '通る（ttl=63）。図では A → R → B の線が光る' },
    ],
  },
  {
    key: 'trunkTags', group: 'VLAN', title: 'トランクのタグを観察',
    intro: 'ルーター R のトランクポートを通るフレームには、802.1Q の VLAN タグが付いています。キャプチャで見ます。',
    vms: [0, 1, 7], observe: 'topology', setup: [['lab']],
    steps: [
      { title: 'キャプチャのフィルタを「vlan」にする', actions: [['filter', 'vlan']], check: 'タグ付きのフレームだけを表示する' },
      { title: 'A から B へ ping', actions: [ping(0, 1, '-c 2'), ['wait', 2500]], check: 'VLAN 列の [20] は「タグ付きで入ってきた」、経路の R[10] は「R へ VLAN 10 のタグを付けて出した」。行を選ぶと「802.1Q Virtual LAN」' },
      { title: 'pcap をダウンロードして Wireshark で開く（任意）', actions: [], check: 'vlan.id == 20 などで同じタグが見える' },
    ],
  },
];

/** プリセット（学習の構成 + 全部の手順）。自動テストと API から使う。疎通確認の手順は1つずつも呼べる */
const PRESETS = Object.fromEntries(LESSONS.map((l) => [l.key, { title: l.title, steps: [...l.setup, ...l.steps.flatMap((s) => s.actions)] }]));
const basicSteps = LESSONS.find((l) => l.key === 'basic').steps;
for (const [key, i] of [['pingAB', 0], ['pingBA', 1], ['httpServe', 2], ['httpGet', 3], ['tcpOpen', 4], ['tcpSend', 5], ['tcpClose', 6]]) {
  PRESETS[key] = { title: basicSteps[i].title, steps: i >= 5 ? basicSteps[i].actions : [['need', 2], ...basicSteps[i].actions] };
}

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
  $('boot').disabled = !machines.some((m) => !m.node && !m.booting);
  renderTabs();
}

function setVmState(m, text, cls = '') {
  m.stateEl.textContent = text;
  m.stateEl.className = 'vm-state ' + cls;
  m.stateEl.title = text;
  m.stateCls = cls;
  renderTabs();
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
  const remove = el('button', 'ghost vm-remove', '×');
  remove.setAttribute('aria-label', '削除');
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
  // ケーブル・遅延・損失・VLAN は、トポロジー図から開くポートの設定パネルで変える
  head.append(el('b', 'vm-name', info.name), isRouter ? el('span', 'vm-role', 'ルーター') : subnetSel, ipEl, el('span', 'vm-port', `P${slot + 1}`), stateEl, remove, progress);
  const termBox = el('div', 'term');
  card.append(head, termBox);
  // スロット順に並べる
  const after = [...$('vms').children].find((c) => Number(c.dataset.slot) > slot);
  $('vms').insertBefore(card, after ?? null);

  const term = new Terminal({ convertEol: false, fontSize: 12, scrollback: 2000, theme: { background: '#000000' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termBox);
  fit.fit();

  const m = {
    ...info, el: card, term, fit, stateEl, progress, ipEl, macEl, subnetSel,   // macEl は表示しない（ポートの設定パネル・title で見る）
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
  subnetSel.addEventListener('change', () => setSubnet(m, subnetSel.value));
  // 新しい VM は、その VM の端末を表示する
  if (!termView.split) termView.focus = slot;
  setBadge();
  applyTermView();
  return m;
}

/** ホストに、サブネットの空いている IP と、それに合わせた MAC を割り当てる */
function assignAddress(m, sn) {
  m.subnet = sn.key;
  m.ip = freeIp(sn, m);
  m.mac = macOfIp(m.ip);
}

function showAddress(m) {
  // 1行に収めるため、カードには IP だけを出し、ゲートウェイと MAC は title（ポインタを乗せると出る）にする
  m.ipEl.textContent = m.role === 'router' ? m.ip : `${m.ip}/24`;
  m.ipEl.title = (m.role === 'router' ? '' : `ゲートウェイ ${gatewayOf(subnetOf(m.subnet))}\n`) + `MAC ${m.mac}`;
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
  machines.filter((m) => !m.el.hidden).forEach((m) => m.fit.fit());
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
    m.port = sw.addPort(m.link, { id: m.slot });
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
  // 見えていない端末に出力があったら、タブに印を付ける
  if (m.el.hidden && !m.unread) {
    m.unread = true;
    renderTabs();
  }
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
  if (ok) setVmState(m, `準備完了 ${fmt(m.netMs)}`, 'ok');
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
  if (termView.focus === m.slot) termView.focus = machines[0]?.slot ?? 0;
  setBadge();
  applyTermView();
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
      if (m?.port) sw.setLinked(m.port, b);
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
    } else if (target === 'boot') {
      machines.forEach((m) => bootMachine(m));
      await until(() => machines.every((m) => m.netReady || m.removed), 300000);
    } else if (target === 'observe') {
      showTab('observe', a);
    } else {
      const m = bySlot(target);
      if (!m?.node) continue;
      showTerminal(m.slot);
      const text = typeof a === 'function' ? a() : a;
      m.node.writeSerial(b ? text : text + '\n');
      // 複数行を続けて送るときは、シェルが読み込む間を少し空ける
      if (steps.length > 1) await sleep(60);
    }
  }
}

// プリセット・学習の手順は、押した順に1つずつ実行する（実行中に押したものは、終わってから）
let queue = Promise.resolve();
function enqueue(steps) {
  queue = queue.then(() => runSteps(steps)).catch((e) => console.error(e));
  return queue;
}
/** プリセットを最後まで実行する（自動テストと、以前のボタンの名前のため） */
function runPreset(key) {
  return enqueue(PRESETS[key].steps);
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

// --- 端末の表示（タブで1つ / 並べる） ---

/**
 * split: false なら focus の VM だけ、true なら list の VM を並べる（list が null なら全部）。
 * 学習を選ぶと、その学習で使う VM を並べる。「自由に使う」は1つずつ
 */
const termView = { split: false, focus: 0, list: null };
let tabsPending = false;

// スマホの幅では、並べずに1つずつ（タブで切り替える）
const narrow = matchMedia('(max-width: 800px)');
narrow.addEventListener?.('change', () => applyTermView());

function visibleSlots() {
  if (!termView.split || narrow.matches) return bySlot(termView.focus) ? [termView.focus] : machines.slice(0, 1).map((m) => m.slot);
  const all = machines.map((m) => m.slot);
  const want = termView.list ? termView.list.filter((x) => all.includes(x)) : all;
  return want.length ? want : all;
}

function applyTermView() {
  const show = new Set(visibleSlots());
  for (const m of machines) {
    const was = m.el.hidden;
    m.el.hidden = !show.has(m.slot);
    if (!m.el.hidden) m.unread = false;
    if (was && !m.el.hidden) m.needFit = true;
  }
  $('vms').dataset.count = String(Math.min(show.size, 4));
  $('term-layout').textContent = termView.split ? '1つずつ' : '並べる';
  $('term-layout').hidden = narrow.matches;
  $('term-layout').setAttribute('aria-pressed', String(termView.split));
  renderTabs();
  // 表示した端末の大きさを合わせ、ゲストにも伝える
  requestAnimationFrame(() => {
    for (const m of machines) {
      if (m.el.hidden) continue;
      const { cols, rows } = m.term;
      m.fit.fit();
      if (m.ready && (cols !== m.term.cols || rows !== m.term.rows || m.needFit)) tellSize(m);
      m.needFit = false;
    }
  });
}

/** その VM の端末を見えるようにする（1つずつなら切り替え、並べていて見えていなければ足す） */
function showTerminal(slot) {
  if (!termView.split) termView.focus = slot;
  else if (!visibleSlots().includes(slot)) termView.list = [...(termView.list ?? visibleSlots()), slot].sort((a, b) => a - b);
  else return;
  applyTermView();
}

function setTermView(split, list = null) {
  termView.split = split;
  termView.list = list;
  if (!split && list?.length) termView.focus = list[0];
  applyTermView();
}

/** タブ: 名前・状態（色の点）・見ていない間の出力（●） */
function renderTabs() {
  if (tabsPending) return;
  tabsPending = true;
  requestAnimationFrame(() => {
    tabsPending = false;
    const shown = new Set(visibleSlots());
    $('term-tabs').replaceChildren(...machines.map((m) => {
      const b = el('button', 'term-tab' + (shown.has(m.slot) ? ' active' : '') + (m.role === 'router' ? ' router' : ''));
      b.dataset.slot = String(m.slot);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(shown.has(m.slot)));
      const dot = el('span', 'dot ' + (m.netReady ? 'ok' : m.stateCls === 'err' ? 'err' : m.node ? 'busy' : ''));
      b.append(dot, el('span', '', m.name), el('small', '', m.role === 'router' ? 'R' : m.ip ?? ''));
      if (m.unread && !shown.has(m.slot)) b.append(el('span', 'unread', '●'));
      b.title = `${m.name}: ${m.stateEl.textContent}`;
      return b;
    }));
  });
}
$('term-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.term-tab');
  if (!b) return;
  const slot = Number(b.dataset.slot);
  showTerminal(slot);
  bySlot(slot)?.term.focus();
});
$('term-layout').addEventListener('click', () => setTermView(!termView.split, termView.split ? null : currentLesson().vms));

// --- タブ（観察・下段） ---

function showTab(group, name) {
  document.querySelectorAll(`[data-tabs="${group}"] [data-tab]`).forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  });
  document.querySelectorAll(`[data-tabbody="${group}"]`).forEach((x) => (x.hidden = x.dataset.name !== name));
  if (group === 'observe' && name === 'router') refreshRouter();
  if (group === 'drawer') setDrawer(true);
}
document.querySelectorAll('[data-tabs] [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.closest('[data-tabs]').dataset.tabs, b.dataset.tab)));
function setDrawer(open) {
  $('drawer').classList.toggle('closed', !open);
  $('drawer-toggle').textContent = open ? 'たたむ' : 'ひらく';
  $('drawer-toggle').setAttribute('aria-expanded', String(open));
}
$('drawer-toggle').addEventListener('click', () => setDrawer($('drawer').classList.contains('closed')));

// スマホ: 下のボタンで、見る場所（手順・端末・観察・キャプチャ）を切り替える
document.querySelectorAll('.mobile-nav [data-pane]').forEach((b) => b.addEventListener('click', () => setPane(b.dataset.pane)));
function setPane(pane) {
  document.body.dataset.pane = pane;
  document.querySelectorAll('.mobile-nav [data-pane]').forEach((b) => b.classList.toggle('active', b.dataset.pane === pane));
  if (pane === 'term') applyTermView();
}

// --- 学習（選ぶ → 開始 → 手順を1つずつ実行） ---

const lessonState = { key: 'free', ready: false, done: new Set(), running: null };
const currentLesson = () => LESSONS.find((l) => l.key === lessonState.key) ?? LESSONS[0];

{
  const sel = $('lesson');
  for (const group of [...new Set(LESSONS.map((l) => l.group))]) {
    const og = el('optgroup');
    og.label = group;
    og.append(...LESSONS.filter((l) => l.group === group).map((l) => Object.assign(el('option', '', l.title), { value: l.key })));
    sel.append(og);
  }
  sel.addEventListener('change', () => selectLesson(sel.value));
}

/** 手順に出すコマンドの説明（アクションから作る。IP は今の値） */
function describeAction([t, a, b]) {
  if (typeof t === 'number') {
    const text = typeof a === 'function' ? a() : a;
    // P8 にまだ何も無ければ、学習で置くルーター R
    const who = t === ROUTER_SLOT && !bySlot(t) ? 'R' : nameOf(t);
    if (b) return text === '\x03' ? `${who}: Ctrl-C` : `${who}: （キー入力）`;
    return `${who}$ ${text.split('\n')[0]}${text.includes('\n') ? ' …' : ''}`;
  }
  const map = {
    mode: () => (a === 'hub' ? '→ ハブに切り替え' : '→ L2 スイッチに切り替え'),
    clear: () => '→ MAC テーブルを空にする',
    link: () => `→ ${nameOf(a)} のケーブルを${b ? '差す' : '抜く'}`,
    flood: () => `→ ${nameOf(a)} のポートから偽の MAC を ${b} 個`,
    forward: () => `R$ echo ${a ? 1 : 0} > /proc/sys/net/ipv4/ip_forward`,
    portVlan: () => `→ ${nameOf(a)} のポートを ${b.mode === 'trunk' ? 'トランク' : `VLAN ${b.access}`} に`,
    filter: () => `→ キャプチャのフィルタ「${a}」`,
    routes: () => '→ ルーターの ip route を読む',
  };
  return map[t]?.() ?? null;
}

function renderLesson() {
  const l = currentLesson();
  $('lesson').value = l.key;
  $('lesson-title').textContent = l.title;
  $('lesson-intro').textContent = l.intro;
  const items = l.steps.map((step, i) => {
    const li = el('li', 'lesson-step' + (lessonState.done.has(i) ? ' done' : '') + (lessonState.running === i ? ' running' : ''));
    li.dataset.step = String(i);
    const head = el('div', 'step-head');
    const run = el('button', 'ghost step-run', lessonState.done.has(i) ? 'もう一度' : '実行');
    run.disabled = !lessonState.ready || lessonState.running !== null;
    run.addEventListener('click', () => runLessonStep(i));
    head.append(el('span', 'step-title', step.title), run);
    li.append(head);
    const cmds = step.actions.map(describeAction).filter(Boolean);
    if (cmds.length) li.append(el('pre', 'step-cmd', cmds.join('\n')));
    if (step.check) li.append(el('p', 'step-check', '確認: ' + step.check));
    return li;
  });
  $('lesson-steps').replaceChildren(...items);
  $('lesson-steps').hidden = l.steps.length === 0;
  $('lesson-all').hidden = l.steps.length === 0;
  $('lesson-all').disabled = lessonState.running !== null;
  $('lesson-start').disabled = lessonState.running !== null;
  $('lesson-start').textContent = lessonState.ready ? 'やり直す' : '開始';
}

function selectLesson(key) {
  lessonState.key = LESSONS.some((l) => l.key === key) ? key : 'free';
  lessonState.ready = false;
  lessonState.done.clear();
  const l = currentLesson();
  try { history.replaceState(null, '', '#lesson=' + l.key); } catch { /* file: など */ }
  setTermView(!!l.vms, l.vms);
  showTab('observe', l.observe);
  $('lesson-status').textContent = l.steps.length ? '「開始」で構成をそろえてから、手順を1つずつ実行します。' : '';
  renderLesson();
}

/** 学習の構成をそろえる（「開始」） */
function startLesson() {
  const l = currentLesson();
  lessonState.running = 'setup';
  lessonState.done.clear();
  $('lesson-status').textContent = '構成をそろえています…（VM の起動に数十秒かかります）';
  renderLesson();
  setTermView(!!l.vms, l.vms);
  return enqueue([...l.setup, ['observe', l.observe]]).then(() => {
    lessonState.running = null;
    lessonState.ready = true;
    $('lesson-status').textContent = l.steps.length ? '準備ができました。手順を上から実行してください。' : '準備ができました。';
    renderLesson();
  });
}

function runLessonStep(i) {
  const step = currentLesson().steps[i];
  lessonState.running = i;
  renderLesson();
  return enqueue(step.actions).then(() => {
    lessonState.running = null;
    lessonState.done.add(i);
    renderLesson();
  });
}

async function runLessonAll() {
  if (!lessonState.ready) await startLesson();
  const l = currentLesson();
  for (let i = 0; i < l.steps.length; i++) if (!lessonState.done.has(i)) await runLessonStep(i);
}
$('lesson-start').addEventListener('click', () => startLesson());
$('lesson-all').addEventListener('click', () => runLessonAll());

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

// 最初は 2 台（LAN0。以前の 2 台構成と同じ IP）。「起動」（または学習の「開始」）で全台を起動する
for (let i = 0; i < INITIAL_VMS; i++) createMachine(i, { subnet: 'lan0' });
setBadge();
refreshRouter();
showTab('drawer', 'capture');
setPane('steps');
// URL の #lesson=… で学習を選んで開く（開始はしない）
selectLesson(/(?:^|[#&])lesson=([\w-]+)/.exec(location.hash)?.[1] ?? 'free');

// 自動テストと計測のために、状態を見えるようにしておく
window.__v86link = {
  machines, sw, stats, capture, captureView, topology, macView, portPanel, PRESETS, LESSONS, SUBNETS, ROUTER_SLOT, IMAGE, IMAGE_NAME, downloadMs: 0,
  selectLesson, startLesson, runLessonStep, runLessonAll, lessonState, setTermView, showTerminal, showTab, setPane,
  addMachine, addRouter, removeMachine, bootMachine, need, lab, runPreset, runSteps, setMode, setSubnet, setVlanPlan, macFlood, bySlot, refreshRouter,
};

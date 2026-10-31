// ビルドしたイメージを、Node 上の v86（このリポジトリが同梱している lib/v86）で起動し、コマンドを実行して確かめる。
//
//   node images/build/test-image.cjs <bzImage> [--net] [--report out.json]
//
//   既定（--net なし）: いまのイメージと同じ挙動（プロンプト・inittab・ping の出力・同梱のコマンド）と、2台の疎通
//   --net             : 追加の機能（iptables・nft・VLAN・NAT・LOG・dnsmasq・tc netem・ブリッジ・nmap・dropbear・httpd など）も確かめる
//
// 2台（A・B）は、JS のハブ（相手にそのまま渡す）でつなぐ。終了コードは、失敗があれば 1
'use strict';
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const IMAGE = path.resolve(args.find((a) => !a.startsWith('--')) ?? '');
const NET = args.includes('--net');
const REPORT = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
const LIB = path.resolve(__dirname, '../../lib/v86');
const { V86 } = require(path.join(LIB, 'libv86.js'));
// v86-link と同じ設定（main.js の CMDLINE・MEMORY_MB・ne2k）
const CMDLINE = 'tsc=reliable mitigations=off random.trust_cpu=on';
const MEMORY_MB = Number(process.env.MEMORY_MB || 64);

const results = [];
const check = (name, ok, detail = '', level = 'base') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300), level });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${level}] ${name}${detail ? ' — ' + String(detail).replace(/\s+/g, ' ').slice(0, 200) : ''}`);
};

function boot(name) {
  const vm = new V86({
    wasm_path: path.join(LIB, 'v86.wasm'), bios: { url: path.join(LIB, 'bios/seabios.bin') }, vga_bios: { url: path.join(LIB, 'bios/vgabios.bin') },
    memory_size: MEMORY_MB * 1024 * 1024, autostart: true, net_device: { type: 'ne2k' }, bzimage: { url: IMAGE },
    cmdline: CMDLINE, disable_speaker: true, disable_keyboard: true, disable_mouse: true,
  });
  vm.name = name; vm.all = ''; vm.out = ''; vm.t0 = Date.now(); vm.frames = [];
  vm.add_listener('serial0-output-byte', (b) => { const c = String.fromCharCode(b); vm.all += c; vm.out += c; });
  return vm;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(vm, re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(vm.out)) return true; await sleep(50); }
  return false;
}
/** コマンドを実行して、出力（エスケープシーケンスを除く）を返す */
async function run(vm, cmd, ms = 60000) {
  vm.out = '';
  vm.serial0_send(cmd + '; echo "D""ONE:$?"\n');
  await until(vm, /^DONE:\d+\s*$/m, ms);
  const out = vm.out.replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  const m = /^DONE:(\d+)\s*$/m.exec(out);
  // コマンドのエコー（80 桁で折り返される）と、DONE の行・プロンプトを除く
  const echoEnd = out.indexOf('"D""ONE:$?"');
  const rest = echoEnd >= 0 ? out.slice(out.indexOf('\n', echoEnd) + 1) : out;
  const body = rest.split('\n').filter((l) => !/^DONE:\d+/.test(l) && !/% $/.test(l)).join('\n');
  return { out: body, code: m ? Number(m[1]) : -1 };
}

(async () => {
  if (!fs.existsSync(IMAGE)) { console.error('イメージが無い: ' + IMAGE); process.exit(2); }
  const size = fs.statSync(IMAGE).size;
  console.log(`image ${IMAGE} (${size} bytes), memory ${MEMORY_MB}MB, net=${NET}`);
  const A = boot('A'), B = boot('B');
  // ハブ: 送ったフレームを相手へ。タグ（802.1Q）付きの数も数える
  const vlanFrames = { count: 0, vids: new Set() };
  for (const [from, to] of [[A, B], [B, A]]) {
    from.add_listener('net0-send', (f) => {
      if (((f[12] << 8) | f[13]) === 0x8100) { vlanFrames.count++; vlanFrames.vids.add(((f[14] << 8) | f[15]) & 0xfff); }
      to.bus.send('net0-receive', f);
    });
  }

  // ---------------------------------------------------------------- 起動（いまのイメージと同じ挙動）
  for (const vm of [A, B]) {
    const ok = await until(vm, /% $/m, 180000);
    vm.bootMs = Date.now() - vm.t0;
    check(`${vm.name}: 起動してプロンプト（/% $/）が出る`, ok, ok ? `${vm.bootMs}ms` : JSON.stringify(vm.all.slice(-300)));
    if (!ok) return finish();
  }
  await sleep(500);
  check('端末への問い合わせ（ESC[6n）を出さない', !A.all.includes('\x1b[6n'));
  check('起動の案内（Enable networking using \'udhcpc\'）がシリアルに出る', A.all.includes("Enable networking using 'udhcpc'"));
  check('カーネルのメッセージはシリアルに出ない', !/Linux version|Freeing unused kernel/.test(A.all), JSON.stringify(A.all.slice(0, 120)));
  let r = await run(A, 'echo "PS1=[$PS1]"; hostname; cat /etc/inittab | grep -v "^#"');
  check('プロンプトの設定 PS1=\\W% ', /PS1=\[\\W% \]/.test(r.out), r.out.split('\n')[0]);
  check('ホスト名は (none)（いまのイメージと同じ。init スクリプトは動かさない）', /^\(none\)$/m.test(r.out));
  check('inittab: ttyS0 とコンソールにシェル', /^ttyS0::respawn:-\/bin\/sh$/m.test(r.out) && /^::respawn:-\/bin\/sh$/m.test(r.out));
  r = await run(A, 'ping -V; tcpdump --version 2>&1 | head -1; socat -V | grep "socat version"; curl --version | head -1; which traceroute wget udhcpc ip ifconfig route vconfig arping nslookup');
  check('ping は iputils', /iputils/.test(r.out), r.out.split('\n')[0]);
  check('tcpdump・socat・curl がある', /tcpdump version/.test(r.out) && /socat version/.test(r.out) && /^curl /m.test(r.out));
  check('traceroute・wget・udhcpc・ip・ifconfig・route・vconfig・arping・nslookup がある', r.code === 0, r.out.split('\n').slice(3).join(' '));

  // ---------------------------------------------------------------- 2台の疎通（v86-link の設定と同じコマンド）
  await run(A, 'ifconfig eth0 down; ifconfig eth0 hw ether 02:00:0a:05:00:02 && ifconfig eth0 10.5.0.2 netmask 255.255.255.0 up');
  await run(B, 'ifconfig eth0 down; ifconfig eth0 hw ether 02:00:0a:05:00:03 && ifconfig eth0 10.5.0.3 netmask 255.255.255.0 up');
  r = await run(A, 'ping -c 2 10.5.0.3');
  check('2台の ping（iputils の形式: icmp_seq=1 ttl=64、2 received）', /icmp_seq=1 ttl=64/.test(r.out) && /2 packets transmitted, 2 received/.test(r.out), r.out.split('\n').slice(-2).join(' '));

  if (NET) await netChecks(A, B, vlanFrames);
  return finish();

  function finish() {
    const failed = results.filter((x) => !x.ok);
    const report = { image: IMAGE, bytes: size, memoryMB: MEMORY_MB, bootMs: { A: A.bootMs, B: B.bootMs }, net: NET, passed: results.length - failed.length, failed: failed.length, results };
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      const md = [`### イメージのテスト（${path.basename(IMAGE)}, ${size} bytes, memory ${MEMORY_MB}MB）`, '', `起動（プロンプトまで）: A ${A.bootMs}ms / B ${B.bootMs}ms`, '',
        '| 結果 | 項目 | 詳細 |', '|---|---|---|', ...results.map((x) => `| ${x.ok ? '✅' : '❌'} | ${x.name.replace(/\|/g, '\\|')} | ${x.detail.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)} |`)];
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
    }
    console.log(`\n${report.passed} passed, ${report.failed} failed`);
    process.exit(failed.length ? 1 : 0);
  }
})();

async function netChecks(A, B, vlanFrames) {
  const L = 'net';
  let r = await run(A, 'iptables -V; iptables -L -n; iptables -t nat -L -n');
  check('iptables -L / -t nat -L', r.code === 0 && /Chain INPUT/.test(r.out) && /Chain POSTROUTING/.test(r.out), r.out.split('\n')[0], L);
  r = await run(A, 'iptables-legacy -L -n >/dev/null && echo LEGACY-OK; iptables-nft -L -n >/dev/null && echo NFT-OK');
  check('iptables-legacy・iptables-nft', /LEGACY-OK/.test(r.out) && /NFT-OK/.test(r.out), r.out, L);
  r = await run(A, 'nft --version && nft add table inet t && nft add chain inet t c "{ type filter hook input priority 0; }" && nft list ruleset | head -5 && nft delete table inet t');
  check('nft（nftables）', r.code === 0 && /table inet t/.test(r.out), r.out.split('\n')[0], L);
  // VLAN（ゲストの中のサブインターフェース）
  await run(A, 'ip link add link eth0 name eth0.10 type vlan id 10 && ip addr add 10.10.0.2/24 dev eth0.10 && ip link set eth0.10 up');
  r = await run(B, 'vconfig add eth0 10 && ip addr add 10.10.0.3/24 dev eth0.10 && ip link set eth0.10 up && cat /proc/net/vlan/config');
  check('VLAN: ip link add ... type vlan・vconfig', r.code === 0 && /eth0\.10\s+\|\s+10/.test(r.out), r.out.split('\n').slice(-1)[0], L);
  const before = vlanFrames.count;
  r = await run(A, 'ping -c 2 10.10.0.3');
  check('VLAN: eth0.10 同士で ping（線の上はタグ付き）', /2 received/.test(r.out) && vlanFrames.count > before && vlanFrames.vids.has(10), `タグ付き ${vlanFrames.count - before} フレーム、VID ${[...vlanFrames.vids]}`, L);
  // iptables: LOG・conntrack・NAT
  r = await run(A, 'iptables -A OUTPUT -p icmp -m conntrack --ctstate NEW -j LOG --log-prefix "V86TEST: " && ping -c 1 10.5.0.3 > /dev/null; dmesg | grep V86TEST | tail -1');
  check('iptables: conntrack と LOG（dmesg に出る）', /V86TEST: .*SRC=10\.5\.0\.2 DST=10\.5\.0\.3/.test(r.out), r.out, L);
  r = await run(A, 'iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE && iptables -t nat -A PREROUTING -p tcp --dport 8080 -j DNAT --to-destination 10.5.0.2:80 && iptables -t nat -L -n | grep -c -E "MASQUERADE|DNAT"');
  check('iptables: MASQUERADE・DNAT のルール', r.code === 0 && /^2$/m.test(r.out), r.out, L);
  // httpd（BusyBox）と、DNAT でのポートフォワード（B から A:8080 → A:80）
  r = await run(A, 'mkdir -p /tmp/www && echo hello-v86net > /tmp/www/index.html && httpd -p 80 -h /tmp/www && echo HTTPD-OK');
  r = await run(B, 'wget -q -O - http://10.5.0.2/ && curl -s http://10.5.0.2:8080/');
  check('httpd・wget・curl（DNAT 経由も）', (r.out.match(/hello-v86net/g) || []).length === 2, r.out, L);
  // dnsmasq の DHCP と DNS
  r = await run(A, 'dnsmasq --version | head -1; echo "10.5.0.80 web.lab" > /tmp/hosts.lab && dnsmasq --interface=eth0 --bind-interfaces --dhcp-range=10.5.0.100,10.5.0.150,12h --addn-hosts=/tmp/hosts.lab --no-resolv --local=/lab/ && echo DNSMASQ-OK');
  check('dnsmasq の起動', /Dnsmasq version/.test(r.out) && /DNSMASQ-OK/.test(r.out), r.out.split('\n')[0], L);
  r = await run(B, 'udhcpc -i eth0 -n -q -t 5 2>&1 | tail -2; ip -4 addr show eth0 | grep inet; nslookup web.lab 10.5.0.2 2>&1 | tail -2', 90000);
  check('DHCP: B が dnsmasq からアドレスを取得（udhcpc）', /inet 10\.5\.0\.1[0-5][0-9]\//.test(r.out), r.out.split('\n').filter((l) => /lease|inet/.test(l)).join(' '), L);
  check('DNS: dnsmasq が名前を返す', /10\.5\.0\.80/.test(r.out), r.out.split('\n').slice(-2).join(' '), L);
  // tc netem・ブリッジ
  r = await run(A, 'tc qdisc add dev eth0 root netem delay 100ms && ping -c 2 10.5.0.3 | tail -1; tc qdisc del dev eth0 root');
  const avg = Number((/= [\d.]+\/([\d.]+)\//.exec(r.out) || [])[1]);
  check('tc netem（遅延 100ms）', avg >= 100, `rtt avg ${avg}ms`, L);
  r = await run(A, 'ip link add br0 type bridge && bridge link && brctl show && ip link del br0 && echo BR-OK');
  check('ブリッジ（ip・bridge・brctl）', /BR-OK/.test(r.out), '', L);
  // dropbear・nmap・nc -z・ebtables/arptables・arping
  r = await run(A, 'dropbear -V 2>&1 | head -1; dropbear -R -p 22 && sleep 1 && echo DROPBEAR-OK');
  check('dropbear（SSH サーバー）', /Dropbear/.test(r.out) && /DROPBEAR-OK/.test(r.out), r.out.split('\n')[0], L);
  r = await run(B, 'nmap --version | head -1; nmap -sT -Pn -p 22,23,80 10.5.0.2 2>&1 | grep -E "^[0-9]+/tcp"', 120000);
  check('nmap -sT', /Nmap version/.test(r.out) && /22\/tcp\s+open/.test(r.out) && /80\/tcp\s+open/.test(r.out), r.out.replace(/\n/g, ' '), L);
  r = await run(B, 'nc -z -w 2 10.5.0.2 22 && echo NC22-OPEN; nc -z -w 2 10.5.0.2 23 || echo NC23-CLOSED');
  check('nc -z（BusyBox）', /NC22-OPEN/.test(r.out) && /NC23-CLOSED/.test(r.out), r.out.replace(/\n/g, ' '), L);
  r = await run(A, 'ebtables -L 2>&1 | head -2; arptables -L 2>&1 | head -2; arping -c 1 -I eth0 10.5.0.3 2>&1 | tail -1; ip neigh show dev eth0');
  check('ebtables・arptables・arping・ip neigh', /Bridge table: filter/.test(r.out) && /Chain (INPUT|IN)/.test(r.out) && /Received 1 response|1 packets received|reply from/i.test(r.out) && /10\.5\.0\.3/.test(r.out), r.out.replace(/\n/g, ' '), L);
  r = await run(A, 'which udhcpd && echo UDHCPD-OK');
  check('BusyBox の udhcpd がある', /UDHCPD-OK/.test(r.out), '', L);
}

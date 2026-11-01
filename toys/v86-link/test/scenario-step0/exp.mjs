// ステップ0の実験: 4つの検査方式を、Node の v86（新しいイメージ）と仮想スイッチで試す
// 実行: node toys/v86-link/test/scenario-step0/exp.mjs（v86 を4台、Node で動かす。2〜3分）
import { createRequire } from 'node:module';
import { VirtualSwitch } from '../../switch.js';
import { Probe } from './probe.mjs';
const require = createRequire(import.meta.url);
const { V86 } = require('../../lib/v86/libv86.js');
const LIB = new URL('../../lib/v86/', import.meta.url).pathname;
const IMAGE = new URL('../../images/v86net-20261101-uclibc-gzip.bin', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const T0 = Date.now();

/** VmNode と同じ形（on('frame') / injectFrame）で v86 を包む。シリアルは ttyS0 と ttyS1 */
function vm(name, { uart1 = false } = {}) {
  const e = new V86({ wasm_path: LIB + 'v86.wasm', bios: { url: LIB + 'bios/seabios.bin' }, vga_bios: { url: LIB + 'bios/vgabios.bin' },
    bzimage: { url: IMAGE }, cmdline: 'tsc=reliable mitigations=off random.trust_cpu=on', memory_size: 64 << 20, net_device: { type: 'ne2k' },
    autostart: true, disable_speaker: true, disable_keyboard: true, disable_mouse: true, uart1 });
  const node = { name, e, out: ['', ''], listeners: new Set(),
    on(t, fn) { if (t === 'frame') { node.listeners.add(fn); return () => node.listeners.delete(fn); } },
    injectFrame(f) { e.bus.send('net0-receive', f); } };
  e.add_listener('net0-send', (f) => node.listeners.forEach((fn) => fn(f)));
  e.add_listener('serial0-output-byte', (b) => { node.out[0] += String.fromCharCode(b); });
  e.add_listener('serial1-output-byte', (b) => { node.out[1] += String.fromCharCode(b); });
  node.send = (text, port = 0) => e.serial_send_bytes(port, new TextEncoder().encode(text));
  /** マーカーまで待つ（port のシリアル） */
  node.run = async (cmd, port = 0, ms = 30000) => {
    const mark = node.out[port].length; const tag = 'M' + Math.random().toString(36).slice(2, 8);
    node.send(`${cmd}; echo "${tag}""-END:$?"\n`, port);
    const end = Date.now() + ms;
    while (Date.now() < end) { const m = new RegExp(`^${tag}-END:(\\d+)`, 'm').exec(node.out[port].slice(mark)); if (m) return { code: Number(m[1]), out: node.out[port].slice(mark) }; await sleep(50); }
    return { code: -1, out: node.out[port].slice(mark) };
  };
  return node;
}
async function booted(n) { while (!/% $/.test(n.out[0])) await sleep(100); }
const net = (n, ip, gw, mac) => n.run(`ifconfig eth0 down; ifconfig eth0 hw ether ${mac} && ifconfig eth0 ${ip} netmask 255.255.255.0 up${gw ? ` && route add default gw ${gw}` : ''}`);

const sw = new VirtualSwitch({ maxPorts: 16 });
const frames = [];
sw.onFrame((ev) => frames.push(ev));
const A = vm('A'), B = vm('B', { uart1: true }), R = vm('R'), C = vm('C');
for (const n of [A, B, R, C]) sw.addPort(n);
await Promise.all([A, B, R, C].map(booted));
log('4台 起動');
await net(A, '10.5.0.2', '10.5.0.1', '02:00:0a:05:00:02');
await net(B, '10.5.0.3', '10.5.0.1', '02:00:0a:05:00:03');
await net(C, '10.5.0.4', '10.5.0.1', '02:00:0a:05:00:04');
await net(R, '10.5.0.1', null, '02:00:0a:05:00:01');
await R.run('ip addr add 203.0.113.1/24 dev eth0 && sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.all.send_redirects=0 net.ipv4.conf.eth0.send_redirects=0');
await A.run('mkdir -p /tmp/www && echo hello-from-A > /tmp/www/index.html && httpd -p 80 -h /tmp/www');
log('ネットワーク設定・A の httpd 起動');
const results = {};

// ---------------------------------------------------------------- a. JS のプローブ
{
  const P = new Probe({ mac: '02:00:0a:05:00:63', ip: '10.5.0.99', prefix: 24, gateway: '10.5.0.1' });
  const port = sw.addPort(P);
  const X = new Probe({ mac: '02:00:cb:00:71:0a', ip: '203.0.113.10', prefix: 24, gateway: '203.0.113.1' });   // インターネット側
  const portX = sw.addPort(X);
  const t = Date.now();
  const aOutBefore = A.out[0].length;
  const r = {
    pingA: await P.ping('10.5.0.2'),
    pingNone: await P.ping('10.5.0.77', { timeoutMs: 1500 }),
    tcp80: await P.tcpConnect('10.5.0.2', 80),
    tcp23: await P.tcpConnect('10.5.0.2', 23),
    http: await P.httpGet('10.5.0.2', 80, '/'),
    http404: await P.httpGet('10.5.0.2', 80, '/nothing'),
    extPingA: await X.ping('10.5.0.2'),
    extHttp: await X.httpGet('10.5.0.2', 80, '/'),
    extTtl1: await X.ping('10.5.0.2', { ttl: 1 }),
  };
  // 残骸: A の TCP の接続（ESTABLISHED・TIME_WAIT など）と ARP
  r.terminalOutputOnA = A.out[0].length === aOutBefore ? 'なし' : 'あり';
  await sleep(500);
  // 残骸: A の TCP のうち LISTEN（0A）以外（ESTABLISHED・TIME_WAIT など）の数
  const lo = await A.run("awk 'NR>1 && $4!=\"0A\"' /proc/net/tcp | wc -l | sed 's/^/TCPLEFT=/'");
  r.leftoverTcpOnA = (/TCPLEFT=\s*(\d+)/.exec(lo.out) || [])[1];
  // 不正なフレーム（短い・壊れた IP・ARP の途中まで）を入れても例外を投げない
  for (const bad of [new Uint8Array(3), new Uint8Array(20).fill(0xff), Uint8Array.from([...P.mac, ...P.mac, 8, 0, 0x4f, 0, 0, 1]), Uint8Array.from([...P.mac, ...P.mac, 8, 6, 0, 1])]) P.injectFrame(bad);
  r.errorsCaught = P.errors; r.elapsedMs = Date.now() - t;
  results.a = r;
  sw.removePort(port); sw.removePort(portX);
  log('a', JSON.stringify(r));
}

// ---------------------------------------------------------------- b. 隠しの検査用 VM（C。学習者には見せない想定）
{
  const t = Date.now();
  const r1 = await C.run('wget -q -O - http://10.5.0.2/ ; nc -z -w 2 10.5.0.2 80 && echo P80-OPEN; nc -z -w 2 10.5.0.2 23 || echo P23-CLOSED; ping -c 1 -W 2 10.5.0.2 | grep -c "1 received"');
  results.b = { ok: /hello-from-A/.test(r1.out) && /P80-OPEN/.test(r1.out) && /P23-CLOSED/.test(r1.out), elapsedMs: Date.now() - t, sample: r1.out.replace(/\r/g, '').split('\n').slice(1).join(' | ').slice(0, 200) };
  results.b.memFree = (await C.run('grep MemAvailable /proc/meminfo')).out.split('\n')[1];
  log('b', JSON.stringify(results.b));
}

// ---------------------------------------------------------------- c. 学習者の端末（B の ttyS0）に検査のコマンドを投入する
{
  // c1: 学習者が途中まで打っている（"ifcon"）ところに投入する
  B.send('ifcon');
  await sleep(300);
  const c1 = await B.run('wget -q -O - http://10.5.0.2/', 0, 8000);
  // c2: 学習者が前景で ping を動かしている間に投入する
  B.send('\x03\n');
  await sleep(300);
  B.send('ping -c 4 10.5.0.2\n');
  await sleep(500);
  const c2 = await B.run('wget -q -O - http://10.5.0.2/', 0, 12000);
  results.c = {
    typingCollision: c1.out.replace(/\r/g, '').split('\n').slice(0, 2).join(' | ').slice(0, 160),
    typingCollisionCode: c1.code,
    duringForegroundPing: { code: c2.code, waitedForPing: /4 packets transmitted/.test(c2.out), echoedInLearnerTerminal: true },
  };
  log('c', JSON.stringify(results.c));
}

// ---------------------------------------------------------------- d. 2本目のシリアル（B の ttyS1）
{
  // ttyS1 にシェルを出す（本番はイメージの inittab に ttyS1::respawn を足す想定。ここでは ttyS0 から1回だけ起動）
  await B.run("setsid sh -c 'exec /bin/sh -i </dev/ttyS1 >/dev/ttyS1 2>&1' & true");
  await sleep(800);
  const s0Before = B.out[0].length;
  // 学習者は ttyS0 で前景の ping を動かし、途中まで打っている
  B.send('ping -c 6 10.5.0.2\n');
  await sleep(300);
  const t = Date.now();
  const d1 = await B.run('wget -q -O - http://10.5.0.2/; nc -z -w 2 10.5.0.2 23 || echo P23-CLOSED', 1, 15000);
  const elapsed = Date.now() - t;
  await sleep(6500);
  const s0Text = B.out[0].slice(s0Before);
  results.d = {
    ok: /hello-from-A/.test(d1.out) && /P23-CLOSED/.test(d1.out), elapsedMs: elapsed,
    ttyS0ShowsCheck: /hello-from-A|P23-CLOSED|wget/.test(s0Text),
    ttyS0PingFinished: /6 packets transmitted/.test(s0Text),
    ttyS1Sample: d1.out.replace(/\r/g, '').split('\n').filter(Boolean).slice(-3).join(' | '),
  };
  log('d', JSON.stringify(results.d));
}
console.log('RESULTS ' + JSON.stringify(results, null, 1));
process.exit(0);

// 検査の実行層（プローブ・ttyS1 のシェル・スイッチの観測）の単体テスト。node --test toys/v86-link/test/scenario-exec.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualSwitch } from '../switch.js';
import { Probe, checksum } from '../probe.js';
import { VmShell, buildPing, buildTcp, buildHttp, buildStimulus, parsePing, parseHttp, parseRoute, parseTcp, BOOTSTRAP } from '../vmshell.js';
import { collectCapture, isProbeEvent, matchesProtocol } from '../scenario/observe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** プローブを流用した偽のサーバー: 80 番は HTTP、ほかのポートは RST */
function fakeServer(cfg, body = 'hello-server') {
  const s = new Probe(cfg);
  s.waiters.add((x) => {
    if (x?.kind !== 'tcp') return false;
    const syn = x.flags & 0x02, ack = x.flags & 0x10;
    if (syn && !ack) {
      if (x.dport === 80) s.sendIp(x.src, 6, s.tcpSeg(x.src, 80, x.sport, 1000, (x.seq + 1) >>> 0, 0x12));
      else s.sendIp(x.src, 6, s.tcpSeg(x.src, x.dport, x.sport, 0, (x.seq + 1) >>> 0, 0x14));
    } else if (x.data.length && x.dport === 80) {
      const resp = new TextEncoder().encode(`HTTP/1.0 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      s.sendIp(x.src, 6, s.tcpSeg(x.src, 80, x.sport, 1001, (x.seq + x.data.length) >>> 0, 0x19, resp));   // FIN,PSH,ACK
    }
    return false;   // 外さない
  });
  return s;
}

function lan() {
  const sw = new VirtualSwitch({ maxPorts: 16 });
  const p = new Probe({ mac: '02:00:0a:00:00:63', ip: '10.0.0.99', prefix: 24 });
  const srv = fakeServer({ mac: '02:00:0a:00:00:02', ip: '10.0.0.2', prefix: 24 });
  sw.addPort(p); sw.addPort(srv);
  return { sw, p, srv };
}

test('プローブ: ARP を引いて ping が通る（相手はプローブ。TTL 64）', async () => {
  const { p } = lan();
  const r = await p.ping('10.0.0.2');
  assert.equal(r.ok, true);
  assert.equal(r.ttl, 64);
});

test('プローブ: いないアドレスは arp-failed で終わる（例外を投げない）', async () => {
  const { p } = lan();
  const r = await p.ping('10.0.0.77', { timeoutMs: 1500 });
  assert.deepEqual(r, { ok: false, reason: 'arp-failed' });
});

test('プローブ: TCP の open（SYN-ACK）と closed（RST）、HTTP GET', async () => {
  const { p } = lan();
  assert.equal((await p.tcpConnect('10.0.0.2', 80)).state, 'open');
  assert.equal((await p.tcpConnect('10.0.0.2', 22)).state, 'closed');
  const h = await p.httpGet('10.0.0.2', 80, '/');
  assert.equal(h.ok, true);
  assert.equal(h.status, 200);
  assert.equal(h.body, 'hello-server');
  const refused = await p.httpGet('10.0.0.2', 8080, '/');
  assert.deepEqual(refused, { ok: false, reason: 'refused' });
});

test('プローブ: 不正なフレームでも例外を投げず、数えて無視する', () => {
  const p = new Probe({ mac: '02:00:0a:00:00:63', ip: '10.0.0.99', prefix: 24 });
  const me = [2, 0, 10, 0, 0, 0x63];
  const bad = [
    new Uint8Array(0), new Uint8Array(3), null, undefined, 'xyz', new Uint8Array(60).fill(0xff),
    Uint8Array.from([...me, ...me, 8, 0, 0x4f, 0, 0, 1]),            // 壊れた IP ヘッダ
    Uint8Array.from([...me, ...me, 8, 6, 0, 1, 8]),                   // 途中で切れた ARP
    Uint8Array.from([...me, ...me, 8, 0, 0x45, 0, 0, 40, 0, 0, 0, 0, 64, 6, 0, 0, 10, 0, 0, 2, 10, 0, 0, 99, 0, 80, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 2]),   // TCP のヘッダ長が大きすぎる
  ];
  for (const f of bad) assert.doesNotThrow(() => p.injectFrame(f));
  assert.ok(p.stats.ignored >= 5);
});

test('プローブ: dispose で待っている検査はすぐ終わり、以後は何も送らない', async () => {
  const sw = new VirtualSwitch({ maxPorts: 4 });
  const p = new Probe({ mac: '02:00:0a:00:00:63', ip: '10.0.0.99', prefix: 24 });
  sw.addPort(p);
  const pending = p.wait(() => false, 60000);
  p.dispose();
  assert.equal(await pending, null);
  const before = p.stats.sent;
  p.send(new Uint8Array(42));
  assert.equal(p.stats.sent, before);
});

test('チェックサム（IP ヘッダの例）', () => {
  const h = Uint8Array.from([0x45, 0, 0, 0x73, 0, 0, 0x40, 0, 0x40, 0x11, 0, 0, 0xc0, 0xa8, 0, 1, 0xc0, 0xa8, 0, 0xc7]);
  assert.equal(checksum(h), 0xb861);
});

// ---------------------------------------------------------------- ttyS1 のシェル

/** 偽のノード: ttyS1 に送られたコマンドに、決めた出力で答える（answer が null なら答えない） */
function fakeNode(answer) {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    on(type, fn) { if (type === 'serial1') listeners.add(fn); return () => listeners.delete(fn); },
    writeSerialPort(port, text) {
      sent.push([port, text]);
      const m = /^\n(.*); echo "(V86CHK\w+)""-END:\$\?"\n$/s.exec(text);
      if (!m) return;
      const a = answer(m[1]);
      if (!a) return;
      setTimeout(() => { for (const fn of listeners) fn(new TextEncoder().encode(`${a.output}\r\n${m[2]}-END:${a.code}\r\n`)); }, 5);
    },
  };
}

test('ttyS1 のシェル: コマンドの出力と終了コード。ttyS1 だけに書き、ttyS0 には何も書かない', async () => {
  const node = fakeNode((cmd) => ({ output: `ran:${cmd}`, code: 3 }));
  const sh = new VmShell(node);
  const r = await sh.run('echo hi');
  assert.deepEqual(r, { exitCode: 3, output: 'ran:echo hi' });
  assert.ok(node.sent.every(([port]) => port === 1));
});

test('ttyS1 のシェル: 応答が無ければ shell-unresponsive（ほかの方法で再実行しない）', async () => {
  const node = fakeNode(() => null);
  const sh = new VmShell(node);
  assert.deepEqual(await sh.run('true', { timeoutMs: 100 }), { error: 'shell-unresponsive' });
  assert.equal(await sh.alive(100), false);
  assert.ok(node.sent.every(([port]) => port === 1));
});

test('ttyS1 のシェル: コマンドは1つずつ順に送る', async () => {
  let active = 0, max = 0;
  const listeners = new Set();
  const node = {
    on(t, fn) { listeners.add(fn); return () => listeners.delete(fn); },
    writeSerialPort(port, text) {
      const tag = /"(V86CHK\w+)""-END/.exec(text)[1];
      active++; max = Math.max(max, active);
      setTimeout(() => { active--; for (const fn of listeners) fn(new TextEncoder().encode(`${tag}-END:0\n`)); }, 10);
    },
  };
  const sh = new VmShell(node);
  await Promise.all([sh.run('a'), sh.run('b'), sh.run('c')]);
  assert.equal(max, 1);
});

test('ttyS1 のシェル: 検査の種類ごとのアダプタ（ping・tcp・http・route）', async () => {
  const outputs = {
    ping: '64 bytes from 10.0.0.2: icmp_seq=1 ttl=63 time=1.2 ms\n2 packets transmitted, 2 received, 0% packet loss',
    nc: '',
    wget: '  HTTP/1.1 200 OK\r\n  Content-Length: 5\r\n  \r\nhi-A',
    ip: 'default via 192.168.10.1 dev eth0',
  };
  const node = fakeNode((cmd) => {
    const k = cmd.split(' ')[0];
    return { output: outputs[k], code: k === 'nc' ? 1 : 0 };
  });
  const sh = new VmShell(node);
  assert.deepEqual(await sh.ping('10.0.0.2'), { ok: true, ttl: 63 });
  assert.deepEqual(await sh.tcp('10.0.0.2', 22), { state: 'not-open' });
  assert.deepEqual(await sh.http('10.0.0.2', 80, '/'), { ok: true, status: 200, body: 'hi-A' });
  assert.deepEqual(await sh.route(), { defaultGateway: '192.168.10.1' });
});

test('ttyS1 のシェル: 検証していない値はコマンドにしない', () => {
  assert.throws(() => buildPing('10.0.0.1; reboot'));
  assert.throws(() => buildTcp('10.0.0.1', 70000));
  assert.throws(() => buildHttp('10.0.0.1', 80, '/x;rm'));
  assert.throws(() => buildHttp('10.0.0.1', 80, "/'"));
  assert.throws(() => buildStimulus({ action: 'arp', target: '$(id)' }));
  assert.throws(() => buildStimulus({ action: 'flood', target: '10.0.0.1' }));
  assert.match(buildHttp('10.0.0.1', 80, '/index.html', 5000), /^wget -S -q -O - -T 5 http:\/\/10\.0\.0\.1:80\/index\.html/);
  assert.match(BOOTSTRAP, /ttyS1/);
});

test('出力の解析（v86 で実際に取った出力）', () => {
  assert.deepEqual(parseHttp('  HTTP/1.1 404 Not Found\r\nwget: server returned error: HTTP/1.1 404 Not Found'), { ok: true, status: 404, body: '' });
  assert.deepEqual(parseHttp("wget: can't connect to remote host (10.5.0.2): Connection refused"), { ok: false, reason: 'refused' });
  assert.deepEqual(parseHttp('wget: download timed out'), { ok: false, reason: 'timeout-connect' });
  assert.deepEqual(parsePing('--- 10.5.0.9 ping statistics ---\n3 packets transmitted, 0 received, 100% packet loss, time 2033ms', 1), { ok: false, reason: 'timeout' });
  assert.deepEqual(parsePing('From 10.5.1.1 icmp_seq=1 Time to live exceeded\n1 packets transmitted, 0 received', 1), { ok: false, reason: 'ttl-exceeded' });
  assert.deepEqual(parsePing('ping: connect: Network is unreachable', 2), { ok: false, reason: 'unreachable' });
  assert.deepEqual(parseRoute(''), { defaultGateway: null });
  assert.deepEqual(parseTcp('', 0), { state: 'open' });
});

// ---------------------------------------------------------------- スイッチの観測

const ev = (inPort, outPorts, frame) => ({ inPort, outPorts, frame });
const arp = Uint8Array.from([255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 0, 1, 8, 6, ...new Array(28).fill(0)]);
const taggedArp = Uint8Array.from([255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 0, 1, 0x81, 0, 0, 10, 8, 6, ...new Array(28).fill(0)]);
const icmp = (() => { const f = new Uint8Array(42); f.set([2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 1, 8, 0, 0x45]); f[23] = 1; return f; })();

test('観測: プローブの通信（入った・届いた先が全部プローブ）は除く。きっかけの VM の分だけ見る', () => {
  const probePorts = new Set([8, 9]);
  const nodeOfPort = (p) => ({ 0: 'sales1', 1: 'dev1', 2: 'devweb', 8: 'probe-a' }[p]);
  const events = [
    ev(8, [0, 1, 2], arp),        // プローブの ARP（ブロードキャスト）: 除く
    ev(1, [8], arp),              // プローブへの返事: 除く
    ev(0, [1, 2], arp),           // sales1 の ARP: dev1・devweb に届いた
    ev(1, [0], arp),              // 別の VM から: 見ない
    ev(0, [2], icmp),             // プロトコルが違う: 見ない
  ];
  const r = collectCapture(events, { fromPort: 0, protocol: 'arp', probePorts, nodeOfPort });
  assert.deepEqual(r.frames, [{ outNodes: ['dev1', 'devweb'] }]);
  assert.equal(r.excludedProbe, 2);
  assert.equal(isProbeEvent(ev(0, [8], arp), probePorts), true);
  assert.equal(isProbeEvent(ev(0, [], arp), probePorts), false);
});

test('観測: プロトコルの判定（802.1Q のタグ付きも）', () => {
  assert.equal(matchesProtocol(taggedArp, 'arp'), true);
  assert.equal(matchesProtocol(taggedArp, 'broadcast'), true);
  assert.equal(matchesProtocol(icmp, 'icmp'), true);
  assert.equal(matchesProtocol(icmp, 'arp'), false);
  assert.equal(matchesProtocol(new Uint8Array(5), 'arp'), false);
});

test('プローブとスイッチ: プローブの通信だけでは capture の検査は何も観測しない（自分の検査で不合格にならない）', async () => {
  const { sw, p } = lan();
  const events = [];
  sw.onFrame((e) => events.push(e));
  await p.ping('10.0.0.2');
  await p.tcpConnect('10.0.0.2', 80);
  const probePorts = new Set([0]);   // p はポート 0
  const r = collectCapture(events, { fromPort: 1, protocol: 'arp', probePorts, nodeOfPort: () => 'x' });
  assert.ok(events.length > 0);
  assert.deepEqual(r.frames, []);
  await sleep(0);
});

// シナリオの攻撃者ノード（attacker.js）と、それに合わせて足した検査・スキーマ・キャプチャの注記を Node で確かめる。
// 偽のホスト 2 台には Probe（probe.js）を使う（ARP に答え、ping を送り、ARP の応答で自分の ARP の表を書き換える = ふつうのホストと同じ）。
//
//   node --test toys/v86-link/test/attacker.test.mjs
//
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Attacker, decodeBasic } from '../attacker.js';
import { Probe, checksum } from '../probe.js';
import { VirtualSwitch } from '../switch.js';
import { collectCapture } from '../scenario/observe.js';
import { validateScenario } from '../scenario/schema.js';
import { runChecks } from '../scenario/evaluate.js';
import { Capture } from '../capture.js';
import { compileFilter, parseFrame } from '../packet.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PC = { ip: '192.168.10.11', mac: '02:00:c0:a8:0a:0b' };
const GW = { ip: '192.168.10.1', mac: '02:00:c0:a8:0a:01' };
const ATK = { ip: '192.168.10.66', mac: '02:00:c0:a8:0a:42' };
const macBytes = (m) => m.split(':').map((x) => parseInt(x, 16));
const macOf = (f, o) => [...f.slice(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');

/** スイッチ・偽の PC・偽のゲートウェイ・攻撃者。frames: スイッチを通ったフレーム（複製） */
function lab(opts = {}) {
  const sw = new VirtualSwitch({ maxPorts: 16 });
  const frames = [];
  sw.onFrame((ev) => frames.push({ ...ev, frame: ev.frame.slice(), outPorts: [...ev.outPorts] }));
  const pc = new Probe({ name: 'pc', mac: PC.mac, ip: PC.ip, prefix: 24, gateway: GW.ip });
  const gw = new Probe({ name: 'gw', mac: GW.mac, ip: GW.ip, prefix: 24 });
  const atk = new Attacker({ name: 'ATK', mac: ATK.mac, ip: ATK.ip, prefix: 24, targets: [PC.ip, GW.ip], intervalMs: 40, ...opts });
  sw.addPort(pc, { id: 0 });
  sw.addPort(gw, { id: 7 });
  sw.addPort(atk, { id: 9 });
  const L = { sw, frames, pc, gw, atk, stop: () => { atk.stop(); pc.dispose(); gw.dispose(); } };
  labs.push(L);
  return L;
}
// 検査が失敗して途中で抜けても、攻撃者のタイマーを残さない（残るとテストのプロセスが終わらない）
const labs = [];
afterEach(() => { for (const L of labs.splice(0)) L.stop(); });
const poisonFrames = (frames, target) => frames.filter((e) => e.inPort === 9 && e.frame[12] === 8 && e.frame[13] === 6 && e.frame[21] === 2 && macOf(e.frame, 0) === target.mac);

test('汚染の ARP（op=2、ユニキャスト）が intervalMs ごとに両方へ出る。標的の ARP の表が攻撃者の MAC になる', async () => {
  const L = lab();
  L.atk.start();
  await sleep(330);
  const toPc = poisonFrames(L.frames, PC), toGw = poisonFrames(L.frames, GW);
  // 最初の 1 回は本当の MAC を調べる（ARP の問い合わせ）。そのあと 40ms ごと
  assert.ok(toPc.length >= 4 && toPc.length <= 9, `PC へ ${toPc.length} 回`);
  assert.ok(toGw.length >= 4 && toGw.length <= 9, `ゲートウェイへ ${toGw.length} 回`);
  // PC には「ゲートウェイの IP は攻撃者の MAC」、ゲートウェイには「PC の IP は攻撃者の MAC」
  const f = toPc[0].frame;
  assert.equal(macOf(f, 22), ATK.mac);
  assert.equal(`${f[28]}.${f[29]}.${f[30]}.${f[31]}`, GW.ip);
  assert.deepEqual([...L.pc.arp.get(GW.ip)], macBytes(ATK.mac));
  assert.deepEqual([...L.gw.arp.get(PC.ip)], macBytes(ATK.mac));
  // 間隔
  const gaps = toPc.slice(1).map((x, i) => x.ts - toPc[i].ts);
  assert.ok(gaps.every((g) => g >= 30 && g <= 120), `間隔 ${gaps.join(',')}`);
  // ARP の表を消しても（学習者の ip neigh flush）、すぐにまた汚染される
  L.pc.arp.clear();
  await sleep(100);
  assert.deepEqual([...L.pc.arp.get(GW.ip)], macBytes(ATK.mac));
  L.stop();
});

test('relay: 書き換えたフレームが本当の宛先に届く。TTL が 1 減り、IP のチェックサムが正しい（通信は切れない）', async () => {
  const L = lab();
  L.atk.start();
  await sleep(120);
  const r = await L.pc.ping(GW.ip, { timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.ttl, 63, 'ゲートウェイの応答（TTL 64）が攻撃者を通って 63 になる');
  const relayed = L.frames.filter((e) => e.inPort === 9 && e.frame[12] === 8 && e.frame[13] === 0);
  assert.ok(relayed.length >= 2, '行きも帰りも攻撃者を通る');
  for (const e of relayed) {
    assert.equal(checksum(e.frame, 14, 34), 0, 'IP ヘッダのチェックサムが正しい');
    assert.equal(macOf(e.frame, 6), ATK.mac);
  }
  assert.ok(relayed.some((e) => macOf(e.frame, 0) === GW.mac) && relayed.some((e) => macOf(e.frame, 0) === PC.mac), '本当の MAC に書き換えて送る');
  assert.equal(relayed.find((e) => macOf(e.frame, 0) === GW.mac).frame[22], 63, '行き（PC の TTL 64）も 63');
  L.stop();
  // decrementTtl: false なら TTL はそのまま
  const M = lab({ decrementTtl: false });
  M.atk.start();
  await sleep(120);
  assert.equal((await M.pc.ping(GW.ip, { timeoutMs: 2000 })).ttl, 64);
  M.stop();
  // relay: false なら通信が切れる
  const N = lab({ relay: false });
  N.atk.start();
  await sleep(120);
  assert.equal((await N.pc.ping(GW.ip, { timeoutMs: 800 })).ok, false);
  N.stop();
});

/** PC から、攻撃者の MAC あてに、社内 Web（別のサブネット）への HTTP のリクエストを送る（汚染された PC が送るのと同じ形） */
function httpFrame(text, { sport = 40000 } = {}) {
  const data = new TextEncoder().encode(text);
  const tcp = new Uint8Array(20 + data.length);
  tcp.set([sport >> 8, sport & 255, 0, 80, 0, 0, 0, 1, 0, 0, 0, 1, 0x50, 0x18, 0x20, 0]);
  tcp.set(data, 20);
  const ip = new Uint8Array(20 + tcp.length);
  ip.set([0x45, 0, ip.length >> 8, ip.length & 255, 0, 1, 0x40, 0, 64, 6, 0, 0, 192, 168, 10, 11, 192, 168, 20, 10]);
  const c = checksum(ip, 0, 20); ip[10] = c >> 8; ip[11] = c & 255;
  ip.set(tcp, 20);
  const f = new Uint8Array(14 + ip.length);
  f.set(macBytes(ATK.mac), 0); f.set(macBytes(PC.mac), 6); f[12] = 8; f[13] = 0; f.set(ip, 14);
  return f;
}

test('Authorization: Basic のリクエストを中継すると loot に入る。宛先が標的でなければゲートウェイへ。上限を超えない', async () => {
  const L = lab({ maxLoot: 50 });
  L.atk.start();
  await sleep(120);
  const port0 = L.sw.port(0);
  const seen = [];
  L.atk.on('loot', (x) => seen.push(x.length));
  L.sw.receive(port0, httpFrame('GET /staff/ HTTP/1.1\r\nHost: 192.168.20.10\r\nAuthorization: Basic c3RhZmY6czNjcmV0\r\n\r\n'));
  assert.equal(L.atk.loot.length, 1);
  assert.deepEqual({ ...L.atk.loot[0], ts: 0 }, { ts: 0, src: PC.ip, dst: '192.168.20.10', request: 'GET /staff/', user: 'staff', password: 's3cret' });
  // 中継先は、宛先（別のサブネット）が標的でないので、送り元（PC）でない方の標的 = ゲートウェイ
  const out = L.frames.filter((e) => e.inPort === 9 && e.frame[23] === 6);
  assert.equal(out.length, 1);
  assert.equal(macOf(out[0].frame, 0), GW.mac);
  // 認証なしのリクエストも、リクエスト行だけ入る。HTTP でない TCP は入らない
  L.sw.receive(port0, httpFrame('GET / HTTP/1.0\r\n\r\n'));
  L.sw.receive(port0, httpFrame('hello\r\n'));
  assert.equal(L.atk.loot.length, 2);
  assert.equal(L.atk.loot[1].user, null);
  for (let i = 0; i < 80; i++) L.sw.receive(port0, httpFrame(`GET /x${i} HTTP/1.1\r\nAuthorization: Basic dTp2\r\n\r\n`));
  assert.equal(L.atk.loot.length, 50, '上限 50 件');
  assert.equal(L.atk.loot.at(-1).request, 'GET /x79', '新しいものを残す');
  assert.ok(seen.length >= 82);
  L.stop();
});

test('でたらめなフレーム 5000 個で例外を投げない。stop() のあとは何も送らない', async () => {
  const L = lab();
  L.atk.start();
  await sleep(100);
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 5000; i++) {
    const f = Uint8Array.from({ length: Math.floor(rnd() * 120) }, () => Math.floor(rnd() * 256));
    // 攻撃者あての IPv4・TCP・ARP に見えるものも混ぜる
    if (f.length > 14 && i % 2) f.set(macBytes(ATK.mac), 0);
    if (f.length > 40 && i % 3 === 0) { f[12] = 8; f[13] = 0; f[14] = 0x45; f[23] = 6; }
    if (f.length > 42 && i % 5 === 0) { f[12] = 8; f[13] = 6; f.set([0, 1, 8, 0, 6, 4], 14); }
    assert.doesNotThrow(() => L.atk.injectFrame(f));
  }
  assert.doesNotThrow(() => { L.atk.injectFrame(null); L.atk.injectFrame(new Uint8Array(0)); });
  L.atk.stop();
  const sent = L.atk.stats.sent;
  await sleep(150);
  L.sw.receive(L.sw.port(0), httpFrame('GET / HTTP/1.0\r\n\r\n'));
  assert.equal(L.atk.stats.sent, sent, 'stop() のあとは何も送らない');
  L.pc.dispose(); L.gw.dispose();
});

test('自分の IP への ARP・ping には答える（ふつうのホストのふり）', async () => {
  const L = lab();
  L.atk.start();
  await sleep(100);
  const r = await L.gw.ping(ATK.ip, { timeoutMs: 1500 });
  assert.equal(r.ok, true);
  assert.equal(r.ttl, 64);
  L.stop();
});

test('decodeBasic', () => {
  assert.deepEqual(decodeBasic('c3RhZmY6czNjcmV0'), { user: 'staff', password: 's3cret' });
  assert.deepEqual(decodeBasic('bm9jb2xvbg=='), { user: 'nocolon', password: '' });
  assert.equal(decodeBasic('***'), null);
});

// ---------------------------------------------------------------- observe の fromNode・ignoreFlood

test('observe: 攻撃者のポートは除かない。ignoreFlood ならフラッディング・ブロードキャスト・ハブは数えない', () => {
  const icmp = new Uint8Array(40); icmp[12] = 8; icmp[13] = 0; icmp[23] = 1;
  const ev = (inPort, outPorts, decision) => ({ frame: icmp, inPort, outPorts, decision });
  const nodeOfPort = (p) => ({ 0: 'pc1', 7: 'router', 8: 'probe-lan', 9: 'atk' }[p]);
  const events = [ev(0, [9], 'known'), ev(7, [0, 9], 'flood'), ev(7, [0], 'known'), ev(8, [0], 'known')];
  const probePorts = new Set([8]);
  // PC1 から入ったもの: 攻撃者に届いている（攻撃者は除かない）
  const a = collectCapture(events, { fromPort: 0, protocol: 'icmp', probePorts, nodeOfPort });
  assert.deepEqual(a.frames.map((f) => f.outNodes), [['atk']]);
  // ルーターから入ったもの（fromNode にあたる）: フラッディングで攻撃者にも届いた 1 つは、ignoreFlood なら数えない
  const b = collectCapture(events, { fromPort: 7, protocol: 'icmp', probePorts, nodeOfPort });
  assert.deepEqual(b.frames.map((f) => f.outNodes), [['pc1', 'atk'], ['pc1']]);
  const c = collectCapture(events, { fromPort: 7, protocol: 'icmp', probePorts, nodeOfPort, ignoreFlood: true });
  assert.deepEqual(c.frames.map((f) => f.outNodes), [['pc1']]);
  assert.equal(c.excludedFlood, 1);
});

test('evaluate: capture の検査は fromNode（省略時は from）と ignoreFlood をアダプタに渡す', async () => {
  const sc = validateScenario(scenarioWithAttacker({
    checks: [
      { id: 'c1', requirement: 'R1', title: 't', type: 'capture', from: 'pc1', stimulus: { action: 'ping', target: '192.168.20.10' }, observe: { protocol: 'icmp', mustNotReach: ['atk'], fromNode: 'router', ignoreFlood: true } },
      { id: 'c2', requirement: 'R1', title: 't', type: 'capture', from: 'pc1', stimulus: { action: 'ping', target: '192.168.20.10' }, observe: { protocol: 'icmp', mustNotReach: ['atk'] } },
    ],
  }), { trusted: true });
  assert.equal(sc.ok, true, sc.errors.join('\n'));
  const calls = [];
  const res = await runChecks(sc.scenario, { capture: async (from, stim, o) => { calls.push({ from, ...o }); return { frames: [{ outNodes: o.fromNode === 'router' ? ['pc1'] : ['atk'] }] }; } });
  assert.deepEqual(calls.map((c) => [c.from, c.fromNode, c.ignoreFlood]), [['pc1', 'router', true], ['pc1', 'pc1', false]]);
  assert.deepEqual(res.requirements[0].checks.map((c) => c.status), ['pass', 'fail']);
});

// ---------------------------------------------------------------- スキーマ

function scenarioWithAttacker(over = {}) {
  return {
    schema: 'v86-link-scenario/1', id: 'atk-test', title: 't', difficulty: 'easy', minutes: 5, summary: 's', briefing: 'b', debrief: 'd',
    requirements: [{ id: 'R1', text: 'r' }],
    addressing: { allowed: ['192.168.10.0/24', '192.168.20.0/24'] },
    switch: { mode: 'switch', locked: true },
    nodes: [
      { id: 'pc1', kind: 'vm', role: 'host', name: 'PC1', port: 0, address: '192.168.10.11/24' },
      { id: 'router', kind: 'vm', role: 'router', name: 'R', port: 7, address: '192.168.10.1/24' },
      { id: 'atk', kind: 'attacker', name: 'ATK', port: 9, address: '192.168.10.66/24', mac: '02:00:c0:a8:0a:42',
        attack: { targets: ['192.168.10.11', '192.168.10.1'], intervalMs: 1500, relay: true, decrementTtl: true, showLoot: true } },
      { id: 'probe-lan', kind: 'probe', name: 'P', port: 8, address: '192.168.10.50/24', mac: '02:00:c0:a8:0a:32' },
    ],
    checks: [{ id: 'c1', requirement: 'R1', title: 't', type: 'ping', from: 'pc1', to: '192.168.10.1', expect: { reach: 'success' } }],
    ...over,
  };
}

test('スキーマ: attacker ノード（既定の値）。from・listener には使えない。mustNotReach・fromNode には書ける', () => {
  const ok = validateScenario(scenarioWithAttacker());
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  const a = ok.scenario.nodes.find((n) => n.id === 'atk');
  assert.deepEqual(a.attack, { intervalMs: 1500, relay: true, decrementTtl: true, showLoot: true, label: '不明な機器', autoStart: true, targets: ['192.168.10.11', '192.168.10.1'] });
  assert.equal(ok.scenario.schema, 'v86-link-scenario/1', '版はそのまま');
  const bad = (over, re) => {
    const r = validateScenario(scenarioWithAttacker(over));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => re.test(e)), r.errors.join('\n'));
  };
  bad({ checks: [{ id: 'c1', requirement: 'R1', title: 't', type: 'ping', from: 'atk', to: '192.168.10.1', expect: { reach: 'success' } }] }, /攻撃者からは検査を出せない/);
  bad({ checks: [{ id: 'c1', requirement: 'R1', title: 't', type: 'tcp_source', from: 'pc1', listener: 'atk', port: 80, expect: { sourceIp: '192.168.10.11' } }] }, /攻撃者は待ち受けに使えない/);
  bad({ checks: [{ id: 'c1', requirement: 'R1', title: 't', type: 'capture', from: 'pc1', stimulus: { action: 'ping', target: '192.168.10.1' }, observe: { protocol: 'icmp', mustNotReach: ['atk'], fromNode: 'probe-lan' } }] }, /プローブは書けない/);
  const withObs = validateScenario(scenarioWithAttacker({ checks: [{ id: 'c1', requirement: 'R1', title: 't', type: 'capture', from: 'pc1', stimulus: { action: 'ping', target: '192.168.10.1' }, observe: { protocol: 'icmp', mustNotReach: ['atk'], fromNode: 'router', ignoreFlood: true } }] }));
  assert.equal(withObs.ok, true, withObs.errors.join('\n'));
  const nodes = (f) => { const s = scenarioWithAttacker(); s.nodes[2] = f(s.nodes[2]); return { nodes: s.nodes }; };
  bad(nodes((n) => ({ ...n, mac: undefined })), /攻撃者には必須/);
  bad(nodes((n) => ({ ...n, port: 3 })), /8〜11/);
  bad(nodes((n) => ({ ...n, attack: { ...n.attack, targets: ['192.168.10.11'] } })), /少なすぎる/);
  bad(nodes((n) => ({ ...n, attack: { ...n.attack, targets: ['192.168.10.11', '8.8.8.8'] } })), /プライベート/);
  bad(nodes((n) => ({ ...n, attack: { ...n.attack, targets: ['192.168.10.66', '192.168.10.1'] } })), /自分のアドレス/);
  bad(nodes((n) => ({ ...n, attack: { ...n.attack, intervalMs: 50 } })), /200〜60000/);
  bad(nodes((n) => ({ ...n, attack: { ...n.attack, run: 'rm -rf /' } })), /知らない項目/);
  bad(nodes((n) => ({ ...n, init: ['x'] })), /攻撃者には付けない/);
  bad({ nodes: scenarioWithAttacker().nodes.map((n) => (n.id === 'pc1' ? { ...n, attack: { targets: [] } } : n)) }, /攻撃者（kind: "attacker"）だけ/);
});

// ---------------------------------------------------------------- キャプチャ: 同じ IP に別の MAC（arp-dup）

test('キャプチャ: ARP の送り元の IP が、前と別の MAC で来たら注記する。フィルタ arp-dup', () => {
  const cap = new Capture(undefined, () => 0);
  const arp = (sha, spa) => {
    const f = new Uint8Array(42);
    f.fill(255, 0, 6); f.set(macBytes(sha), 6); f[12] = 8; f[13] = 6; f.set([0, 1, 8, 0, 6, 4, 0, 2], 14);
    f.set(macBytes(sha), 22); f.set(spa.split('.').map(Number), 28);
    return f;
  };
  const r1 = cap.add({ frame: arp(GW.mac, GW.ip), inPort: 7, outPorts: [0] });
  const r2 = cap.add({ frame: arp(ATK.mac, GW.ip), inPort: 9, outPorts: [0] });
  const r3 = cap.add({ frame: arp(GW.mac, GW.ip), inPort: 7, outPorts: [0] });
  const r4 = cap.add({ frame: arp(ATK.mac, ATK.ip), inPort: 9, outPorts: [0] });
  assert.equal(r1.arpDup, null);
  assert.deepEqual(r2.arpDup, { ip: GW.ip, mac: ATK.mac, was: GW.mac });
  assert.equal(r3.arpDup, null, '最初に見た MAC なら注記しない');
  assert.equal(r4.arpDup, null);
  const f = compileFilter('arp-dup');
  assert.deepEqual([r1, r2, r3, r4].filter((r) => f(parseFrame(r.frame), r)).map((r) => r.no), [2]);
  cap.clear();
  assert.equal(cap.add({ frame: arp(ATK.mac, GW.ip), inPort: 9, outPorts: [0] }).arpDup, null, 'クリアしたら覚え直す');
});

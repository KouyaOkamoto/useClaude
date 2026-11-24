// スイッチの DAI（Dynamic ARP Inspection。dai.js・switch.js）を Node で確かめる。
//
//   node --test toys/v86-link/test/dai.test.mjs
//
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualSwitch, tag } from '../switch.js';
import { Dai, normalizeBinding, DAI_LIMITS } from '../dai.js';
import { Probe } from '../probe.js';
import { Attacker } from '../attacker.js';

const bytes = (mac) => mac.split(':').map((h) => parseInt(h, 16));
const ipb = (ip) => ip.split('.').map(Number);
/** ARP のフレーム（op: 1 要求 / 2 応答）。ethSrc を変えると送り元 MAC の検査に引っかかる */
function arp({ op = 2, sha, spa, tha = '00:00:00:00:00:00', tpa = '0.0.0.0', ethSrc = sha, ethDst = op === 1 ? 'ff:ff:ff:ff:ff:ff' : tha }) {
  return Uint8Array.from([...bytes(ethDst), ...bytes(ethSrc), 0x08, 0x06, 0, 1, 8, 0, 6, 4, 0, op, ...bytes(sha), ...ipb(spa), ...bytes(tha), ...ipb(tpa)]);
}
const ipv4 = (dst, src) => Uint8Array.from([...bytes(dst), ...bytes(src), 0x08, 0x00, ...new Array(46).fill(0)]);
function fakeNode() {
  const n = { got: [], handlers: new Set(), on(t, fn) { n.handlers.add(fn); return () => n.handlers.delete(fn); }, send(f) { for (const fn of n.handlers) fn(f); }, injectFrame(f) { n.got.push(f); } };
  return n;
}
const A = { mac: '02:00:0a:05:00:02', ip: '10.5.0.2' }, B = { mac: '02:00:0a:05:00:03', ip: '10.5.0.3' }, X = { mac: '02:00:0a:05:00:42', ip: '10.5.0.66' };
function setup() {
  const sw = new VirtualSwitch({ clock: () => 1000, schedule: (fn) => fn() });
  const a = fakeNode(), b = fakeNode(), x = fakeNode();
  const pa = sw.addPort(a), pb = sw.addPort(b), px = sw.addPort(x);
  const events = [];
  sw.onFrame((ev) => events.push(ev));
  return { sw, a, b, x, pa, pb, px, events, last: () => events.at(-1) };
}

test('無効のとき（既定）は何も検査しない: 偽の ARP もそのまま通る', () => {
  const t = setup();
  t.x.send(arp({ sha: X.mac, spa: A.ip, tha: B.mac, tpa: B.ip }));
  assert.equal(t.last().reason, null);
  assert.equal(t.b.got.length, 1);
  assert.deepEqual(t.sw.dai.stats().vlans, {});
});

test('表に合う ARP は通る。合わない（MAC 違い）・表に無いものは arp-inspection。送り元 MAC 違いは arp-src-mac', () => {
  const t = setup();
  t.sw.dai.setVlan(1, true);
  t.sw.dai.addBinding({ vlan: 1, ip: A.ip, mac: A.mac });
  t.sw.dai.addBinding({ vlan: 1, ip: B.ip, mac: B.mac });
  t.a.send(arp({ op: 1, sha: A.mac, spa: A.ip, tpa: B.ip }));
  assert.equal(t.last().reason, null, '正規の要求');
  assert.equal(t.last().decision, 'broadcast');
  t.b.send(arp({ op: 2, sha: B.mac, spa: B.ip, tha: A.mac, tpa: A.ip }));
  assert.equal(t.last().reason, null, '正規の応答');
  // X が「A の IP は X の MAC」と名乗る（ARP スプーフィング）
  t.x.send(arp({ sha: X.mac, spa: A.ip, tha: B.mac, tpa: B.ip }));
  assert.equal(t.last().reason, 'arp-inspection');
  assert.deepEqual(t.last().dai, { reason: 'arp-inspection', sender: { mac: X.mac, ip: A.ip }, expectedMac: A.mac });
  assert.deepEqual(t.last().outPorts, []);
  // 表に無い IP
  t.x.send(arp({ op: 1, sha: X.mac, spa: X.ip, tpa: A.ip }));
  assert.equal(t.last().reason, 'arp-inspection');
  assert.equal(t.last().dai.expectedMac, null);
  // Ethernet の送り元と sender MAC が違う
  t.a.send(arp({ op: 1, sha: A.mac, spa: A.ip, tpa: B.ip, ethSrc: X.mac }));
  assert.equal(t.last().reason, 'arp-src-mac');
  // 捨てたフレームの MAC は覚えない（X の MAC はテーブルに入らない）
  assert.equal(t.sw.entries().some((e) => e.mac === X.mac), false);
  // 送り元 MAC の検査を切ると、表で判断する（A の組は表にあるので通る）
  t.sw.dai.setSrcMacCheck(false);
  t.a.send(arp({ op: 1, sha: A.mac, spa: A.ip, tpa: B.ip, ethSrc: X.mac }));
  assert.equal(t.last().reason, null);
  const st = t.sw.dai.stats();
  assert.deepEqual(st.vlans[1], { inspected: 6, dropped: 3 });
  assert.deepEqual(st.ports[t.px.id], { inspected: 2, dropped: 2 });
  assert.equal(st.recent.length, 3);
  assert.deepEqual(Object.keys(st.recent[0]).sort(), ['expectedMac', 'ip', 'mac', 'port', 'reason', 'ts', 'vlan']);
});

test('sender IP が 0.0.0.0（ARP probe・DAD）は、送り元 MAC の検査だけで通す', () => {
  const t = setup();
  t.sw.dai.setVlan(1, true);
  t.x.send(arp({ op: 1, sha: X.mac, spa: '0.0.0.0', tpa: '10.5.0.99' }));
  assert.equal(t.last().reason, null);
  t.x.send(arp({ op: 1, sha: X.mac, spa: '0.0.0.0', tpa: '10.5.0.99', ethSrc: A.mac }));
  assert.equal(t.last().reason, 'arp-src-mac');
});

test('trusted なポート・DAI が無効の VLAN・ARP 以外・ハブのときは検査しない', () => {
  const t = setup();
  t.sw.dai.setVlan(1, true);
  const spoof = () => arp({ sha: X.mac, spa: A.ip, tha: B.mac, tpa: B.ip });
  t.sw.setDaiTrusted(t.px, true);
  t.x.send(spoof());
  assert.equal(t.last().reason, null, 'trusted');
  t.sw.setDaiTrusted(t.px, false);
  t.x.send(ipv4(B.mac, X.mac));
  assert.equal(t.last().reason, null, 'ARP 以外');
  t.sw.setPortVlan(t.px, { mode: 'access', access: 20 });
  t.sw.setPortVlan(t.pb, { mode: 'access', access: 20 });
  t.x.send(spoof());
  assert.equal(t.last().reason, null, 'DAI が無効の VLAN 20');
  t.sw.setPortVlan(t.px, { mode: 'access', access: 1 });
  t.sw.setMode('hub');
  t.x.send(spoof());
  assert.equal(t.last().reason, null, 'ハブ');
  assert.equal(t.last().decision, 'hub');
  // addPort の trusted（シナリオのプローブ）
  const p = t.sw.addPort(fakeNode(), { trusted: true });
  assert.equal(p.daiTrusted, true);
});

test('トランクでタグ付きの ARP も、その VLAN の設定で検査される', () => {
  const t = setup();
  t.sw.setPortVlan(t.px, { mode: 'trunk', allowed: [1, 10], native: 1 });
  t.sw.setPortVlan(t.pb, { mode: 'access', access: 10 });
  t.sw.dai.setVlan(10, true);
  t.sw.dai.addBinding({ vlan: 10, ip: '10.5.1.1', mac: X.mac });
  t.x.send(tag(arp({ sha: X.mac, spa: '10.5.1.1', tha: B.mac, tpa: B.ip }), 10));
  assert.equal(t.last().reason, null, 'VLAN 10 の表に合う');
  assert.equal(t.last().vlan, 10);
  t.x.send(tag(arp({ sha: X.mac, spa: '10.5.1.9', tha: B.mac, tpa: B.ip }), 10));
  assert.equal(t.last().reason, 'arp-inspection');
  assert.equal(t.last().inTag, 10);
  t.x.send(arp({ sha: X.mac, spa: '10.5.1.9', tha: B.mac, tpa: B.ip }));
  assert.equal(t.last().reason, null, 'ネイティブ VLAN 1 は無効なので通す');
});

test('壊れた ARP は arp-malformed。でたらめなフレーム 5000 個で例外を投げない', () => {
  const t = setup();
  t.sw.dai.setVlan(1, true);
  const short = arp({ sha: X.mac, spa: A.ip }).slice(0, 30);
  t.x.send(short);
  assert.equal(t.last().reason, 'arp-malformed');
  const wrongLen = arp({ sha: X.mac, spa: A.ip });
  wrongLen[18] = 8;   // hlen 8
  t.x.send(wrongLen);
  assert.equal(t.last().reason, 'arp-malformed');
  let seed = 9;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 5000; i++) {
    const f = Uint8Array.from({ length: Math.floor(rnd() * 80) }, () => Math.floor(rnd() * 256));
    if (f.length > 14 && i % 2) { f[12] = 8; f[13] = 6; }
    if (f.length > 18 && i % 7 === 0) { f[12] = 0x81; f[13] = 0; f[16] = 8; f[17] = 6; }
    assert.doesNotThrow(() => t.x.send(f));
  }
  assert.ok(t.sw.dai.stats().recent.length <= DAI_LIMITS.recent, '最近の記録は 50 件まで');
});

test('バインディング表: 形の検査・同じ VLAN の同じ IP は置き換え・上限 256 件・設定の写しと置き換え', () => {
  const d = new Dai();
  assert.deepEqual(normalizeBinding({ vlan: '10', ip: ' 10.5.1.2 ', mac: '02-00-0A-05-01-02' }), { vlan: 10, ip: '10.5.1.2', mac: '02:00:0a:05:01:02' });
  for (const bad of [{ vlan: 0, ip: A.ip, mac: A.mac }, { vlan: 4095, ip: A.ip, mac: A.mac }, { vlan: 1, ip: '10.5.0.256', mac: A.mac }, { vlan: 1, ip: '0.0.0.0', mac: A.mac },
    { vlan: 1, ip: A.ip, mac: 'zz:00:0a:05:00:02' }, { vlan: 1, ip: A.ip, mac: 'ff:ff:ff:ff:ff:ff' }, { vlan: 1, ip: A.ip, mac: '01:00:5e:00:00:01' },
    { vlan: 1, ip: '<img src=x onerror=alert(1)>', mac: A.mac }, { vlan: 1, ip: A.ip, mac: '00:00:00:00:00:00' }]) {
    assert.throws(() => d.addBinding(bad), Error, JSON.stringify(bad));
  }
  assert.equal(d.listBindings().length, 0, '不正な値は反映しない');
  d.addBinding({ vlan: 1, ip: A.ip, mac: A.mac });
  d.addBinding({ vlan: 1, ip: A.ip, mac: B.mac });
  assert.deepEqual(d.listBindings(), [{ vlan: 1, ip: A.ip, mac: B.mac }]);
  for (let i = 0; i < 300; i++) {
    const r = (() => { try { d.addBinding({ vlan: 2, ip: `10.9.${i >> 8}.${i & 255 || 1}`, mac: '02:00:00:00:00:01' }); return true; } catch { return false; } })();
    if (!r) break;
  }
  assert.equal(d.listBindings().length, DAI_LIMITS.maxBindings, '上限を超えられない');
  assert.throws(() => d.addBinding({ vlan: 3, ip: '10.10.0.1', mac: A.mac }), /256/);
  const cfg = { vlans: [1, 10], bindings: [{ vlan: 1, ip: A.ip, mac: A.mac }], srcMacCheck: false };
  d.applyConfig(cfg);
  assert.deepEqual(d.config(), cfg);
  assert.throws(() => d.applyConfig({ vlans: [1], bindings: [{ vlan: 1, ip: 'bad', mac: A.mac }] }));
  assert.deepEqual(d.config(), cfg, '不正な設定では何も変えない');
  d.reset();
  assert.deepEqual(d.config(), { vlans: [], bindings: [], srcMacCheck: true });
});

// ---------------------------------------------------------------- 攻撃者ノード（attacker.js）と偽のホスト 2 台

const labs = [];
afterEach(() => { for (const x of labs.splice(0)) x(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('攻撃者と偽のホスト 2 台: DAI を有効にして表を入れると、攻撃者の ARP は全部捨てられ、ホスト同士の ARP は通る', async () => {
  const PC = { ip: '192.168.10.11', mac: '02:00:c0:a8:0a:0b' }, GW = { ip: '192.168.10.1', mac: '02:00:c0:a8:0a:01' }, ATK = { ip: '192.168.10.66', mac: '02:00:c0:a8:0a:42' };
  const sw = new VirtualSwitch({ maxPorts: 16 });
  const events = [];
  sw.onFrame((ev) => events.push({ ...ev, frame: ev.frame.slice() }));
  sw.dai.setVlan(1, true);
  sw.dai.addBinding({ vlan: 1, ip: PC.ip, mac: PC.mac });
  sw.dai.addBinding({ vlan: 1, ip: GW.ip, mac: GW.mac });
  const pc = new Probe({ mac: PC.mac, ip: PC.ip, prefix: 24, gateway: GW.ip });
  const gw = new Probe({ mac: GW.mac, ip: GW.ip, prefix: 24 });
  const atk = new Attacker({ name: 'ATK', mac: ATK.mac, ip: ATK.ip, targets: [PC.ip, GW.ip], intervalMs: 40 });
  sw.addPort(pc, { id: 0 }); sw.addPort(gw, { id: 7 }); sw.addPort(atk, { id: 9 });
  labs.push(() => { atk.stop(); pc.dispose(); gw.dispose(); });
  atk.start();
  await sleep(300);
  const r = await pc.ping(GW.ip, { timeoutMs: 2000 });
  assert.equal(r.ok, true);
  assert.equal(r.ttl, 64, '攻撃者を経由しない');
  const fromAtk = events.filter((e) => e.inPort === 9 && e.frame[12] === 8 && e.frame[13] === 6);
  assert.ok(fromAtk.length >= 4, `攻撃者は ARP を出し続けている（${fromAtk.length}）`);
  assert.ok(fromAtk.every((e) => e.reason === 'arp-inspection'), '攻撃者の ARP は全部捨てられる');
  const hostArp = events.filter((e) => (e.inPort === 0 || e.inPort === 7) && e.frame[12] === 8 && e.frame[13] === 6);
  assert.ok(hostArp.length >= 2 && hostArp.every((e) => e.reason === null), 'ホスト同士の ARP は通る');
  assert.equal(atk.stats.relayed, 0);
  assert.deepEqual([...pc.arp.get(GW.ip)], bytes(GW.mac), 'PC の ARP の表は本物のゲートウェイ');
});

// 自由構成の学習「L2: ARP スプーフィングと DAI」の部品（labattack.js）を Node で確かめる。
//
//   node --test toys/v86-link/test/labattack.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualSwitch } from '../switch.js';
import { Attacker } from '../attacker.js';
import { LabAttacker, LAB_ATTACKER, parseLabAction, applyLabAction, attackerAddress } from '../labattack.js';

const bytes = (mac) => mac.split(':').map((h) => parseInt(h, 16));
const ipb = (ip) => ip.split('.').map(Number);
const macStr = (b, o) => [...b.slice(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
const ipStr = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
function arp({ op = 2, sha, spa, tha = '00:00:00:00:00:00', tpa, ethDst = op === 1 ? 'ff:ff:ff:ff:ff:ff' : tha }) {
  return Uint8Array.from([...bytes(ethDst), ...bytes(sha), 0x08, 0x06, 0, 1, 8, 0, 6, 4, 0, op, ...bytes(sha), ...ipb(spa), ...bytes(tha), ...ipb(tpa)]);
}
const A = { mac: '02:00:0a:05:00:02', ip: '10.5.0.2' }, B = { mac: '02:00:0a:05:00:03', ip: '10.5.0.3' };
const X = attackerAddress(A.ip);

/** ARP の問い合わせに答えるだけの偽のホスト */
function fakeHost(me) {
  const h = {
    got: [], handlers: new Set(),
    on(t, fn) { h.handlers.add(fn); return () => h.handlers.delete(fn); },
    send(f) { for (const fn of h.handlers) fn(f); },
    injectFrame(f) {
      h.got.push(f);
      if (f[12] === 8 && f[13] === 6 && f[21] === 1 && ipStr(f, 38) === me.ip) h.send(arp({ op: 2, sha: me.mac, spa: me.ip, tha: macStr(f, 22), tpa: ipStr(f, 28) }));
    },
  };
  return h;
}
/** 手で進めるタイマー */
function fakeTimers() {
  const t = { list: [], set: (fn, ms) => { t.list.push(fn); return t.list.length; }, clear: () => {}, run() { const l = t.list; t.list = []; l.forEach((fn) => fn()); } };
  return t;
}
function setup() {
  const sw = new VirtualSwitch({ maxPorts: 12, clock: () => 1000, schedule: (fn) => fn() });
  const a = fakeHost(A), b = fakeHost(B);
  sw.addPort(a, { id: 0 });
  sw.addPort(b, { id: 1 });
  const timers = fakeTimers();
  const changes = [];
  const lab = new LabAttacker({ sw, create: (cfg) => new Attacker(cfg, { setTimer: timers.set, clearTimer: timers.clear }), onChange: () => changes.push(lab.running) });
  const events = [];
  sw.onFrame((ev) => events.push(ev));
  const ctx = { sw, lab, targets: () => [A.ip, B.ip], vlan: () => 1, bindingsFromVms: () => [{ vlan: 1, ...A }, { vlan: 1, ...B }] };
  return { sw, a, b, lab, timers, changes, events, ctx };
}
const fromX = (events) => events.filter((e) => e.inPort === LAB_ATTACKER.port && e.frame?.[12] === 8 && e.frame?.[13] === 6);

test('parseLabAction: 形を確かめる。学習の action でなければ null', () => {
  assert.deepEqual(parseLabAction(['attacker', true]), { kind: 'attacker', on: true });
  assert.deepEqual(parseLabAction(['attacker', false]), { kind: 'attacker', on: false });
  assert.deepEqual(parseLabAction(['dai', { vlan: 1, enable: true }]), { kind: 'dai', vlan: 1, enable: true });
  assert.deepEqual(parseLabAction(['dai-bind', 'auto']), { kind: 'dai-bind', mode: 'auto' });
  assert.deepEqual(parseLabAction(['dai-bind', 'clear']), { kind: 'dai-bind', mode: 'clear' });
  for (const x of [['wait', 100], ['mode', 'hub'], [0, 'ls'], null, 'attacker']) assert.equal(parseLabAction(x), null);
  for (const bad of [['attacker'], ['attacker', 'on'], ['attacker', 1], ['dai'], ['dai', { vlan: 0, enable: true }], ['dai', { vlan: 4095, enable: true }],
    ['dai', { vlan: '1', enable: true }], ['dai', { vlan: 1 }], ['dai', { vlan: 1, enable: 'yes' }], ['dai-bind'], ['dai-bind', 'all'], ['dai-bind', '<img onerror>']]) {
    assert.throws(() => parseLabAction(bad), Error, JSON.stringify(bad));
  }
});

test('attackerAddress: 標的と同じ /24 の .66。不正な IP は例外', () => {
  assert.deepEqual(attackerAddress('10.5.0.2'), { ip: '10.5.0.66', mac: '02:00:0a:05:00:42', prefix: 24 });
  assert.deepEqual(attackerAddress('10.5.1.7').ip, '10.5.1.66');
  for (const bad of ['10.5.0', '10.5.0.256', '', null, 'a.b.c.d']) assert.throws(() => attackerAddress(bad));
});

test('attacker: 有効にすると P9 につながり、A と B を汚染する。無効にするとポートから外れ、もう何も送らない', () => {
  const t = setup();
  assert.equal(applyLabAction(['attacker', true], t.ctx), true);
  assert.equal(t.lab.running, true);
  const port = t.sw.ports.get(LAB_ATTACKER.port);
  assert.ok(port, 'P9 につながる');
  assert.equal(port.daiTrusted, false, '攻撃者のポートは trusted にしない');
  assert.deepEqual(port.vlan.access, 1);
  // 1 回目: 本当の MAC を問い合わせる → 偽のホストが答える。2 回目から汚染
  t.timers.run();
  const poison = fromX(t.events).filter((e) => e.frame[21] === 2 && ipStr(e.frame, 28) !== X.ip);
  assert.ok(poison.length >= 2, '両方へ汚染の ARP 応答');
  // A へは「B の IP は X の MAC」、B へは「A の IP は X の MAC」
  const toA = poison.find((e) => macStr(e.frame, 32) === A.mac);
  const toB = poison.find((e) => macStr(e.frame, 32) === B.mac);
  assert.equal(ipStr(toA.frame, 28), B.ip);
  assert.equal(ipStr(toB.frame, 28), A.ip);
  assert.equal(macStr(toA.frame, 22), X.mac);
  // 同じ標的でもう一度有効にしても、作り直さない
  const attacker = t.lab.attacker;
  applyLabAction(['attacker', true], t.ctx);
  assert.equal(t.lab.attacker, attacker);
  // 止める
  applyLabAction(['attacker', false], t.ctx);
  assert.equal(t.lab.running, false);
  assert.equal(t.sw.ports.has(LAB_ATTACKER.port), false, 'ポートから外れる');
  const n = t.events.length;
  t.timers.run();
  t.timers.run();
  assert.equal(t.events.length, n, '止めたあとは何も送らない');
  // もう一度有効にできる（新しい攻撃者を作る）
  applyLabAction(['attacker', true], t.ctx);
  assert.equal(t.lab.running, true);
  assert.notEqual(t.lab.attacker, attacker);
  assert.deepEqual(t.changes, [true, false, true]);
  assert.deepEqual(t.lab.info().targets, [A.ip, B.ip]);
  assert.equal(t.lab.info().ip, X.ip);
});

test('dai・dai-bind: DAI を有効にして表を作ると、X の ARP は arp-inspection で捨てられ、A・B の ARP は通る', () => {
  const t = setup();
  applyLabAction(['attacker', true], t.ctx);
  t.timers.run();
  applyLabAction(['dai', { vlan: 1, enable: true }], t.ctx);
  applyLabAction(['dai-bind', 'auto'], t.ctx);
  assert.equal(t.sw.dai.isEnabled(1), true);
  assert.deepEqual(t.sw.dai.config().bindings, [{ vlan: 1, ...A }, { vlan: 1, ...B }]);
  const before = t.events.length;
  t.timers.run();
  const x = fromX(t.events.slice(before));
  assert.ok(x.length >= 2);
  assert.ok(x.every((e) => e.reason === 'arp-inspection'), 'X の ARP は全部捨てる');
  // A の正規の ARP は通る
  t.a.send(arp({ op: 1, sha: A.mac, spa: A.ip, tpa: B.ip }));
  assert.equal(t.events.at(-2).reason, null);
  // 表を空にすると A の ARP も捨てられる。DAI を無効にすると X の ARP も通る
  applyLabAction(['dai-bind', 'clear'], t.ctx);
  t.a.send(arp({ op: 1, sha: A.mac, spa: A.ip, tpa: B.ip }));
  assert.equal(t.events.at(-1).reason, 'arp-inspection');
  applyLabAction(['dai', { vlan: 1, enable: false }], t.ctx);
  const n = t.events.length;
  t.timers.run();
  assert.ok(fromX(t.events.slice(n)).every((e) => e.reason === null));
});

test('不正な action はスイッチ・DAI を変えない', () => {
  const t = setup();
  t.sw.dai.setBindings([{ vlan: 1, ...A }]);
  for (const bad of [['dai', { vlan: 0, enable: true }], ['dai-bind', 'x'], ['attacker', 'yes']]) assert.throws(() => applyLabAction(bad, t.ctx));
  assert.deepEqual(t.sw.dai.config(), { vlans: [], bindings: [{ vlan: 1, ...A }], srcMacCheck: true });
  assert.equal(t.sw.ports.has(LAB_ATTACKER.port), false);
  // 表を作る元が不正なら、表は変えない
  assert.throws(() => applyLabAction(['dai-bind', 'auto'], { ...t.ctx, bindingsFromVms: () => [{ vlan: 1, ip: 'x', mac: A.mac }] }));
  assert.deepEqual(t.sw.dai.config().bindings, [{ vlan: 1, ...A }]);
  // 学習の action でなければ false（呼び出し側が続きを見る）
  assert.equal(applyLabAction(['wait', 10], t.ctx), false);
});

test('標的が不正・ポートが使われている → 例外で、何もつながない', () => {
  const t = setup();
  assert.throws(() => t.lab.start({ targets: [A.ip] }));
  assert.throws(() => t.lab.start({ targets: [A.ip, A.ip] }));
  assert.throws(() => t.lab.start({ targets: [A.ip, 'x'] }));
  t.sw.addPort({ on: () => () => {}, injectFrame() {} }, { id: LAB_ATTACKER.port });
  assert.throws(() => t.lab.start({ targets: [A.ip, B.ip] }), /P9/);
  assert.equal(t.lab.running, false);
});

test('中継した HTTP の Basic 認証は loot に入り、止めても残る（clearLoot で消える）', () => {
  const t = setup();
  t.lab.start({ targets: [A.ip, B.ip] });
  t.timers.run();
  // A → X（汚染された MAC）へ、B 宛ての HTTP リクエスト（TCP）
  const payload = new TextEncoder().encode('GET /staff/ HTTP/1.1\r\nHost: b\r\nAuthorization: Basic c3RhZmY6czNjcmV0\r\n\r\n');
  const ip = new Uint8Array(20 + 20 + payload.length);
  ip.set([0x45, 0, (ip.length >> 8) & 0xff, ip.length & 0xff, 0, 1, 0x40, 0, 64, 6, 0, 0, ...ipb(A.ip), ...ipb(B.ip)]);
  ip.set([0x9c, 0x40, 0x1f, 0x90, 0, 0, 0, 1, 0, 0, 0, 1, 0x50, 0x18, 0xff, 0xff, 0, 0, 0, 0], 20);
  ip.set(payload, 40);
  const frame = Uint8Array.from([...bytes(X.mac), ...bytes(A.mac), 0x08, 0x00, ...ip]);
  t.a.send(frame);
  assert.equal(t.lab.loot.length, 1);
  assert.deepEqual({ user: t.lab.loot[0].user, password: t.lab.loot[0].password, request: t.lab.loot[0].request }, { user: 'staff', password: 's3cret', request: 'GET /staff/' });
  // 中継されて B に届く（TTL が 1 減る）
  const got = t.b.got.find((f) => f[12] === 8 && f[13] === 0);
  assert.ok(got);
  assert.equal(got[22], 63);
  t.lab.stop();
  assert.equal(t.lab.loot.length, 1, '止めても残る');
  t.lab.clearLoot();
  assert.equal(t.lab.loot.length, 0);
});

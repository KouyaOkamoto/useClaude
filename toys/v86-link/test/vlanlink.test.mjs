// ルーターの NIC とスイッチの間でタグを付け外しする VlanLink を Node で確かめる。
//
//   node --test toys/v86-link/test/vlanlink.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VlanLink, parseCidr, peerIp } from '../vlanlink.js';
import { VirtualSwitch, readTag } from '../switch.js';

const mac = (s) => s.split(':').map((h) => parseInt(h, 16));
const ip = (s) => s.split('.').map(Number);
const ROUTER = '02:00:0a:05:00:01';

function ipv4(dstMac, srcMac, src, dst, ttl = 64) {
  const f = new Uint8Array(14 + 28);
  f.set([...mac(dstMac), ...mac(srcMac), 0x08, 0x00]);
  f.set([0x45, 0, 0, 28, 0, 0, 0, 0, ttl, 1, 0, 0, ...ip(src), ...ip(dst)], 14);
  f.set([8, 0, 0, 0, 0, 1, 0, 1], 34);
  return f;
}
function arp(op, dstMac, srcMac, spa, tpa) {
  const f = new Uint8Array(42);
  f.set([...mac(dstMac), ...mac(srcMac), 0x08, 0x06, 0, 1, 8, 0, 6, 4, 0, op, ...mac(srcMac), ...ip(spa), 0, 0, 0, 0, 0, 0, ...ip(tpa)]);
  return f;
}
function fakeNode(name) {
  const node = {
    name, got: [], handlers: new Set(),
    on(type, fn) { node.handlers.add(fn); return () => node.handlers.delete(fn); },
    send(f) { for (const fn of node.handlers) fn(f); },
    injectFrame(f) { node.got.push(f); },
  };
  return node;
}
const MAP = [{ cidr: '10.5.0.0/24', vlan: 1 }, { cidr: '10.5.1.0/24', vlan: 10 }, { cidr: '10.5.2.0/24', vlan: 20 }];

test('CIDR と相手の IP', () => {
  assert.deepEqual(parseCidr('10.5.1.0/24'), { net: 0x0a050100, mask: 0xffffff00 });
  assert.deepEqual(parseCidr('10.5.1.77/24'), { net: 0x0a050100, mask: 0xffffff00 });
  assert.deepEqual(parseCidr('0.0.0.0/0'), { net: 0, mask: 0 });
  for (const bad of ['10.5.1.0', '10.5.1.0/33', '300.1.1.1/8', 'x']) assert.throws(() => parseCidr(bad));
  assert.equal(peerIp(ipv4('ff:ff:ff:ff:ff:ff', ROUTER, '10.5.1.1', '10.5.2.9')), 0x0a050209);
  assert.equal(peerIp(arp(1, 'ff:ff:ff:ff:ff:ff', ROUTER, '10.5.2.1', '10.5.2.2')), 0x0a050202);
  assert.equal(peerIp(new Uint8Array(20)), null);
  assert.equal(peerIp(ipv4('ff:ff:ff:ff:ff:ff', ROUTER, '1.1.1.1', '2.2.2.2').subarray(0, 30)), null);
});

test('ルーター → スイッチ: 相手の IP のサブネットで VLAN を決めてタグを付ける（ネイティブはタグなし）', () => {
  const r = fakeNode('r');
  const link = new VlanLink(r, { map: MAP, native: 1 });
  const out = [];
  link.on('frame', (f) => out.push(f));
  r.send(arp(1, 'ff:ff:ff:ff:ff:ff', ROUTER, '10.5.2.1', '10.5.2.2'));     // VLAN 20 への ARP 問い合わせ
  r.send(ipv4('02:00:0a:05:01:02', ROUTER, '10.5.2.2', '10.5.1.2', 63));   // 転送した ping（送り元は別のサブネット。宛先で決める）
  r.send(ipv4('02:00:0a:05:00:02', ROUTER, '10.5.0.1', '10.5.0.2'));      // ネイティブ VLAN 1 のサブネット → タグなし
  r.send(ipv4('ff:ff:ff:ff:ff:ff', ROUTER, '10.5.0.1', '255.255.255.255'));   // どのサブネットでもない → タグなし
  assert.deepEqual(out.map((f) => readTag(f)?.vid ?? null), [20, 10, null, null]);
  assert.equal(out[1][14 + 4 + 8], 63);    // TTL はルーターが下げたまま
  assert.deepEqual(link.stats, { tagged: 2, untagged: 2, stripped: 0 });
});

test('スイッチ → ルーター: タグを外して渡す。対応表が無ければ何もしない', () => {
  const r = fakeNode('r');
  const link = new VlanLink(r, { map: MAP });
  const sw = new VirtualSwitch({ clock: () => 0 });
  const h = fakeNode('h');
  sw.addPort(h, { vlan: { access: 20 } });
  sw.addPort(link, { vlan: { mode: 'trunk', allowed: [1, 10, 20], native: 1 } });
  h.send(arp(1, 'ff:ff:ff:ff:ff:ff', '02:00:0a:05:02:02', '10.5.2.2', '10.5.2.1'));
  assert.equal(r.got.length, 1);
  assert.equal(readTag(r.got[0]), null);
  assert.equal(r.got[0].length, 42);
  assert.equal(link.stats.stripped, 1);
  // ルーターの答えは VLAN 20 のタグ付きでトランクに入り、VLAN 20 のホストに（タグなしで）届く
  const events = [];
  sw.onFrame((e) => events.push(e));
  r.send(arp(2, '02:00:0a:05:02:02', ROUTER, '10.5.2.1', '10.5.2.2'));
  assert.deepEqual([events[0].inTag, events[0].vlan, events[0].outPorts], [20, 20, [0]]);
  assert.equal(readTag(h.got[0]), null);

  const plain = new VlanLink(fakeNode('p'), { map: [] });
  const seen = [];
  plain.on('frame', (f) => seen.push(f));
  const f = ipv4('ff:ff:ff:ff:ff:ff', ROUTER, '10.5.1.1', '10.5.2.2');
  plain.inner.send(f);
  assert.equal(seen[0], f);
});

test('壊れたフレームでも例外を投げない', () => {
  const r = fakeNode('r');
  const link = new VlanLink(r, { map: MAP });
  const out = [];
  link.on('frame', (f) => out.push(f));
  for (const f of [new Uint8Array(0), new Uint8Array(13), null, 'x', Uint8Array.from([...new Array(12).fill(0), 0x08, 0x00, 0x45])]) {
    assert.doesNotThrow(() => r.send(f));
  }
  for (const f of [new Uint8Array(0), Uint8Array.from([...new Array(12).fill(0), 0x81, 0x00, 0])]) {
    assert.doesNotThrow(() => link.injectFrame(f));
  }
  assert.equal(out.length, 5);
});

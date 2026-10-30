// 書き出した pcap を、実際のツール（tcpdump・tshark・Python の dpkt / scapy）で読めるか確かめる。
// ツールが無い環境では、そのテストを飛ばす（skip と表示される）。
//
//   node --test toys/v86-link/test/pcap-tools.test.mjs
//   PYTHON=/path/to/python node --test ...   # dpkt / scapy の入った Python を使うとき
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePcap } from '../pcap.js';
import { FRAMES } from './frames.mjs';

const ORDER = ['mld', 'ndp', 'arpRequest', 'arpReply', 'icmpRequest', 'icmpReply', 'tcpSyn', 'tcpSynAck', 'tcpAck',
  'tcpDataLeft', 'tcpDataRight', 'tcpFin', 'udp', 'icmpUnreachable'];
const T0 = Date.UTC(2026, 9, 30, 3, 0, 0);   // 2026-10-30 03:00:00 UTC
const dir = mkdtempSync(join(tmpdir(), 'v86-link-pcap-'));
const files = {};
for (const nano of [false, true]) {
  const recs = ORDER.map((k, i) => ({ ts: T0 + i * 10.5, frame: FRAMES[k] }));   // 10.5ms ごと
  files[nano ? 'nano' : 'micro'] = join(dir, nano ? 'nano.pcap' : 'micro.pcap');
  writeFileSync(files[nano ? 'nano' : 'micro'], writePcap(recs, { nano }));
}

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

for (const kind of ['micro', 'nano']) {
  test(`tcpdump -r で読める（${kind}）`, { skip: !has('tcpdump') && 'tcpdump が無い' }, () => {
    const out = run('tcpdump', ['-nn', '-tt', ...(kind === 'nano' ? ['--time-stamp-precision=nano'] : []), '-r', files[kind]]);
    const lines = out.trim().split('\n');
    assert.equal(lines.length, ORDER.length);
    assert.match(lines[2], /^1793329200\.0210+ ARP, Request who-has 10\.5\.0\.3 tell 10\.5\.0\.2/);
    assert.match(lines[4], /IP 10\.5\.0\.2 > 10\.5\.0\.3: ICMP echo request, id 39, seq 1/);
    assert.match(lines[6], /IP 10\.5\.0\.2\.38708 > 10\.5\.0\.3\.7000: Flags \[S\], seq 698380666/);
    assert.match(lines[7], /Flags \[S\.\]/);
    assert.match(lines[11], /Flags \[F\.\]/);
    assert.match(lines[12], /UDP, length 10/);
  });
}

test('tshark -r で読める（プロトコルとフラグ）', { skip: !has('tshark') && 'tshark が無い' }, () => {
  const out = run('tshark', ['-r', files.micro, '-T', 'fields', '-e', 'frame.time_epoch', '-e', '_ws.col.Protocol', '-e', 'tcp.flags.str']);
  const rows = out.trim().split('\n').map((l) => l.split('\t'));
  assert.equal(rows.length, ORDER.length);
  assert.deepEqual(rows.map((r) => r[1]), ['ICMPv6', 'ICMPv6', 'ARP', 'ARP', 'ICMP', 'ICMP', 'TCP', 'TCP', 'TCP', 'TCP', 'TCP', 'TCP', 'UDP', 'ICMP']);
  // 時刻（10.5ms ごと）
  assert.ok(Math.abs(Number(rows[1][0]) - Number(rows[0][0]) - 0.0105) < 1e-6);
  assert.match(rows[6][2], /S/);   // SYN
});

const python = process.env.PYTHON || 'python3';
const pyHas = (mod) => spawnSync(python, ['-c', `import ${mod}`]).status === 0;

test('Python の dpkt で読める', { skip: !pyHas('dpkt') && 'dpkt が無い' }, () => {
  const out = run(python, ['-c', `
import dpkt, sys
with open(sys.argv[1], 'rb') as f:
    r = dpkt.pcap.Reader(f)
    print(r.datalink(), r.snaplen)
    for ts, buf in r:
        e = dpkt.ethernet.Ethernet(buf)
        print('%.6f %s %d' % (ts, type(e.data).__name__, len(buf)))
`, files.micro]);
  const [head, ...rows] = out.trim().split('\n');
  assert.equal(head, '1 262144');
  assert.equal(rows.length, ORDER.length);
  assert.match(rows[2], /^1793329200\.021000 ARP 60$/);
  assert.match(rows[6], / IP /);
});

test('Python の scapy で読める', { skip: !pyHas('scapy') && 'scapy が無い' }, () => {
  const out = run(python, ['-c', `
import sys
from scapy.all import rdpcap, TCP
pk = rdpcap(sys.argv[1])
print(len(pk))
print(pk[6][TCP].flags, pk[6][TCP].seq, pk[9][TCP].payload.load)
`, files.nano]);
  const [count, tcp] = out.trim().split('\n');
  assert.equal(Number(count), ORDER.length);
  assert.equal(tcp, "S 698380666 b'hello from left\\n'");
});

// VLAN タグ付きのフレームは、タグ付きのまま書き出す（Wireshark などでタグが見える）
const withTag = (f, vid, pcp = 0) => Uint8Array.from([...f.subarray(0, 12), 0x81, 0x00, (pcp << 5) | (vid >> 8), vid & 255, ...f.subarray(12)]);
const vlanFile = join(dir, 'vlan.pcap');
writeFileSync(vlanFile, writePcap([
  { ts: T0, frame: withTag(FRAMES.icmpRequest, 20, 5) },
  { ts: T0 + 1, frame: FRAMES.icmpReply },
  { ts: T0 + 2, frame: withTag(FRAMES.arpRequest, 10) },
]));

test('VLAN: tcpdump -e でタグが見える', { skip: !has('tcpdump') && 'tcpdump が無い' }, () => {
  const lines = run('tcpdump', ['-nn', '-e', '-r', vlanFile]).trim().split('\n');
  assert.match(lines[0], /ethertype 802\.1Q \(0x8100\), length 102: vlan 20, p 5, ethertype IPv4.*10\.5\.0\.2 > 10\.5\.0\.3: ICMP echo request/);
  assert.doesNotMatch(lines[1], /vlan/);
  assert.match(lines[2], /vlan 10, p 0, ethertype ARP/);
});

test('VLAN: tshark でタグと TTL が見える', { skip: !has('tshark') && 'tshark が無い' }, () => {
  const rows = run('tshark', ['-r', vlanFile, '-T', 'fields', '-e', 'vlan.id', '-e', 'vlan.priority', '-e', 'ip.ttl', '-e', '_ws.col.Protocol']).trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(rows, [['20', '5', '64', 'ICMP'], ['', '', '64', 'ICMP'], ['10', '0', '', 'ARP']]);
});

test('VLAN: scapy でタグと TTL が見える', { skip: !pyHas('scapy') && 'scapy が無い' }, () => {
  const out = run(python, ['-c', `
import sys
from scapy.all import rdpcap, Dot1Q, IP
for p in rdpcap(sys.argv[1]):
    print(p[Dot1Q].vlan if Dot1Q in p else '-', p[Dot1Q].prio if Dot1Q in p else '-', p[IP].ttl if IP in p else '-')
`, vlanFile]);
  assert.deepEqual(out.trim().split('\n'), ['20 5 64', '- - 64', '10 0 -']);
});

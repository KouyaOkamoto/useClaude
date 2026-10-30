// フレームの解析・フィルタ・16進ダンプ・pcap の書き出し・キャプチャ・仮想スイッチを Node で確かめる。
//
//   node --test toys/v86-link/test/
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, hexdump, compileFilter, formatIpv6 } from '../packet.js';
import { writePcap, pcapFileName, MAGIC_MICRO, MAGIC_NANO } from '../pcap.js';
import { Capture, TrafficStats } from '../capture.js';
import { VirtualSwitch } from '../switch.js';
import { FRAMES } from './frames.mjs';

// ------------------------------------------------------------------ 解析（実フレーム）

test('ARP: who-has / is-at', () => {
  const q = parseFrame(FRAMES.arpRequest);
  assert.equal(q.protocol, 'ARP');
  assert.equal(q.info, 'Who has 10.5.0.3? Tell 10.5.0.2');
  assert.equal(q.dst, 'ff:ff:ff:ff:ff:ff');
  assert.deepEqual(q.ip, { src: '10.5.0.2', dst: '10.5.0.3' });
  const r = parseFrame(FRAMES.arpReply);
  assert.equal(r.info, '10.5.0.3 is at 00:22:15:c1:fd:02');
  assert.equal(r.src, '00:22:15:c1:fd:02');
});

test('ICMP: echo request / reply', () => {
  const q = parseFrame(FRAMES.icmpRequest);
  assert.equal(q.protocol, 'ICMP');
  assert.equal(q.src, '10.5.0.2');
  assert.equal(q.dst, '10.5.0.3');
  assert.equal(q.info, 'Echo (ping) request id=0x0027, seq=1, ttl=64');
  assert.equal(parseFrame(FRAMES.icmpReply).info, 'Echo (ping) reply id=0x0027, seq=1, ttl=64');
  const icmp = q.layers.find((l) => l.name === 'ICMP');
  assert.ok(icmp.fields.some(([k, v]) => k === 'シーケンス番号' && v === '1'));
  assert.equal(parseFrame(FRAMES.icmpUnreachable).info, 'Destination unreachable (code 3)');
});

test('TCP: 3ウェイハンドシェイク・データ・FIN', () => {
  const syn = parseFrame(FRAMES.tcpSyn);
  assert.equal(syn.protocol, 'TCP');
  assert.deepEqual(syn.tcp.flags, ['SYN']);
  assert.deepEqual(syn.ports, { src: 38708, dst: 7000 });
  assert.equal(syn.info, '38708 → 7000 [SYN] Seq=698380666 Win=64240 Len=0');
  const synAck = parseFrame(FRAMES.tcpSynAck);
  assert.deepEqual(synAck.tcp.flags, ['SYN', 'ACK']);
  assert.equal(synAck.tcp.ack, syn.tcp.seq + 1);
  assert.deepEqual(parseFrame(FRAMES.tcpAck).tcp.flags, ['ACK']);
  const data = parseFrame(FRAMES.tcpDataLeft);
  assert.deepEqual(data.tcp.flags, ['PSH', 'ACK']);
  assert.equal(data.tcp.len, 16);
  // ペイロード（アプリのデータ）の位置が正しい
  assert.equal(new TextDecoder().decode(FRAMES.tcpDataLeft.subarray(data.payloadOffset)), 'hello from left\n');
  const fin = parseFrame(FRAMES.tcpFin);
  assert.deepEqual(fin.tcp.flags, ['FIN', 'ACK']);
  assert.match(fin.info, /^38708 → 7000 \[FIN, ACK\] Seq=\d+ Ack=\d+ Win=\d+ Len=0$/);
});

test('UDP・IPv6（ICMPv6・Hop-by-Hop）', () => {
  const u = parseFrame(FRAMES.udp);
  assert.equal(u.protocol, 'UDP');
  assert.deepEqual(u.ports, { src: 35501, dst: 9999 });
  assert.equal(u.info, '35501 → 9999 Len=10');
  const ndp = parseFrame(FRAMES.ndp);
  assert.equal(ndp.protocol, 'ICMPv6');
  assert.equal(ndp.info, 'Neighbor solicitation');
  const mld = parseFrame(FRAMES.mld);
  assert.equal(mld.protocol, 'IPv6');
  assert.equal(mld.info, 'IPv6 next header 0 (Hop-by-Hop)');
  assert.equal(mld.dst, 'ff02::16');
  assert.equal(formatIpv6(Uint8Array.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x02, 0x22, 0x15, 0xff, 0xfe, 0xcd, 0xe6, 0x99])), 'fe80::222:15ff:fecd:e699');
});

// ------------------------------------------------------------------ 解析（壊れたフレーム）

test('知らない ethertype は Unknown(ethertype=0x....)', () => {
  const f = FRAMES.arpRequest.slice();
  f[12] = 0x88; f[13] = 0xcc;   // LLDP
  const p = parseFrame(f);
  assert.equal(p.protocol, 'Unknown');
  assert.equal(p.info, 'Unknown (ethertype=0x88cc)');
});

test('短すぎる・壊れたフレームでも例外を出さず、Malformed として返す', () => {
  const cases = {
    empty: new Uint8Array(0),
    three: Uint8Array.from([1, 2, 3]),
    notUint8Array: 'これはバイト列ではない',
    arpCut: FRAMES.arpRequest.subarray(0, 20),
    ipv4Cut: FRAMES.icmpRequest.subarray(0, 24),
    tcpCut: FRAMES.tcpSyn.subarray(0, 40),
    ipv6Cut: FRAMES.ndp.subarray(0, 30),
  };
  for (const [name, f] of Object.entries(cases)) {
    const p = parseFrame(f);
    assert.ok(p.malformed, name + ' は Malformed になる: ' + p.info);
    assert.equal(typeof p.info, 'string');
  }
  // IPv4 のヘッダ長が不正（ihl=1）
  const badIhl = FRAMES.icmpRequest.slice();
  badIhl[14] = 0x41;
  assert.match(parseFrame(badIhl).info, /Malformed/);
  // IPv4 の全長がフレームより長い
  const longTotal = FRAMES.icmpRequest.slice();
  longTotal[16] = 0xff; longTotal[17] = 0xff;
  const lt = parseFrame(longTotal);
  assert.equal(lt.protocol, 'ICMP');
  assert.match(lt.info, /全長がフレームより長い/);
  // TCP のヘッダ長が不正（data offset = 15 → 60 バイト）
  const badDoff = FRAMES.tcpAck.slice();
  badDoff[14 + 20 + 12] = 0xf0;
  assert.match(parseFrame(badDoff).info, /TCP ヘッダ長/);
});

test('でたらめなバイト列を大量に与えても例外を出さない', () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const bases = Object.values(FRAMES);
  for (let i = 0; i < 5000; i++) {
    // 実フレームを壊す（途中で切る・バイトを書き換える）か、完全にでたらめにする
    let f;
    if (i % 2) {
      f = bases[i % bases.length].slice(0, Math.floor(rand() * 120));
      for (let k = 0; k < 4 && f.length; k++) f[Math.floor(rand() * f.length)] = Math.floor(rand() * 256);
    } else {
      f = Uint8Array.from({ length: Math.floor(rand() * 200) }, () => Math.floor(rand() * 256));
      if (f.length > 13) { f[12] = [0x08, 0x86, 0x08][i % 3]; f[13] = [0x00, 0xdd, 0x06][i % 3]; }
    }
    const p = parseFrame(f);
    assert.equal(typeof p.protocol, 'string');
    assert.equal(typeof p.info, 'string');
    hexdump(f);
  }
});

test('解析結果はすべて文字列・数値（HTML として解釈されるものを作らない）', () => {
  const p = parseFrame(FRAMES.tcpDataRight);   // ペイロードに "<b>right</b>" を含む
  // ASCII の列（16バイトずつ折り返す）をつなげると、文字としてはそのまま出る（表示側は textContent で入れる）
  const ascii = hexdump(FRAMES.tcpDataRight).map((l) => l.slice(55)).join('');
  assert.match(ascii, /<b>right<\/b>/);
  for (const layer of p.layers) {
    assert.equal(typeof layer.name, 'string');
    for (const [k, v] of layer.fields) {
      assert.equal(typeof k, 'string');
      assert.equal(typeof v, 'string');
    }
  }
});

// ------------------------------------------------------------------ 16進ダンプ・フィルタ

test('16進ダンプ: 16バイトずつ、オフセット・16進・ASCII', () => {
  const lines = hexdump(Uint8Array.from([0x41, 0x42, 0x00, 0x7f, ...Array(14).fill(0x2e)]));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '0000  41 42 00 7f 2e 2e 2e 2e 2e 2e 2e 2e 2e 2e 2e 2e  AB..............');
  assert.equal(lines[1], '0010  2e 2e' + ' '.repeat(42 + 2) + '..');
  assert.match(hexdump(new Uint8Array(5000), 64).at(-1), /残り 4936 バイト/);
});

test('フィルタ: プロトコル・IP・ポート・フラグ・捨てたもの', () => {
  const all = Object.entries(FRAMES).map(([name, f]) => ({ name, p: parseFrame(f), rec: { dropped: name === 'udp' } }));
  const pick = (text) => all.filter((x) => compileFilter(text)(x.p, x.rec)).map((x) => x.name);
  assert.deepEqual(pick('arp'), ['arpRequest', 'arpReply']);
  assert.deepEqual(pick('icmp'), ['icmpRequest', 'icmpReply', 'icmpUnreachable']);
  assert.deepEqual(pick('tcp syn'), ['tcpSyn', 'tcpSynAck']);
  assert.deepEqual(pick('tcp fin'), ['tcpFin']);
  assert.deepEqual(pick('port:9999'), ['udp']);
  assert.deepEqual(pick('udp 9999'), ['udp']);
  assert.ok(pick('10.5.0.3').includes('arpRequest'));
  assert.equal(pick('ip:10.5.0.2 tcp').length, 6);
  assert.deepEqual(pick('dropped'), ['udp']);
  assert.deepEqual(pick('who has'), ['arpRequest']);
  // malformed は、プロトコル名が TCP などのままの壊れたフレームも含める
  const brokenTcp = FRAMES.tcpAck.slice();
  brokenTcp[14 + 20 + 12] = 0xf0;
  assert.ok(compileFilter('malformed')(parseFrame(brokenTcp), {}));
  assert.ok(!compileFilter('malformed')(parseFrame(FRAMES.tcpAck), {}));
  assert.equal(pick('').length, all.length);
});

// ------------------------------------------------------------------ pcap

test('pcap: ファイルヘッダとレコード（マイクロ秒）', () => {
  const ts0 = Date.UTC(2026, 9, 30, 12, 0, 0) + 0.25;   // 12:00:00.000250
  const recs = [{ ts: ts0, frame: FRAMES.arpRequest }, { ts: ts0 + 1500.5, frame: FRAMES.tcpDataLeft }];
  const out = writePcap(recs);
  const v = new DataView(out.buffer);
  assert.equal(v.getUint32(0, true), MAGIC_MICRO);
  assert.deepEqual([out[0], out[1], out[2], out[3]], [0xd4, 0xc3, 0xb2, 0xa1]);   // リトルエンディアン
  assert.equal(v.getUint16(4, true), 2);
  assert.equal(v.getUint16(6, true), 4);
  assert.equal(v.getInt32(8, true), 0);
  assert.equal(v.getUint32(12, true), 0);
  assert.equal(v.getUint32(16, true), 262144);
  assert.equal(v.getUint32(20, true), 1);   // LINKTYPE_ETHERNET
  // 1件目
  let at = 24;
  assert.equal(v.getUint32(at, true), Math.floor(ts0 / 1000));
  assert.equal(v.getUint32(at + 4, true), 250);
  assert.equal(v.getUint32(at + 8, true), FRAMES.arpRequest.length);
  assert.equal(v.getUint32(at + 12, true), FRAMES.arpRequest.length);
  assert.deepEqual(out.subarray(at + 16, at + 16 + FRAMES.arpRequest.length), FRAMES.arpRequest);
  // 2件目（1.5005秒後 → 12:00:01.500750）
  at += 16 + FRAMES.arpRequest.length;
  assert.equal(v.getUint32(at, true), Math.floor(ts0 / 1000) + 1);
  assert.equal(v.getUint32(at + 4, true), 500750);
  assert.equal(v.getUint32(at + 8, true), FRAMES.tcpDataLeft.length);
  assert.equal(at + 16 + FRAMES.tcpDataLeft.length, out.length);
});

test('pcap: ナノ秒版・snaplen で切る・秒の繰り上がり', () => {
  const ts = Date.UTC(2026, 0, 1) + 999.9999996;   // ほぼ1秒 → 繰り上がる
  const out = writePcap([{ ts, frame: FRAMES.tcpDataLeft }], { nano: true, snaplen: 20 });
  const v = new DataView(out.buffer);
  assert.equal(v.getUint32(0, true), MAGIC_NANO);
  assert.equal(v.getUint32(16, true), 20);
  const nsec = v.getUint32(28, true);
  assert.ok(nsec < 1e9, 'ナノ秒は 1e9 未満');
  assert.equal(v.getUint32(32, true), 20);                         // incl_len
  assert.equal(v.getUint32(36, true), FRAMES.tcpDataLeft.length);  // orig_len
  assert.equal(out.length, 24 + 16 + 20);
  assert.equal(writePcap([]).length, 24);
});

test('pcap のファイル名に日時が入る', () => {
  assert.equal(pcapFileName(new Date(2026, 9, 30, 15, 30, 12)), 'v86-link-20261030-153012.pcap');
});

// ------------------------------------------------------------------ キャプチャ・仮想スイッチ

test('キャプチャ: 件数とバイト数の上限で古いものから捨てる', () => {
  let t = 1000;
  const cap = new Capture({ maxRecords: 3, maxBytes: 1000 }, () => t++);
  for (let i = 0; i < 5; i++) cap.add({ frame: new Uint8Array(100), inPort: 0, outPorts: [1] });
  assert.equal(cap.size, 3);
  assert.equal(cap.evicted, 2);
  assert.deepEqual(cap.list().map((r) => r.no), [3, 4, 5]);
  // バイト数の上限: 600 バイトを入れると、合計 1000 を超えないよう古いものを捨てる
  cap.add({ frame: new Uint8Array(600), inPort: 1, outPorts: [] });
  assert.ok(cap.bytes <= 1000);
  assert.deepEqual(cap.list().map((r) => r.no), [4, 5, 6]);
  assert.equal(cap.at(2).dropped, true);
  assert.deepEqual(cap.list({ includeDropped: false }).map((r) => r.no), [4, 5]);
  // 停止中は記録しない・クリア
  cap.stop();
  assert.equal(cap.add({ frame: new Uint8Array(10), inPort: 0, outPorts: [1] }), null);
  cap.start();
  cap.clear();
  assert.equal(cap.size, 0);
  assert.equal(cap.evicted, 0);
  // フレームは複製して持つ（元を書き換えても記録は変わらない）
  const f = Uint8Array.from([1, 2, 3]);
  cap.add({ frame: f, inPort: 0, outPorts: [1] });
  f[0] = 9;
  assert.equal(cap.at(0).frame[0], 1);
});

test('キャプチャ: たくさん入れても配列が伸び続けない', () => {
  const cap = new Capture({ maxRecords: 100, maxBytes: 1e9 }, () => 0);
  for (let i = 0; i < 20000; i++) cap.add({ frame: new Uint8Array(1), inPort: 0, outPorts: [1] });
  assert.equal(cap.size, 100);
  assert.ok(cap.records.length < 5000);
  assert.equal(cap.at(99).no, 20000);
});

/** フレームを送ったり受けたりするだけの VmNode の代わり */
function fakeNode(name) {
  const node = { name, got: [], on: (type, fn) => { node.send = fn; }, injectFrame: (f) => node.got.push(f) };
  return node;
}

test('仮想スイッチ: 1フレームごとに入ったポート・出たポート・捨てた理由を知らせる（3ポート）', () => {
  let t = 0;
  const sw = new VirtualSwitch(() => ++t);
  const [a, b, c] = ['a', 'b', 'c'].map(fakeNode);
  const [pa, pb] = [a, b, c].map((n) => sw.attach(n));
  const events = [];
  const stats = new TrafficStats();
  sw.onFrame((e) => events.push({ ...e, outPorts: [...e.outPorts] }));
  sw.onFrame((e) => stats.add(e));
  const cap = new Capture({ maxRecords: 100, maxBytes: 1e6 }, () => 0);
  sw.onFrame((e) => cap.add(e));

  a.send(FRAMES.arpRequest);      // ブロードキャスト → b と c
  b.send(FRAMES.arpReply);        // a 宛て（覚えた）→ a だけ
  sw.setLinked(pb, false);
  a.send(FRAMES.icmpRequest);     // b 宛て。ケーブルを抜いたので b の MAC は忘れていて全ポートへ → c には届き、b へは捨てる
  sw.setLinked(pb, true);
  sw.setLinked(pa, false);
  a.send(FRAMES.icmpRequest);     // a のケーブルが抜けている → 捨てる
  sw.setLinked(pa, true);
  c.send(Uint8Array.from([1, 2, 3]));   // 短すぎる → 捨てる

  assert.deepEqual(events.map((e) => [e.inPort, e.outPorts, e.reason]), [
    [0, [1, 2], null], [1, [0], null], [0, [2], 'cable'], [0, [], 'cable'], [2, [], 'runt'],
  ]);
  assert.deepEqual(events.map((e) => e.ts), [1, 2, 3, 4, 5]);
  assert.equal(b.got.length, 1);
  assert.equal(c.got.length, 2);
  assert.equal(a.got.length, 1);
  // モニタの集計とキャプチャは同じ知らせから（重複して数えない）
  assert.equal(stats.frames, 3);
  assert.equal(stats.dropped, 2);
  assert.deepEqual(stats.types, { ARP: 2, ICMP: 1 });
  assert.equal(cap.size, 5);
  // 一部の届け先だけ捨てたフレームは「転送した」扱いで、理由が残る
  assert.deepEqual(cap.list().map((r) => [r.dropped, r.reason]), [[false, null], [false, null], [false, 'cable'], [true, 'cable'], [true, 'runt']]);
});

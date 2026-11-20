// シーケンス（ラダー図）の配置（ladder.js）を Node で確かめる。フレームは test/frames.mjs の実フレーム。
//
//   node --test toys/v86-link/test/ladder.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutLadder, conversationOf, inConversation, shortLabel, PROBE_LANE } from '../ladder.js';
import { parseFrame } from '../packet.js';
import { FRAMES } from './frames.mjs';

// frames.mjs: 左 10.5.0.2（00:22:15:cd:e6:99）= ポート 0、右 10.5.0.3（00:22:15:c1:fd:02）= ポート 1
let no = 0;
const rec = (frame, inPort, outPorts, extra = {}) => ({
  no: ++no, ts: 1000 + no * 10, frame, inPort, outPorts, outTags: outPorts.map(() => null), vlan: 1, inTag: null,
  dropped: outPorts.length === 0, reason: null, decision: outPorts.length > 1 ? 'flood' : 'known', probe: false, ...extra,
});
/** 802.1Q のタグを差し込んだフレーム */
const tagged = (f, vid) => Uint8Array.from([...f.slice(0, 12), 0x81, 0x00, (vid >> 8) & 0x0f, vid & 0xff, ...f.slice(12)]);

test('ARP の問い合わせ（ブロードキャスト）と応答、ping の往復', () => {
  const rs = [
    rec(FRAMES.arpRequest, 0, [1, 2], { decision: 'broadcast' }),
    rec(FRAMES.arpReply, 1, [0]),
    rec(FRAMES.icmpRequest, 0, [1]),
    rec(FRAMES.icmpReply, 1, [0]),
  ];
  const { lanes, rows } = layoutLadder(rs);
  assert.deepEqual(lanes.map((l) => l.id), [0, 1, 2], 'レーンはポート番号順');
  assert.equal(rows[0].kind, 'flood');
  assert.deepEqual(rows[0].to, [1, 2]);
  assert.equal(rows[0].strong, null, 'ブロードキャストは濃い線なし');
  assert.equal(rows[0].label, 'Who has 10.5.0.3?');
  assert.deepEqual([rows[1].kind, rows[1].from, rows[1].to, rows[1].strong], ['known', 1, [0], 0]);
  assert.match(rows[1].label, /^10\.5\.0\.3 is at 00:22:15:c1:fd:02$/);
  assert.equal(rows[2].label, 'echo request seq=1 ttl=64');
  assert.equal(rows[3].label, 'echo reply seq=1 ttl=64');
  assert.deepEqual([rows[2].from, rows[2].to, rows[3].from, rows[3].to], [0, [1], 1, [0]]);
  // 時間は上から下
  assert.ok(rows.every((r, i) => i === 0 || r.y > rows[i - 1].y));
});

test('TCP の 3 ウェイハンドシェイク: 相対 Seq が 0・1（既定）。相対をやめると生の値', () => {
  const rs = [rec(FRAMES.tcpSyn, 0, [1]), rec(FRAMES.tcpSynAck, 1, [0]), rec(FRAMES.tcpAck, 0, [1]), rec(FRAMES.tcpDataLeft, 0, [1]), rec(FRAMES.tcpFin, 0, [1])];
  const { rows } = layoutLadder(rs);
  assert.equal(rows[0].label, '[SYN] Seq=0');
  assert.equal(rows[1].label, '[SYN, ACK] Seq=0 Ack=1');
  assert.equal(rows[2].label, '[ACK] Seq=1 Ack=1');
  assert.match(rows[3].label, /^\[PSH, ACK\] Seq=1 Ack=1 Len=16$/);
  assert.match(rows[4].label, /^\[FIN, ACK\] Seq=17 Ack=20$/);
  const raw = layoutLadder(rs, { relativeSeq: false }).rows;
  assert.equal(raw[0].label, `[SYN] Seq=${parseFrame(FRAMES.tcpSyn).tcp.seq}`);
});

test('フラッディング: 宛先 MAC のポートを知っていれば、そのレーンだけ濃く', () => {
  const rs = [
    rec(FRAMES.arpReply, 1, [0]),                                   // 右（ポート 1）の MAC を見る
    rec(FRAMES.icmpRequest, 0, [1, 2, 3], { decision: 'flood' }),   // 右宛てが、スイッチでは知らない宛先としてフラッディング
  ];
  const { rows } = layoutLadder(rs);
  assert.equal(rows[1].kind, 'flood');
  assert.deepEqual(rows[1].to, [1, 2, 3]);
  assert.equal(rows[1].strong, 1);
  // ハブ
  const hub = layoutLadder([rec(FRAMES.icmpRequest, 0, [1, 2], { decision: 'hub' })]).rows[0];
  assert.equal(hub.kind, 'flood');
});

test('捨てたフレーム（cable・loss・vlan-not-allowed）は drop。理由を持つ', () => {
  const rs = ['cable', 'loss', 'vlan-not-allowed'].map((reason) => rec(FRAMES.icmpRequest, 0, [], { reason, decision: null }));
  const { rows, lanes } = layoutLadder(rs);
  assert.deepEqual(rows.map((r) => [r.kind, r.from, r.to.length, r.reason]), [['drop', 0, 0, 'cable'], ['drop', 0, 0, 'loss'], ['drop', 0, 0, 'vlan-not-allowed']]);
  assert.deepEqual(lanes.map((l) => l.id), [0]);
});

test('ルーター越え: A→R と R→B が別の矢印。R のトランクのタグが出る', () => {
  // A（ポート 0、VLAN 10 のアクセス）→ R（ポート 7、トランク）へは VLAN 10 のタグを付けて出す。
  // R が VLAN 20 のタグを付けて送り返し、B（ポート 1）へはタグを外して出す。TTL は 63
  const fwd = FRAMES.icmpRequest.slice();
  fwd[22] = 63;
  const rs = [
    rec(FRAMES.icmpRequest, 0, [7], { vlan: 10, outTags: [10] }),
    rec(tagged(fwd, 20), 7, [1], { vlan: 20, inTag: 20 }),
  ];
  const { lanes, rows } = layoutLadder(rs);
  assert.deepEqual(lanes.map((l) => l.id), [0, 1, 7]);
  assert.deepEqual([rows[0].from, rows[0].to], [0, [7]]);
  assert.deepEqual(rows[0].outTags, [{ lane: 7, tag: 10 }]);
  assert.equal(rows[0].label, 'echo request seq=1 ttl=64');
  assert.deepEqual([rows[1].from, rows[1].to], [7, [1]]);
  assert.equal(rows[1].label, '[20] echo request seq=1 ttl=63');
});

test('検査のプローブは 1 本の「検査」レーンにまとめ、最後に置く。kind は probe', () => {
  const rs = [rec(FRAMES.icmpRequest, 9, [0], { probe: true }), rec(FRAMES.icmpReply, 0, [10], { probe: true })];
  const { lanes, rows } = layoutLadder(rs, { probePorts: new Set([9, 10]) });
  assert.deepEqual(lanes.map((l) => l.id), [0, PROBE_LANE]);
  assert.deepEqual([rows[0].from, rows[0].to, rows[0].kind], [PROBE_LANE, [0], 'probe']);
  assert.deepEqual([rows[1].from, rows[1].to], [0, [PROBE_LANE]]);
});

test('「会話だけ」: 別の会話のフレームを含まない。その 2 つの IP の間の ARP は含む', () => {
  const all = [FRAMES.arpRequest, FRAMES.arpReply, FRAMES.icmpRequest, FRAMES.tcpSyn, FRAMES.tcpSynAck, FRAMES.tcpAck, FRAMES.udp, FRAMES.icmpUnreachable, FRAMES.mld];
  const conv = conversationOf(parseFrame(FRAMES.tcpSyn));
  assert.deepEqual(conv, { ips: ["10.5.0.2", "10.5.0.3"], proto: "TCP", ports: [7000, 38708] });
  const keep = all.filter((f) => inConversation(conv, parseFrame(f)));
  assert.deepEqual(keep, [FRAMES.arpRequest, FRAMES.arpReply, FRAMES.tcpSyn, FRAMES.tcpSynAck, FRAMES.tcpAck]);
  // ICMP の会話: 同じ 2 つの IP の ICMP と ARP。TCP・UDP は含めない
  const icmp = conversationOf(parseFrame(FRAMES.icmpRequest));
  const keep2 = all.filter((f) => inConversation(icmp, parseFrame(f)));
  assert.deepEqual(keep2, [FRAMES.arpRequest, FRAMES.arpReply, FRAMES.icmpRequest, FRAMES.icmpUnreachable]);
  assert.equal(conversationOf(parseFrame(FRAMES.mld)).ips.length, 2, 'IPv6 も IP の組で');
  assert.equal(conversationOf(parseFrame(new Uint8Array(5))), null);
});

test('等間隔: 0.5 秒以上空いたところに区切り。実時間: 時間に比例（行は重ならない）', () => {
  const rs = [rec(FRAMES.icmpRequest, 0, [1], { ts: 0 }), rec(FRAMES.icmpReply, 1, [0], { ts: 10 }), rec(FRAMES.icmpRequest, 0, [1], { ts: 1210 })];
  const even = layoutLadder(rs, { rowH: 20, gapH: 10 }).rows;
  assert.deepEqual(even.map((r) => r.gapBefore), [null, null, 1200]);
  assert.deepEqual(even.map((r) => r.y), [0, 20, 50]);
  const real = layoutLadder(rs, { timeMode: 'real', rowH: 20, pxPerSec: 100 }).rows;
  assert.deepEqual(real.map((r) => r.y), [0, 20, 121]);
  assert.ok(real.every((r) => r.gapBefore === null));
});

test('壊れたフレーム（でたらめなバイト列）で例外を投げない', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rs = [];
  for (let i = 0; i < 3000; i++) {
    const len = Math.floor(rnd() * 120);
    const f = Uint8Array.from({ length: len }, () => Math.floor(rnd() * 256));
    // TCP・ARP に見えるものも混ぜる
    if (len > 40 && i % 3 === 0) { f[12] = 0x08; f[13] = 0x00; f[14] = 0x45; f[23] = 6; }
    if (len > 30 && i % 5 === 0) { f[12] = 0x08; f[13] = 0x06; }
    rs.push(rec(f, Math.floor(rnd() * 4), rnd() < 0.2 ? [] : [Math.floor(rnd() * 4)], { ts: rnd() * 1e6 }));
  }
  rs.push({ no: 1, frame: null, inPort: 0, outPorts: [1] }, { no: 2, frame: new Uint8Array(0), inPort: 0 });
  const out = layoutLadder(rs);
  assert.equal(out.rows.length, rs.length);
  assert.ok(out.rows.every((r) => typeof r.label === 'string' && Number.isFinite(r.y)));
  // parse が例外を投げても止まらない
  assert.doesNotThrow(() => layoutLadder(rs.slice(0, 10), { parse: () => { throw new Error('x'); } }));
});

test('shortLabel: そのほか', () => {
  assert.match(shortLabel(parseFrame(FRAMES.udp)), /^35501 → 9999 Len=10$/);
  assert.match(shortLabel(parseFrame(FRAMES.icmpUnreachable)), /^Destination unreachable/);
  assert.match(shortLabel(parseFrame(new Uint8Array(3))), /^壊れたフレーム/);
});

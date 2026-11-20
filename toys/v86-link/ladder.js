// シーケンス（ラダー図）の配置。DOM にも v86 にも依存しない（Node でテストできる）。描くのは ladderview.js。
//
//   縦のレーン = スイッチのポート（ポート番号順。そのフレームの並びに出てくるポートだけ）。シナリオの検査のプローブは 1 本の「検査」レーンにまとめる
//   横の矢印   = 1 フレーム。入ったポートのレーンから、出たポートのレーンへ。時間は上から下
//
//   layoutLadder(records, opts) → { lanes, rows, height }
//     records: キャプチャの記録（capture.js。古い順。フィルタはかけたもの）
//     opts:
//       parse(record)   解析結果（packet.js の parseFrame。CaptureView のキャッシュを使うときに渡す）
//       probePorts      検査のプローブのポート番号の Set（そのポートは 'probe' レーンにまとめる）
//       timeMode        'even'（等間隔。既定）/ 'real'（実時間）
//       relativeSeq     TCP の Seq/Ack を接続ごとの相対値で出すか（既定 true）
//       rowH            1 行の高さ（px。既定 24）/ gapH 区切りの高さ（既定 18）/ gapMs 区切りを入れる間（既定 500ms）
//       pxPerSec        実時間のときの 1 秒の高さ（既定 120px。ただし行が重ならないよう rowH は空ける）
//     lanes: [{ id: ポート番号 | 'probe' }]
//     rows:  [{ recordIndex, no, y, from, to: [], strong, kind, label, gapBefore, inTag, outTags: [{ lane, tag }], reason, probe, protocol }]
//       kind:   'known'（宛先が 1 つ）/ 'flood'（フラッディング・ブロードキャスト・ハブ）/ 'drop'（捨てた）/ 'probe'（検査の通信）
//       strong: フラッディングで、宛先 MAC のポートが分かっているときのそのレーン（濃く描く）。known なら届け先のレーン
//       gapBefore: 等間隔のとき、前の行から gapMs 以上空いていれば、その ms（区切り「… 1.2s …」を入れる）。無ければ null
//
//   conversationOf(parsed) / inConversation(conv, parsed): 「会話だけ」の判定（同じ 2 つの IP。TCP/UDP ならポートの組み合わせも同じ。
//   その 2 つの IP の間の ARP も含める）

import { parseFrame } from './packet.js';

export const PROBE_LANE = 'probe';
const DEFAULTS = { timeMode: 'even', relativeSeq: true, rowH: 24, gapH: 18, gapMs: 500, pxPerSec: 120 };

const laneOf = (port, probePorts) => (probePorts?.has(port) ? PROBE_LANE : port);
const macKey = (b, at) => (b.length >= at + 6 ? [...b.slice(at, at + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':') : null);
const isGroupMac = (b) => b.length >= 1 && (b[0] & 1) === 1;

/** 接続（向きを含む）のキー */
const flowKey = (p) => `${p.ip.src}:${p.ports.src}>${p.ip.dst}:${p.ports.dst}`;
const reverseKey = (p) => `${p.ip.dst}:${p.ports.dst}>${p.ip.src}:${p.ports.src}`;

/**
 * 矢印のラベル（packet.js の概要を短くしたもの）。
 *   ARP "Who has 10.5.0.3?" / "10.5.0.3 is at 02:…" ・ ICMP "echo request seq=1 ttl=64" ・ TCP "[SYN] Seq=0" ・ UDP "53 → 1234 Len=20"
 */
export function shortLabel(p, { seq = null, ack = null } = {}) {
  if (p.malformed) return `壊れたフレーム（${p.protocol}）`;
  // タグ付きのフレームの概要には "[VLAN 20] " が付いている（印は withTag で付け直す）
  const info = String(p.info ?? '').replace(/^\[VLAN [^\]]*\] /, '');
  if (p.protocol === 'ARP') {
    const who = /^Who has (\S+)\?/.exec(info);
    return who ? `Who has ${who[1]}?` : info;
  }
  if (p.protocol === 'ICMP') {
    const echo = /^Echo \(ping\) (request|reply) id=\S+, seq=(\d+), ttl=(\d+)/.exec(info);
    if (echo) return `echo ${echo[1]} seq=${echo[2]} ttl=${echo[3]}`;
    return info.replace(/ 元: .*$/, '');
  }
  if (p.protocol === 'TCP' && p.tcp) {
    const t = p.tcp;
    const parts = [`[${t.flags.join(', ')}]`, `Seq=${seq ?? t.seq}`];
    if (t.flags.includes('ACK')) parts.push(`Ack=${ack ?? t.ack}`);
    if (t.len > 0) parts.push(`Len=${t.len}`);
    return parts.join(' ');
  }
  if (p.protocol === 'UDP') return info;
  const s = info || p.protocol;
  return s.length > 48 ? s.slice(0, 47) + '…' : s;
}

/** VLAN のタグの印（[10]）を付けたラベル。タグ付きで入ってきたものだけ */
const withTag = (label, record, p) => {
  const tag = record.inTag ?? (p.vlans?.length ? p.vlans[0].id : null);
  return tag !== null && tag !== undefined ? `[${tag}] ${label}` : label;
};

export function layoutLadder(records, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const parse = o.parse ?? ((r) => parseFrame(r.frame));
  const probePorts = o.probePorts ?? new Set();
  const laneSet = new Set();
  const rows = [];
  const macPort = new Map();       // MAC → 最後にそのMAC を送り元として見たレーン（フラッディングで濃く描く先）
  const tcpBase = new Map();       // 接続の向き → 最初に見た Seq（相対値の基準）
  let y = 0;
  let prevTs = null;
  let t0 = null;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    let p;
    try {
      p = parse(r);
    } catch {
      p = { protocol: 'Malformed', info: '', malformed: true, vlans: [] };
    }
    const b = r.frame instanceof Uint8Array ? r.frame : new Uint8Array(0);
    const from = laneOf(r.inPort, probePorts);
    const to = [...new Set((r.outPorts ?? []).map((x) => laneOf(x, probePorts)))].filter((x) => x !== from);
    laneSet.add(from);
    for (const x of to) laneSet.add(x);
    // 宛先 MAC のレーン（その MAC を送り元として見たことがあれば）
    const dst = macKey(b, 0), src = macKey(b, 6);
    const dstLane = dst && !isGroupMac(b) ? macPort.get(dst) : undefined;
    if (src && !(b[6] & 1)) macPort.set(src, from);
    let kind;
    if (r.dropped || to.length === 0) kind = 'drop';
    else if (r.probe) kind = 'probe';
    else if (r.decision === 'known' || r.decision === 'filtered' || (to.length === 1 && r.decision !== 'flood' && r.decision !== 'broadcast' && r.decision !== 'hub')) kind = 'known';
    else kind = 'flood';
    const strong = kind === 'known' || (kind === 'probe' && to.length === 1) ? to[0] : dstLane !== undefined && to.includes(dstLane) ? dstLane : null;
    // TCP の相対 Seq / Ack
    let seq = null, ack = null;
    if (o.relativeSeq && p.protocol === 'TCP' && p.tcp && p.ip && p.ports) {
      const k = flowKey(p), rk = reverseKey(p);
      if (!tcpBase.has(k) || p.tcp.flags.includes('SYN')) tcpBase.set(k, p.tcp.seq);
      seq = (p.tcp.seq - tcpBase.get(k)) >>> 0;
      if (p.tcp.flags.includes('ACK') && tcpBase.has(rk)) ack = (p.tcp.ack - tcpBase.get(rk)) >>> 0;
    }
    let label;
    try {
      label = withTag(shortLabel(p, { seq, ack }), r, p);
    } catch {
      label = '壊れたフレーム';
    }
    // 縦の位置
    const ts = Number.isFinite(r.ts) ? r.ts : (prevTs ?? 0);
    if (t0 === null) t0 = ts;
    let gapBefore = null;
    if (o.timeMode === 'real') {
      y = Math.max(rows.length ? y + o.rowH : 0, ((ts - t0) / 1000) * o.pxPerSec);
    } else {
      if (prevTs !== null && ts - prevTs >= o.gapMs) {
        gapBefore = ts - prevTs;
        y += o.gapH;
      }
      if (rows.length) y += o.rowH;
    }
    prevTs = ts;
    rows.push({
      recordIndex: i, no: r.no, y, from, to, strong, kind, label, gapBefore,
      inTag: r.inTag ?? null,
      outTags: (r.outPorts ?? []).map((x, j) => ({ lane: laneOf(x, probePorts), tag: r.outTags?.[j] ?? null })).filter((x) => x.tag !== null && x.tag !== undefined),
      reason: r.reason ?? null, probe: !!r.probe, protocol: p.protocol,
    });
  }
  const lanes = [...laneSet].sort((a, b) => (a === PROBE_LANE) - (b === PROBE_LANE) || (a === PROBE_LANE ? 0 : a - b)).map((id) => ({ id }));
  return { lanes, rows, height: rows.length ? y + o.rowH : 0 };
}

// ---------------------------------------------------------------- 「会話だけ」

/** 選んだフレームの会話（2 つの IP と、TCP/UDP ならポートの組み合わせ）。IP を持たないフレームは null */
export function conversationOf(p) {
  if (!p?.ip) return null;
  if (p.protocol === 'ARP') return { ips: [p.ip.src, p.ip.dst].sort(), proto: null, ports: null };
  const proto = p.protocol;
  const ports = (proto === 'TCP' || proto === 'UDP') && p.ports ? [p.ports.src, p.ports.dst].sort((a, b) => a - b) : null;
  return { ips: [p.ip.src, p.ip.dst].sort(), proto, ports };
}

/** フレームがその会話に入るか（その 2 つの IP の間の ARP も含める） */
export function inConversation(conv, p) {
  if (!conv || !p?.ip) return false;
  const ips = [p.ip.src, p.ip.dst].sort();
  if (ips[0] !== conv.ips[0] || ips[1] !== conv.ips[1]) return false;
  if (p.protocol === 'ARP') return true;
  if (conv.proto === null) return true;
  if (p.protocol !== conv.proto) return false;
  if (!conv.ports) return true;
  if (!p.ports) return false;
  const ports = [p.ports.src, p.ports.dst].sort((a, b) => a - b);
  return ports[0] === conv.ports[0] && ports[1] === conv.ports[1];
}

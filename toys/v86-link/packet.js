// フレームの解析（DOM にも v86 にも依存しない純粋なモジュール。Node でテストできる）。
//
// フレームの中身はゲスト VM が作る「信用できない入力」として扱う:
//   - 読む前に必ず長さを確かめる（範囲外を読まない）
//   - どんなバイト列でも例外を投げない（最後の砦として try/catch もある）
//   - 返すのは文字列と数値だけ（表示する側は textContent で入れる）
//
// parseFrame(bytes) → {
//   protocol: 一覧の「プロトコル」列（"ARP" / "ICMP" / "TCP" / "UDP" / "IPv4" / "IPv6" / "ICMPv6" / "Unknown" / "Malformed"）
//   src, dst: 一覧の「送信元」「宛先」（IP があれば IP、無ければ MAC）
//   info:     一覧の「概要」
//   layers:   詳細表示 [{ name, fields: [[項目, 値], ...] }]
//   ip:       { src, dst }（あれば）・ports: { src, dst }（TCP/UDP）・tcp: { flags, ... }（TCP）
//   payloadOffset: アプリケーションのデータが始まる位置（無ければ frame.length）
// }

export const ETHERTYPES = { 0x0800: 'IPv4', 0x0806: 'ARP', 0x86dd: 'IPv6', 0x8100: '802.1Q' };
const IP_PROTOCOLS = { 0: 'Hop-by-Hop', 1: 'ICMP', 6: 'TCP', 17: 'UDP', 58: 'ICMPv6' };
const ICMP_TYPES = { 0: 'Echo (ping) reply', 3: 'Destination unreachable', 5: 'Redirect', 8: 'Echo (ping) request', 11: 'Time exceeded' };
const ICMPV6_TYPES = {
  1: 'Destination unreachable', 128: 'Echo request', 129: 'Echo reply', 133: 'Router solicitation', 134: 'Router advertisement',
  135: 'Neighbor solicitation', 136: 'Neighbor advertisement', 143: 'Multicast listener report v2',
};
const TCP_FLAGS = [[0x20, 'URG'], [0x10, 'ACK'], [0x08, 'PSH'], [0x04, 'RST'], [0x02, 'SYN'], [0x01, 'FIN']];
// Wireshark と同じ並び（SYN, ACK など）で表示する
const TCP_FLAG_ORDER = ['FIN', 'SYN', 'RST', 'PSH', 'ACK', 'URG'];

const hex = (n, width) => n.toString(16).padStart(width, '0');

/** 範囲を確かめながら読む小さな読み取り器 */
function reader(b) {
  const has = (at, n) => Number.isInteger(at) && at >= 0 && n >= 0 && at + n <= b.length;
  return {
    has,
    u8: (at) => (has(at, 1) ? b[at] : null),
    u16: (at) => (has(at, 2) ? (b[at] << 8) | b[at + 1] : null),
    u32: (at) => (has(at, 4) ? ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3] : null),
    mac: (at) => (has(at, 6) ? [...b.subarray(at, at + 6)].map((x) => hex(x, 2)).join(':') : null),
    ipv4: (at) => (has(at, 4) ? [...b.subarray(at, at + 4)].join('.') : null),
    ipv6: (at) => (has(at, 16) ? formatIpv6(b.subarray(at, at + 16)) : null),
  };
}

/** IPv6 アドレスを短く書く（いちばん長い 0 の並びを :: にする） */
export function formatIpv6(bytes) {
  const words = [];
  for (let i = 0; i < 16; i += 2) words.push((bytes[i] << 8) | bytes[i + 1]);
  let bestAt = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (words[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestAt = i; bestLen = j - i; }
    i = j;
  }
  const part = (ws) => ws.map((w) => w.toString(16)).join(':');
  if (bestAt < 0) return part(words);
  return part(words.slice(0, bestAt)) + '::' + part(words.slice(bestAt + bestLen));
}

function malformed(out, why) {
  out.protocol = out.protocol === 'Unknown' ? 'Malformed' : out.protocol;
  out.malformed = true;
  out.info = (out.info ? out.info + ' ' : '') + `[Malformed: ${why}]`;
  return out;
}

export function parseFrame(frame) {
  const b = frame instanceof Uint8Array ? frame : new Uint8Array(0);
  const out = { protocol: 'Unknown', src: '', dst: '', info: '', layers: [], payloadOffset: b.length, malformed: false };
  try {
    return parseEthernet(b, out);
  } catch (e) {
    // ここに来るのはバグだけのはず。画面を壊さないよう、壊れたフレームとして返す
    out.layers.push({ name: '解析エラー', fields: [['例外', String(e && e.message)]] });
    return malformed(out, 'parser error');
  }
}

function parseEthernet(b, out) {
  const r = reader(b);
  out.layers.push({ name: 'Frame', fields: [['長さ', `${b.length} バイト`]] });
  if (!r.has(0, 14)) {
    out.protocol = 'Malformed';
    return malformed(out, `${b.length} バイトしかない（Ethernet ヘッダは14バイト）`);
  }
  const dst = r.mac(0), src = r.mac(6), type = r.u16(12);
  out.src = src;
  out.dst = dst;
  const typeName = ETHERTYPES[type];
  out.layers.push({
    name: 'Ethernet II',
    fields: [['宛先 MAC', dst + (dst === 'ff:ff:ff:ff:ff:ff' ? '（ブロードキャスト）' : (b[0] & 1) ? '（マルチキャスト）' : '')],
      ['送信元 MAC', src], ['タイプ', `0x${hex(type, 4)}${typeName ? ` (${typeName})` : ''}`]],
  });
  out.payloadOffset = 14;
  if (type === 0x0806) return parseArp(b, r, out);
  if (type === 0x0800) return parseIpv4(b, r, out);
  if (type === 0x86dd) return parseIpv6(b, r, out);
  out.protocol = 'Unknown';
  out.info = `Unknown (ethertype=0x${hex(type, 4)})`;
  return out;
}

function parseArp(b, r, out) {
  out.protocol = 'ARP';
  const at = 14;
  if (!r.has(at, 8)) return malformed(out, 'ARP ヘッダが短い');
  const htype = r.u16(at), ptype = r.u16(at + 2), hlen = r.u8(at + 4), plen = r.u8(at + 5), oper = r.u16(at + 6);
  const fields = [['ハードウェア種別', String(htype)], ['プロトコル種別', `0x${hex(ptype, 4)}`], ['操作', oper === 1 ? '1 (request)' : oper === 2 ? '2 (reply)' : String(oper)]];
  out.layers.push({ name: 'ARP', fields });
  // Ethernet + IPv4 の ARP（hlen=6, plen=4）だけ中身を読む
  if (hlen !== 6 || plen !== 4) {
    out.info = `ARP（hlen=${hlen}, plen=${plen}）`;
    return out;
  }
  if (!r.has(at, 28)) return malformed(out, 'ARP が短い');
  const sha = r.mac(at + 8), spa = r.ipv4(at + 14), tha = r.mac(at + 18), tpa = r.ipv4(at + 24);
  fields.push(['送信元 MAC', sha], ['送信元 IP', spa], ['宛先 MAC', tha], ['宛先 IP', tpa]);
  out.ip = { src: spa, dst: tpa };
  out.payloadOffset = at + 28;
  if (oper === 1) out.info = `Who has ${tpa}? Tell ${spa}`;
  else if (oper === 2) out.info = `${spa} is at ${sha}`;
  else out.info = `ARP operation ${oper}`;
  return out;
}

function parseIpv4(b, r, out) {
  out.protocol = 'IPv4';
  const at = 14;
  if (!r.has(at, 20)) return malformed(out, 'IPv4 ヘッダが短い');
  const version = r.u8(at) >> 4, ihl = (r.u8(at) & 0x0f) * 4;
  const total = r.u16(at + 2), id = r.u16(at + 4), fragWord = r.u16(at + 6), ttl = r.u8(at + 8), proto = r.u8(at + 9);
  const src = r.ipv4(at + 12), dst = r.ipv4(at + 16);
  out.src = src;
  out.dst = dst;
  out.ip = { src, dst };
  const fragOffset = (fragWord & 0x1fff) * 8, moreFragments = !!(fragWord & 0x2000), dontFragment = !!(fragWord & 0x4000);
  out.layers.push({
    name: 'IPv4',
    fields: [['バージョン', String(version)], ['ヘッダ長', `${ihl} バイト`], ['全長', String(total)], ['ID', `0x${hex(id, 4)}`],
      ['フラグ', [dontFragment && 'DF', moreFragments && 'MF'].filter(Boolean).join(', ') || 'なし'], ['フラグメントオフセット', String(fragOffset)],
      ['TTL', String(ttl)], ['プロトコル', `${proto}${IP_PROTOCOLS[proto] ? ` (${IP_PROTOCOLS[proto]})` : ''}`], ['送信元', src], ['宛先', dst]],
  });
  if (version !== 4 || ihl < 20) return malformed(out, `version=${version}, ヘッダ長=${ihl}`);
  if (!r.has(at, ihl)) return malformed(out, 'IPv4 オプションが途中で切れている');
  // 全長がフレームより長ければ、あるところまで読む（壊れたものとして印を付ける）
  let end = at + total;
  let truncated = false;
  if (total < ihl) return malformed(out, `全長(${total})がヘッダ長より短い`);
  if (end > b.length) { end = b.length; truncated = true; }
  const l4 = at + ihl;
  out.payloadOffset = l4;
  if (fragOffset > 0) {
    out.info = `Fragmented IP protocol (proto=${proto}, off=${fragOffset})`;
    return out;
  }
  if (proto === 1) parseIcmp(b, r, out, l4, end, ttl);
  else if (proto === 6) parseTcp(b, r, out, l4, end);
  else if (proto === 17) parseUdp(b, r, out, l4, end);
  else out.info = `IPv4 protocol ${proto}`;
  if (truncated && !out.malformed) malformed(out, 'IPv4 の全長がフレームより長い');
  return out;
}

function parseIcmp(b, r, out, at, end, ttl) {
  out.protocol = 'ICMP';
  if (end - at < 4) return malformed(out, 'ICMP ヘッダが短い');
  const type = r.u8(at), code = r.u8(at + 1);
  const name = ICMP_TYPES[type] ?? `type ${type}`;
  const fields = [['タイプ', `${type} (${name})`], ['コード', String(code)], ['チェックサム', `0x${hex(r.u16(at + 2), 4)}`]];
  out.layers.push({ name: 'ICMP', fields });
  out.payloadOffset = at + 4;
  if ((type === 0 || type === 8) && end - at >= 8) {
    const id = r.u16(at + 4), seq = r.u16(at + 6);
    fields.push(['ID', `0x${hex(id, 4)}`], ['シーケンス番号', String(seq)]);
    out.payloadOffset = at + 8;
    out.info = `${name} id=0x${hex(id, 4)}, seq=${seq}, ttl=${ttl}`;
  } else {
    out.info = `${name}${code ? ` (code ${code})` : ''}`;
  }
  return out;
}

function parseTcp(b, r, out, at, end) {
  out.protocol = 'TCP';
  if (end - at < 20) return malformed(out, 'TCP ヘッダが短い');
  const sport = r.u16(at), dport = r.u16(at + 2), seq = r.u32(at + 4), ack = r.u32(at + 8);
  const doff = (r.u8(at + 12) >> 4) * 4, flagByte = r.u8(at + 13), win = r.u16(at + 14);
  const flags = TCP_FLAGS.filter(([bit]) => flagByte & bit).map(([, n]) => n).sort((x, y) => TCP_FLAG_ORDER.indexOf(x) - TCP_FLAG_ORDER.indexOf(y));
  out.ports = { src: sport, dst: dport };
  if (doff < 20 || at + doff > end) {
    out.layers.push({ name: 'TCP', fields: [['送信元ポート', String(sport)], ['宛先ポート', String(dport)], ['ヘッダ長', `${doff} バイト`]] });
    return malformed(out, `TCP ヘッダ長(${doff})が不正`);
  }
  const len = end - (at + doff);
  out.tcp = { flags, seq, ack, len, win };
  out.payloadOffset = at + doff;
  out.layers.push({
    name: 'TCP',
    fields: [['送信元ポート', String(sport)], ['宛先ポート', String(dport)], ['シーケンス番号', String(seq)],
      ['確認応答番号', flags.includes('ACK') ? String(ack) : `${ack}（ACK フラグなし）`], ['ヘッダ長', `${doff} バイト`],
      ['フラグ', `0x${hex(flagByte, 2)} [${flags.join(', ') || 'なし'}]`], ['ウィンドウ', String(win)], ['データ長', `${len} バイト`]],
  });
  const parts = [`${sport} → ${dport}`, `[${flags.join(', ')}]`, `Seq=${seq}`];
  if (flags.includes('ACK')) parts.push(`Ack=${ack}`);
  parts.push(`Win=${win}`, `Len=${len}`);
  out.info = parts.join(' ');
  return out;
}

function parseUdp(b, r, out, at, end) {
  out.protocol = 'UDP';
  if (end - at < 8) return malformed(out, 'UDP ヘッダが短い');
  const sport = r.u16(at), dport = r.u16(at + 2), len = r.u16(at + 4);
  out.ports = { src: sport, dst: dport };
  out.payloadOffset = at + 8;
  out.layers.push({ name: 'UDP', fields: [['送信元ポート', String(sport)], ['宛先ポート', String(dport)], ['長さ', String(len)], ['チェックサム', `0x${hex(r.u16(at + 6), 4)}`]] });
  out.info = `${sport} → ${dport} Len=${Math.max(0, len - 8)}`;
  if (len < 8 || at + len > end) malformed(out, `UDP の長さ(${len})が不正`);
  return out;
}

function parseIpv6(b, r, out) {
  out.protocol = 'IPv6';
  const at = 14;
  if (!r.has(at, 40)) return malformed(out, 'IPv6 ヘッダが短い');
  const payloadLen = r.u16(at + 4), next = r.u8(at + 6), hop = r.u8(at + 7);
  const src = r.ipv6(at + 8), dst = r.ipv6(at + 24);
  out.src = src;
  out.dst = dst;
  out.ip = { src, dst };
  out.payloadOffset = at + 40;
  out.layers.push({
    name: 'IPv6',
    fields: [['ペイロード長', String(payloadLen)], ['次のヘッダ', `${next}${IP_PROTOCOLS[next] ? ` (${IP_PROTOCOLS[next]})` : ''}`],
      ['ホップリミット', String(hop)], ['送信元', src], ['宛先', dst]],
  });
  // 拡張ヘッダはたどらない。ICMPv6 だけ種類を出す
  if (next === 58 && r.has(at + 40, 1)) {
    const type = r.u8(at + 40);
    out.protocol = 'ICMPv6';
    out.info = ICMPV6_TYPES[type] ?? `ICMPv6 type ${type}`;
  } else {
    out.info = `IPv6 next header ${next}${IP_PROTOCOLS[next] ? ` (${IP_PROTOCOLS[next]})` : ''}`;
  }
  return out;
}

/**
 * 16進ダンプ（Wireshark と同じく 16バイトずつ、オフセット・16進・ASCII）。行の配列を返す。
 * 表示できない文字は "." にする
 */
export function hexdump(bytes, max = 4096) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const lines = [];
  const n = Math.min(b.length, max);
  for (let i = 0; i < n; i += 16) {
    const row = b.subarray(i, Math.min(i + 16, n));
    const hexPart = [...row].map((x) => hex(x, 2)).join(' ').padEnd(47, ' ');
    const ascii = [...row].map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${hex(i, 4)}  ${hexPart}  ${ascii}`);
  }
  if (b.length > max) lines.push(`…（残り ${b.length - max} バイトは省略）`);
  return lines;
}

/**
 * 簡単なフィルタ。空白で区切った条件をすべて満たすものを残す（AND）。大文字・小文字は区別しない
 *   arp / icmp / tcp / udp / ipv4 / ipv6 / icmpv6 / unknown / malformed  プロトコル
 *   dropped / forwarded                                                  捨てた / 転送した
 *   10.5.0.2（または ip:10.5.0.2）                                        送信元か宛先の IP
 *   port:8080（または 8080 のような数だけ）                               送信元か宛先のポート
 *   syn / fin / rst / psh                                                TCP のフラグ
 *   それ以外の語                                                          概要（Info）に含まれる文字
 */
export function compileFilter(text) {
  const terms = String(text ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const protos = new Set(['arp', 'icmp', 'tcp', 'udp', 'ipv4', 'ipv6', 'icmpv6', 'unknown', 'malformed']);
  const flags = new Set(['syn', 'fin', 'rst', 'psh']);
  const tests = terms.map((t) => {
    if (protos.has(t)) {
      if (t === 'ipv4') return (p) => !!p.ip && !String(p.ip.src).includes(':') && p.protocol !== 'ARP';
      // 壊れたフレームは、どのプロトコルでも（TCP ヘッダだけ壊れているものなども）含める
      if (t === 'malformed') return (p) => p.malformed;
      return (p) => p.protocol.toLowerCase() === t;
    }
    if (t === 'dropped') return (p, rec) => !!rec?.dropped;
    if (t === 'forwarded') return (p, rec) => !rec?.dropped;
    if (flags.has(t)) return (p) => !!p.tcp?.flags.includes(t.toUpperCase());
    const ip = /^(?:ip:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
    if (ip) return (p) => !!p.ip && (p.ip.src === ip[1] || p.ip.dst === ip[1]);
    const port = /^(?:port:)?(\d{1,5})$/.exec(t);
    if (port) return (p) => !!p.ports && (p.ports.src === Number(port[1]) || p.ports.dst === Number(port[1]));
    return (p) => p.info.toLowerCase().includes(t);
  });
  return (parsed, record) => tests.every((f) => f(parsed, record));
}

// pcap（libpcap 形式）の書き出し（DOM にも v86 にも依存しない。Node でテストできる）。
//
// 形式（https://www.tcpdump.org/manpages/pcap-savefile.5.html、リトルエンディアン）:
//   ファイルヘッダ 24 バイト
//     magic       u32  0xa1b2c3d4（時刻がマイクロ秒）/ 0xa1b23c4d（ナノ秒）
//     version     u16  2 . u16 4
//     thiszone    i32  0（時刻は UTC）
//     sigfigs     u32  0
//     snaplen     u32  記録する最大の長さ
//     linktype    u32  1（LINKTYPE_ETHERNET）
//   レコードごとに 16 バイトのヘッダ + フレーム
//     ts_sec      u32  UNIX 時刻の秒
//     ts_usec     u32  秒未満（マイクロ秒、ナノ秒版ならナノ秒）
//     incl_len    u32  ファイルに入れた長さ（snaplen を超えたら切る）
//     orig_len    u32  元の長さ

export const MAGIC_MICRO = 0xa1b2c3d4;
export const MAGIC_NANO = 0xa1b23c4d;
export const LINKTYPE_ETHERNET = 1;
export const SNAPLEN = 262144;

/**
 * @param {Array<{ts: number, frame: Uint8Array}>} records  ts は UNIX 時刻のミリ秒（小数あり）
 * @param {{nano?: boolean, snaplen?: number}} options
 * @returns {Uint8Array}
 */
export function writePcap(records, { nano = false, snaplen = SNAPLEN } = {}) {
  let size = 24;
  for (const r of records) size += 16 + Math.min(r.frame.length, snaplen);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, nano ? MAGIC_NANO : MAGIC_MICRO, true);
  v.setUint16(4, 2, true);
  v.setUint16(6, 4, true);
  v.setInt32(8, 0, true);
  v.setUint32(12, 0, true);
  v.setUint32(16, snaplen, true);
  v.setUint32(20, LINKTYPE_ETHERNET, true);
  let at = 24;
  const unit = nano ? 1e9 : 1e6;
  for (const r of records) {
    // ミリ秒（小数）を、秒と、秒未満（マイクロ秒/ナノ秒）に分ける。丸めで繰り上がったら秒に足す
    let sec = Math.floor(r.ts / 1000);
    let frac = Math.round((r.ts - sec * 1000) * (unit / 1000));
    if (frac >= unit) { sec += 1; frac -= unit; }
    const incl = Math.min(r.frame.length, snaplen);
    v.setUint32(at, sec >>> 0, true);
    v.setUint32(at + 4, frac >>> 0, true);
    v.setUint32(at + 8, incl, true);
    v.setUint32(at + 12, r.frame.length, true);
    out.set(r.frame.subarray(0, incl), at + 16);
    at += 16 + incl;
  }
  return out;
}

/** ファイル名に使う日時（ローカル時刻）: v86-link-20261030-153012.pcap */
export function pcapFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `v86-link-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.pcap`;
}

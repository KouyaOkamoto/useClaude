// ルーター VM の NIC と仮想スイッチの間で、802.1Q のタグを付け外しする（DOM にも v86 にも依存しない。Node でテストできる）。
//
// 本来の router-on-a-stick では、ルーターの Linux が eth0.10 / eth0.20 のような VLAN インターフェースを作り、
// 自分でタグを付け外しする。このおもちゃのゲスト（Buildroot・Linux 6.8）はカーネルに 8021q が無く、それができない
// （docs/step0-routing-vlan.md）。そこで、ルーターは1枚の eth0 に各サブネットのアドレス（10.5.1.1/24・10.5.2.1/24 …）を持ち、
// その eth0 とスイッチのトランクポートの間で、この VlanLink がタグを付け外しする。ルーティング・TTL の減少・ICMP・
// ip_forward は、すべてゲストの Linux が行う。
//
//   スイッチ → ルーター   タグ付きなら、タグ（1つ）を外して渡す（ゲストはタグを理解できないので）
//   ルーター → スイッチ   フレームの宛先の IP（ARP なら問い合わせ・答えの相手の IP）が、どのサブネットかで VLAN を決めて、タグを付ける。
//                         どのサブネットでもない（IPv6・ブロードキャストの 255.255.255.255 など）ときはタグを付けない（トランクのネイティブ VLAN になる）。
//                         ネイティブ VLAN のサブネットあてもタグを付けない
//
// VmNode と同じ形（on("frame") / injectFrame）なので、スイッチからは VM と同じに見える。
// map が空（または enabled が false）なら、何もせずにそのまま通す（VLAN を使わない構成）。

import { readTag, untag, tag } from './switch.js';

/** "10.5.1.0/24" → { net, mask }（数値） */
export function parseCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr));
  if (!m) throw new Error(`CIDR の書き方が違う: ${cidr}`);
  const parts = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (parts.some((x) => x > 255) || bits > 32) throw new Error(`CIDR の範囲が違う: ${cidr}`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const ip = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  return { net: (ip & mask) >>> 0, mask };
}

const ipAt = (f, at) => (f.length >= at + 4 ? ((f[at] << 24) >>> 0) + (f[at + 1] << 16) + (f[at + 2] << 8) + f[at + 3] : null);

/**
 * ルーターが送ったフレームの「相手の IP」（タグなしのフレーム）。分からなければ null
 *   IPv4: 宛先 IP / ARP（IPv4）: 問い合わせ・答えの相手（target）の IP
 */
export function peerIp(f) {
  if (!f || f.length < 14) return null;
  const type = (f[12] << 8) | f[13];
  if (type === 0x0800) return f.length >= 34 && f[14] >> 4 === 4 ? ipAt(f, 30) : null;
  if (type === 0x0806) return f.length >= 42 && f[18] === 6 && f[19] === 4 ? ipAt(f, 38) : null;
  return null;
}

export class VlanLink {
  /**
   * @param {object} inner  ルーター（VmNode）
   * @param {object} o
   *   map:     [{ cidr: "10.5.1.0/24", vlan: 10 }, ...]（サブネット → VLAN）
   *   native:  トランクのネイティブ VLAN（このサブネットあてはタグを付けない）
   */
  constructor(inner, { map = [], native = 1, enabled = true } = {}) {
    this.inner = inner;
    this.name = inner.name;
    this.enabled = enabled;
    this.native = native;
    this.setMap(map);
    this.listeners = new Set();
    this.stats = { tagged: 0, untagged: 0, stripped: 0 };
    this.unsubscribe = inner.on('frame', (f) => this.fromRouter(f));
  }

  setMap(map) {
    this.map = map.map(({ cidr, vlan }) => ({ cidr, vlan, ...parseCidr(cidr) }));
  }

  /** IP（数値）の VLAN（どのサブネットでもなければ null） */
  vlanOf(ip) {
    if (ip === null) return null;
    for (const s of this.map) if (((ip & s.mask) >>> 0) === s.net) return s.vlan;
    return null;
  }

  on(type, fn) {
    if (type !== 'frame') return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** ルーター → スイッチ */
  fromRouter(frame) {
    let out = frame;
    if (this.enabled && this.map.length && frame instanceof Uint8Array && frame.length >= 14 && !readTag(frame)) {
      const vlan = this.vlanOf(peerIp(frame));
      if (vlan !== null && vlan !== this.native) {
        out = tag(frame, vlan);
        this.stats.tagged++;
      } else {
        this.stats.untagged++;
      }
    }
    for (const fn of this.listeners) fn(out);
  }

  /** スイッチ → ルーター */
  injectFrame(frame) {
    let f = frame;
    if (this.enabled && this.map.length) {
      const t = readTag(f);
      if (t && !t.error) {
        f = untag(f);
        this.stats.stripped++;
      }
    }
    this.inner.injectFrame(f);
  }

  dispose() {
    this.unsubscribe?.();
    this.listeners.clear();
  }
}

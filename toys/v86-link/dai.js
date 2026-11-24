// 仮想スイッチの DAI（Dynamic ARP Inspection）。DOM にも v86 にも依存しない（Node でテストできる）。switch.js が使う。
//
// 本物のスイッチの DAI に寄せた（README の「DAI」）:
//   - VLAN ごとに有効 / 無効（既定は無効。無効なら、いままでと同じ動き）
//   - ポートごとに trusted / untrusted（既定は untrusted。switch.js のポートの daiTrusted。シナリオのプローブのポートは自動で trusted）
//   - バインディング表 { vlan, ip, mac }（本物では DHCP snooping が作る表。ここでは静的に書く。上限 256 件。同じ VLAN の同じ IP は 1 つ）
//   - 送り元 MAC の検査（Ethernet の送り元と ARP の sender MAC が違えば捨てる。既定 ON）
//
// 検査（switch.js の forward で、VLAN が決まったあと、MAC の学習と転送の前）:
//   DAI が有効な VLAN で、untrusted なポートから入ってきた ARP（要求・応答・Gratuitous ARP すべて）は、
//   sender IP と sender MAC の組がバインディング表にあれば通し、無ければ捨てる。
//   - sender IP が 0.0.0.0（ARP probe・DAD）は、送り元 MAC の検査だけで通す
//   - 捨てた理由: arp-inspection（表に合わない）/ arp-src-mac（送り元 MAC が違う）/ arp-malformed（ARP として読めない）
//   - ハブのときは検査しない（ハブは中身を見ない。switch.js が forward を呼ばない）
//
//   inspect(port, vlan, frame, now) → null（検査しない・通す）か { reason, sender: { ip, mac }, expectedMac }
//     frame はタグを外したフレーム（Ethernet ヘッダ 14 バイト + ARP）

export const DAI_LIMITS = { maxBindings: 256, recent: 50 };
export const DAI_REASONS = ['arp-inspection', 'arp-src-mac', 'arp-malformed'];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const macStr = (b, o) => [...b.slice(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
const ipStr = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

/** バインディングの形を確かめて、正規化した形を返す。不正なら理由つきの例外 */
export function normalizeBinding({ vlan, ip, mac } = {}) {
  const v = typeof vlan === 'string' && /^\d+$/.test(vlan.trim()) ? Number(vlan) : vlan;
  if (!Number.isInteger(v) || v < 1 || v > 4094) throw new Error(`VLAN は 1〜4094 の整数（${vlan}）`);
  const i = typeof ip === 'string' ? ip.trim() : ip;
  if (typeof i !== 'string' || !IPV4.test(i) || i === '0.0.0.0') throw new Error(`IPv4 アドレスでない（${ip}）`);
  const m = typeof mac === 'string' ? mac.trim().toLowerCase().replace(/-/g, ':') : mac;
  if (typeof m !== 'string' || !MAC.test(m)) throw new Error(`MAC アドレス（xx:xx:xx:xx:xx:xx）でない（${mac}）`);
  if (parseInt(m.slice(0, 2), 16) & 1) throw new Error(`マルチキャスト・ブロードキャストの MAC は使えない（${m}）`);
  if (m === '00:00:00:00:00:00') throw new Error('MAC が 00:00:00:00:00:00');
  return { vlan: v, ip: i, mac: m };
}

export class Dai {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.listeners = new Set();
    this.reset();
  }

  /** 設定も数も、最初の状態（全 VLAN で無効・表は空・送り元 MAC の検査 ON）に戻す */
  reset() {
    this.vlans = new Set();
    this.bindings = new Map();      // `${vlan}|${ip}` → { vlan, ip, mac }
    this.srcMacCheck = true;
    this.resetStats();
  }

  resetStats() {
    this.vlanStats = new Map();     // vlan → { inspected, dropped }
    this.portStats = new Map();     // port → { inspected, dropped }
    this.recent = [];               // 最近捨てた 50 件（新しいものが後ろ）
    this.changed();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn(this);
  }

  // ---------------------------------------------------------------- 設定

  setVlan(vlan, on) {
    if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error(`VLAN は 1〜4094 の整数（${vlan}）`);
    if (on) this.vlans.add(vlan); else this.vlans.delete(vlan);
    this.changed();
  }

  isEnabled(vlan) {
    return this.vlans.has(vlan);
  }

  setSrcMacCheck(on) {
    this.srcMacCheck = !!on;
    this.changed();
  }

  /** 表に足す（同じ VLAN・同じ IP なら MAC を置き換える）。不正な値・上限を超える → 例外（何も変えない） */
  addBinding(b) {
    const n = normalizeBinding(b);
    const key = `${n.vlan}|${n.ip}`;
    if (!this.bindings.has(key) && this.bindings.size >= DAI_LIMITS.maxBindings) throw new Error(`バインディング表は ${DAI_LIMITS.maxBindings} 件まで`);
    this.bindings.set(key, n);
    this.changed();
    return n;
  }

  removeBinding(vlan, ip) {
    const ok = this.bindings.delete(`${vlan}|${ip}`);
    if (ok) this.changed();
    return ok;
  }

  clearBindings() {
    this.bindings.clear();
    this.changed();
  }

  /** 表を置き換える（どれか 1 つでも不正なら、何も変えずに例外） */
  setBindings(list) {
    const next = new Map();
    for (const b of list) {
      const n = normalizeBinding(b);
      next.set(`${n.vlan}|${n.ip}`, n);
      if (next.size > DAI_LIMITS.maxBindings) throw new Error(`バインディング表は ${DAI_LIMITS.maxBindings} 件まで`);
    }
    this.bindings = next;
    this.changed();
  }

  listBindings() {
    return [...this.bindings.values()].sort((a, b) => a.vlan - b.vlan || ipNum(a.ip) - ipNum(b.ip));
  }

  /** 設定の写し（シナリオの初期設定・やり直し・画面） */
  config() {
    return { vlans: [...this.vlans].sort((a, b) => a - b), bindings: this.listBindings(), srcMacCheck: this.srcMacCheck };
  }

  /** 設定を置き換える（不正なら何も変えずに例外）。数は消す */
  applyConfig({ vlans = [], bindings = [], srcMacCheck = true } = {}) {
    for (const v of vlans) if (!Number.isInteger(v) || v < 1 || v > 4094) throw new Error(`VLAN は 1〜4094 の整数（${v}）`);
    this.setBindings(bindings);   // 不正ならここで例外（まだ何も変えていない）
    this.vlans = new Set(vlans);
    this.srcMacCheck = !!srcMacCheck;
    this.resetStats();
  }

  // ---------------------------------------------------------------- 検査

  /**
   * port: switch.js のポート（id・daiTrusted）/ vlan: スイッチの中の VLAN / frame: タグを外したフレーム
   * 戻り値: null（検査しない・通す）か、捨てる理由
   */
  inspect(port, vlan, frame, now = this.clock()) {
    if (!this.vlans.has(vlan) || port.daiTrusted) return null;
    if (frame.length < 14 || frame[12] !== 0x08 || frame[13] !== 0x06) return null;   // ARP 以外は見ない
    const st = this.count(vlan, port.id);
    st.v.inspected++; st.p.inspected++;
    let verdict = null;
    if (frame.length < 42 || frame[14] !== 0 || frame[15] !== 1 || frame[16] !== 8 || frame[17] !== 0 || frame[18] !== 6 || frame[19] !== 4) {
      verdict = { reason: 'arp-malformed', sender: null, expectedMac: null };
    } else {
      const sender = { mac: macStr(frame, 22), ip: ipStr(frame, 28) };
      if (this.srcMacCheck && macStr(frame, 6) !== sender.mac) {
        verdict = { reason: 'arp-src-mac', sender, expectedMac: macStr(frame, 6) };
      } else if (sender.ip !== '0.0.0.0') {
        const b = this.bindings.get(`${vlan}|${sender.ip}`);
        if (!b || b.mac !== sender.mac) verdict = { reason: 'arp-inspection', sender, expectedMac: b?.mac ?? null };
      }
    }
    if (!verdict) return null;
    st.v.dropped++; st.p.dropped++;
    this.recent.push({ ts: now, port: port.id, vlan, ip: verdict.sender?.ip ?? null, mac: verdict.sender?.mac ?? null, reason: verdict.reason, expectedMac: verdict.expectedMac });
    if (this.recent.length > DAI_LIMITS.recent) this.recent.splice(0, this.recent.length - DAI_LIMITS.recent);
    return verdict;
  }

  count(vlan, port) {
    let v = this.vlanStats.get(vlan);
    if (!v) this.vlanStats.set(vlan, (v = { inspected: 0, dropped: 0 }));
    let p = this.portStats.get(port);
    if (!p) this.portStats.set(port, (p = { inspected: 0, dropped: 0 }));
    return { v, p };
  }

  stats() {
    return {
      vlans: Object.fromEntries([...this.vlanStats].sort((a, b) => a[0] - b[0])),
      ports: Object.fromEntries([...this.portStats].sort((a, b) => a[0] - b[0])),
      recent: this.recent.slice(),
    };
  }
}

const ipNum = (ip) => ip.split('.').reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0);

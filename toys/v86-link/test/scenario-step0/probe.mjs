// ステップ0の試作: JS のプローブノード（仮想スイッチのポートにつなぐ。ゲストは操作しない）
// VmNode と同じ形（on('frame') / injectFrame）なので、VirtualSwitch.addPort にそのまま渡せる。
// 例外を外に出さず、すべてタイムアウトで終わる。

const ipToBytes = (ip) => ip.split('.').map(Number);
const bytesToIp = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const macToBytes = (mac) => mac.split(':').map((x) => parseInt(x, 16));
const macStr = (b, o) => [...b.slice(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
const ipNum = (ip) => ipToBytes(ip).reduce((a, x) => (a << 8 | x) >>> 0, 0);
const sameNet = (a, b, prefix) => prefix === 0 || (ipNum(a) >>> (32 - prefix)) === (ipNum(b) >>> (32 - prefix));

function csum(buf, start, end, init = 0) {
  let s = init;
  for (let i = start; i < end; i += 2) s += (buf[i] << 8) | (i + 1 < end ? buf[i + 1] : 0);
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (~s) & 0xffff;
}

export class Probe {
  /** @param {{mac:string, ip:string, prefix:number, gateway?:string}} cfg */
  constructor(cfg, { now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.mac = macToBytes(cfg.mac);
    this.now = now;
    this.listeners = new Map();
    this.arp = new Map();          // ip → mac bytes
    this.waiters = new Set();      // (frameInfo) => boolean（true で外す）
    this.ipId = 1;
    this.sent = 0; this.received = 0; this.errors = 0;
  }
  on(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); return () => this.listeners.get(type).delete(fn); }
  send(frame) { this.sent++; for (const fn of this.listeners.get('frame') ?? []) fn(frame); }

  // ---------------------------------------------------------------- 受信（スイッチから）
  injectFrame(frame) {
    try {
      this.received++;
      const f = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
      if (f.length < 14) return;
      const dst = macStr(f, 0);
      const mine = dst === this.cfg.mac || dst === 'ff:ff:ff:ff:ff:ff';
      if (!mine) return;
      const type = (f[12] << 8) | f[13];
      let info = null;
      if (type === 0x0806 && f.length >= 42) info = this.onArp(f);
      else if (type === 0x0800 && f.length >= 34) info = this.onIp(f);
      if (info) for (const w of [...this.waiters]) if (w(info)) this.waiters.delete(w);
    } catch (e) {
      this.errors++;   // 不正なフレームで例外を外に出さない
    }
  }
  onArp(f) {
    const op = (f[20] << 8) | f[21];
    const spa = bytesToIp(f, 28), tpa = bytesToIp(f, 38);
    this.arp.set(spa, f.slice(22, 28));
    if (op === 1 && tpa === this.cfg.ip) this.send(this.arpFrame(2, f.slice(22, 28), spa));
    return { kind: 'arp', op, spa, tpa };
  }
  onIp(f) {
    const ihl = (f[14] & 0x0f) * 4;
    if (f[14] >> 4 !== 4 || ihl < 20 || f.length < 14 + ihl) return null;
    const proto = f[23], src = bytesToIp(f, 26), dst = bytesToIp(f, 30), ttl = f[22];
    const totalLen = (f[16] << 8) | f[17];
    const end = Math.min(f.length, 14 + totalLen);
    if (dst !== this.cfg.ip) return null;
    const p = 14 + ihl;
    if (proto === 1 && end - p >= 8) {
      const t = f[p], code = f[p + 1], id = (f[p + 4] << 8) | f[p + 5], seq = (f[p + 6] << 8) | f[p + 7];
      // 自分あての echo request には答える（「外のホスト」として ping に応える）
      if (t === 8) this.sendIp(src, 1, (() => { const b = f.slice(p, end); b[0] = 0; b[2] = b[3] = 0; const c = csum(b, 0, b.length); b[2] = c >> 8; b[3] = c & 0xff; return b; })());
      // ICMP エラー（time exceeded・unreachable）は、元のパケットのヘッダを返す
      const orig = (t === 11 || t === 3) && end - p >= 8 + 20 ? { proto: f[p + 8 + 9], dst: bytesToIp(f, p + 8 + 16) } : null;
      return { kind: 'icmp', type: t, code, id, seq, src, ttl, orig };
    }
    if (proto === 6 && end - p >= 20) {
      const sport = (f[p] << 8) | f[p + 1], dport = (f[p + 2] << 8) | f[p + 3];
      const seq = ((f[p + 4] << 24) | (f[p + 5] << 16) | (f[p + 6] << 8) | f[p + 7]) >>> 0;
      const ack = ((f[p + 8] << 24) | (f[p + 9] << 16) | (f[p + 10] << 8) | f[p + 11]) >>> 0;
      const off = (f[p + 12] >> 4) * 4, flags = f[p + 13];
      return { kind: 'tcp', src, sport, dport, seq, ack, flags, ttl, data: f.slice(p + off, end) };
    }
    return null;
  }

  // ---------------------------------------------------------------- 送信
  arpFrame(op, tha, tpa) {
    const f = new Uint8Array(42);
    f.set(op === 1 ? [255, 255, 255, 255, 255, 255] : tha, 0); f.set(this.mac, 6); f[12] = 8; f[13] = 6;
    f.set([0, 1, 8, 0, 6, 4, 0, op], 14); f.set(this.mac, 22); f.set(ipToBytes(this.cfg.ip), 28);
    f.set(op === 1 ? [0, 0, 0, 0, 0, 0] : tha, 32); f.set(ipToBytes(tpa), 38);
    return f;
  }
  nextHop(dst) { return sameNet(dst, this.cfg.ip, this.cfg.prefix) || !this.cfg.gateway ? dst : this.cfg.gateway; }
  async resolve(ip, timeoutMs = 1500) {
    if (this.arp.has(ip)) return this.arp.get(ip);
    for (let i = 0; i < 3; i++) {
      this.send(this.arpFrame(1, null, ip));
      const r = await this.wait((x) => x.kind === 'arp' && x.spa === ip, timeoutMs / 3);
      if (r) return this.arp.get(ip);
    }
    return null;
  }
  ipPacket(dst, proto, payload, ttl = 64) {
    const ip = new Uint8Array(20 + payload.length);
    ip.set([0x45, 0, (ip.length >> 8) & 0xff, ip.length & 0xff, (this.ipId >> 8) & 0xff, this.ipId++ & 0xff, 0x40, 0, ttl, proto, 0, 0]);
    ip.set(ipToBytes(this.cfg.ip), 12); ip.set(ipToBytes(dst), 16);
    const c = csum(ip, 0, 20); ip[10] = c >> 8; ip[11] = c & 0xff;
    ip.set(payload, 20);
    return ip;
  }
  async sendIp(dst, proto, payload, ttl) {
    const mac = await this.resolve(this.nextHop(dst));
    if (!mac) return false;
    const ip = this.ipPacket(dst, proto, payload, ttl);
    const f = new Uint8Array(14 + ip.length);
    f.set(mac, 0); f.set(this.mac, 6); f[12] = 8; f[13] = 0; f.set(ip, 14);
    this.send(f);
    return true;
  }
  wait(pred, ms) {
    return new Promise((resolve) => {
      let done = false;
      const w = (x) => { if (done || !pred(x)) return false; done = true; clearTimeout(t); resolve(x); return true; };
      const t = setTimeout(() => { done = true; this.waiters.delete(w); resolve(null); }, ms);
      this.waiters.add(w);
    });
  }

  // ---------------------------------------------------------------- 検査
  /** ICMP echo。{ ok, rttMs, ttl } か { ok:false, reason } */
  async ping(dst, { timeoutMs = 2000, ttl = 64 } = {}) {
    const id = 0x5000 + (Math.random() * 0x0fff | 0), seq = 1;
    const icmp = new Uint8Array(8 + 32);
    icmp.set([8, 0, 0, 0, id >> 8, id & 0xff, 0, seq]);
    for (let i = 8; i < icmp.length; i++) icmp[i] = i;
    const c = csum(icmp, 0, icmp.length); icmp[2] = c >> 8; icmp[3] = c & 0xff;
    const t0 = this.now();
    if (!(await this.sendIp(dst, 1, icmp, ttl))) return { ok: false, reason: 'arp-failed' };
    const r = await this.wait((x) => x.kind === 'icmp' && ((x.type === 0 && x.id === id) || ((x.type === 11 || x.type === 3) && x.orig?.dst === dst)), timeoutMs);
    if (!r) return { ok: false, reason: 'timeout' };
    if (r.type === 0) return { ok: true, rttMs: this.now() - t0, ttl: r.ttl };
    return { ok: false, reason: r.type === 11 ? 'ttl-exceeded' : 'unreachable', from: r.src, code: r.code };
  }

  tcpSeg(dst, sport, dport, seq, ack, flags, data = new Uint8Array(0)) {
    const t = new Uint8Array(20 + data.length);
    t.set([sport >> 8, sport & 0xff, dport >> 8, dport & 0xff]);
    t.set([seq >>> 24, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff, ack >>> 24, (ack >>> 16) & 0xff, (ack >>> 8) & 0xff, ack & 0xff], 4);
    t[12] = 0x50; t[13] = flags; t[14] = 0xff; t[15] = 0xff;
    t.set(data, 20);
    // 疑似ヘッダ
    const ph = new Uint8Array(12 + t.length);
    ph.set(ipToBytes(this.cfg.ip), 0); ph.set(ipToBytes(dst), 4); ph[9] = 6; ph[10] = t.length >> 8; ph[11] = t.length & 0xff; ph.set(t, 12);
    const c = csum(ph, 0, ph.length); t[16] = c >> 8; t[17] = c & 0xff;
    return t;
  }

  /** TCP の接続の可否。SYN → SYN-ACK なら open（すぐ RST で閉じる）、RST なら closed、無応答なら filtered */
  async tcpConnect(dst, dport, { timeoutMs = 2000 } = {}) {
    const sport = 40000 + (Math.random() * 20000 | 0), isn = (Math.random() * 0xffffffff) >>> 0;
    if (!(await this.sendIp(dst, 6, this.tcpSeg(dst, sport, dport, isn, 0, 0x02)))) return { state: 'arp-failed' };
    const r = await this.wait((x) => (x.kind === 'tcp' && x.src === dst && x.sport === dport && x.dport === sport) ||
      (x.kind === 'icmp' && (x.type === 3 || x.type === 11) && x.orig?.dst === dst), timeoutMs);
    if (!r) return { state: 'filtered' };
    if (r.kind === 'icmp') return { state: 'unreachable', type: r.type, code: r.code, from: r.src };
    if ((r.flags & 0x12) === 0x12) {
      await this.sendIp(dst, 6, this.tcpSeg(dst, sport, dport, isn + 1, (r.seq + 1) >>> 0, 0x04));   // RST（残骸を残さない）
      return { state: 'open', ttl: r.ttl };
    }
    if (r.flags & 0x04) return { state: 'closed' };
    return { state: 'unexpected', flags: r.flags };
  }

  /** HTTP/1.0 の GET。{ ok, status, body } */
  async httpGet(dst, port, path = '/', { timeoutMs = 4000, host = dst, maxBytes = 65536 } = {}) {
    const sport = 40000 + (Math.random() * 20000 | 0), isn = (Math.random() * 0xffffffff) >>> 0;
    const deadline = this.now() + timeoutMs;
    const left = () => Math.max(1, deadline - this.now());
    if (!(await this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, isn, 0, 0x02)))) return { ok: false, reason: 'arp-failed' };
    const match = (x) => x.kind === 'tcp' && x.src === dst && x.sport === port && x.dport === sport;
    const syn = await this.wait(match, left());
    if (!syn) return { ok: false, reason: 'timeout-connect' };
    if (!((syn.flags & 0x12) === 0x12)) return { ok: false, reason: syn.flags & 4 ? 'refused' : 'unexpected' };
    let snd = isn + 1, rcv = (syn.seq + 1) >>> 0;
    const req = new TextEncoder().encode(`GET ${path} HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    // 受け取りは順番どおりに来たものだけ受ける（ずれたら ACK をし直す。試作なので再送はしない）
    const chunks = []; let got = 0, fin = false;
    const done = new Promise((resolve) => {
      const w = (x) => {
        if (!match(x)) return false;
        if (x.flags & 0x04) { fin = true; resolve(); return true; }
        if (x.seq === rcv && x.data.length) { chunks.push(x.data); got += x.data.length; rcv = (rcv + x.data.length) >>> 0; }
        if (x.flags & 0x01 && x.seq + x.data.length === rcv) { rcv = (rcv + 1) >>> 0; fin = true; }
        this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, snd, rcv, 0x10));   // ACK
        if (fin || got > maxBytes) { resolve(); return true; }
        return false;
      };
      this.waiters.add(w);
      setTimeout(() => { this.waiters.delete(w); resolve(); }, left());
    });
    await this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, snd, rcv, 0x18, req));   // PSH,ACK
    snd = (snd + req.length) >>> 0;
    await done;
    // 閉じる: 相手が FIN を送っていれば FIN,ACK、そうでなければ RST（どちらでも相手に残骸を残さない）
    await this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, snd, rcv, fin ? 0x11 : 0x14));
    const text = new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])));
    const m = /^HTTP\/\d\.\d (\d{3})/.exec(text);
    if (!m) return { ok: false, reason: fin ? 'bad-response' : 'timeout-response', bytes: got };
    return { ok: true, status: Number(m[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4), bytes: got };
  }
}

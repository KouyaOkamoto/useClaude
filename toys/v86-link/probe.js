// シナリオの検査用の JS のプローブ。仮想スイッチのポートにつなぐ、学習者に見えないノード（ゲストを操作しない）。
// DOM にも v86 にも依存しない（Node でテストできる。時計・乱数・タイマーは差し替えられる）。
//
// VmNode と同じ形（on('frame') / injectFrame）なので、VirtualSwitch.addPort にそのまま渡せる。
//   ping(dst)                 ICMP echo。{ ok, rttMs, ttl } / { ok: false, reason: timeout | arp-failed | ttl-exceeded | unreachable }
//   tcpConnect(dst, port)     SYN を送る。SYN-ACK なら open（すぐ RST で閉じる）・RST なら closed・無応答なら filtered
//   httpGet(dst, port, path)  HTTP/1.0 の GET。{ ok, status, body } / { ok: false, reason }。終わったら FIN（か RST）で閉じる
// 自分の IP への ARP の問い合わせと、ICMP echo request には答える（「外のホスト」としてふるまう）。
//
// IPv4 だけ。TCP は検査に要る最小限（再送は SYN だけ。順番どおりに来たデータだけ受け取る）。
// 不正なフレーム・想定外の応答では例外を投げない（数えて無視する）。どの操作もタイムアウトで終わる。
// ステップ0の試作（test/scenario-step0/probe.mjs）を元にしている。docs/scenario-step0.md

const ipToBytes = (ip) => ip.split('.').map(Number);
const bytesToIp = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const macToBytes = (mac) => mac.split(':').map((x) => parseInt(x, 16));
const macStr = (b, o) => [...b.slice(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
const ipNum = (ip) => ipToBytes(ip).reduce((a, x) => ((a << 8) | x) >>> 0, 0);
const sameNet = (a, b, prefix) => prefix === 0 || (ipNum(a) >>> (32 - prefix)) === (ipNum(b) >>> (32 - prefix));

export function checksum(buf, start = 0, end = buf.length) {
  let s = 0;
  for (let i = start; i < end; i += 2) s += (buf[i] << 8) | (i + 1 < end ? buf[i + 1] : 0);
  while (s >> 16) s = (s & 0xffff) + (s >> 16);
  return (~s) & 0xffff;
}

export class Probe {
  /**
   * @param {{ name?: string, mac: string, ip: string, prefix: number, gateway?: string }} cfg
   * @param {{ now?: () => number, random?: () => number, setTimer?: Function, clearTimer?: Function }} env
   */
  constructor(cfg, env = {}) {
    this.cfg = cfg;
    this.name = cfg.name ?? 'probe';
    this.mac = macToBytes(cfg.mac);
    this.now = env.now ?? (() => Date.now());
    this.random = env.random ?? Math.random;
    this.setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = env.clearTimer ?? ((t) => clearTimeout(t));
    this.listeners = new Map();
    this.arp = new Map();          // ip → MAC（バイト列）
    this.waiters = new Set();      // (受け取ったものの説明) => true で外す
    this.timers = new Set();
    this.ipId = 1;
    this.stats = { sent: 0, received: 0, ignored: 0 };
    this.disposed = false;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  send(frame) {
    if (this.disposed) return;
    this.stats.sent++;
    for (const fn of this.listeners.get('frame') ?? []) fn(frame);
  }

  /** 待っているものを全部終わらせる（検査の途中でやり直したとき）。以後は何も送らない */
  dispose() {
    this.disposed = true;
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    for (const w of [...this.waiters]) w(null);
    this.waiters.clear();
  }

  // ---------------------------------------------------------------- 受け取り（スイッチから）

  injectFrame(frame) {
    try {
      this.stats.received++;
      const f = frame instanceof Uint8Array ? frame : new Uint8Array(frame ?? []);
      if (f.length < 14) return this.ignore();
      const dst = macStr(f, 0);
      if (dst !== this.cfg.mac && dst !== 'ff:ff:ff:ff:ff:ff') return;
      const type = (f[12] << 8) | f[13];
      let info = null;
      if (type === 0x0806) info = this.onArp(f);
      else if (type === 0x0800) info = this.onIp(f);
      if (!info) return;
      for (const w of [...this.waiters]) if (w(info)) this.waiters.delete(w);
    } catch {
      this.ignore();   // 不正なフレームで例外を外に出さない
    }
  }

  ignore() { this.stats.ignored++; }

  onArp(f) {
    if (f.length < 42) return this.ignore();
    const op = (f[20] << 8) | f[21];
    const spa = bytesToIp(f, 28), tpa = bytesToIp(f, 38);
    if (f[14] !== 0 || f[15] !== 1 || f[16] !== 8 || f[17] !== 0 || f[18] !== 6 || f[19] !== 4) return this.ignore();
    this.arp.set(spa, f.slice(22, 28));
    if (op === 1 && tpa === this.cfg.ip) this.send(this.arpFrame(2, f.slice(22, 28), spa));
    return { kind: 'arp', op, spa, tpa };
  }

  onIp(f) {
    if (f.length < 34) return this.ignore();
    const ihl = (f[14] & 0x0f) * 4;
    if (f[14] >> 4 !== 4 || ihl < 20 || f.length < 14 + ihl) return this.ignore();
    const proto = f[23], src = bytesToIp(f, 26), dst = bytesToIp(f, 30), ttl = f[22];
    const totalLen = (f[16] << 8) | f[17];
    const end = Math.min(f.length, 14 + totalLen);
    if (dst !== this.cfg.ip) return null;
    const p = 14 + ihl;
    if (proto === 1 && end - p >= 8) {
      const t = f[p], code = f[p + 1], id = (f[p + 4] << 8) | f[p + 5];
      if (t === 8) {
        // 自分あての echo request には答える（「外のホスト」として ping に応える）
        const reply = f.slice(p, end);
        reply[0] = 0; reply[2] = reply[3] = 0;
        const c = checksum(reply); reply[2] = c >> 8; reply[3] = c & 0xff;
        this.sendIp(src, 1, reply);
      }
      // ICMP のエラー（time exceeded・unreachable）は、元のパケットの宛先を見る
      const orig = (t === 11 || t === 3) && end - p >= 8 + 20 ? { dst: bytesToIp(f, p + 8 + 16) } : null;
      return { kind: 'icmp', type: t, code, id, src, ttl, orig };
    }
    if (proto === 6 && end - p >= 20) {
      const sport = (f[p] << 8) | f[p + 1], dport = (f[p + 2] << 8) | f[p + 3];
      const seq = ((f[p + 4] << 24) | (f[p + 5] << 16) | (f[p + 6] << 8) | f[p + 7]) >>> 0;
      const off = (f[p + 12] >> 4) * 4, flags = f[p + 13];
      if (off < 20 || p + off > end) return this.ignore();
      return { kind: 'tcp', src, sport, dport, seq, flags, ttl, data: f.slice(p + off, end) };
    }
    return null;
  }

  // ---------------------------------------------------------------- 送る

  arpFrame(op, tha, tpa) {
    const f = new Uint8Array(42);
    f.set(op === 1 ? [255, 255, 255, 255, 255, 255] : tha, 0);
    f.set(this.mac, 6);
    f[12] = 8; f[13] = 6;
    f.set([0, 1, 8, 0, 6, 4, 0, op], 14);
    f.set(this.mac, 22);
    f.set(ipToBytes(this.cfg.ip), 28);
    f.set(op === 1 ? [0, 0, 0, 0, 0, 0] : tha, 32);
    f.set(ipToBytes(tpa), 38);
    return f;
  }

  nextHop(dst) {
    return sameNet(dst, this.cfg.ip, this.cfg.prefix) || !this.cfg.gateway ? dst : this.cfg.gateway;
  }

  async resolve(ip, timeoutMs = 1500) {
    if (this.arp.has(ip)) return this.arp.get(ip);
    for (let i = 0; i < 3 && !this.disposed; i++) {
      // 待ちを先に登録してから送る（スイッチは同期的に届けることがあり、送ったとたんに返事が来る）
      const reply = this.wait((x) => x.kind === 'arp' && x.spa === ip, timeoutMs / 3);
      this.send(this.arpFrame(1, null, ip));
      if (await reply || this.arp.has(ip)) return this.arp.get(ip);
    }
    return null;
  }

  ipPacket(dst, proto, payload, ttl = 64) {
    const ip = new Uint8Array(20 + payload.length);
    ip.set([0x45, 0, (ip.length >> 8) & 0xff, ip.length & 0xff, (this.ipId >> 8) & 0xff, this.ipId & 0xff, 0x40, 0, ttl, proto, 0, 0]);
    this.ipId = (this.ipId + 1) & 0xffff;
    ip.set(ipToBytes(this.cfg.ip), 12);
    ip.set(ipToBytes(dst), 16);
    const c = checksum(ip, 0, 20); ip[10] = c >> 8; ip[11] = c & 0xff;
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

  /** pred に合うものが来るまで待つ（来なければ ms で null） */
  wait(pred, ms) {
    return new Promise((resolve) => {
      if (this.disposed) return resolve(null);
      let done = false;
      const finish = (x) => { done = true; this.clearTimer(t); this.timers.delete(t); resolve(x); };
      const w = (x) => {
        if (done) return true;
        if (x === null) { finish(null); return true; }   // dispose
        if (!pred(x)) return false;
        finish(x);
        return true;
      };
      const t = this.setTimer(() => { if (!done) { done = true; this.waiters.delete(w); this.timers.delete(t); resolve(null); } }, ms);
      this.timers.add(t);
      this.waiters.add(w);
    });
  }

  // ---------------------------------------------------------------- 検査

  async ping(dst, { timeoutMs = 3000, ttl = 64 } = {}) {
    const deadline = this.now() + timeoutMs;
    const left = () => Math.max(1, deadline - this.now());
    const id = 0x5000 + Math.floor(this.random() * 0x0fff);
    let last = { ok: false, reason: 'timeout' };
    for (let seq = 1; seq <= 2 && this.now() < deadline; seq++) {
      const icmp = new Uint8Array(8 + 32);
      icmp.set([8, 0, 0, 0, id >> 8, id & 0xff, 0, seq]);
      for (let i = 8; i < icmp.length; i++) icmp[i] = i;
      const c = checksum(icmp); icmp[2] = c >> 8; icmp[3] = c & 0xff;
      const t0 = this.now();
      // 次のホップの MAC を先に引いてから、待ちを登録して送る（返事を取りこぼさない）
      if (!(await this.resolve(this.nextHop(dst)))) return { ok: false, reason: 'arp-failed' };
      const reply = this.wait((x) => x.kind === 'icmp' && ((x.type === 0 && x.id === id && x.src === dst) || ((x.type === 11 || x.type === 3) && x.orig?.dst === dst)), Math.min(left(), timeoutMs / 2));
      await this.sendIp(dst, 1, icmp, ttl);
      const r = await reply;
      if (!r) continue;
      if (r.type === 0) return { ok: true, rttMs: this.now() - t0, ttl: r.ttl };
      last = { ok: false, reason: r.type === 11 ? 'ttl-exceeded' : 'unreachable', from: r.src, code: r.code };
      break;
    }
    return last;
  }

  tcpSeg(dst, sport, dport, seq, ack, flags, data = new Uint8Array(0)) {
    const t = new Uint8Array(20 + data.length);
    t.set([sport >> 8, sport & 0xff, dport >> 8, dport & 0xff]);
    t.set([seq >>> 24, (seq >>> 16) & 0xff, (seq >>> 8) & 0xff, seq & 0xff, ack >>> 24, (ack >>> 16) & 0xff, (ack >>> 8) & 0xff, ack & 0xff], 4);
    t[12] = 0x50; t[13] = flags; t[14] = 0x20; t[15] = 0x00;   // 窓 8192
    t.set(data, 20);
    const ph = new Uint8Array(12 + t.length);   // 疑似ヘッダ
    ph.set(ipToBytes(this.cfg.ip), 0); ph.set(ipToBytes(dst), 4); ph[9] = 6; ph[10] = t.length >> 8; ph[11] = t.length & 0xff; ph.set(t, 12);
    const c = checksum(ph); t[16] = c >> 8; t[17] = c & 0xff;
    return t;
  }

  newPort() { return 40000 + Math.floor(this.random() * 20000); }

  /** SYN を送って、SYN-ACK か RST か ICMP のエラーを待つ（SYN は1回だけ再送する） */
  async syn(dst, dport, sport, isn, timeoutMs) {
    const match = (x) => (x.kind === 'tcp' && x.src === dst && x.sport === dport && x.dport === sport) ||
      (x.kind === 'icmp' && (x.type === 3 || x.type === 11) && x.orig?.dst === dst);
    if (!(await this.resolve(this.nextHop(dst)))) return { arpFailed: true };
    for (let i = 0; i < 2; i++) {
      const reply = this.wait(match, timeoutMs / 2);
      await this.sendIp(dst, 6, this.tcpSeg(dst, sport, dport, isn, 0, 0x02));
      const r = await reply;
      if (r) return r;
    }
    return null;
  }

  async tcpConnect(dst, dport, { timeoutMs = 3000 } = {}) {
    const sport = this.newPort(), isn = Math.floor(this.random() * 0xffffffff) >>> 0;
    const r = await this.syn(dst, dport, sport, isn, timeoutMs);
    if (!r) return { state: 'filtered' };
    if (r.arpFailed) return { state: 'arp-failed' };
    if (r.kind === 'icmp') return { state: 'unreachable', from: r.src };
    if ((r.flags & 0x12) === 0x12) {
      // 開いている。接続は作らずに RST で閉じる（相手に残骸を残さない）
      await this.sendIp(dst, 6, this.tcpSeg(dst, sport, dport, (isn + 1) >>> 0, (r.seq + 1) >>> 0, 0x04));
      return { state: 'open', ttl: r.ttl };
    }
    if (r.flags & 0x04) return { state: 'closed' };
    return { state: 'filtered' };
  }

  async httpGet(dst, port, path = '/', { timeoutMs = 6000, maxBytes = 65536 } = {}) {
    const deadline = this.now() + timeoutMs;
    const left = () => Math.max(1, deadline - this.now());
    const sport = this.newPort(), isn = Math.floor(this.random() * 0xffffffff) >>> 0;
    const r = await this.syn(dst, port, sport, isn, Math.min(left(), 3000));
    if (!r) return { ok: false, reason: 'timeout-connect' };
    if (r.arpFailed) return { ok: false, reason: 'arp-failed' };
    if (r.kind === 'icmp') return { ok: false, reason: 'unreachable' };
    if ((r.flags & 0x12) !== 0x12) return { ok: false, reason: r.flags & 0x04 ? 'refused' : 'bad-response' };
    let snd = (isn + 1) >>> 0, rcv = (r.seq + 1) >>> 0;
    const chunks = [];
    let got = 0, fin = false, reset = false;
    const match = (x) => x.kind === 'tcp' && x.src === dst && x.sport === port && x.dport === sport;
    const done = this.wait((x) => {
      if (!match(x)) return false;
      if (x.flags & 0x04) { reset = true; return true; }
      if (x.seq === rcv && x.data.length) { chunks.push(x.data); got += x.data.length; rcv = (rcv + x.data.length) >>> 0; }
      if (x.flags & 0x01 && ((x.seq + x.data.length) >>> 0) === rcv) { rcv = (rcv + 1) >>> 0; fin = true; }
      this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, snd, rcv, 0x10));   // ACK
      return fin || got > maxBytes;
    }, left());
    const req = new TextEncoder().encode(`GET ${path} HTTP/1.0\r\nHost: ${dst}\r\nConnection: close\r\n\r\n`);
    await this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, snd, rcv, 0x18, req));   // PSH,ACK
    snd = (snd + req.length) >>> 0;
    await done;
    // 閉じる: 相手が FIN を送っていれば FIN,ACK、そうでなければ RST（どちらでも相手に接続を残さない）
    if (!reset) await this.sendIp(dst, 6, this.tcpSeg(dst, sport, port, snd, rcv, fin ? 0x11 : 0x14));
    const bytes = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { bytes.set(c.subarray(0, Math.min(c.length, got - at)), at); at += c.length; }
    const text = new TextDecoder().decode(bytes);
    const m = /^HTTP\/\d\.\d (\d{3})/.exec(text);
    if (!m) return { ok: false, reason: fin || reset ? 'bad-response' : 'timeout-response' };
    const head = text.indexOf('\r\n\r\n');
    return { ok: true, status: Number(m[1]), body: head >= 0 ? text.slice(head + 4) : '' };
  }
}

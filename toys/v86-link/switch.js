// 仮想スイッチ（ハブ / L2 スイッチ）: VmNode が送った Ethernet フレームを、ほかの VmNode に届ける。
// DOM にも v86 にも依存しない純粋なモジュール（Node でテストできる。時計・乱数・タイマーは差し替えられる）。
//
//   ポート     VM を1台つなぐ口。番号は 0 から、空いている小さい番号を使う（VM を外すと空く）。
//              ポートごとに「ケーブル（リンク）」「遅延」「損失率」を持つ。
//   ハブ       入ってきたポート以外の、全ポートに届ける（MAC アドレスは覚えない）。
//   スイッチ   送り元の MAC アドレスを覚える（MAC アドレステーブル）。宛先が分かればそのポートだけに、
//              分からない・ブロードキャスト・マルチキャストなら、入ってきたポート以外の全ポートに届ける（フラッディング）。
//              宛先が入ってきたのと同じポートなら、どこにも届けない（filtered）。
//
// MAC アドレステーブル（VLAN ごと）
//   エージング   最後に見てから agingMs（既定 300 秒）たったエントリは消す。
//   上限         VLAN ごとに maxEntriesPerVlan（既定 1024）、全体で maxEntries（既定 2048）。
//                いっぱいのときは「新しい MAC は覚えない」（覚えているものの更新は続ける）。
//                覚えられなかった宛先へのフレームはフラッディングになる。本物のスイッチの CAM テーブルが
//                あふれたときと同じで、MAC フラッディング攻撃（偽の送り元 MAC を大量に送る）で盗聴できるようになる理由。
//   モード切替   ハブ ⇔ スイッチを切り替えると、テーブルは空にする（ハブは使わない。スイッチに戻したら学習を最初から見せる）。
//   ポートを外す・ケーブルを抜く   そのポートで覚えた MAC は消す。
//
// 遅延と損失はケーブル（ポート）の性質で、フレームは送り元のケーブルと届け先のケーブルを通る。
//   遅延 = 送り元のポートの遅延 + 届け先のポートの遅延
//   損失 = 送り元のポートで1回（捨てたらどこにも届かない）、届け先のポートごとに1回
//
// VLAN（IEEE 802.1Q。スイッチのときだけ。ハブは VLAN を見ずにそのまま全ポートへ届ける）
//   ポートごとに vlan = { mode, access, allowed, native }。既定はアクセス VLAN 1（以前の版と同じ動き）。
//   アクセスポート   タグなしで受け、access の VLAN のフレームとして扱う。送るときもタグなし。
//                    タグ付きで来たフレームは捨てる（vlan-tagged-access）。ただし VLAN ID 0（優先度だけのタグ）は、タグなしと同じに扱う。
//   トランクポート   タグ付きで受け、そのタグの VLAN として扱う（allowed に無ければ捨てる: vlan-not-allowed）。
//                    タグなしは native の VLAN。送るときは、native の VLAN はタグなし、それ以外はタグを付ける（優先度は受けたときのものを保つ）。
//   転送は、同じ VLAN に属するポート（アクセス VLAN が同じ・トランクで許可されている）だけ。VLAN をまたぐには、ルーターを通る。
//   捨てるもの: タグが途中で切れている（vlan-malformed）/ VLAN ID 4095（vlan-invalid）/ 802.1Q 以外のタグ（0x88a8・0x9100。vlan-unsupported）/
//               二重タグ（double-tag。VLAN ホッピングの入口になるので、受けない）。
//   MAC アドレステーブルは VLAN ごと（同じ MAC が別の VLAN にあっても混ざらない）。上限は VLAN ごと（既定 1024）と全体（既定 2048）。
//
// 外へ出す口（アップリンク）は持たない。つないだ VmNode の間でだけフレームをやりとりする。
// 壊れたフレーム（Ethernet ヘッダより短い・バイト列でない）でも例外は投げない（どこにも届けず、記録だけする）。
//
// 処理したフレームは onFrame で知らせる（キャプチャ・モニタ・トポロジー図はそこから）。

const GROUP = 0x01;   // 宛先 MAC の先頭オクテットの最下位ビット（ブロードキャスト・マルチキャスト）

export const DEFAULTS = { mode: 'switch', agingMs: 300_000, maxEntries: 2048, maxEntriesPerVlan: 1024, maxPorts: 64 };

const TPID = 0x8100;                        // 802.1Q のタグ
const OTHER_TPIDS = new Set([0x88a8, 0x9100]);   // 802.1ad（Q-in-Q）など。受けない
export const DEFAULT_VLAN = 1;
/** ポートの VLAN 設定の既定（アクセス VLAN 1） */
export const defaultVlanConfig = () => ({ mode: 'access', access: DEFAULT_VLAN, allowed: null, native: DEFAULT_VLAN });

const validVid = (v) => Number.isInteger(v) && v >= 1 && v <= 4094;

/**
 * ポートの VLAN 設定を確かめて、正しい形にする（不正なら例外。画面からの入力に使う）
 *   mode: "access" / "trunk"、access / native: 1〜4094、allowed: VLAN ID の配列（null なら全部）
 */
export function normalizeVlanConfig({ mode = 'access', access = DEFAULT_VLAN, allowed = null, native = DEFAULT_VLAN } = {}) {
  if (mode !== 'access' && mode !== 'trunk') throw new Error('mode は access か trunk');
  access = Number(access);
  native = Number(native);
  if (!validVid(access)) throw new Error('アクセス VLAN は 1〜4094');
  if (!validVid(native)) throw new Error('ネイティブ VLAN は 1〜4094');
  if (allowed !== null) {
    allowed = [...new Set([...allowed].map(Number))].sort((a, b) => a - b);
    if (!allowed.every(validVid)) throw new Error('許可 VLAN は 1〜4094');
  }
  return { mode, access, allowed, native };
}

/** "10,20,30-32" → [10, 20, 30, 31, 32]。空や "all" なら null（全部） */
export function parseVlanList(text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (t === '' || t === 'all') return null;
  const out = [];
  for (const part of t.split(/[\s,]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(part);
    if (!m) throw new Error(`VLAN の書き方が違う: ${part}`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (!validVid(a) || !validVid(b) || b < a || b - a > 4094) throw new Error(`VLAN の範囲が違う: ${part}`);
    for (let v = a; v <= b; v++) out.push(v);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

/** ポートが VLAN v に属するか（アクセスなら access、トランクなら allowed） */
export function portCarries(cfg, v) {
  return cfg.mode === 'access' ? cfg.access === v : (cfg.allowed === null || cfg.allowed.includes(v));
}

/**
 * フレームの先頭の 802.1Q タグを読む（壊れたフレームでも例外を投げない）
 *   null（タグなし）/ { vid, pcp, dei, innerType } / { error: 理由 }
 */
export function readTag(f) {
  if (!f || f.length < 14) return { error: 'runt' };
  const tpid = (f[12] << 8) | f[13];
  if (OTHER_TPIDS.has(tpid)) return { error: 'vlan-unsupported' };
  if (tpid !== TPID) return null;
  if (f.length < 18) return { error: 'vlan-malformed' };
  const tci = (f[14] << 8) | f[15];
  const innerType = (f[16] << 8) | f[17];
  return { vid: tci & 0x0fff, pcp: tci >> 13, dei: (tci >> 12) & 1, innerType };
}

/** タグを外したフレーム（新しい配列） */
export function untag(f) {
  const out = new Uint8Array(f.length - 4);
  out.set(f.subarray(0, 12), 0);
  out.set(f.subarray(16), 12);
  return out;
}

/** タグを付けたフレーム（新しい配列） */
export function tag(f, vid, pcp = 0) {
  const out = new Uint8Array(f.length + 4);
  out.set(f.subarray(0, 12), 0);
  out[12] = TPID >> 8;
  out[13] = TPID & 0xff;
  out[14] = ((pcp & 7) << 5) | ((vid >> 8) & 0x0f);
  out[15] = vid & 0xff;
  out.set(f.subarray(12), 16);
  return out;
}

/** 6バイトの MAC を数値に（Map のキーにする。48 ビットなので Number で正確に表せる） */
const macKey = (f, at) => ((f[at] * 256 + f[at + 1]) * 256 + f[at + 2]) * 16777216 + ((f[at + 3] << 16) | (f[at + 4] << 8) | f[at + 5]);

export function formatMac(key) {
  return key.toString(16).padStart(12, '0').replace(/(..)(?!$)/g, '$1:');
}

/** フレームの種類（モニタで数える）。802.1Q のタグは1つまで読み飛ばす */
export function classify(frame) {
  if (!frame || frame.length < 14) return 'other';
  let at = 12;
  if (((frame[12] << 8) | frame[13]) === TPID) at = 16;
  if (frame.length < at + 2) return 'other';
  const ethertype = (frame[at] << 8) | frame[at + 1];
  if (ethertype === 0x0806) return 'ARP';
  if (ethertype === 0x86dd) return 'IPv6';
  if (ethertype !== 0x0800 || frame.length < at + 22) return 'other';
  switch (frame[at + 11]) {          // IPv4 ヘッダの protocol（タイプの後ろ + 9）
    case 1: return 'ICMP';
    case 6: return 'TCP';
    case 17: return 'UDP';
    default: return 'IPv4';
  }
}

/** 何が来ても Uint8Array にする（バイト列でなければ空） */
function toBytes(frame) {
  if (frame instanceof Uint8Array) return frame;
  if (ArrayBuffer.isView(frame)) return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(0);
}

export class VirtualSwitch {
  /**
   * @param {object|function} options  関数なら clock（以前の呼び方）
   *   clock()        いまの時刻（UNIX 時刻のミリ秒）
   *   random()       0〜1 の乱数（損失の判定）
   *   schedule(fn, ms)  遅延して届ける（setTimeout）
   *   mode           "switch" / "hub"
   *   agingMs        MAC アドレステーブルのエージング時間
   *   maxEntries     MAC アドレステーブルの上限（全体）
   *   maxEntriesPerVlan  MAC アドレステーブルの上限（VLAN ごと。既定は 1024 と maxEntries の小さいほう）
   *   maxPorts       ポートの数の上限
   */
  constructor(options = {}) {
    const o = typeof options === 'function' ? { clock: options } : options;
    this.clock = o.clock ?? (() => performance.timeOrigin + performance.now());
    this.random = o.random ?? Math.random;
    this.schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.mode = o.mode ?? DEFAULTS.mode;
    this.agingMs = o.agingMs ?? DEFAULTS.agingMs;
    this.maxEntries = o.maxEntries ?? DEFAULTS.maxEntries;
    this.maxEntriesPerVlan = o.maxEntriesPerVlan ?? Math.min(DEFAULTS.maxEntriesPerVlan, this.maxEntries);
    this.maxPorts = o.maxPorts ?? DEFAULTS.maxPorts;
    this.ports = new Map();       // 番号 → port
    this.tables = new Map();      // VLAN → Map（MAC（数値）→ { port: 番号, updatedAt }）
    this.tableSize = 0;           // 全 VLAN のエントリ数
    this.learnRejected = 0;       // テーブルがいっぱいで覚えられなかった回数
    this.lastSweep = -Infinity;
    this.listeners = new Set();
    this.changeListeners = new Set();
  }

  /**
   * フレームを1つ処理するたびに知らせる。
   *   { frame, inPort, outPorts, outTags, vlan, inTag, reason, decision, ts }
   *     frame: 入ってきたときのフレーム（タグ付きで来たら、タグ付きのまま）
   *     inPort / outPorts: ポートの番号（届けた先。捨てたら空）
   *     vlan:  スイッチの中で扱った VLAN（ハブ・VLAN を決める前に捨てたときは null）
   *     inTag: 入ってきたときのタグの VLAN ID（タグなしなら null）
   *     outTags: outPorts と同じ並びで、出したときのタグの VLAN ID（タグなしなら null）
   *     decision: "hub"（ハブ）/ "known"（宛先を知っていた）/ "flood"（知らない宛先）/ "broadcast"（ブロードキャスト・マルチキャスト）/
   *               "filtered"（宛先が入ってきたポート）/ null（届け先を決める前に捨てた）
   *     reason: 捨てた理由 "cable"（ケーブルが抜けている）/ "loss"（損失の設定）/ "no-port"（ほかにポートが無い）/
   *             "runt"（Ethernet ヘッダより短い）/ "filtered" / VLAN の理由（vlan-*・double-tag。上の説明）。
   *             一部の届け先だけ捨てたときも入る
   */
  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** ポート・モード・MAC アドレステーブルが変わったら知らせる（画面の更新用） */
  onChange(fn) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  changed() {
    for (const fn of this.changeListeners) fn(this);
  }

  // ---------------------------------------------------------------- ポート

  /** VM をつなぐ。番号（id）を指定しなければ、空いている小さい番号を使う。いっぱい・使用中なら null */
  addPort(node, { id, linked = true, delayMs = 0, lossRate = 0, vlan } = {}) {
    if (this.ports.size >= this.maxPorts) return null;
    if (id === undefined) {
      id = 0;
      while (this.ports.has(id)) id++;
    } else if (this.ports.has(id) || !(id >= 0 && id < this.maxPorts)) {
      return null;
    }
    const port = { id, node, linked, delayMs, lossRate, removed: false, vlan: vlan ? normalizeVlanConfig(vlan) : defaultVlanConfig() };
    port.unsubscribe = node.on('frame', (frame) => this.receive(port, frame));
    this.ports.set(id, port);
    this.changed();
    return port;
  }

  /** 以前の名前（2台の版） */
  attach(node) {
    return this.addPort(node);
  }

  /** ポートを外す（番号は空く）。そのポートで覚えた MAC は消す。遅延中のフレームも届けない */
  removePort(portOrId) {
    const port = typeof portOrId === 'number' ? this.ports.get(portOrId) : portOrId;
    if (!port || this.ports.get(port.id) !== port) return false;
    port.removed = true;
    port.unsubscribe?.();
    this.ports.delete(port.id);
    this.forgetPort(port.id);
    this.changed();
    return true;
  }

  port(id) {
    return this.ports.get(id);
  }

  /** ケーブルの抜き差し。抜いたら、そのポートで覚えた MAC は消す（差し直したら覚え直す） */
  setLinked(port, linked) {
    port.linked = linked;
    if (!linked) this.forgetPort(port.id);
    this.changed();
  }

  setPortOptions(port, { delayMs, lossRate }) {
    if (delayMs !== undefined) port.delayMs = Math.max(0, Number(delayMs) || 0);
    if (lossRate !== undefined) port.lossRate = Math.min(1, Math.max(0, Number(lossRate) || 0));
    this.changed();
  }

  /** ポートの VLAN 設定を変える（不正なら例外で、何も変えない）。そのポートで覚えた MAC は消す */
  setPortVlan(port, cfg) {
    port.vlan = normalizeVlanConfig({ ...port.vlan, ...cfg });
    this.forgetPort(port.id);
    this.changed();
  }

  forgetPort(id) {
    this.eachEntry((v, t, m, e) => { if (e.port === id) this.deleteEntry(t, m); });
  }

  eachEntry(fn) {
    for (const [v, t] of this.tables) for (const [m, e] of t) fn(v, t, m, e);
  }

  deleteEntry(t, m) {
    if (t.delete(m)) this.tableSize--;
  }

  /** VLAN v のテーブル（無ければ作る） */
  table(v) {
    let t = this.tables.get(v);
    if (!t) this.tables.set(v, (t = new Map()));
    return t;
  }

  // ---------------------------------------------------------------- モード・MAC アドレステーブル

  /** ハブ ⇔ スイッチ。切り替えたらテーブルは空にする */
  setMode(mode) {
    if (mode !== 'hub' && mode !== 'switch') throw new Error('mode must be "hub" or "switch"');
    if (mode === this.mode) return;
    this.mode = mode;
    this.clearTable();
  }

  setAging(ms) {
    this.agingMs = Math.max(1000, Number(ms) || DEFAULTS.agingMs);
    this.sweep(true);
    this.changed();
  }

  clearTable() {
    this.tables.clear();
    this.tableSize = 0;
    this.learnRejected = 0;
    this.changed();
  }

  /** エージング時間を過ぎたエントリを消す（いっぱいのときに毎フレーム全部を見ないよう、force でなければ 1 秒に1回まで） */
  sweep(force = false) {
    const now = this.clock();
    if (!force && now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    this.eachEntry((v, t, m, e) => { if (now - e.updatedAt >= this.agingMs) this.deleteEntry(t, m); });
  }

  /** 表示用: [{ vlan, mac, port, updatedAt, remainingMs }]（VLAN ごとに、覚えた順） */
  entries() {
    this.sweep(true);
    const now = this.clock();
    const out = [];
    this.eachEntry((v, t, m, e) => out.push({ vlan: v, mac: formatMac(m), port: e.port, updatedAt: e.updatedAt, remainingMs: Math.max(0, e.updatedAt + this.agingMs - now) }));
    return out;
  }

  /** 全体の上限に達したか */
  get tableFull() {
    return this.tableSize >= this.maxEntries;
  }

  /** VLAN v で、もう新しい MAC を覚えられないか（VLAN ごとの上限か、全体の上限） */
  isFull(v) {
    return this.tableFull || (this.tables.get(v)?.size ?? 0) >= this.maxEntriesPerVlan;
  }

  /** いっぱいの VLAN の一覧（表示用） */
  fullVlans() {
    return [...this.tables].filter(([, t]) => t.size >= this.maxEntriesPerVlan).map(([v]) => v);
  }

  learn(vlan, key, portId, now) {
    const t = this.table(vlan);
    const e = t.get(key);
    if (e) {
      // 覚えているものは、時刻（と、つながっているポート）を更新する
      const moved = e.port !== portId;
      e.port = portId;
      e.updatedAt = now;
      if (moved) this.changed();
      return;
    }
    if (this.isFull(vlan)) this.sweep();
    if (this.isFull(vlan)) {
      // いっぱい: 新しい MAC は覚えない（その MAC が宛先のフレームはフラッディングになる）
      this.learnRejected++;
      return;
    }
    t.set(key, { port: portId, updatedAt: now });
    this.tableSize++;
    this.changed();
  }

  /** VLAN vlan で、宛先のポート番号（知らない・期限切れなら undefined） */
  lookup(vlan, key, now) {
    const t = this.tables.get(vlan);
    const e = t?.get(key);
    if (!e) return undefined;
    if (now - e.updatedAt >= this.agingMs) {
      this.deleteEntry(t, key);
      this.changed();
      return undefined;
    }
    return e.port;
  }

  // ---------------------------------------------------------------- 転送

  receive(from, rawFrame) {
    const frame = toBytes(rawFrame);
    const now = this.clock();
    const event = { frame, inPort: from.id, outPorts: [], outTags: [], vlan: null, inTag: null, reason: null, decision: null, ts: now };
    if (from.removed) return;
    if (!from.linked) {
      event.reason = 'cable';
    } else if (frame.length < 14) {
      // Ethernet ヘッダにも満たないフレームは、どこにも届けない（記録だけする）
      event.reason = 'runt';
    } else if (from.lossRate > 0 && this.random() < from.lossRate) {
      event.reason = 'loss';
    } else if (this.mode === 'hub') {
      // ハブは VLAN を見ない（タグもそのまま）
      event.decision = 'hub';
      this.send(from, this.others(from), event, () => frame, () => null);
    } else {
      this.forward(from, frame, now, event);
    }
    for (const fn of this.listeners) fn(event);
  }

  /**
   * 入ってきたフレームの VLAN を決める（ポートの設定とタグから）。
   *   { vlan, pcp, inner（タグを外したフレーム）, tagVid } か { drop: 理由 }
   */
  ingress(from, frame) {
    const t = readTag(frame);
    const cfg = from.vlan;
    if (t?.error) return { drop: t.error };
    if (t && (t.innerType === TPID || OTHER_TPIDS.has(t.innerType))) return { drop: 'double-tag' };
    if (t && t.vid === 0x0fff) return { drop: 'vlan-invalid' };
    const inner = t ? untag(frame) : frame;
    const pcp = t ? t.pcp : 0;
    const tagVid = t ? t.vid : null;
    // VLAN ID 0 は「優先度だけのタグ」。タグなしと同じ VLAN にする
    const untagged = !t || t.vid === 0;
    if (cfg.mode === 'access') {
      if (!untagged) return { drop: 'vlan-tagged-access' };
      return { vlan: cfg.access, pcp, inner, tagVid };
    }
    const vlan = untagged ? cfg.native : t.vid;
    if (!portCarries(cfg, vlan)) return { drop: 'vlan-not-allowed' };
    return { vlan, pcp, inner, tagVid };
  }

  forward(from, frame, now, event) {
    const c = this.ingress(from, frame);
    if (c.drop) {
      event.reason = c.drop;
      return;
    }
    const { vlan, pcp, inner } = c;
    event.vlan = vlan;
    event.inTag = c.tagVid;
    // 送り元がマルチキャストの MAC になっているフレーム（不正）は覚えない
    if (!(inner[6] & GROUP)) this.learn(vlan, macKey(inner, 6), from.id, now);
    const members = this.others(from).filter((p) => portCarries(p.vlan, vlan));
    let targets;
    if (inner[0] & GROUP) {
      event.decision = 'broadcast';
      targets = members;
    } else {
      const known = this.lookup(vlan, macKey(inner, 0), now);
      const knownPort = known === undefined ? undefined : this.ports.get(known);
      if (known === from.id) {
        // 宛先は入ってきたポートの先にいる: 同じポートには送り返さない
        event.decision = 'filtered';
        event.reason = 'filtered';
        return;
      }
      if (!knownPort || !portCarries(knownPort.vlan, vlan)) {
        event.decision = 'flood';
        targets = members;
      } else {
        event.decision = 'known';
        targets = [knownPort];
      }
    }
    // 出すときの形: トランクで native 以外ならタグ付き、それ以外はタグなし（同じ形は1回だけ作る）
    let tagged = null;
    const needTag = (to) => to.vlan.mode === 'trunk' && vlan !== to.vlan.native;
    this.send(from, targets, event,
      (to) => (needTag(to) ? (tagged ??= tag(inner, vlan, pcp)) : inner),
      (to) => (needTag(to) ? vlan : null));
  }

  /** targets へ届ける（ケーブル・損失を見る）。make(to) で出す形、tagOf(to) で記録するタグ */
  send(from, targets, event, make, tagOf) {
    if (targets.length === 0) event.reason ??= 'no-port';
    for (const to of targets) {
      if (!to.linked) {
        event.reason = 'cable';
        continue;
      }
      if (to.lossRate > 0 && this.random() < to.lossRate) {
        event.reason ??= 'loss';
        continue;
      }
      event.outPorts.push(to.id);
      event.outTags.push(tagOf(to));
      this.deliver(to, make(to), from.delayMs + to.delayMs);
    }
  }

  /** 入ってきたポート以外の全ポート（番号順） */
  others(from) {
    return [...this.ports.values()].filter((p) => p !== from).sort((a, b) => a.id - b.id);
  }

  deliver(to, frame, delayMs) {
    // 受け取った側の NIC はフレームを保持し続けることがあるので、ポートごとに複製して渡す
    const copy = frame.slice();
    const send = () => { if (!to.removed) to.node.injectFrame(copy); };
    if (delayMs > 0) this.schedule(send, delayMs);
    else send();
  }
}

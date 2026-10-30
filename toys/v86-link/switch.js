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
// MAC アドレステーブル
//   エージング   最後に見てから agingMs（既定 300 秒）たったエントリは消す。
//   上限         maxEntries（既定 1024）。いっぱいのときは「新しい MAC は覚えない」（覚えているものの更新は続ける）。
//                覚えられなかった宛先へのフレームはフラッディングになる。本物のスイッチの CAM テーブルが
//                あふれたときと同じで、MAC フラッディング攻撃（偽の送り元 MAC を大量に送る）で盗聴できるようになる理由。
//   モード切替   ハブ ⇔ スイッチを切り替えると、テーブルは空にする（ハブは使わない。スイッチに戻したら学習を最初から見せる）。
//   ポートを外す・ケーブルを抜く   そのポートで覚えた MAC は消す。
//
// 遅延と損失はケーブル（ポート）の性質で、フレームは送り元のケーブルと届け先のケーブルを通る。
//   遅延 = 送り元のポートの遅延 + 届け先のポートの遅延
//   損失 = 送り元のポートで1回（捨てたらどこにも届かない）、届け先のポートごとに1回
//
// 外へ出す口（アップリンク）は持たない。つないだ VmNode の間でだけフレームをやりとりする。
// 壊れたフレーム（Ethernet ヘッダより短い・バイト列でない）でも例外は投げない（どこにも届けず、記録だけする）。
//
// 処理したフレームは onFrame で知らせる（キャプチャ・モニタ・トポロジー図はそこから）。

const GROUP = 0x01;   // 宛先 MAC の先頭オクテットの最下位ビット（ブロードキャスト・マルチキャスト）

export const DEFAULTS = { mode: 'switch', agingMs: 300_000, maxEntries: 1024, maxPorts: 64 };

/** 6バイトの MAC を数値に（Map のキーにする。48 ビットなので Number で正確に表せる） */
const macKey = (f, at) => ((f[at] * 256 + f[at + 1]) * 256 + f[at + 2]) * 16777216 + ((f[at + 3] << 16) | (f[at + 4] << 8) | f[at + 5]);

export function formatMac(key) {
  return key.toString(16).padStart(12, '0').replace(/(..)(?!$)/g, '$1:');
}

/** フレームの種類（モニタで数える） */
export function classify(frame) {
  if (!frame || frame.length < 14) return 'other';
  const ethertype = (frame[12] << 8) | frame[13];
  if (ethertype === 0x0806) return 'ARP';
  if (ethertype === 0x86dd) return 'IPv6';
  if (ethertype !== 0x0800 || frame.length < 34) return 'other';
  switch (frame[23]) {          // IPv4 ヘッダの protocol（14 + 9）
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
   *   maxEntries     MAC アドレステーブルの上限
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
    this.maxPorts = o.maxPorts ?? DEFAULTS.maxPorts;
    this.ports = new Map();       // 番号 → port
    this.macTable = new Map();    // MAC（数値）→ { port: 番号, updatedAt }
    this.learnRejected = 0;       // テーブルがいっぱいで覚えられなかった回数
    this.lastSweep = -Infinity;
    this.listeners = new Set();
    this.changeListeners = new Set();
  }

  /**
   * フレームを1つ処理するたびに知らせる。
   *   { frame, inPort, outPorts, reason, decision, ts }
   *     inPort / outPorts: ポートの番号（届けた先。捨てたら空）
   *     decision: "hub"（ハブ）/ "known"（宛先を知っていた）/ "flood"（知らない宛先）/ "broadcast"（ブロードキャスト・マルチキャスト）/
   *               "filtered"（宛先が入ってきたポート）/ null（届け先を決める前に捨てた）
   *     reason: 捨てた理由 "cable"（ケーブルが抜けている）/ "loss"（損失の設定）/ "no-port"（ほかにポートが無い）/
   *             "runt"（Ethernet ヘッダより短い）/ "filtered"。一部の届け先だけ捨てたときも入る
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

  /** VM をつなぐ。空いている小さい番号のポートを使う。いっぱいなら null */
  addPort(node, { linked = true, delayMs = 0, lossRate = 0 } = {}) {
    if (this.ports.size >= this.maxPorts) return null;
    let id = 0;
    while (this.ports.has(id)) id++;
    const port = { id, node, linked, delayMs, lossRate, removed: false };
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

  forgetPort(id) {
    for (const [m, e] of this.macTable) if (e.port === id) this.macTable.delete(m);
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
    this.macTable.clear();
    this.learnRejected = 0;
    this.changed();
  }

  /** エージング時間を過ぎたエントリを消す（いっぱいのときに毎フレーム全部を見ないよう、force でなければ 1 秒に1回まで） */
  sweep(force = false) {
    const now = this.clock();
    if (!force && now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [m, e] of this.macTable) if (now - e.updatedAt >= this.agingMs) this.macTable.delete(m);
  }

  /** 表示用: [{ mac, port, updatedAt, remainingMs }]（覚えた順） */
  entries() {
    this.sweep(true);
    const now = this.clock();
    return [...this.macTable].map(([m, e]) => ({ mac: formatMac(m), port: e.port, updatedAt: e.updatedAt, remainingMs: Math.max(0, e.updatedAt + this.agingMs - now) }));
  }

  get tableFull() {
    return this.macTable.size >= this.maxEntries;
  }

  learn(key, portId, now) {
    const e = this.macTable.get(key);
    if (e) {
      // 覚えているものは、時刻（と、つながっているポート）を更新する
      const moved = e.port !== portId;
      e.port = portId;
      e.updatedAt = now;
      if (moved) this.changed();
      return;
    }
    if (this.tableFull) this.sweep();
    if (this.tableFull) {
      // いっぱい: 新しい MAC は覚えない（その MAC が宛先のフレームはフラッディングになる）
      this.learnRejected++;
      return;
    }
    this.macTable.set(key, { port: portId, updatedAt: now });
    this.changed();
  }

  /** 宛先のポート番号（知らない・期限切れなら undefined） */
  lookup(key, now) {
    const e = this.macTable.get(key);
    if (!e) return undefined;
    if (now - e.updatedAt >= this.agingMs) {
      this.macTable.delete(key);
      this.changed();
      return undefined;
    }
    return e.port;
  }

  // ---------------------------------------------------------------- 転送

  receive(from, rawFrame) {
    const frame = toBytes(rawFrame);
    const now = this.clock();
    const event = { frame, inPort: from.id, outPorts: [], reason: null, decision: null, ts: now };
    if (from.removed) return;
    if (!from.linked) {
      event.reason = 'cable';
    } else if (frame.length < 14) {
      // Ethernet ヘッダにも満たないフレームは、どこにも届けない（記録だけする）
      event.reason = 'runt';
    } else if (from.lossRate > 0 && this.random() < from.lossRate) {
      event.reason = 'loss';
    } else {
      this.forward(from, frame, now, event);
    }
    for (const fn of this.listeners) fn(event);
  }

  forward(from, frame, now, event) {
    let targets;
    if (this.mode === 'hub') {
      event.decision = 'hub';
      targets = this.others(from);
    } else {
      // 送り元がマルチキャストの MAC になっているフレーム（不正）は覚えない
      if (!(frame[6] & GROUP)) this.learn(macKey(frame, 6), from.id, now);
      const known = frame[0] & GROUP ? undefined : this.lookup(macKey(frame, 0), now);
      const knownPort = known === undefined ? undefined : this.ports.get(known);
      if (frame[0] & GROUP) {
        event.decision = 'broadcast';
        targets = this.others(from);
      } else if (!knownPort) {
        event.decision = 'flood';
        targets = this.others(from);
      } else if (known === from.id) {
        // 宛先は入ってきたポートの先にいる: 同じポートには送り返さない
        event.decision = 'filtered';
        event.reason = 'filtered';
        return;
      } else {
        event.decision = 'known';
        targets = [knownPort];
      }
    }
    if (targets.length === 0) event.reason = 'no-port';
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
      this.deliver(to, frame, from.delayMs + to.delayMs);
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

// 仮想スイッチ: VmNode が送った Ethernet フレームを、ほかの VmNode に届ける（エンジンに依存しない）。
//
// 本物のスイッチと同じく、送り元の MAC アドレスを覚えて（MAC アドレステーブル）、宛先が分かればそのポートだけに、
// 分からない・ブロードキャスト・マルチキャストならほかの全ポートに届ける。2台なら必ず相手に届くが、
// 3台以上つないでもそのまま動く。
//
// ケーブル（ポートごとのリンク）を抜くと、そのポートとの間のフレームは捨てる。
// 遅延（ミリ秒）と損失率（0〜1）も足せる。
// 外へ出す口は持たない（つないだ VmNode の間でだけフレームをやりとりする）。
// 処理したフレームは onFrame で知らせる（キャプチャ・モニタの集計はそこから。capture.js）

const BROADCAST = 0x01;   // 宛先 MAC の先頭オクテットの最下位ビット（ブロードキャスト・マルチキャスト）

const mac = (f, at) => [...f.subarray(at, at + 6)].map((b) => b.toString(16).padStart(2, '0')).join(':');

/** フレームの種類（モニタで数える） */
export function classify(frame) {
  if (frame.length < 14) return 'other';
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

export class VirtualSwitch {
  /** @param {() => number} clock フレームの時刻（UNIX 時刻のミリ秒）。テストでは差し替える */
  constructor(clock = () => performance.timeOrigin + performance.now()) {
    this.ports = [];
    this.macTable = new Map();  // MAC → port
    this.delayMs = 0;
    this.lossRate = 0;
    this.clock = clock;
    this.listeners = new Set();
  }

  /**
   * フレームを1つ処理するたびに知らせる（キャプチャとモニタはここから受け取る）。
   *   { frame, inPort, outPorts, reason, ts }
   *     inPort / outPorts: ポートの番号（届けた先。捨てたら空）
   *     reason: 捨てた理由 "cable"（ケーブルが抜けている）/ "loss"（損失の設定）/ "no-port"（ほかにポートが無い）/
   *             "runt"（Ethernet ヘッダより短い）。一部の届け先だけ捨てたときも入る
   */
  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** VM をつなぐ。戻り値のポートでケーブルを抜き差しする */
  attach(node) {
    const port = { id: this.ports.length, node, linked: true };
    this.ports.push(port);
    node.on('frame', (frame) => this.receive(port, frame));
    return port;
  }

  setLinked(port, linked) {
    port.linked = linked;
    // 抜いた先の MAC は忘れる（差し直したら覚え直す）
    for (const [m, p] of this.macTable) if (p === port) this.macTable.delete(m);
  }

  receive(from, frame) {
    const event = { frame, inPort: from.id, outPorts: [], reason: null, ts: this.clock() };
    if (!from.linked) {
      event.reason = 'cable';
    } else if (frame.length >= 14) {
      this.macTable.set(mac(frame, 6), from);
      const dst = mac(frame, 0);
      const known = !(frame[0] & BROADCAST) && this.macTable.get(dst);
      const targets = known ? [known] : this.ports.filter((p) => p !== from);
      if (targets.length === 0) event.reason = 'no-port';
      for (const to of targets) {
        if (to === from) continue;
        if (!to.linked) {
          event.reason = 'cable';
          continue;
        }
        if (this.lossRate > 0 && Math.random() < this.lossRate) {
          event.reason ??= 'loss';
          continue;
        }
        event.outPorts.push(to.id);
        this.deliver(to, frame);
      }
    } else {
      // Ethernet ヘッダにも満たないフレームは、どこにも届けない（記録だけする）
      event.reason = 'runt';
    }
    for (const fn of this.listeners) fn(event);
  }

  deliver(to, frame) {
    // 受け取った側の NIC はフレームを保持し続けることがあるので、念のため複製して渡す
    const copy = frame.slice();
    if (this.delayMs > 0) setTimeout(() => to.node.injectFrame(copy), this.delayMs);
    else to.node.injectFrame(copy);
  }
}

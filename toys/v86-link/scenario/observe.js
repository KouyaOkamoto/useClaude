// シナリオの検査: 仮想スイッチの観測（capture の検査）と、検査の通信の見分け方。DOM にも v86 にも依存しない。
//
// capture の検査は、きっかけ（VM から ARP の問い合わせや ping）を出している間、スイッチが処理したフレームを集めて、
// そのフレームがどのノードに届いたかを見る（キャプチャと同じ出どころ = VirtualSwitch.onFrame）。
//   - プローブ（検査用の JS のノード）のポートから入ったフレーム・プローブだけに届いたフレームは「検査の通信」として除く
//     （自分の検査の通信で、ほかの検査が不合格にならないように）
//   - きっかけの VM のポートから入ったフレームだけを見る（ほかの通信に左右されない）

/** スイッチの知らせ（onFrame の event）が、プローブの通信か（入ったのがプローブ / 届いた先が全部プローブ） */
export function isProbeEvent(ev, probePorts) {
  if (probePorts.has(ev.inPort)) return true;
  return ev.outPorts.length > 0 && ev.outPorts.every((p) => probePorts.has(p));
}

/** 802.1Q のタグを読み飛ばした EtherType と、その中身の先頭の位置 */
function innerType(frame) {
  if (!frame || frame.length < 14) return null;
  let off = 12;
  let type = (frame[off] << 8) | frame[off + 1];
  if (type === 0x8100 && frame.length >= 18) { off += 4; type = (frame[off] << 8) | frame[off + 1]; }
  return { type, payload: off + 2 };
}

export function matchesProtocol(frame, protocol) {
  const t = innerType(frame);
  if (!t) return false;
  switch (protocol) {
    case 'arp': return t.type === 0x0806;
    case 'ipv4': return t.type === 0x0800;
    case 'icmp': return t.type === 0x0800 && frame.length > t.payload + 9 && frame[t.payload + 9] === 1;
    case 'broadcast': return frame[0] === 0xff && frame[1] === 0xff && frame[2] === 0xff && frame[3] === 0xff && frame[4] === 0xff && frame[5] === 0xff;
    default: return false;
  }
}

/**
 * 集めた知らせから、capture の検査の観測を作る。
 * @param {Array} events  VirtualSwitch.onFrame の event
 * @param {{ fromPort: number, protocol: string, probePorts: Set<number>, nodeOfPort: (port:number) => string|undefined }} o
 * @returns {{ frames: Array<{ outNodes: string[] }>, excludedProbe: number }}
 */
export function collectCapture(events, { fromPort, protocol, probePorts, nodeOfPort }) {
  const frames = [];
  let excludedProbe = 0;
  for (const ev of events) {
    if (isProbeEvent(ev, probePorts)) { excludedProbe++; continue; }
    if (ev.inPort !== fromPort) continue;
    if (!matchesProtocol(ev.frame, protocol)) continue;
    frames.push({ outNodes: ev.outPorts.map(nodeOfPort).filter(Boolean) });
  }
  return { frames, excludedProbe };
}

/** 検査の間だけ、スイッチの知らせを集める */
export class SwitchObserver {
  constructor(sw) {
    this.sw = sw;
  }

  /** fn（きっかけ）を動かしている間と、そのあと durationMs まで集める */
  async record(fn, durationMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const events = [];
    const off = this.sw.onFrame((ev) => events.push(ev));
    const t0 = Date.now();
    try {
      await fn();
      const left = durationMs - (Date.now() - t0);
      if (left > 0) await sleep(left);
    } finally {
      off();
    }
    return events;
  }
}

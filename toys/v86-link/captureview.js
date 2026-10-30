// キャプチャの画面: パケット一覧（仮想スクロール）と、選んだパケットの詳細・16進ダンプ。
//
// フレームの中身はゲスト VM が作る信用できない入力なので、画面にはすべて textContent で入れる（innerHTML は使わない）。

import { parseFrame, hexdump, compileFilter } from './packet.js';
import { writePcap, pcapFileName } from './pcap.js';

const ROW_H = 22;          // 一覧の1行の高さ（px）。CSS の .cap-row と合わせる
const OVERSCAN = 8;        // 見えている行の前後に余分に作る行数

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const REASONS = { cable: 'ケーブルが抜けている', loss: '損失の設定', 'no-port': 'ほかにポートが無い', runt: 'Ethernet ヘッダより短い' };

export class CaptureView {
  /**
   * @param {object} o
   *   capture:   Capture
   *   portName:  (portId) => 表示名（"左" など）
   *   root:      キャプチャの section 要素（中の要素を id で探す）
   */
  constructor({ capture, portName, root }) {
    this.capture = capture;
    this.portName = portName;
    this.q = (id) => root.querySelector('#' + id);
    this.parsed = new WeakMap();     // record → 解析結果（1回だけ解析する）
    this.rows = [];                  // フィルタに合う記録（古い順）
    this.lastNo = 0;                 // rows に入れ終えた最後の記録の番号
    this.filter = compileFilter('');
    this.selected = null;
    this.drawPending = false;
    this.follow = true;              // いちばん下を見ているときは、新しい行に付いていく

    this.scroller = this.q('cap-scroll');
    this.spacer = this.q('cap-spacer');
    this.scroller.addEventListener('scroll', () => {
      this.follow = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - ROW_H * 1.5;
      this.schedule();
    });
    // 行のクリック（行は作り直すので、まとめて受ける）
    this.spacer.addEventListener('click', (e) => {
      const row = e.target.closest('.cap-row');
      if (row) this.select(this.rows[Number(row.dataset.index)]);
    });
    this.q('cap-filter').addEventListener('input', (e) => this.setFilter(e.target.value));
    this.q('cap-toggle').addEventListener('click', () => (capture.running ? capture.stop() : capture.start()));
    this.q('cap-clear').addEventListener('click', () => capture.clear());
    this.q('cap-download').addEventListener('click', () => this.download());
    capture.onChange(() => this.schedule(true));
    this.schedule(true);
  }

  parse(record) {
    let p = this.parsed.get(record);
    if (!p) {
      p = parseFrame(record.frame);
      this.parsed.set(record, p);
    }
    return p;
  }

  setFilter(text) {
    this.filter = compileFilter(text);
    this.rebuild();
    this.follow = true;
    this.schedule();
  }

  /** フィルタを変えたとき・クリアしたときは、全部を見直す */
  rebuild() {
    this.rows = [];
    this.lastNo = 0;
    this.sync();
  }

  /** 新しく増えた記録を足し、上限で捨てられた記録を除く */
  sync() {
    const cap = this.capture;
    if (this.generation !== cap.generation) {
      // クリアされた
      this.generation = cap.generation;
      this.rows = [];
      this.lastNo = 0;
      if (this.selected) this.select(null);
    }
    const firstNo = cap.size ? cap.at(0).no : Infinity;
    let drop = 0;
    while (drop < this.rows.length && this.rows[drop].no < firstNo) drop++;
    if (drop) this.rows.splice(0, drop);
    if (this.selected && this.selected.no < firstNo) this.select(null);
    // まだ見ていない記録（番号が lastNo より大きいもの）を、後ろから探して足す
    let i = cap.size - 1;
    while (i >= 0 && cap.at(i).no > this.lastNo) i--;
    for (i++; i < cap.size; i++) {
      const r = cap.at(i);
      if (this.filter(this.parse(r), r)) this.rows.push(r);
      this.lastNo = r.no;
    }
  }

  schedule(dataChanged = false) {
    if (dataChanged) this.dirty = true;
    if (this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => {
      this.drawPending = false;
      if (this.dirty) {
        this.dirty = false;
        this.sync();
        this.status();
      }
      this.draw();
    });
  }

  status() {
    const cap = this.capture;
    let dropped = 0;
    for (let i = 0; i < cap.size; i++) if (cap.at(i).dropped) dropped++;
    const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + 'MB';
    this.q('cap-toggle').textContent = cap.running ? '記録を止める' : '記録を始める';
    this.q('cap-state').textContent = cap.running ? '● 記録中' : '■ 停止中';
    this.q('cap-state').className = cap.running ? 'rec' : '';
    this.q('cap-status').textContent =
      `${cap.size.toLocaleString()} 件（転送 ${(cap.size - dropped).toLocaleString()}・捨てた ${dropped.toLocaleString()}）・${mb(cap.bytes)}` +
      ` ／ 上限 ${cap.maxRecords.toLocaleString()} 件・${mb(cap.maxBytes)}` +
      ` ／ 上限を超えて消した古い記録 ${cap.evicted.toLocaleString()} 件` +
      (this.rows.length !== cap.size ? ` ／ フィルタに合う ${this.rows.length.toLocaleString()} 件` : '');
  }

  /** 見えている範囲の行だけを作る（仮想スクロール） */
  draw() {
    const total = this.rows.length;
    this.spacer.style.height = total * ROW_H + 'px';
    if (this.follow) this.scroller.scrollTop = this.scroller.scrollHeight;
    const top = this.scroller.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(total, Math.ceil((top + this.scroller.clientHeight) / ROW_H) + OVERSCAN);
    const t0 = this.capture.startedAt;
    const rows = [];
    for (let i = first; i < last; i++) {
      const r = this.rows[i];
      const p = this.parse(r);
      const row = el('div', 'cap-row' + (r.dropped ? ' dropped' : '') + (p.malformed ? ' malformed' : '') + (r === this.selected ? ' selected' : ''));
      row.dataset.index = String(i);
      row.dataset.proto = p.protocol;
      row.style.transform = `translateY(${i * ROW_H}px)`;
      row.append(
        el('span', 'c-no', String(r.no)),
        el('span', 'c-time', ((r.ts - t0) / 1000).toFixed(6)),
        el('span', 'c-src', p.src),
        el('span', 'c-dst', p.dst),
        el('span', 'c-proto', p.protocol),
        el('span', 'c-len', String(r.frame.length)),
        el('span', 'c-path', this.path(r)),
        el('span', 'c-info', p.info),
      );
      rows.push(row);
    }
    this.spacer.replaceChildren(...rows);
    this.q('cap-empty').hidden = total > 0;
  }

  /** 経路: 入ったポート → 出たポート（捨てたら ✕） */
  path(r) {
    const from = this.portName(r.inPort);
    if (r.dropped) return `${from} → ✕`;
    return `${from} → ${r.outPorts.map((p) => this.portName(p)).join(', ')}`;
  }

  select(record) {
    this.selected = record;
    this.schedule();
    const box = this.q('cap-detail');
    if (!record) {
      box.replaceChildren(el('p', 'hint', '一覧の行を選ぶと、ここに中身が出ます。'));
      return;
    }
    const p = this.parse(record);
    const parts = [];
    // 経路（入ったポート・出たポート・捨てた理由）
    const route = [['番号', String(record.no)], ['時刻', new Date(record.ts).toISOString()], ['入ったポート', this.portName(record.inPort)],
      ['出たポート', record.outPorts.length ? record.outPorts.map((x) => this.portName(x)).join(', ') : 'なし（捨てた）']];
    if (record.reason) route.push(['捨てた理由', REASONS[record.reason] ?? record.reason]);
    parts.push(this.layer('仮想スイッチ', route));
    for (const layer of p.layers) parts.push(this.layer(layer.name, layer.fields));
    if (p.tcp && p.ip && p.ports) {
      const follow = el('button', 'ghost', 'この TCP 接続だけ表示');
      follow.addEventListener('click', () => {
        const f = `tcp ip:${p.ip.src} ip:${p.ip.dst} port:${p.ports.src} port:${p.ports.dst}`;
        this.q('cap-filter').value = f;
        this.setFilter(f);
      });
      parts.push(follow);
    }
    const payload = record.frame.length - p.payloadOffset;
    const bytes = el('div', 'bytes');
    bytes.append(
      el('h4', '', `16進ダンプ（${record.frame.length} バイト${payload > 0 && p.payloadOffset > 0 ? `。データは ${p.payloadOffset} バイト目から ${payload} バイト` : ''}）`),
      el('pre', 'hex', hexdump(record.frame).join('\n')),
    );
    const layers = el('div', 'layers');
    layers.append(...parts);
    box.replaceChildren(layers, bytes);
  }

  layer(name, fields) {
    const d = el('details', 'layer');
    d.open = true;
    d.append(el('summary', '', name));
    const dl = el('dl');
    for (const [k, v] of fields) dl.append(el('dt', '', k), el('dd', '', v));
    d.append(dl);
    return d;
  }

  download() {
    const includeDropped = this.q('cap-dropped').checked;
    const data = writePcap(this.capture.list({ includeDropped }).map((r) => ({ ts: r.ts, frame: r.frame })));
    const url = URL.createObjectURL(new Blob([data], { type: 'application/vnd.tcpdump.pcap' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: pcapFileName() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

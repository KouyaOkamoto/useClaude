// 仮想スイッチの画面: トポロジー図（インライン SVG）と MAC アドレステーブル。
//
// 図のラベル（VM 名・IP）はこのページが決めたものだけを使い、ゲストが出した文字列（ホスト名など）は使わない。
// どちらにしても DOM へは textContent で入れる（innerHTML は使わない）。

const SVG = 'http://www.w3.org/2000/svg';
const FLASH_MS = 350;

const svg = (tag, attrs = {}, text) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * トポロジー図。スイッチを真ん中に、ポートの番号ごとに決まった位置（8方向）に VM を置く。
 * フレームが通るたびに、入ったポートの線と出たポートの線を光らせる（ハブなら全部、スイッチなら1本）
 */
export class TopologyView {
  /**
   * @param {object} o
   *   sw:        VirtualSwitch
   *   root:      SVG を入れる要素
   *   describe:  (portId) => { name, ip } またはつながっていなければ null
   *   slots:     ポートの数（位置を決める）
   */
  constructor({ sw, root, describe, slots = 8 }) {
    this.sw = sw;
    this.describe = describe;
    this.slots = slots;
    this.W = 520;
    this.H = 300;
    this.el = svg('svg', { viewBox: `0 0 ${this.W} ${this.H}`, class: 'topo', role: 'img', 'aria-label': '仮想スイッチと VM のつながり' });
    root.replaceChildren(this.el);
    this.lit = new Map();        // portId → { cls, until }
    this.pending = false;
    this.renderPending = false;
    sw.onChange(() => {
      // MAC フラッディング中などは何度も来るので、1フレームに1回だけ描き直す
      if (this.renderPending) return;
      this.renderPending = true;
      requestAnimationFrame(() => { this.renderPending = false; this.render(); });
    });
    sw.onFrame((e) => this.flash(e));
    this.render();
  }

  pos(id) {
    const a = -Math.PI / 2 + (id / this.slots) * Math.PI * 2;
    const cx = this.W / 2, cy = this.H / 2;
    return {
      vm: { x: cx + Math.cos(a) * 205, y: cy + Math.sin(a) * 112 },
      port: { x: cx + Math.cos(a) * 62, y: cy + Math.sin(a) * 30 },
    };
  }

  render() {
    const cx = this.W / 2, cy = this.H / 2;
    const parts = [];
    this.lines = new Map();
    for (const port of [...this.sw.ports.values()].sort((a, b) => a.id - b.id)) {
      const d = this.describe(port.id);
      const { vm, port: pp } = this.pos(port.id);
      const line = svg('line', { x1: pp.x, y1: pp.y, x2: vm.x, y2: vm.y, class: 'link' + (port.linked ? '' : ' unplugged'), 'data-port': port.id });
      this.lines.set(port.id, line);
      const g = svg('g', { class: 'vm-node', 'data-port': port.id });
      g.append(
        svg('rect', { x: vm.x - 46, y: vm.y - 19, width: 92, height: 38, rx: 7 }),
        svg('text', { x: vm.x, y: vm.y - 3, class: 'name' }, d ? d.name : `P${port.id + 1}`),
        svg('text', { x: vm.x, y: vm.y + 12, class: 'ip' }, d ? d.ip : ''),
      );
      parts.push(line, svg('circle', { cx: pp.x, cy: pp.y, r: 5, class: 'port-dot' + (port.linked ? '' : ' unplugged') }),
        svg('text', { x: pp.x + (pp.x >= cx ? 9 : -9), y: pp.y - 7, class: 'port-label', 'text-anchor': pp.x >= cx ? 'start' : 'end' }, `P${port.id + 1}`), g);
    }
    const hub = this.sw.mode === 'hub';
    const box = svg('g', { class: 'switch-box ' + this.sw.mode });
    box.append(
      svg('rect', { x: cx - 58, y: cy - 24, width: 116, height: 48, rx: 9 }),
      svg('text', { x: cx, y: cy - 3, class: 'name' }, hub ? 'ハブ' : 'L2 スイッチ'),
      svg('text', { x: cx, y: cy + 13, class: 'ip' }, hub ? '全ポートへ' : `MAC ${this.sw.tableSize} 件`),
    );
    // 線の上に箱が重なるよう、線 → 箱の順に入れる
    this.el.replaceChildren(...parts.filter((p) => p.tagName === 'line'), box, ...parts.filter((p) => p.tagName !== 'line'));
    this.paint();
  }

  flash(e) {
    const until = performance.now() + FLASH_MS;
    this.lit.set(e.inPort, { cls: e.outPorts.length ? 'in' : 'drop', until });
    for (const id of e.outPorts) if (id !== e.inPort) this.lit.set(id, { cls: 'out', until });
    if (!this.pending) {
      this.pending = true;
      requestAnimationFrame(() => this.paint());
    }
  }

  /** 光っている線の色を付け、時間が来たら消す */
  paint() {
    this.pending = false;
    const now = performance.now();
    for (const [id, line] of this.lines ?? []) {
      const l = this.lit.get(id);
      const on = l && l.until > now;
      line.classList.toggle('in', !!on && l.cls === 'in');
      line.classList.toggle('out', !!on && l.cls === 'out');
      line.classList.toggle('drop', !!on && l.cls === 'drop');
      if (!on) this.lit.delete(id);
    }
    if (this.lit.size) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.paint(), 60);
    }
  }
}

/** MAC アドレステーブル（MAC・ポート・最後に見た時刻・残り時間） */
export class MacTableView {
  /**
   * @param {object} o
   *   sw:        VirtualSwitch
   *   root:      表を入れる要素（tbody を作る）
   *   status:    件数などを書く要素
   *   portName:  (portId) => 表示名
   */
  constructor({ sw, root, status, portName }) {
    this.sw = sw;
    this.root = root;
    this.status = status;
    this.portName = portName;
    this.pending = false;
    sw.onChange(() => this.schedule());
    setInterval(() => this.schedule(), 1000);   // 残り時間を進める
    this.schedule();
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    const sw = this.sw;
    const sec = (ms) => (ms / 1000).toFixed(0) + ' 秒';
    if (sw.mode === 'hub') {
      this.status.textContent = 'ハブは MAC アドレスを覚えません（入ってきたポート以外の全ポートへ届けます）。';
      this.root.replaceChildren();
      return;
    }
    const entries = sw.entries();
    this.status.textContent = `${entries.length.toLocaleString()} / ${sw.maxEntries.toLocaleString()} 件` +
      ` ・エージング ${sec(sw.agingMs)}` +
      (sw.tableFull ? ' ・いっぱい（新しい MAC は覚えない → その宛先はフラッディング）' : '') +
      (sw.learnRejected ? ` ・覚えられなかった ${sw.learnRejected.toLocaleString()} 回` : '');
    this.status.classList.toggle('full', sw.tableFull);
    // 多すぎるときは、新しいもの（最後に見た時刻が新しい順）から 200 件だけ表示する
    const shown = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
    const rows = shown.map((e) => {
      const tr = el('tr');
      tr.dataset.port = String(e.port);
      tr.append(
        el('td', 'mono', e.mac),
        el('td', '', this.portName(e.port)),
        el('td', 'mono', new Date(e.updatedAt).toLocaleTimeString('ja-JP')),
        el('td', 'num', sec(e.remainingMs)),
      );
      return tr;
    });
    if (entries.length > shown.length) {
      const tr = el('tr');
      const td = el('td', 'hint', `ほか ${(entries.length - shown.length).toLocaleString()} 件（新しい 200 件だけ表示）`);
      td.colSpan = 4;
      tr.append(td);
      rows.push(tr);
    }
    this.root.replaceChildren(...rows);
  }
}

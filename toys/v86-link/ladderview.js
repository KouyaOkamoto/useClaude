// シーケンス（ラダー図）の画面。配置は ladder.js（DOM に依存しない）、ここは SVG に描くだけ。
//
//   - 要素は createElementNS と textContent だけで作る（innerHTML は使わない。フレームは信用できない入力）
//   - 見えている範囲の行だけを描く（キャプチャの一覧と同じ仮想スクロール。上限 2 万件でも重くしない）
//   - フィルタはキャプチャのもの（CaptureView.filter）をそのまま使う。「会話だけ」は、一覧で選んだ行の 2 つの IP（とポート）に絞る
//   - 矢印をクリックすると、キャプチャの一覧でその行を選び（CaptureView.select）、横に詳細を出す。一覧で選んだ行は、ここで強調する
//   - 記録中は最新へ自動でスクロールする（追従）。上へスクロールしたら止め、いちばん下へ戻すとまた追従する

import { layoutLadder, conversationOf, inConversation, PROBE_LANE } from './ladder.js';
import { REASONS } from './captureview.js';

const SVG = 'http://www.w3.org/2000/svg';
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

const LEFT = 56;          // 左の列（番号・時刻）
const LANE_W = 190;       // レーンの幅
const TOP = 18;           // 最初の行の上の余白
const ROW_H = 26;
const GAP_H = 18;
const OVERSCAN = 200;     // 見えている範囲の上下に、余分に描く高さ（px）
const SHORT_REASON = {
  cable: 'ケーブル', loss: '損失', 'no-port': 'ほかにポートなし', runt: '短すぎる', filtered: '同じポート', 'not-ready': '設定前',
  'vlan-tagged-access': 'アクセスにタグ', 'vlan-not-allowed': '許可外の VLAN', 'vlan-malformed': 'タグが壊れている', 'vlan-invalid': 'VLAN 4095',
  'vlan-unsupported': '802.1Q 以外', 'double-tag': '二重タグ',
};

export class LadderView {
  /**
   * @param {object} o
   *   capture / captureView: キャプチャ（capture.js）と、その一覧（captureview.js。フィルタ・選択・解析のキャッシュを共有する）
   *   portName:   (portId) => 表示名
   *   probePorts: シナリオの検査のプローブのポートの Set（1 本の「検査」レーンにまとめる）
   *   root:       シーケンスのタブの要素（中の要素を id で探す）
   */
  constructor({ capture, captureView, portName, probePorts, root }) {
    this.capture = capture;
    this.cv = captureView;
    this.portName = portName;
    this.probePorts = probePorts;
    this.root = root;
    this.q = (id) => root.querySelector('#' + id);
    this.scroller = this.q('lad-scroll');
    this.head = this.q('lad-head');
    this.svg = this.q('lad-svg');
    this.detail = this.q('lad-detail');
    this.opts = { timeMode: 'even', relativeSeq: true };
    this.conv = null;            // 「会話だけ」の会話（null なら全部）
    this.layout = { lanes: [], rows: [], height: 0 };
    this.records = [];           // layout.rows[i].recordIndex が指す記録
    this.dirty = true;
    this.pending = false;
    this.follow = true;
    this.selectedNo = null;
    this.lastLayoutMs = 0;
    this.lastDrawMs = 0;

    this.q('lad-time').addEventListener('change', (e) => { this.opts.timeMode = e.target.value === 'real' ? 'real' : 'even'; this.schedule(true); });
    this.q('lad-rel').addEventListener('change', (e) => { this.opts.relativeSeq = e.target.checked; this.schedule(true); });
    this.q('lad-conv').addEventListener('click', () => this.toggleConversation());
    this.scroller.addEventListener('scroll', () => {
      this.follow = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - ROW_H * 1.5;
      this.schedule();
    });
    // 矢印（行）のクリック。行は作り直すので、まとめて受ける
    this.svg.addEventListener('click', (e) => {
      const g = e.target.closest?.('g.lrow');
      if (!g) return;
      const rec = this.records[Number(g.dataset.index)];
      if (rec) this.pick(rec);
    });
    capture.onChange(() => this.schedule(true));
    captureView.on('filter', () => this.schedule(true));
    captureView.on('select', (rec) => this.onSelect(rec));
    this.onSelect(captureView.selected ?? null);
  }

  /** タブを開いたとき（見えていない間は描かない） */
  show() {
    this.schedule(true);
  }

  visible() {
    return !this.root.hidden && this.scroller.clientHeight > 0;
  }

  schedule(dataChanged = false) {
    if (dataChanged) this.dirty = true;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      if (!this.visible()) return;
      this.draw();
    });
  }

  /** フィルタ（と会話）に合う記録を集めて、配置を計算し直す */
  relayout() {
    const t = performance.now();
    const cap = this.capture;
    const recs = [];
    for (let i = 0; i < cap.size; i++) {
      const r = cap.at(i);
      const p = this.cv.parse(r);
      if (!this.cv.filter(p, r)) continue;
      if (this.conv && !inConversation(this.conv, p)) continue;
      recs.push(r);
    }
    this.records = recs;
    this.layout = layoutLadder(recs, { ...this.opts, parse: (r) => this.cv.parse(r), probePorts: this.probePorts, rowH: ROW_H, gapH: GAP_H });
    this.lastLayoutMs = performance.now() - t;
  }

  laneX(id) {
    const i = this.laneIndex.get(id) ?? 0;
    return LEFT + i * LANE_W + LANE_W / 2;
  }

  laneName(id) {
    return id === PROBE_LANE ? '検査' : this.portName(id);
  }

  draw() {
    const t = performance.now();
    if (this.dirty) {
      this.dirty = false;
      this.relayout();
    }
    const { lanes, rows, height } = this.layout;
    this.laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
    // 右端のレーンの「✕ 理由 ラベル」が切れないよう、右に余白を取る
    const width = Math.max(LEFT + Math.max(1, lanes.length) * LANE_W + 240, this.scroller.clientWidth - 2);
    const h = TOP + height + ROW_H;
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(h));
    this.svg.setAttribute('viewBox', `0 0 ${width} ${h}`);
    // 見出し（レーンの名前）。スクロールしても上に残る（CSS の sticky）
    this.head.style.width = width + 'px';
    this.head.replaceChildren(el('span', 'lad-lane lad-left', 'No.'), ...lanes.map((l) => {
      const s = el('span', 'lad-lane' + (l.id === PROBE_LANE ? ' probe' : ''), this.laneName(l.id));
      s.style.left = LEFT + this.laneIndex.get(l.id) * LANE_W + 'px';
      s.style.width = LANE_W + 'px';
      return s;
    }));
    if (this.follow && this.capture.running) this.scroller.scrollTop = this.scroller.scrollHeight;
    const top = this.scroller.scrollTop - OVERSCAN - TOP;
    const bottom = this.scroller.scrollTop + this.scroller.clientHeight + OVERSCAN;
    const parts = [];
    // レーンの縦線
    for (const l of lanes) {
      const x = this.laneX(l.id);
      parts.push(svg('line', { x1: x, y1: 0, x2: x, y2: h, class: 'lane' + (l.id === PROBE_LANE ? ' probe' : '') }));
    }
    // 見えている範囲の行（y は昇順なので、二分探索で最初の行を探す）
    let lo = 0, hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].y < top) lo = mid + 1; else hi = mid;
    }
    const t0 = this.capture.startedAt;
    for (let i = lo; i < rows.length && rows[i].y <= bottom; i++) parts.push(this.row(rows[i], i, width, t0));
    this.svg.replaceChildren(...parts);
    this.q('lad-empty').hidden = rows.length > 0;
    this.q('lad-status').textContent = `${rows.length.toLocaleString()} 件` + (this.conv ? `（会話だけ: ${this.conv.ips.join(' ⇄ ')}${this.conv.ports ? ` ${this.conv.proto} ${this.conv.ports.join('/')}` : this.conv.proto ? ` ${this.conv.proto}` : ''}）` : '') +
      (rows.length !== this.capture.size ? ` ／ キャプチャ全体 ${this.capture.size.toLocaleString()} 件` : '');
    this.lastDrawMs = performance.now() - t;
  }

  /** 1 行（1 フレーム）。<g class="lrow"> の中に、当たり判定・区切り・矢印・ラベル */
  row(r, index, width, t0) {
    const y = TOP + r.y;
    const rec = this.records[r.recordIndex];
    const g = svg('g', { class: `lrow ${r.kind}${r.no === this.selectedNo ? ' selected' : ''}`, 'data-index': r.recordIndex, 'data-no': r.no, 'data-proto': r.protocol });
    if (r.gapBefore !== null) {
      const gy = y - ROW_H / 2 - GAP_H / 2 + 2;
      g.append(svg('line', { x1: LEFT, y1: gy, x2: width - 8, y2: gy, class: 'gap' }),
        svg('text', { x: LEFT + 6, y: gy - 3, class: 'gap-label' }, `… ${(r.gapBefore / 1000).toFixed(1)}s …`));
    }
    g.append(svg('rect', { x: 0, y: y - ROW_H / 2, width, height: ROW_H, class: 'hit' }));
    g.append(svg('text', { x: 4, y: y + 4, class: 'no' }, String(r.no)));
    if (rec && Number.isFinite(rec.ts) && Number.isFinite(t0)) g.lastChild.append(svg('title', {}, `${((rec.ts - t0) / 1000).toFixed(6)} 秒`));
    const fx = this.laneX(r.from);
    if (r.kind === 'drop') {
      // 入ったレーンに「✕ 理由」と、そのあとにラベル（1 行に並べる）
      const mark = svg('text', { x: fx + 30, y: y + 4, class: 'drop-mark' }, `✕ ${SHORT_REASON[r.reason] ?? r.reason ?? '捨てた'}`);
      mark.append(svg('tspan', { class: 'label', dx: 10 }, r.label));
      g.append(svg('line', { x1: fx, y1: y, x2: fx + 26, y2: y, class: 'arrow drop' }), mark);
      g.append(svg('title', {}, `No.${r.no} ${r.label}\n捨てた理由: ${REASONS[r.reason] ?? r.reason ?? ''}`));
      return g;
    }
    // 届け先ごとの矢印。濃い線（宛先）を最後に描く（上に重ねる）
    const targets = [...r.to].sort((a, b) => (a === r.strong) - (b === r.strong));
    for (const to of targets) {
      const tx = this.laneX(to);
      const strong = to === r.strong;
      const dir = tx >= fx ? 1 : -1;
      const cls = `arrow ${strong ? 'strong' : 'weak'}`;
      g.append(svg('line', { x1: fx, y1: y, x2: tx - dir * 6, y2: y, class: cls }),
        svg('polygon', { points: `${tx},${y} ${tx - dir * 8},${y - 4} ${tx - dir * 8},${y + 4}`, class: `head ${strong ? 'strong' : 'weak'}` }));
      const tag = r.outTags.find((x) => x.lane === to);
      if (tag) g.append(svg('text', { x: tx - dir * 10, y: y + 13, class: 'out-tag', 'text-anchor': dir > 0 ? 'end' : 'start' }, `[${tag.tag}]`));
    }
    // ラベル: 送り元と、濃い線の先（無ければいちばん近い届け先）のあいだ
    const main = r.strong ?? targets.reduce((best, x) => (best === null || Math.abs(this.laneX(x) - fx) < Math.abs(this.laneX(best) - fx) ? x : best), null);
    const mx = (fx + this.laneX(main)) / 2;
    g.append(svg('text', { x: mx, y: y - 5, class: 'label', 'text-anchor': 'middle' }, r.label));
    g.append(svg('title', {}, `No.${r.no} ${r.label}\n${this.laneName(r.from)} → ${r.to.map((x) => this.laneName(x)).join(', ')}`));
    return g;
  }

  /** 矢印を選んだ: キャプチャの一覧でその行を選び（詳細も開く）、一覧をその行までスクロールする */
  pick(record) {
    this.cv.select(record);
    this.cv.reveal(record);
  }

  /** 一覧で行が選ばれた（ここで選んだときも）: 強調して、見えていなければスクロールする。横に詳細を出す */
  onSelect(record) {
    this.selectedNo = record?.no ?? null;
    this.q('lad-conv').disabled = !record && !this.conv;
    this.detail.replaceChildren(...(record ? this.cv.detailNodes(record) : [el('p', 'hint', '矢印をクリックすると、ここに中身が出ます（キャプチャの一覧でも同じ行が選ばれます）。')]));
    if (record && this.visible()) {
      if (this.dirty) this.draw();
      const row = this.layout.rows.find((x) => x.no === record.no);
      if (row) {
        const y = TOP + row.y;
        if (y < this.scroller.scrollTop || y > this.scroller.scrollTop + this.scroller.clientHeight - ROW_H) {
          this.follow = false;
          this.scroller.scrollTop = Math.max(0, y - this.scroller.clientHeight / 2);
        }
      }
    }
    this.schedule();
  }

  /** 「会話だけ」: 一覧で選んだ行の会話に絞る / 戻す */
  toggleConversation() {
    if (this.conv) {
      this.conv = null;
    } else {
      const rec = this.cv.selected;
      const conv = rec ? conversationOf(this.cv.parse(rec)) : null;
      if (!conv) {
        this.q('lad-status').textContent = '選んだ行に IP が無いので、会話を決められません（ARP・IPv4・IPv6 の行を選んでください）';
        return;
      }
      this.conv = conv;
    }
    this.q('lad-conv').textContent = this.conv ? 'すべて表示' : '選んだ行の会話だけ';
    this.q('lad-conv').classList.toggle('on', !!this.conv);
    this.q('lad-conv').disabled = !this.conv && !this.cv.selected;
    this.follow = true;
    this.schedule(true);
  }
}

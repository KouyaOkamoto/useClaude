// 仮想スイッチの画面: トポロジー図（インライン SVG）と MAC アドレステーブル。
//
// 図のラベル（VM 名・IP）はこのページが決めたものだけを使い、ゲストが出した文字列（ホスト名など）は使わない。
// どちらにしても DOM へは textContent で入れる（innerHTML は使わない）。

const SVG = 'http://www.w3.org/2000/svg';
const FLASH_MS = 350;

/** VLAN ごとの色（図とテーブルで同じもの） */
const VLAN_COLORS = { 1: '#8b98a9', 10: '#e3b341', 20: '#d2a8ff', 30: '#56d4dd' };
export function vlanColor(v) {
  if (VLAN_COLORS[v]) return VLAN_COLORS[v];
  return `hsl(${(v * 47) % 360}, 60%, 65%)`;
}
/** ポートの VLAN の短い説明（図のラベル） */
export function vlanLabel(cfg) {
  if (cfg.mode === 'access') return `VLAN ${cfg.access}`;
  return `trunk ${cfg.allowed ? cfg.allowed.join(',') : 'all'}${cfg.native !== 1 || (cfg.allowed && !cfg.allowed.includes(1)) ? ` (native ${cfg.native})` : ''}`;
}

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
   *   describe:  (portId) => { name, ip, sub, role } またはつながっていなければ null
   *   slots:     ポートの数（位置を決める）
   *   onSelect:  (portId) => VM（ポート）をクリックしたとき（ポートの設定パネルを開く）
   */
  constructor({ sw, root, describe, slots = 8, onSelect = () => {} }) {
    this.sw = sw;
    this.describe = describe;
    this.onSelect = onSelect;
    this.slots = slots;
    this.W = 520;
    this.H = 300;
    this.el = svg('svg', { viewBox: `0 0 ${this.W} ${this.H}`, class: 'topo', role: 'group', 'aria-label': '仮想スイッチと VM のつながり' });
    root.replaceChildren(this.el);
    // VM（ポート）を選ぶ: クリック・Enter
    const pick = (e) => {
      const g = e.target.closest?.('[data-port]');
      if (g && (e.type === 'click' || e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        this.onSelect(Number(g.dataset.port));
      }
    };
    this.el.addEventListener('click', pick);
    this.el.addEventListener('keydown', pick);
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
      const cfg = port.vlan;
      const hub = this.sw.mode === 'hub';
      // VLAN の色: アクセスはその VLAN の色、トランクは太い線（色は付けない）。ハブは VLAN を見ないので色なし
      const color = !hub && cfg.mode === 'access' ? vlanColor(cfg.access) : null;
      const trunk = !hub && cfg.mode === 'trunk';
      const line = svg('line', { x1: pp.x, y1: pp.y, x2: vm.x, y2: vm.y, class: 'link' + (port.linked ? '' : ' unplugged') + (trunk ? ' trunk' : ''), 'data-port': port.id });
      if (color) line.setAttribute('stroke', color);
      this.lines.set(port.id, line);
      const router = d?.role === 'router';
      const g = svg('g', { class: 'vm-node' + (router ? ' router' : ''), 'data-port': port.id, tabindex: 0, role: 'button', 'aria-label': `${d ? d.name : ''} P${port.id + 1} のポートの設定` });
      const rect = svg('rect', { x: vm.x - 48, y: vm.y - 22, width: 96, height: 44, rx: router ? 20 : 7 });
      if (color) rect.setAttribute('stroke', color);
      g.append(
        rect,
        svg('text', { x: vm.x, y: vm.y - 7, class: 'name' }, d ? (router ? 'R ルーター' : d.name) : `P${port.id + 1}`),
        svg('text', { x: vm.x, y: vm.y + 6, class: 'ip' }, d ? (router ? d.sub : d.ip) : ''),
        svg('text', { x: vm.x, y: vm.y + 18, class: 'ip' }, hub ? (d && !router ? d.sub : '') : `${d && !router ? d.sub + ' · ' : ''}${vlanLabel(cfg)}`),
      );
      parts.push(line, svg('circle', { cx: pp.x, cy: pp.y, r: 5, class: 'port-dot' + (port.linked ? '' : ' unplugged') }),
        svg('text', { x: pp.x + (pp.x >= cx ? 9 : -9), y: pp.y - 7, class: 'port-label', 'text-anchor': pp.x >= cx ? 'start' : 'end' }, `P${port.id + 1}`), g);
    }
    const hub = this.sw.mode === 'hub';
    const box = svg('g', { class: 'switch-box ' + this.sw.mode });
    box.append(
      svg('rect', { x: cx - 58, y: cy - 24, width: 116, height: 48, rx: 9 }),
      svg('text', { x: cx, y: cy - 3, class: 'name' }, hub ? 'ハブ' : 'L2 スイッチ'),
      svg('text', { x: cx, y: cy + 13, class: 'ip' }, hub ? '全ポートへ（VLAN なし）' : `MAC ${this.sw.tableSize} 件`),
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
    const fullVlans = sw.fullVlans();
    const full = sw.tableFull || fullVlans.length > 0;
    this.status.textContent = `${entries.length.toLocaleString()} 件（上限 VLAN ごと ${sw.maxEntriesPerVlan.toLocaleString()}・全体 ${sw.maxEntries.toLocaleString()}）` +
      ` ・エージング ${sec(sw.agingMs)}` +
      (sw.tableFull ? ' ・全体がいっぱい' : '') +
      (fullVlans.length ? ` ・VLAN ${fullVlans.join(', ')} がいっぱい` : '') +
      (full ? '（新しい MAC は覚えない → その宛先はフラッディング）' : '') +
      (sw.learnRejected ? ` ・覚えられなかった ${sw.learnRejected.toLocaleString()} 回` : '');
    this.status.classList.toggle('full', full);
    // 多すぎるときは、新しいもの（最後に見た時刻が新しい順）から 200 件だけ表示する
    const shown = entries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
    const rows = shown.map((e) => {
      const tr = el('tr');
      tr.dataset.port = String(e.port);
      const v = el('td', 'num vlan', String(e.vlan));
      v.style.color = vlanColor(e.vlan);
      tr.append(
        v,
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
      td.colSpan = 5;
      tr.append(td);
      rows.push(tr);
    }
    this.root.replaceChildren(...rows);
  }
}

/**
 * ポートの設定パネル。トポロジー図から開く。
 *   ケーブル・遅延・損失: 変えるとすぐ反映する
 *   VLAN（モード・アクセス VLAN・トランクの許可 VLAN・ネイティブ VLAN）: 「反映」で確かめてから反映し、不正なら理由を出して何も変えない
 */
export class PortPanel {
  /**
   * @param {object} o
   *   sw:        VirtualSwitch
   *   root:      パネルを入れる要素
   *   portName:  (portId) => 表示名
   *   parseVlanList: "10,20" → [10, 20]（switch.js）
   */
  constructor({ sw, root, portName, parseVlanList }) {
    this.sw = sw;
    this.root = root;
    this.portName = portName;
    this.parseVlanList = parseVlanList;
    this.id = null;
    sw.onChange(() => {
      if (this.id === null) return;
      if (!sw.port(this.id)) return this.close();
      // プリセットなどでケーブルを抜き差ししたら、チェックボックスも合わせる
      if (this.unplug && document.activeElement !== this.unplug) this.unplug.checked = !sw.port(this.id).linked;
    });
    this.close();
  }

  close() {
    this.id = null;
    this.unplug = null;
    this.root.replaceChildren(el('p', 'hint', 'トポロジー図の VM（ポート）をクリックすると、そのポートの VLAN を設定できます。'));
  }

  open(id) {
    const port = this.sw.port(id);
    if (!port) return;
    this.id = id;
    const cfg = port.vlan;
    // ケーブル・遅延・損失（すぐ反映）
    const cable = el('div', 'pf-cable');
    const unplug = Object.assign(el('input'), { type: 'checkbox', className: 'pf-unplug', checked: !port.linked });
    const delay = Object.assign(el('input'), { type: 'number', className: 'pf-delay', min: 0, max: 2000, step: 10, value: port.delayMs });
    const loss = Object.assign(el('input'), { type: 'number', className: 'pf-loss', min: 0, max: 100, step: 5, value: Math.round(port.lossRate * 100) });
    unplug.addEventListener('change', () => this.sw.setLinked(port, !unplug.checked));
    delay.addEventListener('input', () => this.sw.setPortOptions(port, { delayMs: Math.min(2000, Number(delay.value)) }));
    loss.addEventListener('input', () => this.sw.setPortOptions(port, { lossRate: Number(loss.value) / 100 }));
    const l1 = el('label', 'toggle');
    l1.append(unplug, ' ケーブルを抜く');
    const l2 = el('label');
    l2.append('遅延 ', delay, ' ms');
    const l3 = el('label');
    l3.append('損失 ', loss, ' %');
    cable.append(l1, l2, l3);
    this.unplug = unplug;

    const form = el('form', 'port-form');
    form.noValidate = true;    // 入力の確かめは normalizeVlanConfig で行い、理由を出す
    form.dataset.port = String(id);
    const mode = el('select', 'pf-mode');
    for (const [v, t] of [['access', 'アクセス'], ['trunk', 'トランク']]) mode.append(Object.assign(el('option', '', t), { value: v }));
    mode.value = cfg.mode;
    const num = (cls, value) => Object.assign(el('input'), { type: 'number', className: cls, min: 1, max: 4094, value });
    const access = num('pf-access', cfg.access);
    const native = num('pf-native', cfg.native);
    const allowed = Object.assign(el('input'), { type: 'text', className: 'pf-allowed', value: cfg.allowed ? cfg.allowed.join(',') : 'all', spellcheck: false });
    allowed.placeholder = '例: 1,10,20 / 100-110 / all';
    const lab = (t, input, cls) => { const l = el('label', cls); l.append(el('span', '', t), input); return l; };
    const aRow = lab('アクセス VLAN', access, 'pf-row pf-access-row');
    const tRows = [lab('許可 VLAN', allowed, 'pf-row pf-trunk-row'), lab('ネイティブ VLAN（タグなし）', native, 'pf-row pf-trunk-row')];
    const sync = () => {
      aRow.hidden = mode.value !== 'access';
      tRows.forEach((r) => (r.hidden = mode.value !== 'trunk'));
    };
    mode.addEventListener('change', sync);
    sync();
    const msg = el('p', 'pf-msg');
    const apply = el('button', '', '反映');
    apply.type = 'submit';
    const cancel = el('button', 'ghost', '閉じる');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.close());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        // 見えている欄だけを使う（アクセスなら access、トランクなら allowed と native。ほかは今の値のまま）
        const trunk = mode.value === 'trunk';
        this.sw.setPortVlan(port, {
          mode: mode.value,
          access: trunk ? port.vlan.access : Number(access.value),
          native: trunk ? Number(native.value) : port.vlan.native,
          allowed: trunk ? this.parseVlanList(allowed.value) : port.vlan.allowed,
        });
        msg.textContent = `反映しました（${this.describe(port.vlan)}）。このポートで覚えた MAC は消しました。`;
        msg.className = 'pf-msg ok';
      } catch (err) {
        msg.textContent = '反映できません: ' + err.message;
        msg.className = 'pf-msg err';
      }
    });
    const buttons = el('div', 'pf-buttons');
    buttons.append(apply, cancel);
    form.append(el('h4', '', 'VLAN'), lab('モード', mode, 'pf-row'), aRow, ...tRows, buttons, msg);
    const title = el('h3', '', `ポート ${this.portName(id)}`);
    this.root.replaceChildren(title, cable, form);
    title.scrollIntoView?.({ block: 'nearest' });
  }

  describe(cfg) {
    return cfg.mode === 'access' ? `アクセス VLAN ${cfg.access}` : `トランク 許可 ${cfg.allowed ? cfg.allowed.join(',') : 'すべて'}・ネイティブ ${cfg.native}`;
  }
}

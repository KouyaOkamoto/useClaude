// DAI（Dynamic ARP Inspection）の画面: 観察の「DAI」タブ。DAI の本体は dai.js（スイッチの sw.dai）。
// 表示はすべて createElement + textContent（入力欄に何を打っても要素にはならない）。
//
//   VLAN ごとの有効 / 無効・送り元 MAC の検査・バインディング表（追加・削除。不正な値は理由を出して反映しない）・
//   「いまの VM から表を作る」・数（VLAN ごと・ポートごと）・最近捨てた記録・trusted なポートの一覧（変えるのはポートの設定パネル）
//   locked なら見るだけ（シナリオで L2 を固定しているとき。allow.dai があれば変えられる）

import { normalizeBinding } from './dai.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
export const DAI_REASON_TEXT = {
  'arp-inspection': '表に合わない（sender IP と MAC の組が無い）',
  'arp-src-mac': '送り元 MAC が ARP の sender MAC と違う',
  'arp-malformed': 'ARP として読めない',
};

export class DaiView {
  /**
   * @param {object} o
   *   sw:           VirtualSwitch（sw.dai を使う）
   *   root:         タブの中身を入れる要素
   *   portName:     (portId) => 表示名
   *   vlansInUse:   () => 画面に出す VLAN の番号の配列（ポートの設定から）
   *   buildFromVms: () => [{ vlan, ip, mac }]（「いまの VM から表を作る」）
   *   visible:      () => タブが見えているか（見えていないときは数を描き直さない）
   */
  constructor({ sw, root, portName, vlansInUse, buildFromVms, visible = () => true }) {
    this.sw = sw;
    this.dai = sw.dai;
    this.root = root;
    this.portName = portName;
    this.vlansInUse = vlansInUse;
    this.buildFromVms = buildFromVms;
    this.visible = visible;
    this.locked = false;
    this.pending = false;
    this.lastDraw = 0;
    this.build();
    this.dai.onChange(() => this.schedule(true));
    sw.onChange(() => this.schedule());
    // ARP が流れたら数を描き直す（見えているときだけ・0.5 秒に 1 回まで）
    sw.onFrame((ev) => { if (ev.dai || (ev.vlan !== null && this.dai.isEnabled(ev.vlan))) this.schedule(); });
  }

  setLocked(on) {
    this.locked = !!on;
    this.schedule(true);
  }

  /** 変わらない部分（入力欄・ボタン）。描き直さないので、打っている途中の文字が消えない */
  build() {
    this.vlanBox = el('div', 'dai-vlans');
    this.srcMac = Object.assign(el('input'), { type: 'checkbox', id: 'dai-srcmac' });
    this.srcMac.addEventListener('change', () => this.guard(() => this.dai.setSrcMacCheck(this.srcMac.checked)));
    const srcLabel = el('label', 'toggle plain small');
    srcLabel.append(this.srcMac, ' 送り元 MAC も検査する（Ethernet の送り元と ARP の sender MAC が違えば捨てる）');

    this.rows = el('tbody');
    const table = el('table', 'mac-table dai-table');
    const head = el('thead');
    const hr = el('tr');
    for (const t of ['VLAN', 'IP', 'MAC', '']) hr.append(el('th', '', t));
    head.append(hr);
    table.append(head, this.rows);

    const form = el('form', 'dai-form');
    form.noValidate = true;
    const input = (cls, ph, size) => Object.assign(el('input'), { type: 'text', className: cls, placeholder: ph, spellcheck: false, autocomplete: 'off', size });
    this.inVlan = input('dai-in-vlan', 'VLAN', 4);
    this.inIp = input('dai-in-ip', 'IP（例 10.5.0.2）', 14);
    this.inMac = input('dai-in-mac', 'MAC（例 02:00:0a:05:00:02）', 18);
    this.inVlan.value = '1';
    const add = el('button', '', '表に足す');
    add.type = 'submit';
    this.msg = el('p', 'pf-msg dai-msg');
    form.append(this.inVlan, this.inIp, this.inMac, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.guard(() => {
        const b = this.dai.addBinding(normalizeBinding({ vlan: this.inVlan.value, ip: this.inIp.value, mac: this.inMac.value }));
        this.say(`足しました（VLAN ${b.vlan}・${b.ip}・${b.mac}）`, 'ok');
        this.inIp.value = '';
        this.inMac.value = '';
      });
    });
    this.buildBtn = el('button', 'ghost dai-build', 'いまの VM から表を作る');
    this.buildBtn.addEventListener('click', () => this.guard(() => {
      const list = this.buildFromVms();
      this.dai.setBindings(list);
      this.say(`いまの VM から ${list.length} 件の表を作りました（前の表は置き換えた）`, 'ok');
    }));
    this.clearBtn = el('button', 'ghost dai-clear', '表を空にする');
    this.clearBtn.addEventListener('click', () => this.guard(() => { this.dai.clearBindings(); this.say('表を空にしました', 'ok'); }));
    this.resetBtn = el('button', 'ghost dai-reset-stats', '数を消す');
    this.resetBtn.addEventListener('click', () => this.dai.resetStats());
    const buttons = el('div', 'pf-buttons');
    buttons.append(this.buildBtn, this.clearBtn);

    this.lockNote = el('p', 'hint small dai-lock', 'このシナリオでは、スイッチは用意済みで固定です。DAI の設定は見るだけです。');
    this.trustedLine = el('p', 'hint small dai-trusted');
    this.stats = el('div', 'dai-stats');
    this.recent = el('ol', 'dai-recent');

    this.root.replaceChildren(
      el('p', 'hint small', 'DAI（Dynamic ARP Inspection）: 有効にした VLAN で、untrusted なポートから入った ARP の「sender IP と MAC の組」を、下の表で確かめる。'
        + '表に合わないものは捨てる（キャプチャの理由 arp-inspection。フィルタ dai）。trusted / untrusted は、トポロジー図の VM をクリックして開くポートの設定で変える。'),
      this.lockNote, el('h4', '', '有効にする VLAN'), this.vlanBox, srcLabel, this.trustedLine,
      el('h4', '', 'バインディング表（本物のスイッチでは DHCP snooping が作る。ここでは手で書く）'), table, form, buttons, this.msg,
      el('h4', '', '数と、最近捨てた ARP'), this.stats, this.resetBtn, this.recent,
    );
    this.draw(true);
  }

  guard(fn) {
    if (this.locked) return this.say('このシナリオでは変えられません', 'err');
    try {
      fn();
    } catch (e) {
      this.say('反映できません: ' + (e?.message ?? e), 'err');
    }
  }

  say(text, cls) {
    this.msg.textContent = text;
    this.msg.className = 'pf-msg dai-msg ' + (cls ?? '');
  }

  schedule(force = false) {
    if (force) this.force = true;
    if (this.pending) return;
    this.pending = true;
    const wait = this.force ? 0 : Math.max(0, 500 - (performance.now() - this.lastDraw));
    setTimeout(() => requestAnimationFrame(() => {
      this.pending = false;
      if (!this.force && !this.visible()) return;
      this.draw(this.force);
      this.force = false;
    }), wait);
  }

  /** 変わる部分（VLAN・表・数・記録）だけを描き直す */
  draw() {
    this.lastDraw = performance.now();
    const cfg = this.dai.config();
    const dis = this.locked;
    this.lockNote.hidden = !this.locked;
    for (const x of [this.srcMac, this.inVlan, this.inIp, this.inMac, this.buildBtn, this.clearBtn]) x.disabled = dis;
    this.root.querySelector('.dai-form button').disabled = dis;
    this.srcMac.checked = cfg.srcMacCheck;
    // VLAN の切り替え
    const vlans = [...new Set([...this.vlansInUse(), ...cfg.vlans])].sort((a, b) => a - b);
    this.vlanBox.replaceChildren(...vlans.map((v) => {
      const cb = Object.assign(el('input'), { type: 'checkbox', checked: this.dai.isEnabled(v), disabled: dis });
      cb.dataset.vlan = String(v);
      cb.addEventListener('change', () => this.guard(() => this.dai.setVlan(v, cb.checked)));
      const l = el('label', 'toggle plain dai-vlan');
      l.append(cb, ` VLAN ${v}`);
      return l;
    }));
    // trusted なポート
    const trusted = [...this.sw.ports.values()].filter((p) => p.daiTrusted).map((p) => this.portName(p.id));
    this.trustedLine.textContent = `trusted なポート: ${trusted.length ? trusted.join('・') : 'なし（全ポートが untrusted）'}`;
    // 表
    this.rows.replaceChildren(...cfg.bindings.map((b) => {
      const tr = el('tr');
      const del = el('button', 'ghost dai-del', '削除');
      del.disabled = dis;
      del.addEventListener('click', () => this.guard(() => { this.dai.removeBinding(b.vlan, b.ip); this.say(`消しました（VLAN ${b.vlan}・${b.ip}）`, 'ok'); }));
      const td = el('td');
      td.append(del);
      tr.append(el('td', '', String(b.vlan)), el('td', '', b.ip), el('td', '', b.mac), td);
      return tr;
    }));
    if (!cfg.bindings.length) {
      const tr = el('tr');
      const td = el('td', 'hint', '（空）DAI を有効にした VLAN では、表に無い ARP はすべて捨てる');
      td.colSpan = 4;
      tr.append(td);
      this.rows.append(tr);
    }
    // 数
    const st = this.dai.stats();
    const lines = [];
    for (const [v, s] of Object.entries(st.vlans)) lines.push(`VLAN ${v}: 検査 ${s.inspected}・捨てた ${s.dropped}`);
    for (const [p, s] of Object.entries(st.ports)) lines.push(`${this.portName(Number(p))}: 検査 ${s.inspected}・捨てた ${s.dropped}`);
    this.stats.replaceChildren(...(lines.length ? lines : ['まだ検査していない']).map((t) => el('div', 'small', t)));
    // 最近捨てた記録（新しい順）
    this.recent.replaceChildren(...st.recent.slice().reverse().map((r) => {
      const t = new Date(r.ts);
      const hh = (n) => String(n).padStart(2, '0');
      return el('li', 'small', `${hh(t.getHours())}:${hh(t.getMinutes())}:${hh(t.getSeconds())} ${this.portName(r.port)}（VLAN ${r.vlan}）`
        + ` ${r.ip ?? '?'} is-at ${r.mac ?? '?'} → 捨てた: ${DAI_REASON_TEXT[r.reason] ?? r.reason}${r.expectedMac ? `（表では ${r.expectedMac}）` : r.reason === 'arp-inspection' ? '（表に無い）' : ''}`);
    }));
  }
}

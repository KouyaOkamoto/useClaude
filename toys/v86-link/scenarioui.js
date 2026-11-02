// シナリオモードの画面と制御（要件から設計・構築して、受け入れテストで判定する）。docs/scenarios.md
//
// main.js から、VM の作成・起動・削除などの道具（host）を受け取って使う（グローバルの状態に直接は触らない）。
// シナリオの検証・判定は scenario/*.js（DOM に依存しない）、検査の実行は probe.js・vmshell.js・scenario/observe.js。
//
//   同梱のシナリオ（scenarios/index.json に載っているもの）は trusted（shell の検査を許す）。
//   ファイルから読み込んだシナリオは trusted でない（shell の検査を含むものは、検証で拒否される）。
//   どちらも、検証に通らなければ読み込まない（エラーを表示し、いまの画面と状態はそのまま）。
//
//   表示は textContent と、小さなマークアップ（scenario/markup.js）の変換だけ。innerHTML は使わない。

import { validateScenario, parseCidr } from './scenario/schema.js';
import { parseMarkup, renderMarkup } from './scenario/markup.js';
import { runChecks, STATUS } from './scenario/evaluate.js';
import { collectCapture, SwitchObserver } from './scenario/observe.js';
import { Probe } from './probe.js';
import { VmShell, BOOTSTRAP } from './vmshell.js';

const ROLE_LABEL = { host: 'PC', server: 'サーバー', router: 'ルーター' };
const DIFFICULTY = { easy: '易', medium: '中', hard: '難' };
const macOfIp = (ip) => '02:00:' + ip.split('.').map((x) => Number(x).toString(16).padStart(2, '0')).join(':');
/** ゲストのホスト名（ノードの ID。英小文字・数字・ハイフンだけなので、そのまま使える） */
const hostOf = (id) => id.slice(0, 32);

export class ScenarioController {
  /**
   * @param {{ doc: Document, $: Function, el: Function, host: object }} o
   *   host: main.js の道具（sw・capture・captureView・probePorts・machines・createMachine・bootMachine・removeMachine・setVmState・…）
   */
  constructor({ doc, $, el, host }) {
    this.doc = doc;
    this.$ = $;
    this.el = el;
    this.host = host;
    this.active = false;     // シナリオモードか（URL で指定したときは、読み込みの前から true にして、自由構成の VM を作らない）
    this.sc = null;          // 検証済みのシナリオ
    this.probes = new Map(); // ノードの ID → Probe
    this.result = null;      // いちばん新しい検査の結果
    this.phase = 'idle';     // idle / building / ready / checking / error
    this.hintsShown = 0;
    this.generation = 0;     // やり直したら増やす（古い起動の続きを無視する）
    this.observer = new SwitchObserver(host.sw);
    this.list = [];
    this.listReady = this.loadList();
    this.wire();
  }

  // ---------------------------------------------------------------- 一覧・読み込み

  async loadList() {
    try {
      const res = await fetch('scenarios/index.json');
      const data = await res.json();
      this.list = Array.isArray(data?.scenarios) ? data.scenarios.filter((x) => /^[a-z][a-z0-9-]{0,31}$/.test(x?.id ?? '') && /^[a-z0-9-]+\.json$/.test(x?.file ?? '')) : [];
    } catch (e) {
      console.error(e);
      this.list = [];
    }
    const sel = this.$('scenario-pick');
    for (const x of this.list) sel.append(Object.assign(this.el('option', '', String(x.title ?? x.id)), { value: x.id }));
    return this.list;
  }

  wire() {
    const { $ } = this;
    $('scenario-pick').addEventListener('change', (e) => {
      const id = e.target.value;
      // 自由構成に戻るときは、ページを読み直す（シナリオの VM・プローブを残さない）
      if (!id) { location.search = ''; return; }
      this.setUrl(id);
      this.openBundled(id);
    });
    $('scenario-file-btn').addEventListener('click', () => $('scenario-file').click());
    $('scenario-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (file.size > 200_000) return this.showErrors(['ファイルが大きすぎる（200KB まで）']);
      this.openJson(await file.text(), { trusted: false });
    });
    $('sc-check').addEventListener('click', () => this.check());
    $('sc-reset').addEventListener('click', () => this.reset());
    $('sc-hint').addEventListener('click', () => this.showNextHint());
    $('sc-probe-filter').addEventListener('click', () => {
      $('cap-filter').value = 'probe';
      this.host.captureView.setFilter('probe');
      this.host.showTab('drawer', 'capture');
    });
  }

  setUrl(id) {
    try { history.replaceState(null, '', '?' + new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), scenario: id })); } catch { /* file: など */ }
  }

  /** URL の ?scenario=… で開く（ページを開いたとき） */
  async openFromUrl(id) {
    this.active = true;
    this.enterMode();
    await this.listReady;
    this.$('scenario-pick').value = id;
    return this.openBundled(id);
  }

  async openBundled(id) {
    await this.listReady;
    const entry = this.list.find((x) => x.id === id);
    if (!entry) return this.showErrors([`同梱のシナリオに「${id}」はありません`]);
    try {
      const res = await fetch('scenarios/' + entry.file);
      return this.openJson(await res.text(), { trusted: true });
    } catch (e) {
      return this.showErrors(['シナリオを読み込めませんでした: ' + e.message]);
    }
  }

  /** JSON を検証して開く。検証に通らなければ、エラーを出して、いまの状態のまま */
  async openJson(text, { trusted }) {
    const v = validateScenario(text, { trusted });
    if (!v.ok) return this.showErrors(v.errors);
    this.$('sc-errors').hidden = true;
    return this.start(v.scenario);
  }

  showErrors(errors) {
    const box = this.$('sc-errors');
    box.replaceChildren(this.el('p', '', 'シナリオを読み込めませんでした（検証に通りません）。いまの構成はそのままです:'),
      this.el('ul', '', ''));
    const ul = box.querySelector('ul');
    for (const e of errors.slice(0, 30)) ul.append(this.el('li', '', String(e)));
    if (errors.length > 30) ul.append(this.el('li', '', `ほか ${errors.length - 30} 件`));
    box.hidden = false;
    this.$('scenario-panel').hidden = false;
    if (!this.sc) this.$('sc-title').textContent = 'シナリオ';
    this.lastErrors = errors;
    return false;
  }

  // ---------------------------------------------------------------- 画面のモード

  enterMode() {
    const { $ } = this;
    this.doc.body.classList.add('scenario-mode');
    $('scenario-panel').hidden = false;
    for (const id of ['lesson-title', 'lesson-intro', 'lesson-steps', 'lesson-all', 'lesson-status', 'lesson-pick', 'lesson-start', 'add-subnet', 'add-router', 'net', 'router-fwd-on', 'router-fwd-off']) {
      const e = $(id);
      if (e) e.hidden = true;
    }
    const plan = $('vlan-plan');
    if (plan) { plan.checked = false; plan.closest('label').hidden = true; }
    $('cap-probe-label').hidden = false;
    this.host.setPane('steps');
  }

  // ---------------------------------------------------------------- 構成を作る

  async start(sc) {
    const gen = ++this.generation;
    this.active = true;
    // 片づけの間も「準備中」にする（古い VM を検査・操作の対象にしない）
    this.phase = 'building';
    this.$('sc-check').disabled = true;
    this.enterMode();
    if (this.host.imageName !== 'v86net') {
      this.sc = sc;
      this.renderStatic();
      this.setStatus('シナリオモードは、新しいイメージ（v86net）だけで動きます。URL の ?image=… を外して（または ?image=v86net で）開き直してください。', 'err');
      this.phase = 'error';
      this.$('sc-check').disabled = true;
      return false;
    }
    await this.teardown();
    if (gen !== this.generation) return false;
    this.sc = sc;
    this.result = null;
    this.hintsShown = 0;
    this.addedVms = 0;
    this.phase = 'building';
    this.renderStatic();
    this.host.setMode(sc.switch.mode);
    // L2 を用意済みで固定するシナリオでは、モードとポートの VLAN を変えられないようにする
    this.host.setSwitchLocked(!!sc.switch.locked);
    // VM
    const vms = sc.nodes.filter((n) => n.kind === 'vm');
    for (const n of vms) {
      const addr = n.address ? parseCidr(n.address) : null;
      this.host.createMachine(n.port, {
        role: n.role === 'router' ? 'router' : 'host',
        scenario: {
          id: n.id, name: n.name, host: hostOf(n.id), ipLabel: n.address ?? '未設定', mac: n.mac ?? (addr ? macOfIp(addr.ip) : `02:00:00:00:01:${n.port.toString(16).padStart(2, '0')}`),
          roleLabel: n.testOnly ? '試験用・検査に使わない' : ROLE_LABEL[n.role] ?? n.role, locked: n.locked, removable: !!sc.allow.removeVms, vlan: vlanConfig(n.vlan), note: n.note, init: n.init, gen,
        },
      });
    }
    // プローブ（学習者には見えない。ポート P9〜）
    for (const n of sc.nodes.filter((x) => x.kind === 'probe')) {
      const a = parseCidr(n.address);
      const probe = new Probe({ name: n.name, mac: n.mac, ip: a.ip, prefix: a.prefix, gateway: n.gateway });
      const port = this.host.sw.addPort(probe, { id: n.port, vlan: vlanConfig(n.vlan ?? { mode: 'access', access: 1 }) });
      if (!port) { this.setStatus(`プローブ ${n.name} をつなげませんでした`, 'err'); continue; }
      this.probes.set(n.id, { probe, port, node: n });
      this.host.probePorts.add(n.port);
    }
    this.host.setTermView(vms.length > 1, vms.map((n) => n.port));
    this.host.showTab('observe', 'topology');
    this.host.setBadge();
    this.setStatus('構成を作っています。VM を起動して、初期設定を入れています…（数十秒かかります）', '');
    this.$('sc-check').disabled = true;
    // 起動（全部まとめて）
    for (const m of this.vmMachines()) this.host.bootMachine(m);
    const ok = await this.host.until(() => gen !== this.generation || this.vmMachines().every((m) => m.scenarioReady || m.scenarioFailed), 300000);
    if (gen !== this.generation) return false;
    const failed = this.vmMachines().filter((m) => !m.scenarioReady);
    if (!ok || failed.length) {
      this.phase = 'error';
      this.setStatus(`初期設定に失敗した VM があります（${failed.map((m) => m.name).join('・')}）。「最初からやり直す」を試してください。`, 'err');
      this.$('sc-check').disabled = false;
      return false;
    }
    this.phase = 'ready';
    this.setStatus('準備ができました。依頼を読んで、ネットワークを設計・設定してください。終わったら「検査する」。', 'ok');
    this.$('sc-check').disabled = false;
    return true;
  }

  vmMachines() {
    return this.host.machines.filter((m) => m.scenario);
  }

  /** シナリオの VM が起動したら（main.js の onSerial から）: ttyS1 のシェルを起動 → 初期設定 → 端末をクリア → 学習者に渡す */
  async setupVm(m, t0) {
    const gen = m.scenario.gen;
    const stale = () => m.removed || gen !== this.generation;
    this.host.setVmState(m, 'シナリオの初期設定中…');
    // ttyS0 で1回だけ: ホスト名とプロンプト、ttyS1 の検査用シェルの起動（このあと端末を消す）
    const mark = m.log.length;
    m.node.writeSerial(`hostname ${m.host}; export PS1='\\h:\\w% '; ${BOOTSTRAP}; echo "SC""-BOOT-OK"\n`);
    await this.host.until(() => stale() || /^SC-BOOT-OK\s*$/m.test(m.log.slice(mark)), 20000);
    if (stale()) return;
    m.shell = new VmShell(m.node);
    let alive = false;
    for (let i = 0; i < 5 && !alive && !stale(); i++) alive = await m.shell.alive(2000);
    if (stale()) return;
    if (!alive) { m.scenarioFailed = true; this.host.setVmState(m, '検査用シェルが起動しない（VM を起動し直してください）', 'err'); return; }
    // MAC を決まった値に（シナリオの init より前。init で上書きしてよい）。初期設定は ttyS1 で（学習者の端末に出さない）
    const warnings = [];
    const pre = `ifconfig eth0 down; ifconfig eth0 hw ether ${m.mac}; ifconfig eth0 up`;
    for (const cmd of [pre, ...m.scenario.init]) {
      const r = await m.shell.run(cmd, { timeoutMs: 20000 });
      if (stale()) return;
      if (r.error) { warnings.push(`${cmd.slice(0, 60)}: 応答なし`); break; }
      if (r.exitCode !== 0) warnings.push(`${cmd.slice(0, 60)}: 終了コード ${r.exitCode}`);
    }
    if (warnings.length) console.warn(`シナリオの初期設定（${m.name}）:`, warnings);
    m.initWarnings = warnings;
    // 端末を消して、学習者に渡す（ブートの表示・ブートストラップのコマンドを見せない）
    m.term.reset();
    m.term.write(`\x1b[90m${m.name}（${m.scenario.roleLabel}${m.scenario.locked ? '・閲覧のみ' : ''}）${m.ip !== '未設定' ? ' ' + m.ip : ''}\x1b[0m\r\n`);
    m.inputBlocked = false;
    m.node.writeSerial('\n');
    m.netReady = true;
    m.scenarioReady = true;
    m.netMs = performance.now() - t0;
    this.host.setVmState(m, `準備完了 ${(m.netMs / 1000).toFixed(1)}s`, 'ok');
    this.host.setBadge();
  }

  /** 片づける: シナリオの VM・プローブを外し、MAC テーブル・キャプチャを空にする */
  async teardown() {
    for (const [, x] of this.probes) {
      x.probe.dispose();
      this.host.sw.removePort(x.port);
    }
    this.probes.clear();
    this.host.probePorts.clear();
    for (const m of [...this.host.machines]) {
      m.shell?.dispose();
      await this.host.removeMachine(m);
    }
    this.host.sw.clearTable();
    this.host.capture.clear();
    // シナリオを始める・やり直すときは、キャプチャを記録中にする（既定。前に「記録を止める」を押していても戻す）
    this.host.capture.start();
  }

  async reset() {
    if (!this.sc) return false;
    return this.start(this.sc);
  }

  // ---------------------------------------------------------------- 学習者が足す VM

  canAddVm() {
    return !!this.sc && this.phase !== 'building' && this.addedVms < (this.sc.allow.addVms ?? 0);
  }

  async addLearnerVm() {
    if (!this.canAddVm()) return null;
    let slot = 0;
    while (slot < this.host.maxVms && this.host.bySlot(slot)) slot++;
    if (slot >= this.host.maxVms) return null;
    this.addedVms++;
    const name = `PC${slot + 1}`;
    const m = this.host.createMachine(slot, {
      role: 'host',
      scenario: { id: `added-${slot}`, name, host: `pc${slot + 1}`, ipLabel: '未設定', mac: `02:00:00:00:02:${slot.toString(16).padStart(2, '0')}`, roleLabel: '追加した PC', locked: false, removable: true, vlan: { mode: 'access', access: 1, allowed: null, native: 1 }, init: [], gen: this.generation },
    });
    if (m) await this.host.bootMachine(m);
    return m;
  }

  probeName(port) {
    for (const [, x] of this.probes) if (x.port.id === port) return x.node.name;
    return String(port);
  }

  // ---------------------------------------------------------------- 検査

  adapters() {
    const vm = (id) => this.vmMachines().find((m) => m.scenario.id === id);
    const shellOf = (id) => {
      const m = vm(id);
      if (!m) return { error: 'no-node' };
      if (!m.shell || !m.scenarioReady) return { error: 'vm-not-ready' };
      return { shell: m.shell, m };
    };
    const probe = (id) => this.probes.get(id)?.probe;
    const viaShell = (fn) => async (id, ...args) => {
      const s = shellOf(id);
      if (s.error) return s;
      return fn(s.shell, ...args);
    };
    const nodeOfPort = (port) => {
      for (const [id, x] of this.probes) if (x.port.id === port) return id;
      return this.vmMachines().find((m) => m.slot === port)?.scenario.id;
    };
    return {
      probe: {
        ping: async (id, to, o) => probe(id)?.ping(to, o) ?? { error: 'no-node' },
        tcp: async (id, to, port, o) => probe(id)?.tcpConnect(to, port, o) ?? { error: 'no-node' },
        http: async (id, to, port, path, o) => probe(id)?.httpGet(to, port, path, o) ?? { error: 'no-node' },
      },
      vm: {
        ping: viaShell((sh, to, o) => sh.ping(to, o)),
        tcp: viaShell((sh, to, port, o) => sh.tcp(to, port, o)),
        http: viaShell((sh, to, port, path, o) => sh.http(to, port, path, o)),
        route: viaShell((sh, o) => sh.route(o)),
        shell: viaShell((sh, cmd, o) => sh.shell(cmd, o)),
      },
      capture: async (fromId, stimulus, { protocol, durationMs }) => {
        const s = shellOf(fromId);
        if (s.error) return s;
        let stimErr = null;
        const events = await this.observer.record(async () => {
          const r = await s.shell.stimulus(stimulus);
          if (r.error) stimErr = r.error;
        }, durationMs);
        if (stimErr) return { error: stimErr };
        return collectCapture(events, { fromPort: s.m.slot, protocol, probePorts: this.host.probePorts, nodeOfPort });
      },
      // tcp_source: プローブで待ち受け、VM（ttyS1）から接続して、プローブが受けた接続の送り元を返す
      source: async (fromId, listenerId, port, { timeoutMs }) => {
        const x = this.probes.get(listenerId);
        if (!x) return { error: 'no-node' };
        const s = shellOf(fromId);
        if (s.error) return s;
        const server = x.probe.listen(port);
        if (!server) return { error: 'listener-busy' };
        try {
          const r = await s.shell.connect(x.probe.cfg.ip, port, { timeoutMs: Math.max(1000, timeoutMs - 2000) });
          if (r.error) return r;
          // 接続の最後のセグメントが届くまで、少し待つ
          await new Promise((res) => setTimeout(res, 300));
          return { connections: server.connections.map((c) => ({ src: c.src })) };
        } finally {
          server.close();
        }
      },
    };
  }

  async check() {
    if (!this.sc || this.phase === 'checking' || this.phase === 'building') return null;
    const gen = this.generation;
    this.phase = 'checking';
    this.$('sc-check').disabled = true;
    this.$('sc-reset').disabled = true;
    this.setStatus('検査しています…（学習者の端末は、そのまま使えます）', '');
    try {
      const result = await runChecks(this.sc, this.adapters(), {
        onProgress: ({ index, total, check }) => { this.$('sc-progress').textContent = `検査 ${index + 1} / ${total}: ${check.title}`; },
      });
      if (gen !== this.generation) return null;
      this.result = result;
      this.renderResult(result);
      return result;
    } finally {
      if (gen === this.generation) {
        this.phase = 'ready';
        this.$('sc-check').disabled = false;
        this.$('sc-reset').disabled = false;
        this.$('sc-progress').textContent = '';
      }
    }
  }

  // ---------------------------------------------------------------- 表示

  renderStatic() {
    const { $, sc } = this;
    $('sc-title').textContent = sc.title;
    $('sc-meta').textContent = `難易度 ${DIFFICULTY[sc.difficulty] ?? sc.difficulty}・目安 ${sc.minutes} 分${sc.trusted ? '' : '・読み込んだシナリオ'}`;
    this.renderText($('sc-briefing'), sc.briefing);
    this.renderReqs(null);
    $('sc-hints').replaceChildren();
    $('sc-hint').hidden = sc.hints.length === 0;
    $('sc-hint').disabled = false;
    $('sc-debrief-box').hidden = true;
    this.renderText($('sc-debrief'), sc.debrief);
    $('sc-progress').textContent = '';
  }

  renderText(box, text) {
    box.replaceChildren(renderMarkup(parseMarkup(text), this.doc));
  }

  renderReqs(result) {
    const items = this.sc.requirements.map((r) => {
      const res = result?.requirements.find((x) => x.id === r.id);
      const status = res?.status ?? 'notrun';
      const li = this.el('li', 'sc-req ' + status);
      li.dataset.req = r.id;
      li.dataset.status = res ? status : 'none';
      const head = this.el('div', 'sc-req-head');
      head.append(this.el('span', 'sc-chip ' + status, res ? STATUS[status] : '未検査'), this.el('b', '', r.id));
      const text = this.el('div', 'sc-text');
      text.append(renderMarkup(parseMarkup(r.text), this.doc));
      li.append(head, text);
      for (const c of res?.checks ?? []) {
        if (c.status === 'pass' || !c.message) continue;
        li.append(this.el('p', 'sc-msg ' + c.status, c.message));
      }
      return li;
    });
    this.$('sc-reqs').replaceChildren(...items);
  }

  renderResult(result) {
    this.renderReqs(result);
    const s = result.summary;
    if (result.allPassed) {
      this.setStatus('全部の要件が合格しました。解説を読んでみてください。', 'ok');
      this.$('sc-debrief-box').hidden = false;
      this.$('sc-debrief-box').open = true;
    } else {
      this.setStatus(`合格 ${s.pass}・不合格 ${s.fail}・未実行 ${s.notrun}・エラー ${s.error}`, s.error ? 'err' : '');
    }
  }

  showNextHint() {
    const hints = this.sc?.hints ?? [];
    if (this.hintsShown >= hints.length) return;
    const h = hints[this.hintsShown++];
    const box = this.el('div', 'sc-hint');
    box.append(this.el('b', '', `ヒント ${this.hintsShown}`));
    box.append(renderMarkup(parseMarkup(h.text), this.doc));
    this.$('sc-hints').append(box);
    this.$('sc-hint').disabled = this.hintsShown >= hints.length;
    this.$('sc-hint').textContent = this.hintsShown >= hints.length ? 'ヒントはここまで' : '次のヒントを見る';
  }

  setStatus(text, cls) {
    const e = this.$('sc-status');
    e.textContent = text;
    e.className = 'sc-status ' + (cls ?? '');
  }

  /** 自動テスト用: いまの状態 */
  get state() {
    return {
      active: this.active, phase: this.phase, id: this.sc?.id ?? null, trusted: this.sc?.trusted ?? null,
      result: this.result, errors: this.lastErrors ?? null, probes: [...this.probes.keys()],
      vms: this.vmMachines().map((m) => ({ id: m.scenario.id, slot: m.slot, ready: !!m.scenarioReady, warnings: m.initWarnings ?? [] })),
    };
  }
}

function vlanConfig(v) {
  return { mode: v?.mode ?? 'access', access: v?.access ?? 1, allowed: v?.allowed ?? null, native: v?.native ?? 1 };
}

// 自由構成の学習「L2: ARP スプーフィングと DAI」で使う、攻撃者ノード X と、学習の手順の action（attacker・dai・dai-bind）。
// DOM にも v86 にも依存しない（Node でテストできる）。main.js が使う。
//
// 攻撃者はシナリオと同じ attacker.js のノード（ページの JS）。スイッチの空いたポート（既定 P9。シナリオのプローブと同じ範囲で、
// 自由構成では使っていない）につなぐ。ページの外には通信しない（フレームはスイッチのポートに出すだけ）。学習者は X の VM を操作しない。
//   LabAttacker.start({ targets: [IP, IP], vlan })  つないで動かす（動いていれば何もしない）。アドレスは標的と同じ /24 の .66
//   LabAttacker.stop()                              止めて、ポートから外す（attacker.js の stop() は戻せないので、次の start で作り直す）
//   loot                                            盗んだもの（止めても残す。clearLoot で消す。新しいものが後ろ・上限 50 件）
//
// 学習の action（main.js の runSteps）:
//   ['attacker', bool]                      X を動かす / 止める。標的は A と B（ctx.targets() で、実行するときの IP）
//   ['dai', { vlan, enable }]               その VLAN の DAI を有効 / 無効
//   ['dai-bind', 'auto' | 'clear']          バインディング表を「いまの VM から作る」/ 空にする

import { Attacker } from './attacker.js';

export const LAB_ATTACKER = { port: 8, name: 'X', host: 66, intervalMs: 1500, maxLoot: 50 };
export const LAB_ACTIONS = ['attacker', 'dai', 'dai-bind'];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const macOfIp = (ip) => '02:00:' + ip.split('.').map((x) => Number(x).toString(16).padStart(2, '0')).join(':');

/** X のアドレス: 最初の標的と同じ /24 の .66（MAC は 02:00 + IP。自由構成の VM と同じ決め方） */
export function attackerAddress(targetIp) {
  if (typeof targetIp !== 'string' || !IPV4.test(targetIp)) throw new Error(`標的の IP が IPv4 アドレスでない（${targetIp}）`);
  const ip = targetIp.split('.').slice(0, 3).concat(String(LAB_ATTACKER.host)).join('.');
  return { ip, mac: macOfIp(ip), prefix: 24 };
}

/** 学習の action の形を確かめて、正規化した形を返す。不正なら理由つきの例外。学習の action でなければ null */
export function parseLabAction(action) {
  if (!Array.isArray(action) || !LAB_ACTIONS.includes(action[0])) return null;
  const [kind, a] = action;
  if (kind === 'attacker') {
    if (typeof a !== 'boolean') throw new Error(`attacker には true / false を渡す（${a}）`);
    return { kind, on: a };
  }
  if (kind === 'dai') {
    if (!a || typeof a !== 'object') throw new Error('dai には { vlan, enable } を渡す');
    if (!Number.isInteger(a.vlan) || a.vlan < 1 || a.vlan > 4094) throw new Error(`dai の VLAN は 1〜4094 の整数（${a.vlan}）`);
    if (typeof a.enable !== 'boolean') throw new Error(`dai の enable は true / false（${a.enable}）`);
    return { kind, vlan: a.vlan, enable: a.enable };
  }
  if (a !== 'auto' && a !== 'clear') throw new Error(`dai-bind には 'auto' か 'clear' を渡す（${a}）`);
  return { kind, mode: a };
}

export class LabAttacker {
  /**
   * @param {object} o
   *   sw:       VirtualSwitch
   *   port:     つなぐポート（既定 LAB_ATTACKER.port = P9）
   *   name:     表示名（既定 X）
   *   create:   (cfg) => Attacker（テストで差し替える。既定は attacker.js）
   *   onChange: 動き始めた・止まった・盗んだものが増えたときに呼ぶ
   */
  constructor({ sw, port = LAB_ATTACKER.port, name = LAB_ATTACKER.name, create = (cfg) => new Attacker(cfg), onChange = () => {} }) {
    this.sw = sw;
    this.portId = port;
    this.name = name;
    this.create = create;
    this.onChange = onChange;
    this.attacker = null;
    this.port = null;
    this.address = null;
    this.targets = null;
    this.loot = [];
  }

  get running() {
    return !!this.attacker;
  }

  /** つないで動かす。動いていれば何もしない（標的が変わっていれば作り直す）。つなげなければ例外 */
  start({ targets, vlan = 1 }) {
    if (!Array.isArray(targets) || targets.length !== 2 || !targets.every((t) => typeof t === 'string' && IPV4.test(t)) || targets[0] === targets[1]) {
      throw new Error(`標的は違う 2 つの IPv4 アドレス（${targets}）`);
    }
    if (this.attacker && this.targets.join() === targets.join()) return this;
    this.stop();
    const addr = attackerAddress(targets[0]);
    const attacker = this.create({ name: this.name, mac: addr.mac, ip: addr.ip, prefix: addr.prefix, targets: [...targets],
      intervalMs: LAB_ATTACKER.intervalMs, relay: true, decrementTtl: true, maxLoot: LAB_ATTACKER.maxLoot });
    // 攻撃者のポートは trusted にしない（DAI で検査される側）
    const port = this.sw.addPort(attacker, { id: this.portId, vlan: { mode: 'access', access: vlan }, trusted: false });
    if (!port) {
      attacker.stop();
      throw new Error(`スイッチのポート P${this.portId + 1} に攻撃者をつなげませんでした`);
    }
    attacker.on('loot', (list) => {
      const l = list[list.length - 1];
      if (!l) return;
      this.loot.push({ ...l });
      if (this.loot.length > LAB_ATTACKER.maxLoot) this.loot.splice(0, this.loot.length - LAB_ATTACKER.maxLoot);
      this.onChange(this);
    });
    this.attacker = attacker;
    this.port = port;
    this.address = addr;
    this.targets = [...targets];
    attacker.start();
    this.onChange(this);
    return this;
  }

  /** 止めて、ポートから外す（タイマーも止まる。古い X の ARP は出ない） */
  stop() {
    if (!this.attacker) return this;
    this.attacker.stop();
    this.sw.removePort(this.port);
    this.attacker = null;
    this.port = null;
    this.onChange(this);
    return this;
  }

  clearLoot() {
    this.loot = [];
    this.onChange(this);
  }

  /** いま X がつながっているポートか */
  isPort(id) {
    return !!this.attacker && id === this.portId;
  }

  info() {
    return { running: this.running, port: this.portId, name: this.name, ip: this.address?.ip ?? null, mac: this.address?.mac ?? null,
      targets: this.targets ? [...this.targets] : null, loot: this.loot.length, stats: this.attacker ? { ...this.attacker.stats } : null };
  }
}

/**
 * 学習の action を実行する（main.js の runSteps から）。学習の action でなければ false を返す（呼び出し側が続きを見る）
 *   ctx: { sw, lab: LabAttacker, targets: () => [IP, IP], vlan: () => X のポートの VLAN, bindingsFromVms: () => [{ vlan, ip, mac }] }
 */
export function applyLabAction(action, ctx) {
  const a = parseLabAction(action);
  if (!a) return false;
  if (a.kind === 'attacker') {
    if (a.on) ctx.lab.start({ targets: ctx.targets(), vlan: ctx.vlan?.() ?? 1 });
    else ctx.lab.stop();
  } else if (a.kind === 'dai') {
    ctx.sw.dai.setVlan(a.vlan, a.enable);
  } else if (a.mode === 'auto') {
    ctx.sw.dai.setBindings(ctx.bindingsFromVms());
  } else {
    ctx.sw.dai.clearBindings();
  }
  return true;
}

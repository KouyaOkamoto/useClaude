// シナリオ定義（JSON）の検証。DOM にも v86 にも依存しない（Node でテストできる）。
//
// シナリオの JSON は「信用できない入力」として扱う。ここを通らなかったものは読み込まない。
//   - 知らない項目・知らない検査の種類は、エラーにする（読み飛ばさない）
//   - 文字列の長さ・配列の数に上限を設ける
//   - アドレスは、プライベートの範囲（10/8・172.16/12・192.168/16）か、ドキュメント用の範囲
//     （192.0.2.0/24・198.51.100.0/24・203.0.113.0/24）だけを許す（実在のアドレスを使わせない）
//   - 任意のシェルコマンドを実行する検査（type: "shell"）は、同梱のシナリオ（trusted）だけで許す
//
// 仕様の説明は docs/scenarios.md。validateScenario(json, { trusted }) は { ok, errors, scenario } を返す
// （scenario は既定の値を埋めた形。ok が false なら scenario は null）。

export const SCHEMA_ID = 'v86-link-scenario/1';
export const LIMITS = { maxVms: 8, maxProbes: 4, maxChecks: 40, maxInit: 60, maxText: 4000, maxShort: 200, maxCommand: 1000 };
export const CHECK_TYPES = ['ping', 'tcp', 'http', 'route', 'ttl', 'capture', 'tcp_source', 'shell'];
export const TRUSTED_ONLY_TYPES = new Set(['shell']);
const ROLES = ['host', 'server', 'router'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const FEEDBACK = ['summary', 'detailed'];
const CAPTURE_PROTOCOLS = ['arp', 'icmp', 'broadcast', 'ipv4'];

// ---------------------------------------------------------------- アドレス

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const isIpv4 = (s) => typeof s === 'string' && IPV4.test(s);
export const ipToNum = (ip) => ip.split('.').reduce((a, x) => ((a << 8) | Number(x)) >>> 0, 0);
export function parseCidr(s) {
  if (typeof s !== 'string') return null;
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(s);
  if (!m || !isIpv4(m[1]) || Number(m[2]) > 32) return null;
  return { ip: m[1], prefix: Number(m[2]) };
}
export const inCidr = (ip, cidr) => {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c || !isIpv4(ip)) return false;
  if (c.prefix === 0) return true;
  const mask = c.prefix === 32 ? 0xffffffff : (~0 << (32 - c.prefix)) >>> 0;
  return ((ipToNum(ip) & mask) >>> 0) === ((ipToNum(c.ip) & mask) >>> 0);
};
/** 使ってよいアドレスの範囲（プライベート・ドキュメント用） */
export const SAFE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'];
export const isSafeIp = (ip) => SAFE_RANGES.some((r) => inCidr(ip, r));
const MAC = /^02:[0-9a-f]{2}(:[0-9a-f]{2}){4}$/;   // ローカル管理のユニキャストだけ

// ---------------------------------------------------------------- 小さな検証の道具

class Checker {
  constructor() { this.errors = []; }
  err(path, msg) { this.errors.push(`${path}: ${msg}`); return undefined; }
  obj(v, path, allowed) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return this.err(path, 'オブジェクトでない');
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.err(`${path}.${k}`, '知らない項目');
    return v;
  }
  str(v, path, { required = true, max = LIMITS.maxShort, pattern = null, enumOf = null } = {}) {
    if (v === undefined) return required ? this.err(path, '必須') : undefined;
    if (typeof v !== 'string') return this.err(path, '文字列でない');
    if (v.length > max) return this.err(path, `長すぎる（${max} 文字まで）`);
    if (required && v.trim() === '') return this.err(path, '空');
    if (pattern && !pattern.test(v)) return this.err(path, '書き方が違う');
    if (enumOf && !enumOf.includes(v)) return this.err(path, `${enumOf.join(' / ')} のどれか`);
    // 制御文字（改行・タブ以外）は入れない
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return this.err(path, '制御文字が入っている');
    return v;
  }
  int(v, path, { required = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (v === undefined) return required ? this.err(path, '必須') : undefined;
    if (!Number.isInteger(v) || v < min || v > max) return this.err(path, `${min}〜${max} の整数`);
    return v;
  }
  bool(v, path, { required = false } = {}) {
    if (v === undefined) return required ? this.err(path, '必須') : undefined;
    if (typeof v !== 'boolean') return this.err(path, 'true / false');
    return v;
  }
  arr(v, path, { required = true, max = 100, min = 0 } = {}) {
    if (v === undefined) return required ? this.err(path, '必須') : undefined;
    if (!Array.isArray(v)) return this.err(path, '配列でない');
    if (v.length > max) return this.err(path, `多すぎる（${max} 個まで）`);
    if (v.length < min) return this.err(path, `少なすぎる（${min} 個から）`);
    return v;
  }
  ip(v, path, { required = true } = {}) {
    if (v === undefined) return required ? this.err(path, '必須') : undefined;
    if (!isIpv4(v)) return this.err(path, 'IPv4 アドレスでない');
    if (!isSafeIp(v)) return this.err(path, 'プライベートかドキュメント用（192.0.2.0/24・198.51.100.0/24・203.0.113.0/24）のアドレスだけ使える');
    return v;
  }
  cidr(v, path, { required = true } = {}) {
    if (v === undefined) return required ? this.err(path, '必須') : undefined;
    const c = parseCidr(v);
    if (!c) return this.err(path, 'CIDR（例 192.168.10.0/24）でない');
    if (!isSafeIp(c.ip)) return this.err(path, 'プライベートかドキュメント用のアドレスだけ使える');
    return v;
  }
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const REQ_ID = /^R\d{1,2}$/;
const PATH = /^\/[A-Za-z0-9._~\/-]{0,200}$/;   // HTTP のパス（シェルに渡しても安全な文字だけ）

// ---------------------------------------------------------------- 本体

/**
 * @param {unknown} json   JSON.parse した値（文字列なら JSON.parse する）
 * @param {{ trusted?: boolean }} opts  trusted: 同梱のシナリオ（shell の検査を許す）
 */
export function validateScenario(json, { trusted = false } = {}) {
  const c = new Checker();
  let src = json;
  if (typeof json === 'string') {
    if (json.length > 200_000) return { ok: false, errors: ['JSON が大きすぎる（200KB まで）'], scenario: null };
    try { src = JSON.parse(json); } catch (e) { return { ok: false, errors: ['JSON として読めない: ' + e.message], scenario: null }; }
  }
  const s = c.obj(src, '$', ['schema', 'id', 'title', 'difficulty', 'minutes', 'summary', 'image', 'briefing', 'requirements', 'addressing',
    'switch', 'nodes', 'allow', 'checks', 'hints', 'debrief', 'feedback']);
  if (!s) return { ok: false, errors: c.errors, scenario: null };

  if (s.schema !== SCHEMA_ID) c.err('$.schema', `"${SCHEMA_ID}" でない（対応していない版）`);
  c.str(s.id, '$.id', { pattern: ID });
  c.str(s.title, '$.title');
  c.str(s.difficulty, '$.difficulty', { enumOf: DIFFICULTIES });
  c.int(s.minutes, '$.minutes', { min: 1, max: 600 });
  c.str(s.summary, '$.summary', { max: LIMITS.maxText });
  c.str(s.image, '$.image', { required: false, enumOf: ['v86net'] });
  c.str(s.briefing, '$.briefing', { max: LIMITS.maxText });
  c.str(s.debrief, '$.debrief', { max: LIMITS.maxText });
  c.str(s.feedback, '$.feedback', { required: false, enumOf: FEEDBACK });

  // 要件
  const reqIds = new Set();
  for (const [i, r] of (c.arr(s.requirements, '$.requirements', { min: 1, max: 20 }) ?? []).entries()) {
    const p = `$.requirements[${i}]`;
    if (!c.obj(r, p, ['id', 'text', 'requires'])) continue;
    if (c.str(r.id, `${p}.id`, { pattern: REQ_ID })) {
      if (reqIds.has(r.id)) c.err(`${p}.id`, '重複している');
      reqIds.add(r.id);
    }
    c.str(r.text, `${p}.text`, { max: LIMITS.maxText });
    for (const [j, d] of (c.arr(r.requires, `${p}.requires`, { required: false, max: 10 }) ?? []).entries()) c.str(d, `${p}.requires[${j}]`, { pattern: REQ_ID });
  }
  for (const [i, r] of (Array.isArray(s.requirements) ? s.requirements : []).entries()) {
    for (const d of Array.isArray(r?.requires) ? r.requires : []) if (typeof d === 'string' && !reqIds.has(d)) c.err(`$.requirements[${i}].requires`, `知らない要件 ${d}`);
  }

  // アドレス
  const allowed = [];
  if (c.obj(s.addressing, '$.addressing', ['allowed'])) {
    for (const [i, x] of (c.arr(s.addressing.allowed, '$.addressing.allowed', { min: 1, max: 16 }) ?? []).entries()) if (c.cidr(x, `$.addressing.allowed[${i}]`)) allowed.push(x);
  }
  const inAllowed = (ip, path) => { if (isIpv4(ip) && allowed.length && !allowed.some((x) => inCidr(ip, x))) c.err(path, `addressing.allowed の範囲の外（${ip}）`); };

  // スイッチ
  if (s.switch !== undefined && c.obj(s.switch, '$.switch', ['mode', 'locked'])) {
    c.str(s.switch.mode, '$.switch.mode', { enumOf: ['switch', 'hub'] });
    c.bool(s.switch.locked, '$.switch.locked');   // true: 学習者はスイッチ（モード・ポートの VLAN）を変えられない
  }

  // ノード
  const nodes = new Map();
  const ports = new Set();
  let vms = 0, probes = 0;
  for (const [i, n] of (c.arr(s.nodes, '$.nodes', { min: 1, max: LIMITS.maxVms + LIMITS.maxProbes }) ?? []).entries()) {
    const p = `$.nodes[${i}]`;
    if (!c.obj(n, p, ['id', 'kind', 'role', 'name', 'port', 'vlan', 'address', 'gateway', 'mac', 'init', 'locked', 'note'])) continue;
    if (c.str(n.id, `${p}.id`, { pattern: ID })) {
      if (nodes.has(n.id)) c.err(`${p}.id`, '重複している');
      nodes.set(n.id, n);
    }
    c.str(n.kind, `${p}.kind`, { enumOf: ['vm', 'probe'] });
    c.str(n.name, `${p}.name`, { max: 16 });
    c.str(n.note, `${p}.note`, { required: false, max: LIMITS.maxShort });
    const isVm = n.kind === 'vm';
    if (isVm) vms++; else if (n.kind === 'probe') probes++;
    // ポート: VM は 0〜7（画面のスロット）、プローブは 8〜11（画面には出さない）
    const [lo, hi] = isVm ? [0, LIMITS.maxVms - 1] : [LIMITS.maxVms, LIMITS.maxVms + LIMITS.maxProbes - 1];
    if (c.int(n.port, `${p}.port`, { min: lo, max: hi }) !== undefined) {
      if (ports.has(n.port)) c.err(`${p}.port`, '重複している');
      ports.add(n.port);
    }
    if (n.vlan !== undefined) validateVlan(c, n.vlan, `${p}.vlan`);
    if (n.address !== undefined && c.str(n.address, `${p}.address`)) {
      const a = parseCidr(n.address);
      if (!a) c.err(`${p}.address`, 'IP/プレフィックス（例 192.168.10.11/24）でない');
      else if (c.ip(a.ip, `${p}.address`)) inAllowed(a.ip, `${p}.address`);
    }
    if (n.gateway !== undefined && c.ip(n.gateway, `${p}.gateway`)) inAllowed(n.gateway, `${p}.gateway`);
    if (n.mac !== undefined) c.str(n.mac, `${p}.mac`, { pattern: MAC });
    if (isVm) {
      c.str(n.role, `${p}.role`, { enumOf: ROLES });
      for (const [j, cmd] of (c.arr(n.init, `${p}.init`, { required: false, max: LIMITS.maxInit }) ?? []).entries()) c.str(cmd, `${p}.init[${j}]`, { max: LIMITS.maxCommand });
      c.bool(n.locked, `${p}.locked`);
    } else if (n.kind === 'probe') {
      if (n.role !== undefined) c.err(`${p}.role`, 'プローブには付けない');
      if (n.init !== undefined) c.err(`${p}.init`, 'プローブには付けない');
      if (n.address === undefined) c.err(`${p}.address`, 'プローブには必須');
      if (n.mac === undefined) c.err(`${p}.mac`, 'プローブには必須');
    }
  }
  if (vms === 0) c.err('$.nodes', 'VM が1台もない');
  if (vms > LIMITS.maxVms) c.err('$.nodes', `VM は ${LIMITS.maxVms} 台まで`);
  if (probes > LIMITS.maxProbes) c.err('$.nodes', `プローブは ${LIMITS.maxProbes} 個まで`);
  const isKind = (id, kind) => nodes.get(id)?.kind === kind;

  // 学習者に許す操作
  if (s.allow !== undefined && c.obj(s.allow, '$.allow', ['addVms', 'removeVms'])) {
    c.int(s.allow.addVms, '$.allow.addVms', { required: false, min: 0, max: LIMITS.maxVms });
    c.bool(s.allow.removeVms, '$.allow.removeVms');
  }

  // 検査
  const checkIds = new Set();
  for (const [i, k] of (c.arr(s.checks, '$.checks', { min: 1, max: LIMITS.maxChecks }) ?? []).entries()) {
    const p = `$.checks[${i}]`;
    if (!c.obj(k, p, ['id', 'requirement', 'title', 'type', 'from', 'to', 'port', 'path', 'expect', 'timeoutMs', 'failMessage', 'stimulus', 'observe', 'durationMs', 'command', 'listener'])) continue;
    if (c.str(k.id, `${p}.id`, { pattern: ID })) {
      if (checkIds.has(k.id)) c.err(`${p}.id`, '重複している');
      checkIds.add(k.id);
    }
    if (c.str(k.requirement, `${p}.requirement`, { pattern: REQ_ID }) && !reqIds.has(k.requirement)) c.err(`${p}.requirement`, `知らない要件 ${k.requirement}`);
    c.str(k.title, `${p}.title`);
    c.str(k.failMessage, `${p}.failMessage`, { required: false, max: LIMITS.maxText });
    c.int(k.timeoutMs, `${p}.timeoutMs`, { required: false, min: 500, max: 60000 });
    if (!c.str(k.type, `${p}.type`)) continue;
    if (!CHECK_TYPES.includes(k.type)) { c.err(`${p}.type`, `知らない検査の種類 "${k.type}"`); continue; }
    if (TRUSTED_ONLY_TYPES.has(k.type) && !trusted) { c.err(`${p}.type`, `"${k.type}" は同梱のシナリオだけで使える（読み込んだシナリオでは使えない）`); continue; }
    validateCheck(c, k, p, { nodes, isKind, inAllowed });
  }
  if (Array.isArray(s.requirements)) {
    for (const r of s.requirements) if (r?.id && Array.isArray(s.checks) && !s.checks.some((k) => k?.requirement === r.id)) c.err('$.checks', `要件 ${r.id} の検査が1つもない`);
  }

  // ヒント
  for (const [i, h] of (c.arr(s.hints, '$.hints', { required: false, max: 10 }) ?? []).entries()) {
    const p = `$.hints[${i}]`;
    if (!c.obj(h, p, ['level', 'text'])) continue;
    c.int(h.level, `${p}.level`, { min: 1, max: 10 });
    c.str(h.text, `${p}.text`, { max: LIMITS.maxText });
  }

  if (c.errors.length) return { ok: false, errors: c.errors, scenario: null };
  // 既定の値を埋めた、深い複製（呼び出し側が元の値を変えても影響しない）
  const out = JSON.parse(JSON.stringify(s));
  out.image ??= 'v86net';
  out.feedback ??= 'summary';
  out.switch = { mode: 'switch', locked: false, ...(out.switch ?? {}) };
  out.allow = { addVms: 0, removeVms: false, ...(out.allow ?? {}) };
  out.hints = (out.hints ?? []).sort((a, b) => a.level - b.level);
  out.trusted = trusted;
  for (const r of out.requirements) r.requires ??= [];
  for (const n of out.nodes) {
    n.init ??= [];
    n.locked ??= false;
    if (n.kind === 'vm') n.vlan ??= { mode: 'access', access: 1 };
  }
  for (const k of out.checks) k.timeoutMs ??= defaultTimeout(k.type);
  return { ok: true, errors: [], scenario: out };
}

const defaultTimeout = (type) => ({ http: 8000, capture: 10000, tcp_source: 8000, shell: 15000 }[type] ?? 5000);

function validateVlan(c, v, p) {
  if (!c.obj(v, p, ['mode', 'access', 'allowed', 'native'])) return;
  c.str(v.mode, `${p}.mode`, { enumOf: ['access', 'trunk'] });
  c.int(v.access, `${p}.access`, { required: false, min: 1, max: 4094 });
  c.int(v.native, `${p}.native`, { required: false, min: 1, max: 4094 });
  for (const [i, x] of (c.arr(v.allowed, `${p}.allowed`, { required: false, max: 64 }) ?? []).entries()) c.int(x, `${p}.allowed[${i}]`, { min: 1, max: 4094 });
}

function validateCheck(c, k, p, { nodes, isKind, inAllowed }) {
  const from = c.str(k.from, `${p}.from`, { pattern: ID });
  if (from && !nodes.has(from)) c.err(`${p}.from`, `知らないノード ${from}`);
  const needTo = () => { if (c.ip(k.to, `${p}.to`)) inAllowed(k.to, `${p}.to`); };
  const port = () => c.int(k.port, `${p}.port`, { min: 1, max: 65535 });
  const exp = (keys) => c.obj(k.expect, `${p}.expect`, keys);
  const noExtra = (keys) => { for (const x of keys) if (k[x] !== undefined) c.err(`${p}.${x}`, `${k.type} では使わない`); };
  switch (k.type) {
    case 'ping': {
      needTo(); noExtra(['port', 'path', 'stimulus', 'observe', 'durationMs', 'command', 'listener']);
      if (exp(['reach'])) c.str(k.expect.reach, `${p}.expect.reach`, { enumOf: ['success', 'failure'] });
      break;
    }
    case 'tcp': {
      needTo(); port(); noExtra(['path', 'stimulus', 'observe', 'durationMs', 'command', 'listener']);
      // not_open: 接続できない（RST・無応答・届かない のどれでも）。closed は以前の名前で、意味は not_open と同じ
      if (exp(['state'])) c.str(k.expect.state, `${p}.expect.state`, { enumOf: ['open', 'not_open', 'closed'] });
      break;
    }
    case 'http': {
      needTo(); port(); noExtra(['stimulus', 'observe', 'durationMs', 'command', 'listener']);
      c.str(k.path, `${p}.path`, { required: false, pattern: PATH });
      if (exp(['status', 'bodyIncludes'])) {
        c.int(k.expect.status, `${p}.expect.status`, { required: false, min: 100, max: 599 });
        c.str(k.expect.bodyIncludes, `${p}.expect.bodyIncludes`, { required: false, max: LIMITS.maxShort });
        if (k.expect.status === undefined && k.expect.bodyIncludes === undefined) c.err(`${p}.expect`, 'status か bodyIncludes のどちらかが要る');
      }
      break;
    }
    case 'route': {
      noExtra(['to', 'port', 'path', 'stimulus', 'observe', 'durationMs', 'command', 'listener']);
      if (from && !isKind(from, 'vm')) c.err(`${p}.from`, 'route は VM から（ゲストのルーティングテーブルを読む）');
      if (exp(['defaultGateway'])) c.ip(k.expect.defaultGateway, `${p}.expect.defaultGateway`);
      break;
    }
    case 'ttl': {
      needTo(); noExtra(['port', 'path', 'stimulus', 'observe', 'durationMs', 'command', 'listener']);
      if (exp(['ttl'])) c.int(k.expect.ttl, `${p}.expect.ttl`, { min: 1, max: 255 });
      break;
    }
    case 'capture': {
      noExtra(['to', 'port', 'path', 'expect', 'command', 'listener']);
      // きっかけ（stimulus）は VM から出す。検査用のプローブの通信は観測から除くので、プローブからは出さない
      if (from && !isKind(from, 'vm')) c.err(`${p}.from`, 'capture のきっかけは VM から');
      if (c.obj(k.stimulus, `${p}.stimulus`, ['action', 'target'])) {
        c.str(k.stimulus.action, `${p}.stimulus.action`, { enumOf: ['arp', 'ping'] });
        if (c.ip(k.stimulus.target, `${p}.stimulus.target`)) inAllowed(k.stimulus.target, `${p}.stimulus.target`);
      }
      if (c.obj(k.observe, `${p}.observe`, ['protocol', 'mustNotReach', 'mustReach'])) {
        c.str(k.observe.protocol, `${p}.observe.protocol`, { enumOf: CAPTURE_PROTOCOLS });
        const lists = ['mustNotReach', 'mustReach'].filter((x) => k.observe[x] !== undefined);
        if (lists.length === 0) c.err(`${p}.observe`, 'mustNotReach か mustReach が要る');
        for (const x of lists) {
          for (const [j, id] of (c.arr(k.observe[x], `${p}.observe.${x}`, { min: 1, max: 12 }) ?? []).entries()) {
            if (c.str(id, `${p}.observe.${x}[${j}]`, { pattern: ID }) && !nodes.has(id)) c.err(`${p}.observe.${x}[${j}]`, `知らないノード ${id}`);
          }
        }
      }
      c.int(k.durationMs, `${p}.durationMs`, { required: false, min: 500, max: 20000 });
      break;
    }
    case 'tcp_source': {
      // VM（from）から、プローブ（listener）の port へ TCP で接続し、プローブが受けた接続の送り元 IP を見る（NAT の確認）
      noExtra(['to', 'path', 'stimulus', 'observe', 'durationMs', 'command']);
      if (from && !isKind(from, 'vm')) c.err(`${p}.from`, 'tcp_source は VM から（接続を始める側）');
      if (c.str(k.listener, `${p}.listener`, { pattern: ID }) && !isKind(k.listener, 'probe')) c.err(`${p}.listener`, '待ち受けるのはプローブ');
      port();
      if (exp(['sourceIp'])) { if (c.ip(k.expect.sourceIp, `${p}.expect.sourceIp`)) inAllowed(k.expect.sourceIp, `${p}.expect.sourceIp`); }
      break;
    }
    case 'shell': {
      noExtra(['to', 'port', 'path', 'stimulus', 'observe', 'durationMs', 'listener']);
      if (from && !isKind(from, 'vm')) c.err(`${p}.from`, 'shell は VM から');
      c.str(k.command, `${p}.command`, { max: LIMITS.maxCommand });
      if (exp(['exitCode', 'outputIncludes'])) {
        c.int(k.expect.exitCode, `${p}.expect.exitCode`, { required: false, min: 0, max: 255 });
        c.str(k.expect.outputIncludes, `${p}.expect.outputIncludes`, { required: false, max: LIMITS.maxShort });
      }
      break;
    }
  }
}

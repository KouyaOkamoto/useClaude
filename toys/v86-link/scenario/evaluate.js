// 受け入れテストの実行と判定。DOM にも v86 にも依存しない（Node でテストできる）。
//
// 検査は、ノードの種類に応じてアダプタ（差し替えられる）を通して実行する:
//   probe  … JS のプローブ（スイッチのポートにつないだ、学習者に見えないノード。probe.js）
//   vm     … 学習者の VM の2本目のシリアル（ttyS1）のシェル（vmshell.js）
//   capture… 仮想スイッチの観測（検査用の印が付いたフレームは除く）
// アダプタのメソッドは、観測した結果を返す（判定はここで行う）。例外を投げたら「エラー」にする。
//
//   adapters = {
//     probe: { ping(id, to, {timeoutMs}) → {ok, ttl?, reason?}, tcp(id, to, port, {timeoutMs}) → {state}, http(id, to, port, path, {timeoutMs}) → {ok, status?, body?, reason?} },
//     vm:    { ping(...), tcp(...), http(...) 同上, route(id) → {defaultGateway}, shell(id, command, {timeoutMs}) → {exitCode, output} },
//     capture(fromId, stimulus, { protocol, durationMs }) → { frames: [{ outNodes: [id...] }] }
//   }
//   どのメソッドも、失敗のときは { error: 'shell-unresponsive' | ... } を返してよい
//
// 検査は1つずつ順に実行する（同時に動かさない）。各検査は timeoutMs で打ち切る（アダプタが返さなければ「エラー」）。

export const STATUS = { pass: '合格', fail: '不合格', notrun: '未実行', error: 'エラー' };

const ERRORS = {
  'shell-unresponsive': '検査用シェルが応答しない（VM の中の検査用のシェルが止まっている）。VM を起動し直してから、もう一度検査してください',
  'vm-not-ready': 'VM がまだ起動していない',
  'no-node': '検査に使うノードが見つからない',
  timeout: '検査が時間内に終わらなかった',
};
export const errorText = (code) => ERRORS[code] ?? `検査を実行できなかった（${code}）`;

/** 期待と観測を比べる。{ pass, observed（観測の説明）, expected（期待の説明） } */
export function judge(check, obs) {
  const e = check.expect ?? {};
  switch (check.type) {
    case 'ping': {
      const reached = !!obs.ok;
      return { pass: reached === (e.reach === 'success'), expected: e.reach === 'success' ? '応答が返る' : '応答が返らない',
        observed: reached ? `応答が返った${obs.ttl ? `（TTL ${obs.ttl}）` : ''}` : `応答が返らなかった${obs.reason ? `（${reasonText(obs.reason)}）` : ''}` };
    }
    case 'tcp': {
      const open = obs.state === 'open';
      return { pass: open === (e.state === 'open'), expected: e.state === 'open' ? '接続できる' : '接続できない',
        observed: open ? '接続できた' : `接続できなかった（${reasonText(obs.state)}）` };
    }
    case 'http': {
      if (!obs.ok) return { pass: false, expected: httpExpected(e), observed: `応答を取れなかった（${reasonText(obs.reason)}）` };
      const stOk = e.status === undefined || obs.status === e.status;
      const bodyOk = e.bodyIncludes === undefined || String(obs.body ?? '').includes(e.bodyIncludes);
      return { pass: stOk && bodyOk, expected: httpExpected(e),
        observed: `ステータス ${obs.status}${e.bodyIncludes !== undefined ? (bodyOk ? '、本文に期待した文字列がある' : '、本文に期待した文字列が無い') : ''}` };
    }
    case 'route': {
      const gw = obs.defaultGateway ?? null;
      return { pass: gw === e.defaultGateway, expected: `デフォルトゲートウェイが ${e.defaultGateway}`, observed: gw ? `デフォルトゲートウェイは ${gw}` : 'デフォルトゲートウェイが無い' };
    }
    case 'ttl': {
      if (!obs.ok) return { pass: false, expected: `TTL ${e.ttl} で応答が返る`, observed: `応答が返らなかった${obs.reason ? `（${reasonText(obs.reason)}）` : ''}` };
      return { pass: obs.ttl === e.ttl, expected: `TTL ${e.ttl} で応答が返る`, observed: `TTL ${obs.ttl} で応答が返った` };
    }
    case 'capture': {
      const o = check.observe;
      const reached = new Set((obs.frames ?? []).flatMap((f) => f.outNodes ?? []));
      const leaked = (o.mustNotReach ?? []).filter((id) => reached.has(id));
      const missing = (o.mustReach ?? []).filter((id) => !reached.has(id));
      const parts = [];
      if (o.mustNotReach) parts.push(`${o.mustNotReach.join('・')} に届かない`);
      if (o.mustReach) parts.push(`${o.mustReach.join('・')} に届く`);
      const obsParts = [];
      if (leaked.length) obsParts.push(`${leaked.join('・')} に届いた`);
      if (missing.length) obsParts.push(`${missing.join('・')} に届かなかった`);
      return { pass: leaked.length === 0 && missing.length === 0, expected: `${protoText(o.protocol)}フレームが ${parts.join('、')}`,
        observed: obsParts.length ? `${protoText(o.protocol)}フレームが ${obsParts.join('、')}` : `期待どおり（${(obs.frames ?? []).length} フレームを観測）` };
    }
    case 'shell': {
      const codeOk = e.exitCode === undefined || obs.exitCode === e.exitCode;
      const outOk = e.outputIncludes === undefined || String(obs.output ?? '').includes(e.outputIncludes);
      return { pass: codeOk && outOk, expected: [e.exitCode !== undefined && `終了コード ${e.exitCode}`, e.outputIncludes !== undefined && '出力に期待した文字列がある'].filter(Boolean).join('、') || '実行できる',
        observed: `終了コード ${obs.exitCode}${e.outputIncludes !== undefined ? (outOk ? '、出力に期待した文字列がある' : '、出力に期待した文字列が無い') : ''}` };
    }
    default:
      return { pass: false, expected: '', observed: `知らない検査の種類 ${check.type}` };
  }
}
const httpExpected = (e) => [e.status !== undefined && `ステータス ${e.status}`, e.bodyIncludes !== undefined && '本文に期待した文字列がある'].filter(Boolean).join('、');
const protoText = (p) => ({ arp: 'ARP の', icmp: 'ICMP の', broadcast: 'ブロードキャストの', ipv4: 'IPv4 の' }[p] ?? '');
function reasonText(r) {
  return ({ timeout: '時間内に返事が無い', 'arp-failed': '相手（または次のホップ）の MAC アドレスが分からない', 'ttl-exceeded': '途中で TTL が切れた',
    unreachable: '到達できないという ICMP が返った', closed: '相手が接続を断った（RST）', filtered: '返事が無い', refused: '接続を断られた',
    'timeout-connect': '接続の時間切れ', 'timeout-response': '応答の時間切れ', 'bad-response': 'HTTP の応答でない', 'not-open': '接続できない' }[r] ?? (r ?? '不明'));
}

/** 1つの検査を実行して観測を得る（アダプタを呼ぶだけ。判定はしない） */
async function observe(check, kind, adapters) {
  const from = check.from, t = { timeoutMs: check.timeoutMs };
  const a = kind === 'probe' ? adapters.probe : adapters.vm;
  switch (check.type) {
    case 'ping': return a.ping(from, check.to, t);
    case 'ttl': return a.ping(from, check.to, t);
    case 'tcp': return a.tcp(from, check.to, check.port, t);
    case 'http': return a.http(from, check.to, check.port, check.path ?? '/', t);
    case 'route': return adapters.vm.route(from, t);
    case 'shell': return adapters.vm.shell(from, check.command, t);
    case 'capture': return adapters.capture(from, check.stimulus, { protocol: check.observe.protocol, durationMs: check.durationMs ?? 3000 });
    default: return { error: 'unknown-type' };
  }
}

/**
 * シナリオの全部の検査を、要件の順（前提を先に）に、1つずつ実行する。
 * @returns {Promise<{ requirements: Array<{id, status, checks: Array<{id, title, status, message, observed?, expected?}>}>, summary: {pass, fail, notrun, error} }>}
 *   onProgress({ index, total, check })  を、各検査の前に呼ぶ
 *   setTimer(fn, ms) / clearTimer(t)     時計（テストで差し替える）
 */
export async function runChecks(scenario, adapters, { onProgress = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, only = null } = {}) {
  const kindOf = new Map(scenario.nodes.map((n) => [n.id, n.kind]));
  const detailed = scenario.feedback === 'detailed';
  const order = orderRequirements(scenario.requirements);
  const byReq = new Map(order.map((r) => [r.id, { id: r.id, status: 'notrun', checks: [] }]));
  const checks = scenario.checks.filter((k) => !only || only.includes(k.id));
  const total = checks.length;
  let index = 0;
  for (const req of order) {
    const res = byReq.get(req.id);
    const mine = checks.filter((k) => k.requirement === req.id);
    const blocked = req.requires.filter((d) => byReq.get(d)?.status !== 'pass');
    for (const check of mine) {
      onProgress({ index: index++, total, check });
      if (blocked.length) {
        res.checks.push({ id: check.id, title: check.title, status: 'notrun', message: `前提の要件（${blocked.join('・')}）が合格していないので、実行していない` });
        continue;
      }
      res.checks.push(await runOne(check, kindOf.get(check.from), adapters, { detailed, setTimer, clearTimer }));
    }
    res.status = blocked.length ? 'notrun' : aggregate(res.checks.map((c) => c.status));
  }
  const requirements = scenario.requirements.map((r) => byReq.get(r.id));
  const summary = { pass: 0, fail: 0, notrun: 0, error: 0 };
  for (const r of requirements) summary[r.status]++;
  return { requirements, summary, allPassed: summary.pass === requirements.length };
}

async function runOne(check, kind, adapters, { detailed, setTimer, clearTimer }) {
  const base = { id: check.id, title: check.title };
  if (!kind) return { ...base, status: 'error', message: errorText('no-node') };
  let timer;
  let obs;
  try {
    obs = await Promise.race([
      Promise.resolve().then(() => observe(check, kind, adapters)),
      new Promise((resolve) => { timer = setTimer(() => resolve({ error: 'timeout' }), check.timeoutMs + 2000); }),
    ]);
  } catch (e) {
    obs = { error: 'exception: ' + (e?.message ?? String(e)) };
  } finally {
    clearTimer(timer);
  }
  if (!obs || typeof obs !== 'object') obs = { error: 'no-result' };
  if (obs.error) return { ...base, status: 'error', message: errorText(obs.error) };
  const j = judge(check, obs);
  if (j.pass) return { ...base, status: 'pass', message: '', observed: j.observed, expected: j.expected };
  // 不合格のときに見せる詳しさは、シナリオで決める（summary: 作者の文だけ / detailed: 何を確かめて何が観測されたか）
  const message = detailed
    ? `${check.title}: 期待は「${j.expected}」、観測は「${j.observed}」${check.failMessage ? '。' + check.failMessage : ''}`
    : (check.failMessage ?? `${check.title}: 期待どおりでなかった`);
  return { ...base, status: 'fail', message, ...(detailed ? { observed: j.observed, expected: j.expected } : {}) };
}

/** 検査の結果から、要件の結果を決める: エラーが1つでもあれば エラー、不合格があれば 不合格、全部合格なら 合格 */
export function aggregate(statuses) {
  if (statuses.length === 0) return 'notrun';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.every((s) => s === 'pass')) return 'pass';
  return 'notrun';
}

/** 前提（requires）を先にした順。循環していたら、残りは書いた順 */
export function orderRequirements(reqs) {
  const out = [], done = new Set(), list = reqs.map((r) => ({ ...r, requires: r.requires ?? [] }));
  let progressed = true;
  while (out.length < list.length && progressed) {
    progressed = false;
    for (const r of list) {
      if (done.has(r.id)) continue;
      if (r.requires.every((d) => done.has(d))) { out.push(r); done.add(r.id); progressed = true; }
    }
  }
  for (const r of list) if (!done.has(r.id)) out.push(r);
  return out;
}

// シナリオのコア（スキーマ・マークアップ・判定）の単体テスト。node --test toys/v86-link/test/scenario.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, SCHEMA_ID, isSafeIp, inCidr } from '../scenario/schema.js';
import { parseMarkup, parseInline, markupToText } from '../scenario/markup.js';
import { runChecks, judge, aggregate, orderRequirements, keptAfter } from '../scenario/evaluate.js';

const base = () => ({
  schema: SCHEMA_ID, id: 'tiny', title: 'テスト', difficulty: 'easy', minutes: 5, summary: '概要',
  briefing: '依頼', debrief: '解説',
  requirements: [{ id: 'R1', text: '届く' }, { id: 'R2', text: '届かない', requires: ['R1'] }],
  addressing: { allowed: ['192.168.10.0/24', '203.0.113.0/24'] },
  nodes: [
    { id: 'pc1', kind: 'vm', role: 'host', name: 'PC1', port: 0, address: '192.168.10.11/24', init: ['echo hi'] },
    { id: 'ext', kind: 'probe', name: '外', port: 8, address: '203.0.113.10/24', gateway: '203.0.113.1', mac: '02:00:cb:00:71:0a' },
  ],
  checks: [
    { id: 'c1', requirement: 'R1', title: 'PC1 から外へ ping', type: 'ping', from: 'pc1', to: '203.0.113.10', expect: { reach: 'success' } },
    { id: 'c2', requirement: 'R2', title: '外から PC1 の 22', type: 'tcp', from: 'ext', to: '192.168.10.11', port: 22, expect: { state: 'closed' }, failMessage: '外から入れてしまう' },
  ],
});

// ---------------------------------------------------------------- スキーマ

test('正しいシナリオは通り、既定の値が入る', () => {
  const r = validateScenario(base());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.scenario.feedback, 'summary');
  assert.equal(r.scenario.image, 'v86net');
  assert.equal(r.scenario.checks[0].timeoutMs, 5000);
  assert.deepEqual(r.scenario.nodes[0].vlan, { mode: 'access', access: 1 });
  assert.equal(r.scenario.trusted, false);
});

test('JSON の文字列でも読める。壊れた JSON は拒否', () => {
  assert.equal(validateScenario(JSON.stringify(base())).ok, true);
  const r = validateScenario('{ "schema": ');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /JSON として読めない/);
});

test('必須の項目が欠けていると拒否', () => {
  const s = base(); delete s.title; delete s.checks[0].from;
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.title: 必須')));
  assert.ok(r.errors.some((e) => e.startsWith('$.checks[0].from: 必須')));
});

test('型が違うと拒否', () => {
  const s = base(); s.minutes = '5'; s.nodes[0].port = 'A'; s.checks[0].expect = { reach: true };
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.minutes')));
  assert.ok(r.errors.some((e) => e.startsWith('$.nodes[0].port')));
  assert.ok(r.errors.some((e) => e.startsWith('$.checks[0].expect.reach')));
});

test('知らない項目・知らない検査の種類・版の違いは拒否', () => {
  const s = base(); s.extra = 1; s.checks[0].type = 'exec'; s.schema = 'v86-link-scenario/2';
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.extra: 知らない項目')));
  assert.ok(r.errors.some((e) => /知らない検査の種類 "exec"/.test(e)));
  assert.ok(r.errors.some((e) => e.startsWith('$.schema')));
});

test('shell の検査は同梱のシナリオ（trusted）だけで使える', () => {
  const s = base();
  s.checks.push({ id: 'c3', requirement: 'R1', title: 'ファイル', type: 'shell', from: 'pc1', command: 'test -f /etc/hostname', expect: { exitCode: 0 } });
  const untrusted = validateScenario(s);
  assert.equal(untrusted.ok, false);
  assert.ok(untrusted.errors.some((e) => /同梱のシナリオだけで使える/.test(e)));
  const trusted = validateScenario(s, { trusted: true });
  assert.equal(trusted.ok, true, trusted.errors.join('\n'));
  assert.equal(trusted.scenario.trusted, true);
});

test('アドレスはプライベートかドキュメント用だけ。addressing.allowed の外も拒否', () => {
  assert.equal(isSafeIp('8.8.8.8'), false);
  assert.equal(isSafeIp('198.51.100.7'), true);
  assert.equal(inCidr('192.168.10.11', '192.168.10.0/24'), true);
  const s = base(); s.checks[0].to = '8.8.8.8'; s.nodes[0].address = '192.168.99.11/24';
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.checks[0].to') && /ドキュメント用/.test(e)));
  assert.ok(r.errors.some((e) => e.startsWith('$.nodes[0].address') && /範囲の外/.test(e)));
});

test('要件と検査の対応: 知らない要件・検査の無い要件・知らないノード・前提の要件', () => {
  const s = base(); s.checks[0].requirement = 'R9'; s.checks[1].from = 'nobody'; s.requirements[1].requires = ['R7'];
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /知らない要件 R9/.test(e)));
  assert.ok(r.errors.some((e) => /要件 R1 の検査が1つもない/.test(e)));
  assert.ok(r.errors.some((e) => /知らないノード nobody/.test(e)));
  assert.ok(r.errors.some((e) => /知らない要件 R7/.test(e)));
});

test('文字列の長さ・制御文字・ID の書き方・パスの文字を制限する', () => {
  const s = base();
  s.summary = 'x'.repeat(5000);
  s.title = 'a\u0007b';
  s.id = 'Bad ID';
  s.checks.push({ id: 'c3', requirement: 'R1', title: 'h', type: 'http', from: 'pc1', to: '203.0.113.10', port: 80, path: '/x;rm -rf /', expect: { status: 200 } });
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.summary: 長すぎる')));
  assert.ok(r.errors.some((e) => e.startsWith('$.title: 制御文字')));
  assert.ok(r.errors.some((e) => e.startsWith('$.id: 書き方が違う')));
  assert.ok(r.errors.some((e) => e.startsWith('$.checks[2].path')));
});

test('プローブとVMの制約（ポートの範囲・プローブの必須・capture のきっかけは VM）', () => {
  const s = base();
  s.nodes[1].port = 3;   // プローブは 8〜11
  delete s.nodes[1].mac;
  s.checks.push({ id: 'c3', requirement: 'R1', title: 'cap', type: 'capture', from: 'ext', stimulus: { action: 'arp', target: '192.168.10.99' }, observe: { protocol: 'arp', mustNotReach: ['pc1'] } });
  const r = validateScenario(s);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.nodes[1].port')));
  assert.ok(r.errors.some((e) => e.startsWith('$.nodes[1].mac')));
  assert.ok(r.errors.some((e) => /capture のきっかけは VM から/.test(e)));
});

test('オブジェクトでない入力（null・配列・数）は拒否', () => {
  for (const x of [null, [], 3, 'null']) assert.equal(validateScenario(x).ok, false);
});

// ---------------------------------------------------------------- マークアップ

test('マークアップ: 段落・箇条書き・コード・強調。HTML は解釈しない', () => {
  const b = parseMarkup('こんにちは **大事** と `ping`\n2行目\n\n- 一つ目\n- <b>二つ目</b>\n\n```\n<script>alert(1)</script>\n```');
  assert.equal(b[0].type, 'p');
  assert.deepEqual(b[0].lines[0], [{ t: 'text', v: 'こんにちは ' }, { t: 'strong', v: '大事' }, { t: 'text', v: ' と ' }, { t: 'code', v: 'ping' }]);
  assert.equal(b[0].lines.length, 2);
  assert.equal(b[1].type, 'ul');
  assert.deepEqual(b[1].items[1], [{ t: 'text', v: '<b>二つ目</b>' }]);
  assert.deepEqual(b[2], { type: 'code', text: '<script>alert(1)</script>' });
  assert.deepEqual(parseInline('**閉じない'), [{ t: 'text', v: '**閉じない' }]);
  assert.match(markupToText('- a\n- b'), /・a\n・b/);
});

// ---------------------------------------------------------------- 判定

const fakeAdapters = (over = {}) => ({
  probe: { ping: async () => ({ ok: true, ttl: 63 }), tcp: async () => ({ state: 'closed' }), http: async () => ({ ok: true, status: 200, body: 'hello' }), ...(over.probe ?? {}) },
  vm: { ping: async () => ({ ok: true, ttl: 64 }), tcp: async () => ({ state: 'open' }), http: async () => ({ ok: true, status: 200, body: 'hello' }),
    route: async () => ({ defaultGateway: '192.168.10.1' }), shell: async () => ({ exitCode: 0, output: '' }), ...(over.vm ?? {}) },
  capture: over.capture ?? (async () => ({ frames: [] })),
});
const scenario = (mut = (s) => s) => validateScenario(mut(base()), { trusted: true }).scenario;

test('判定: すべて合格', async () => {
  const r = await runChecks(scenario(), fakeAdapters());
  assert.equal(r.allPassed, true);
  assert.deepEqual(r.requirements.map((x) => x.status), ['pass', 'pass']);
});

test('判定: 不合格（summary は作者の文だけ）と、前提が不合格なら未実行', async () => {
  const r = await runChecks(scenario(), fakeAdapters({ vm: { ping: async () => ({ ok: false, reason: 'timeout' }) } }));
  assert.equal(r.requirements[0].status, 'fail');
  assert.equal(r.requirements[1].status, 'notrun');
  assert.match(r.requirements[1].checks[0].message, /前提の要件（R1）/);
  assert.equal(r.requirements[0].checks[0].observed, undefined);   // summary では観測を出さない
  const r2 = await runChecks(scenario(), fakeAdapters({ probe: { tcp: async () => ({ state: 'open' }) } }));
  assert.equal(r2.requirements[1].status, 'fail');
  assert.equal(r2.requirements[1].checks[0].message, '外から入れてしまう');
});

test('判定: detailed では、期待と観測を出す', async () => {
  const s = scenario((x) => ({ ...x, feedback: 'detailed' }));
  const r = await runChecks(s, fakeAdapters({ probe: { tcp: async () => ({ state: 'open' }) } }));
  const c = r.requirements[1].checks[0];
  assert.equal(c.status, 'fail');
  assert.match(c.message, /期待は「接続できない」、観測は「接続できた」/);
});

test('判定: アダプタが返さない（タイムアウト）・例外・エラーの返り値は「エラー」', async () => {
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return timers.length; };
  const p = runChecks(scenario(), fakeAdapters({ vm: { ping: () => new Promise(() => {}) } }), { setTimer, clearTimer: () => {} });
  await new Promise((r) => setImmediate(r));
  timers[0]();
  const r = await p;
  assert.equal(r.requirements[0].status, 'error');
  assert.match(r.requirements[0].checks[0].message, /時間内に終わらなかった/);
  const r2 = await runChecks(scenario(), fakeAdapters({ vm: { ping: async () => { throw new Error('壊れた'); } } }));
  assert.equal(r2.requirements[0].status, 'error');
  const r3 = await runChecks(scenario(), fakeAdapters({ vm: { ping: async () => ({ error: 'shell-unresponsive' }) } }));
  assert.match(r3.requirements[0].checks[0].message, /検査用シェルが応答しない.*起動し直して/);
});

test('判定: 検査は1つずつ順に動く（同時に動かさない）', async () => {
  let running = 0, max = 0;
  const slow = async () => { running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 5)); running--; return { ok: true }; };
  const s = scenario((x) => { x.checks.push({ ...x.checks[0], id: 'c3' }, { ...x.checks[0], id: 'c4' }); return x; });
  await runChecks(s, fakeAdapters({ vm: { ping: slow } }));
  assert.equal(max, 1);
});

test('判定の種類ごと: http・route・ttl・capture・shell', () => {
  assert.equal(judge({ type: 'http', expect: { status: 200, bodyIncludes: 'ok' } }, { ok: true, status: 200, body: 'is ok' }).pass, true);
  assert.equal(judge({ type: 'http', expect: { status: 200 } }, { ok: true, status: 404 }).pass, false);
  assert.equal(judge({ type: 'http', expect: { status: 200 } }, { ok: false, reason: 'refused' }).pass, false);
  assert.equal(judge({ type: 'route', expect: { defaultGateway: '10.0.0.1' } }, { defaultGateway: null }).pass, false);
  assert.equal(judge({ type: 'ttl', expect: { ttl: 63 } }, { ok: true, ttl: 63 }).pass, true);
  const cap = { type: 'capture', observe: { protocol: 'arp', mustNotReach: ['dev1'], mustReach: ['sales2'] } };
  assert.equal(judge(cap, { frames: [{ outNodes: ['sales2'] }] }).pass, true);
  const leak = judge(cap, { frames: [{ outNodes: ['sales2', 'dev1'] }] });
  assert.equal(leak.pass, false);
  assert.match(leak.observed, /dev1 に届いた/);
  assert.equal(judge({ type: 'shell', expect: { exitCode: 0, outputIncludes: 'x' } }, { exitCode: 0, output: 'yxz' }).pass, true);
});

test('要件の順・まとめ方', () => {
  assert.deepEqual(orderRequirements([{ id: 'R2', requires: ['R1'] }, { id: 'R1' }]).map((r) => r.id), ['R1', 'R2']);
  assert.deepEqual(orderRequirements([{ id: 'R1', requires: ['R2'] }, { id: 'R2', requires: ['R1'] }]).map((r) => r.id), ['R1', 'R2']);
  assert.equal(aggregate(['pass', 'fail', 'error']), 'error');
  assert.equal(aggregate(['pass', 'fail']), 'fail');
  assert.equal(aggregate([]), 'notrun');
});

test('同梱のシナリオ（scenarios/）は、どれも検証に通る（shell の検査を使わないものは trusted でなくても）', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../scenarios/', import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
  assert.ok(index.scenarios.length >= 2);
  for (const x of index.scenarios) {
    const text = fs.readFileSync(new URL(x.file, dir), 'utf8');
    const r = validateScenario(text, { trusted: true });
    assert.deepEqual(r.errors, [], `${x.file}（trusted）`);
    assert.equal(r.scenario.id, x.id);
    // shell の検査を使うもの（S6）は、同梱だから通る。読み込んだ（trusted でない）ときは、その理由だけで拒否される
    const u = validateScenario(text, { trusted: false });
    if (r.scenario.checks.some((k) => k.type === 'shell')) {
      assert.equal(u.ok, false, x.file);
      assert.ok(u.errors.every((e) => /同梱のシナリオだけ/.test(e)), `${x.file}: ${u.errors.join(' / ')}`);
    } else {
      assert.deepEqual(u.errors, [], `${x.file}（trusted: false）`);
    }
    // 公開のディレクトリに、模範解答を置かない（解答は test/scenario-answers/）
    assert.doesNotMatch(text, /answer|解答/i);
  }
});

test('S3 で足した検査の種類のスキーマ: tcp の not_open・tcp_source・switch.locked', () => {
  const sc = base();
  sc.switch = { mode: 'switch', locked: true };
  sc.checks.push({ id: 'n1', requirement: 'R1', title: 't', type: 'tcp', from: 'ext', to: '203.0.113.1', port: 22, expect: { state: 'not_open' } });
  sc.checks.push({ id: 's1', requirement: 'R1', title: 't', type: 'tcp_source', from: sc.nodes[0].id, listener: 'ext', port: 8080, expect: { sourceIp: '203.0.113.1' } });
  const r = validateScenario(sc);
  assert.deepEqual(r.errors, []);
  assert.equal(r.scenario.switch.locked, true);
  assert.equal(r.scenario.checks.find((k) => k.id === 's1').timeoutMs, 8000);
  // 省略したときの switch は固定しない
  const plain = base();
  delete plain.switch;
  assert.deepEqual(validateScenario(plain).scenario.switch, { mode: 'switch', locked: false, allow: { dai: false }, dai: { vlans: [], bindings: [], srcMacCheck: true, trusted: [] } });
  // 誤り: 待ち受けが VM / tcp_source に to / 送り元がアドレスの範囲外 / 知らない state / ほかの種類に listener
  const bad = (mut) => { const x = JSON.parse(JSON.stringify(sc)); mut(x); return validateScenario(x).errors.join('\n'); };
  assert.match(bad((x) => { x.checks.at(-1).listener = x.nodes[0].id; }), /待ち受けるのはプローブ/);
  assert.match(bad((x) => { x.checks.at(-1).from = 'ext'; }), /VM から/);
  assert.match(bad((x) => { x.checks.at(-1).to = '203.0.113.50'; }), /tcp_source では使わない/);
  assert.match(bad((x) => { x.checks.at(-1).expect.sourceIp = '198.51.100.1'; }), /範囲の外/);
  assert.match(bad((x) => { x.checks.at(-2).expect.state = 'filtered'; }), /state/);
  assert.match(bad((x) => { x.checks.at(-2).listener = 'ext'; }), /tcp では使わない/);
  assert.match(bad((x) => { x.switch.locked = 'yes'; }), /locked/);
});

test('試験用の端末（testOnly）は、検査に使えない（出す・待ち受ける・観測する・宛先・期待する送り元）', () => {
  const sc = base();
  sc.nodes.push({ id: 'inet', kind: 'vm', role: 'host', name: 'INET', port: 2, address: '203.0.113.60/24', testOnly: true });
  const ok = validateScenario(sc);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.scenario.nodes.find((n) => n.id === 'inet').testOnly, true);
  assert.equal(ok.scenario.nodes.find((n) => n.id === 'pc1').testOnly, false);
  const bad = (check) => { const x = JSON.parse(JSON.stringify(sc)); x.checks.push({ id: 'z', requirement: 'R1', title: 't', ...check }); return validateScenario(x).errors.join('\n'); };
  assert.match(bad({ type: 'ping', from: 'inet', to: '203.0.113.10', expect: { reach: 'success' } }), /試験用の端末 inet/);
  assert.match(bad({ type: 'ping', from: 'pc1', to: '203.0.113.60', expect: { reach: 'success' } }), /試験用の端末のアドレス 203\.0\.113\.60/);
  assert.match(bad({ type: 'tcp_source', from: 'inet', listener: 'ext', port: 8080, expect: { sourceIp: '203.0.113.1' } }), /試験用の端末 inet/);
  assert.match(bad({ type: 'capture', from: 'pc1', stimulus: { action: 'arp', target: '192.168.10.99' }, observe: { protocol: 'arp', mustReach: ['inet'] } }), /試験用の端末 inet/);
  assert.match(bad({ type: 'capture', from: 'pc1', stimulus: { action: 'ping', target: '203.0.113.60' }, observe: { protocol: 'icmp', mustNotReach: ['ext'] } }), /試験用の端末のアドレス/);
  const t = JSON.parse(JSON.stringify(sc)); t.nodes.at(-1).testOnly = 'yes';
  assert.match(validateScenario(t).errors.join('\n'), /testOnly/);
});

const baseOf = base;
test('S6 で足したスキーマ: switch.allow.dai・switch.dai（初期の設定）・capture の mustBeDropped', () => {
  const base = JSON.parse(JSON.stringify(baseOf()));
  base.switch = { mode: 'switch', locked: true, allow: { dai: true }, dai: { vlans: [1], bindings: [{ vlan: 1, ip: '192.168.10.11', mac: '02:00:c0:a8:0a:0b' }], srcMacCheck: true, trusted: [base.nodes[0].id] } };
  const r = validateScenario(base);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.scenario.switch.allow, { dai: true });
  assert.deepEqual(r.scenario.switch.dai.vlans, [1]);
  const bad = (f) => { const x = JSON.parse(JSON.stringify(base)); f(x); const v = validateScenario(x); assert.equal(v.ok, false); return v.errors.join(' / '); };
  assert.match(bad((x) => { x.switch.dai.vlans = [5000]; }), /4094/);
  assert.match(bad((x) => { x.switch.dai.bindings = [{ vlan: 1, ip: '192.168.10.11', mac: 'ff:ff:ff:ff:ff:ff' }]; }), /マルチキャスト/);
  assert.match(bad((x) => { x.switch.dai.bindings = [{ vlan: 1, ip: '8.8.8.8', mac: '02:00:00:00:00:01' }]; }), /プライベート/);
  assert.match(bad((x) => { x.switch.dai.trusted = ['nobody']; }), /知らないノード/);
  assert.match(bad((x) => { x.switch.allow = { cable: true }; }), /知らない項目/);
  assert.match(bad((x) => { x.switch.dai.extra = 1; }), /知らない項目/);
  // capture の mustBeDropped（DAI の理由だけ）。mustNotReach・mustReach が無くてもよい
  const cap = (obs) => { const x = JSON.parse(JSON.stringify(base)); x.checks = [{ id: 'c', requirement: x.requirements[0].id, title: 't', type: 'capture', from: x.nodes[0].id, stimulus: { action: 'arp', target: '192.168.10.1' }, observe: obs }];
    x.requirements = [x.requirements[0]]; return validateScenario(x); };
  assert.equal(cap({ protocol: 'arp', mustBeDropped: 'arp-inspection' }).ok, true);
  assert.equal(cap({ protocol: 'arp', mustBeDropped: 'cable' }).ok, false);
  assert.equal(cap({ protocol: 'arp' }).ok, false);
});

test('判定: capture の mustBeDropped（1 件以上観測し、すべてその理由で捨てられていれば合格）', () => {
  const k = { type: 'capture', observe: { protocol: 'arp', mustBeDropped: 'arp-inspection' } };
  assert.equal(judge(k, { frames: [{ outNodes: [], reason: 'arp-inspection' }, { outNodes: [], reason: 'arp-inspection' }] }).pass, true);
  assert.equal(judge(k, { frames: [{ outNodes: [], reason: 'arp-inspection' }, { outNodes: ['pc1'], reason: null }] }).pass, false);
  const none = judge(k, { frames: [] });
  assert.equal(none.pass, false);
  assert.match(none.observed, /観測できなかった/);
});

// ---------------------------------------------------------------- S7（観察型）で足した項目

/** S7 の形: 攻撃者ノードと、それを動かす / 止めるボタン。R1 は止まっているとき、R2 は動いているときに確かめる（どちらも once） */
const s7 = (mut = (x) => x) => {
  const x = base();
  x.requirements = [{ id: 'R1', text: '前', once: true }, { id: 'R2', text: '後', once: true }];
  x.nodes.push({ id: 'atk', kind: 'attacker', name: 'X', port: 9, address: '192.168.10.66/24', mac: '02:00:c0:a8:0a:42',
    attack: { targets: ['192.168.10.11', '192.168.10.1'], showLoot: true, autoStart: false } });
  x.controls = [{ id: 'start', label: '攻撃を始める', action: 'attacker-start', target: 'atk' }, { id: 'stop', label: '攻撃を止める', action: 'attacker-stop', target: 'atk' }];
  x.checks = [
    { id: 'before', requirement: 'R1', title: '前', type: 'capture', from: 'pc1', when: { attacker: 'atk', running: false },
      stimulus: { action: 'ping', target: '192.168.10.1' }, observe: { protocol: 'ipv4', mustNotReach: ['atk'] } },
    { id: 'after', requirement: 'R2', title: '後', type: 'capture', from: 'pc1', when: { attacker: 'atk', running: true },
      stimulus: { action: 'ping', target: '192.168.10.1' }, observe: { protocol: 'ipv4', mustReach: ['atk'] } },
  ];
  return mut(x);
};

test('S7 で足したスキーマ: controls・要件の once・検査の when・攻撃者の autoStart', () => {
  const r = validateScenario(s7());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.scenario.controls.length, 2);
  assert.deepEqual(r.scenario.requirements.map((x) => x.once), [true, true]);
  assert.equal(r.scenario.nodes.find((n) => n.id === 'atk').attack.autoStart, false);
  // 既定: controls は空・once は false・autoStart は true（S1〜S6 はいままでどおり）
  const d = validateScenario(base()).scenario;
  assert.deepEqual(d.controls, []);
  assert.deepEqual(d.requirements.map((x) => x.once), [false, false]);
  const d2 = validateScenario(s7((x) => { delete x.nodes[2].attack.autoStart; return x; })).scenario;
  assert.equal(d2.nodes[2].attack.autoStart, true);
  const bad = (f) => { const v = validateScenario(s7((x) => { f(x); return x; })); assert.equal(v.ok, false); return v.errors.join(' / '); };
  assert.match(bad((x) => { x.controls[0].action = 'shell'; }), /controls\[0\]\.action/);
  assert.match(bad((x) => { x.controls[0].target = 'pc1'; }), /攻撃者のノードでない/);
  assert.match(bad((x) => { x.controls[1].id = 'start'; }), /重複/);
  assert.match(bad((x) => { x.controls[0].label = 'x'.repeat(25); }), /controls\[0\]\.label/);
  assert.match(bad((x) => { x.controls[0].run = 'rm -rf /'; }), /知らない項目/);
  assert.match(bad((x) => { x.controls = new Array(9).fill(0).map((_, i) => ({ id: `c${i}`, label: 'a', action: 'attacker-stop', target: 'atk' })); }), /controls/);
  assert.match(bad((x) => { x.requirements[0].once = 'yes'; }), /once/);
  assert.match(bad((x) => { x.checks[0].when = { attacker: 'ext', running: true }; }), /攻撃者のノードでない/);
  assert.match(bad((x) => { x.checks[0].when = { attacker: 'atk' }; }), /when\.running/);
  assert.match(bad((x) => { x.checks[0].when.extra = 1; }), /知らない項目/);
  assert.match(bad((x) => { x.nodes[2].attack.autoStart = 1; }), /autoStart/);
  // 読み込んだシナリオ（trusted でない）でも使える（ボタンはページの中の攻撃者を動かすだけ）
  assert.equal(validateScenario(s7(), { trusted: false }).ok, true);
});

test('判定: when が合わない検査は実行せず不合格（どうすればよいかを出す）。once の要件は、一度合格したら検査せずに合格のまま', async () => {
  const sc = validateScenario(s7()).scenario;
  let running = false;
  const calls = [];
  // X に届いたか: 動いていれば届く
  const adapters = { ...fakeAdapters({ capture: async (from, st, o) => { calls.push(running); return { frames: [{ outNodes: running ? ['atk'] : ['router'] }] }; } }), attackerRunning: async (id) => (id === 'atk' ? running : null) };
  // 攻撃の前: R1 合格・R2 は不合格（実行しない）
  let kept = new Set();
  let r = await runChecks(sc, adapters, { kept });
  assert.deepEqual(r.requirements.map((x) => x.status), ['pass', 'fail']);
  assert.match(r.requirements[1].checks[0].message, /攻撃を始めてから/);
  assert.deepEqual(calls, [false], 'R2 の検査は実行していない');
  kept = keptAfter(sc, r, kept);
  assert.deepEqual([...kept], ['R1']);
  // 攻撃のあと: R1 は前の合格を残す（検査しない）・R2 合格 → 全部合格
  running = true;
  r = await runChecks(sc, adapters, { kept });
  assert.deepEqual(r.requirements.map((x) => x.status), ['pass', 'pass']);
  assert.equal(r.requirements[0].kept, true);
  assert.equal(r.requirements[0].checks[0].kept, true);
  assert.equal(r.allPassed, true);
  assert.deepEqual(calls, [false, true]);
  kept = keptAfter(sc, r, kept);
  assert.deepEqual([...kept].sort(), ['R1', 'R2']);
  // kept が空なら（やり直したあと）、攻撃中の R1 は「止めてから」で不合格
  r = await runChecks(sc, adapters, { kept: new Set() });
  assert.equal(r.requirements[0].status, 'fail');
  assert.match(r.requirements[0].checks[0].message, /攻撃を止めてから/);
  // 攻撃者の状態が分からない（アダプタが無い・ノードが無い）→ 不合格で、理由を出す
  const r2 = await runChecks(sc, fakeAdapters());
  assert.match(r2.requirements[0].checks[0].message, /見つからない/);
  // once でない要件は kept に入らない
  const sc2 = validateScenario(s7((x) => { x.requirements[0].once = false; return x; })).scenario;
  assert.deepEqual([...keptAfter(sc2, { requirements: [{ id: 'R1', status: 'pass' }, { id: 'R2', status: 'fail' }] })], []);
});

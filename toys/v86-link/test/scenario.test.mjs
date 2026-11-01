// シナリオのコア（スキーマ・マークアップ・判定）の単体テスト。node --test toys/v86-link/test/scenario.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario, SCHEMA_ID, isSafeIp, inCidr } from '../scenario/schema.js';
import { parseMarkup, parseInline, markupToText } from '../scenario/markup.js';
import { runChecks, judge, aggregate, orderRequirements } from '../scenario/evaluate.js';

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

test('同梱のシナリオ（scenarios/）は、どれも検証に通る（trusted でも、そうでなくても）', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../scenarios/', import.meta.url);
  const index = JSON.parse(fs.readFileSync(new URL('index.json', dir), 'utf8'));
  assert.ok(index.scenarios.length >= 2);
  for (const x of index.scenarios) {
    const text = fs.readFileSync(new URL(x.file, dir), 'utf8');
    for (const trusted of [true, false]) {
      const r = validateScenario(text, { trusted });
      assert.deepEqual(r.errors, [], `${x.file}（trusted: ${trusted}）`);
      assert.equal(r.scenario.id, x.id);
    }
    // 公開のディレクトリに、模範解答を置かない（解答は test/scenario-answers/）
    assert.doesNotMatch(text, /answer|解答/i);
  }
});

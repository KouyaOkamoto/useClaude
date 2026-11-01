// シナリオモードの結合テスト（実ブラウザ: ヘッドレス Chromium）。docs/scenarios.md
//
//   npx http-server -p 8080        # リポジトリのルートで
//   node toys/v86-link/test/scenario-e2e.cjs [ページのURL]
//
// 確かめること:
//   (a) S1: 何もしない → 不合格 / 途中まで（転送を忘れた）→ 特定の要件だけ不合格 / 模範解答 → 全部合格
//   (b) S2: 同じ3つ（VLAN 1 のまま / VLAN だけ分けてフィルタ無し / 模範解答）。キャプチャの条件は、検査の通信（プローブ）で不合格にならない
//   (c) 「最初からやり直す」で初期状態に戻る
//   (d) ttyS1 の読み書き・検査中に学習者が ttyS0 に打っても衝突しない（端末に検査のコマンドが出ない）
//   (e) 壊れた JSON・shell の検査を含む外部のシナリオは読み込まず、ページも壊れない。HTML は文字として出る
//   ほか: 以前のイメージではシナリオモードにしない / 外への通信・CSP の違反・ページのエラーが無い
//
// 模範解答は test/scenario-answers/answers.cjs（自習するときは見ない）
const { chromium } = require('playwright');
const ANSWERS = require('./scenario-answers/answers.cjs');

const BASE = process.argv[2] || 'http://localhost:8080/toys/v86-link/';
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (...a) => console.log(ts(), ...a);
let failures = 0, passes = 0;
const check = (ok, label) => { if (ok) passes++; else failures++; say(ok ? 'PASS' : 'FAIL', label); };

const state = (p) => p.evaluate(() => window.__v86link.scenario.state);
async function waitReady(p, timeout = 300000) {
  await p.waitForFunction(() => {
    const s = window.__v86link.scenario.state;
    return s.phase === 'ready' && s.vms.length > 0 && s.vms.every((v) => v.ready);
  }, null, { timeout, polling: 500 });
  return state(p);
}
/** 「検査する」を押して、結果（要件 ID → 状態）を返す */
async function runCheck(p) {
  await p.click('#sc-check');
  await p.waitForFunction(() => window.__v86link.scenario.state.phase === 'ready' && !document.querySelector('#sc-check').disabled, null, { timeout: 240000, polling: 300 });
  const r = await p.evaluate(() => window.__v86link.scenario.result);
  return { map: Object.fromEntries(r.requirements.map((x) => [x.id, x.status])), raw: r };
}
const fmt = (m) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' ');
const same = (a, b) => Object.keys(b).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;
const slotOf = (p, id) => p.evaluate((id) => window.__v86link.machines.find((m) => m.scenario?.id === id).slot, id);

/** 学習者の操作を再現する: VM の端末（ttyS0）に打つ / ポートの VLAN を変える（ポートの設定パネルと同じ sw.setPortVlan） */
async function applySteps(p, steps) {
  for (const s of steps) {
    if (s.vm) {
      const [id, cmd] = s.vm;
      const slot = await slotOf(p, id);
      const tag = 'DONE' + Math.random().toString(36).slice(2, 7);
      const mark = await p.evaluate((slot) => window.__v86link.bySlot(slot).log.length, slot);
      await p.evaluate(([slot, t]) => window.__v86link.bySlot(slot).node.writeSerial(t), [slot, `${cmd}; echo "${tag}""-OK"\n`]);
      await p.waitForFunction(([slot, mark, tag]) => window.__v86link.bySlot(slot).log.slice(mark).includes(tag + '-OK'), [slot, mark, tag], { timeout: 30000 });
    }
    if (s.port) {
      const [id, vlan] = s.port;
      const slot = await slotOf(p, id);
      await p.evaluate(([slot, vlan]) => { const sw = window.__v86link.sw; sw.setPortVlan(sw.port(slot), vlan); }, [slot, vlan]);
    }
  }
}

async function scenarioPatterns(p, id) {
  const a = ANSWERS[id];
  const res = {};
  for (const [name, applied] of [['none', []], ['partial', a.partial.steps], ['full', a.full.steps]]) {
    // 途中までと模範解答は、どちらも初期状態から（やり直してから）適用する
    if (name !== 'none') { await p.click('#sc-reset'); await waitReady(p); }
    await applySteps(p, applied);
    const t = Date.now();
    const r = await runCheck(p);
    res[name] = r;
    check(same(r.map, a[name].expect), `${id} ${name}: ${fmt(r.map)}（期待 ${fmt(a[name].expect)}、検査 ${((Date.now() - t) / 1000).toFixed(1)}s）`);
    if (!same(r.map, a[name].expect)) say('  詳細', JSON.stringify(r.raw.requirements.map((x) => [x.id, x.checks.map((c) => `${c.id}:${c.status}:${c.message}`)])));
  }
  return res;
}

(async () => {
  const b = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  const external = new Set();
  ctx.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol) && u.host !== new URL(BASE).host) external.add(u.host); });
  const pageErrors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => { pageErrors.push(e.message); say('pageerror', e.message); });
    p.on('console', (m) => { if (m.type() === 'error') { pageErrors.push(m.text()); say('console.error', m.text()); } });
  };
  const p = await ctx.newPage();
  watch(p);

  // ---------------------------------------------------------------- S1
  await p.goto(BASE + '?scenario=small-office');
  let st = await waitReady(p);
  say('S1 準備完了', JSON.stringify(st.vms));
  check(st.id === 'small-office' && st.trusted === true && st.probes.length === 1, 'S1: URL の ?scenario= で開き、同梱（trusted）として読み込む');
  check(await p.isHidden('#lesson-steps') && await p.isVisible('#scenario-panel'), 'S1: 学習の画面を隠し、シナリオの画面を出す');
  check((await p.$$('#sc-reqs li')).length === 3, 'S1: 要件が3つ表示される');
  check(await p.evaluate(() => window.__v86link.topology && [...document.querySelectorAll('#topology text')].every((t) => !/検査/.test(t.textContent))), 'S1: プローブはトポロジー図に出ない');
  // 端末をクリアしてから渡している（ブートストラップのコマンドが端末に見えない）
  const pc1Screen = await p.evaluate(() => { const t = window.__v86link.bySlot(0).term; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; return s; });
  check(!/setsid|ttyS1|SC-BOOT|Done/.test(pc1Screen) && /pc1:~%/.test(pc1Screen), 'S1: 端末をクリアしてから学習者に渡す（ブートストラップも「Done」も見えない）');
  check(await p.evaluate(() => window.__v86link.bySlot(1).scenario.locked && window.__v86link.bySlot(1).el.classList.contains('locked')), 'S1: サーバーは閲覧のみ');

  // (d) ttyS1 の読み書き
  const s1 = await p.evaluate(async () => window.__v86link.bySlot(0).shell.run('echo hello-ttyS1; cat /proc/sys/kernel/hostname; tty'));
  check(s1.exitCode === 0 && /hello-ttyS1\npc1\n\/dev\/ttyS1/.test(s1.output), `(d) ttyS1 のシェルで実行して出力を読める: ${JSON.stringify(s1)}`);

  // (a) S1 の3つの型
  await scenarioPatterns(p, 'small-office');

  // (d) 検査の最中に、学習者が ttyS0 に打つ（1文字ずつ）。検査の結果も、学習者の入力も、どちらも崩れない
  {
    const before = await p.evaluate(() => window.__v86link.bySlot(0).log.length);
    const typing = (async () => {
      await p.waitForTimeout(300);
      for (const ch of 'echo TYPED-$((6*7))-during-check\n') {
        await p.evaluate((c) => window.__v86link.bySlot(0).node.writeSerial(c), ch);
        await p.waitForTimeout(40);
      }
    })();
    const r = await runCheck(p);
    await typing;
    await p.waitForFunction((m) => /^TYPED-42-during-check\r?$/m.test(window.__v86link.bySlot(0).log.slice(m)), before, { timeout: 15000 }).catch(() => {});
    const log = await p.evaluate((m) => window.__v86link.bySlot(0).log.slice(m), before);
    check(/^TYPED-42-during-check\r?$/m.test(log), '(d) 検査中に打ったコマンドが、そのまま実行される（衝突しない）');
    check(!/V86CHK|wget|nc -z|ip -4 route/.test(log), '(d) 学習者の端末（ttyS0）に、検査のコマンドも出力も出ない');
    check(r.raw.allPassed, `(d) 打っている間の検査も全部合格: ${fmt(r.map)}`);
  }
  // 検査の通信はキャプチャに「検査」の印付きで残る
  const probeRows = await p.evaluate(() => window.__v86link.capture.list({ includeProbe: true }).filter((x) => x.probe).length);
  check(probeRows > 0, `キャプチャに検査の通信が印付きで残る（${probeRows} 件）`);
  check(await p.evaluate(() => window.__v86link.capture.list({ includeProbe: false }).every((x) => !x.probe)), 'pcap の既定（includeProbe: false）は検査の通信を除く');
  await p.click('#sc-probe-filter');
  check(await p.inputValue('#cap-filter') === 'probe', '「検査の通信を見る」でフィルタが probe になる');
  check(await p.isVisible('#sc-debrief-box'), '全部合格すると解説が出る');

  // ヒント
  await p.click('#sc-hint');
  await p.click('#sc-hint');
  check((await p.$$('#sc-hints .sc-hint')).length === 2, 'ヒントを段階ごとに1つずつ出す');

  // (c) やり直し: 初期状態に戻る（PC1 のゲートウェイ・ルーターの転送が消える）
  await p.click('#sc-reset');
  st = await waitReady(p);
  const route = await p.evaluate(() => window.__v86link.machines.find((m) => m.scenario.id === 'pc1').shell.run('ip route; cat /proc/sys/net/ipv4/ip_forward'));
  const fwd = await p.evaluate(() => window.__v86link.machines.find((m) => m.scenario.id === 'router').shell.run('cat /proc/sys/net/ipv4/ip_forward'));
  check(!/default/.test(route.output) && fwd.output.trim() === '0', `(c) やり直すと初期状態（ゲートウェイ無し・転送 OFF）: ${JSON.stringify([route.output, fwd.output])}`);
  check((await p.$$('#sc-hints .sc-hint')).length === 0 && await p.isHidden('#sc-debrief-box') && await p.evaluate(() => window.__v86link.scenario.result === null), '(c) やり直すと、結果・ヒント・解説も最初に戻る');
  check(await p.evaluate(() => window.__v86link.machines.length === 3 && window.__v86link.probePorts.size === 1 && window.__v86link.sw.ports.size === 4), '(c) VM 3台・プローブ 1つ（ポートが重複して残らない）');
  const r0 = await runCheck(p);
  check(same(r0.map, ANSWERS['small-office'].none.expect), `(c) やり直したあとの検査は「何もしない」と同じ: ${fmt(r0.map)}`);

  // (e) 壊れた JSON・shell の検査・HTML
  const loadFile = async (name, text) => {
    await p.setInputFiles('#scenario-file', { name, mimeType: 'application/json', buffer: Buffer.from(text) });
    await p.waitForTimeout(500);
  };
  await loadFile('broken.json', '{ "schema": "v86-link-scenario/1", ');
  check(await p.isVisible('#sc-errors') && /JSON として読めない/.test(await p.textContent('#sc-errors')), '(e) 壊れた JSON は読み込まず、理由を表示する');
  st = await state(p);
  check(st.id === 'small-office' && st.phase === 'ready' && st.vms.length === 3, '(e) 読み込みに失敗しても、いまの構成はそのまま');
  const fs = require('fs');
  const s1json = JSON.parse(fs.readFileSync(require('path').join(__dirname, '../scenarios/small-office.json'), 'utf8'));
  const withShell = { ...s1json, checks: [...s1json.checks, { id: 'x', requirement: 'R1', title: 'x', type: 'shell', from: 'pc1', command: 'id', expect: { exitCode: 0 } }] };
  await loadFile('shell.json', JSON.stringify(withShell));
  check(/同梱のシナリオだけ/.test(await p.textContent('#sc-errors')) && (await state(p)).trusted === true, '(e) 外部のシナリオの shell の検査は拒否する');
  await loadFile('unknown.json', JSON.stringify({ ...s1json, checks: [{ ...s1json.checks[0], type: 'exec' }] }));
  check(/知らない検査の種類/.test(await p.textContent('#sc-errors')), '(e) 知らない検査の種類は拒否する');
  await loadFile('real-ip.json', JSON.stringify({ ...s1json, addressing: { allowed: ['8.8.8.0/24'] } }));
  check(await p.isVisible('#sc-errors') && (await state(p)).id === 'small-office', '(e) ドキュメント用・プライベート以外のアドレスは拒否する');
  check(await p.evaluate(() => typeof window.__v86link.scenario.check === 'function') && await p.isEnabled('#sc-check'), '(e) ページは壊れていない（検査できる）');
  // 外部の（trusted でない）正しいシナリオ: HTML は文字として出る
  const html = { ...s1json, id: 'html-test', title: '<b>題</b>', briefing: '<img src=x onerror="window.__pwned=1"> **強調** `code`', nodes: [s1json.nodes[0]],
    requirements: [{ id: 'R1', text: '<script>window.__pwned=2</script>' }], checks: [{ ...s1json.checks[1], requirement: 'R1' }], hints: [] };
  await loadFile('html.json', JSON.stringify(html));
  st = await waitReady(p);
  check(st.id === 'html-test' && st.trusted === false && st.vms.length === 1, '(e) 外部の正しいシナリオは読み込める（trusted ではない）');
  check(await p.evaluate(() => !document.querySelector('#scenario-panel img, #scenario-panel script, #sc-title b') && !window.__pwned
    && document.querySelector('#sc-briefing').textContent.includes('<img src=x') && !!document.querySelector('#sc-briefing strong')), '(e) 依頼文・要件の HTML は文字として出る（許したマークアップだけ要素になる）');

  // ---------------------------------------------------------------- S2（新しいページで）
  await p.close();
  const p2 = await ctx.newPage();
  watch(p2);
  await p2.goto(BASE + '?scenario=dept-vlan');
  st = await waitReady(p2);
  say('S2 準備完了', JSON.stringify(st.vms));
  check(st.probes.length === 2 && st.vms.length === 4, 'S2: VM 4台・プローブ 2つ');
  const res2 = await scenarioPatterns(p2, 'dept-vlan');
  // キャプチャの条件の検査（R4）は、検査の通信で不合格にならない（同じ時間に、プローブの通信も流れている）
  const r4 = res2.full.raw.requirements.find((x) => x.id === 'R4');
  check(r4.status === 'pass', 'S2: キャプチャの条件（ブロードキャストが開発部に届かない）が、プローブの通信があっても合格');
  // プローブが ARP の問い合わせ（ブロードキャスト）を出している間に、キャプチャの条件の検査をしても不合格にならない
  {
    const r = await p2.evaluate(async () => {
      const sc = window.__v86link.scenario;
      const probe = sc.probes.get('probe-sales').probe;
      // 営業のプローブから、開発部のアドレスを含む宛先へ ping を連発する（ARP のブロードキャストが VLAN 10 に流れる）
      const flood = Promise.all([1, 2, 3, 4, 5, 6].map((i) => probe.ping('10.10.10.' + (100 + i), { timeoutMs: 3000 })));
      const res = await (await import('./scenario/evaluate.js')).runChecks(sc.sc, sc.adapters(), { only: ['sales-bcast'] });
      await flood;
      return res.requirements.find((x) => x.id === 'R4');
    });
    check(r.status === 'pass', `S2: プローブのブロードキャストと同時でも、キャプチャの条件の検査は合格（${r.checks.map((c) => c.message).join(' ')}）`);
  }

  // ---------------------------------------------------------------- 以前のイメージ
  const p3 = await ctx.newPage();
  watch(p3);
  await p3.goto(BASE + '?image=buildroot68&scenario=small-office');
  await p3.waitForFunction(() => /v86net/.test(document.querySelector('#sc-status').textContent), null, { timeout: 30000 });
  check(await p3.evaluate(() => window.__v86link.machines.length === 0 && window.__v86link.scenario.state.phase === 'error'), '以前のイメージでは、その旨を表示し、構成を作らない');
  await p3.close();

  // ---------------------------------------------------------------- 自由構成（後方互換）
  const p4 = await ctx.newPage();
  watch(p4);
  await p4.goto(BASE);
  check(await p4.evaluate(() => window.__v86link.machines.length === 2 && !window.__v86link.scenario.active && !document.querySelector('#lesson-pick').hidden && document.querySelector('#scenario-panel').hidden), '自由構成は今までどおり（A・B の2台、学習の選択。シナリオの画面は出ない）');
  check(await p4.evaluate(() => document.querySelectorAll('#scenario-pick option').length === 3), 'シナリオの一覧に同梱の2つが出る');
  await p4.close();

  check(external.size === 0, `ページの外への通信が無い（${[...external].join(', ') || 'なし'}）`);
  check(pageErrors.length === 0, `ページのエラー・CSP の違反が無い（${pageErrors.length} 件）`);
  await b.close();
  say(`結果: ${passes} 件 PASS / ${failures} 件 FAIL`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// spring-kakeibo の通し確認（実ブラウザ: ヘッドレス Chromium。CheerpJ 上の Spring を Service Worker 経由で使う）
//
//   npx http-server -p 8080        # リポジトリのルートで（Range 対応のサーバー）
//   node toys/spring-kakeibo/test/e2e.cjs [ページのURL]
//
// playwright が必要。外向きの通信にプロキシが要る環境では HTTPS_PROXY を設定しておく。
// SHOT_DIR を設定すると、画面のスクリーンショットを保存する。
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:8080/toys/spring-kakeibo/';
const ORIGIN = new URL(BASE).origin;
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const say = (...a) => console.log(ts(), ...a);
let failures = 0;
const check = (ok, label) => { if (!ok) failures++; say(ok ? 'PASS' : 'FAIL', label); };
const shot = async (p, name) => { if (process.env.SHOT_DIR) await p.screenshot({ path: path.join(process.env.SHOT_DIR, name), fullPage: true }); };

/** ページの fetch を包んで、api/* の所要時間を記録する */
function recordApiTimes() {
  const orig = window.fetch;
  window.__apiTimes = [];
  window.fetch = async (...args) => {
    const t = performance.now();
    const res = await orig(...args);
    const url = String(args[0]?.url ?? args[0]);
    if (url.includes('api/')) window.__apiTimes.push({ url, ms: performance.now() - t, status: res.status });
    return res;
  };
}

async function waitReady(p) {
  await p.waitForFunction(() => /実行中|起動失敗/.test(document.getElementById('backend').textContent), null, { timeout: 600000 });
  const steps = await p.$$eval('#steps li', (l) => l.map((x) => x.className + ' ' + x.textContent.trim()));
  return steps.join(' | ');
}

const apiJson = (p, url) => p.evaluate(async (u) => (await (await fetch(u)).json()), url);

(async () => {
  const b = await chromium.launch({ args: process.env.HTTPS_PROXY ? ['--proxy-server=' + process.env.HTTPS_PROXY] : [] });
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1100, height: 1000 } });
  await ctx.addInitScript(recordApiTimes);
  const hosts = new Set();
  ctx.on('request', (r) => hosts.add(new URL(r.url()).host));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => say('pageerror', e.message));
  p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'ペット用品' : undefined));
  const apiResponses = [];
  p.on('response', (r) => { if (new URL(r.url()).pathname.includes('/api/')) apiResponses.push({ url: r.url(), sw: r.fromServiceWorker() }); });

  // --- 1回目（キャッシュなし）の起動。起動中のリクエストは待たされて、起動後に答えが返る
  await p.goto(BASE);
  await p.waitForFunction(() => document.getElementById('sw').textContent.includes('有効'), null, { timeout: 30000 });
  const during = p.evaluate(async () => {
    const t = performance.now();
    const r = await fetch('api/health');
    return { status: r.status, servedBy: r.headers.get('x-served-by'), waitedMs: Math.round(performance.now() - t) };
  });
  say('起動（1回目）:', await waitReady(p));
  const d = await during;
  check(d.status === 200 && d.servedBy === 'spring-boot (CheerpJ)', `起動中のリクエストは待たされ、起動後に Spring が答えた: ${JSON.stringify(d)}`);
  const health = await apiJson(p, 'api/health');
  check(health.persistence.startedFrom === 'new', '初めての起動は空の DB（初期カテゴリだけ）: ' + JSON.stringify(health.persistence));
  await p.waitForFunction(() => document.querySelectorAll('#f-category option').length > 0);

  // --- サンプルデータ → 集計と一覧
  await p.click('#reset');
  await p.waitForFunction(() => /サンプルデータを入れました/.test(document.getElementById('data-msg').textContent), null, { timeout: 60000 });
  await p.waitForFunction(() => document.querySelectorAll('#tx-list li').length > 0 && document.querySelectorAll('#bars li').length > 0);
  const totals = await p.evaluate(() => ['income', 'expense', 'balance'].map((id) => document.getElementById(id).textContent));
  const bars = await p.$$eval('#bars li', (l) => l.map((x) => x.textContent));
  check(totals[0] === '¥280,000' && bars.length > 0, `サマリー: 収入 ${totals[0]} / 支出 ${totals[1]} / 収支 ${totals[2]}、棒グラフ ${bars.length} 本（先頭 ${bars[0]}）`);
  await shot(p, 'kakeibo-desktop.png');

  // --- 取引の入力・編集・削除（UI から）
  await p.selectOption('#f-category', { label: '食費' });
  await p.fill('#f-amount', '1234');
  await p.fill('#f-memo', 'UIテスト');
  await p.click('#f-submit');
  await p.waitForFunction(() => [...document.querySelectorAll('#tx-list li')].some((li) => li.textContent.includes('UIテスト')));
  check(true, 'UI: 取引を追加 → 一覧に出る');
  await p.locator('#tx-list li', { hasText: 'UIテスト' }).getByText('編集').click();
  await p.fill('#f-amount', '2000');
  await p.click('#f-submit');
  await p.waitForFunction(() => [...document.querySelectorAll('#tx-list li')].some((li) => li.textContent.includes('UIテスト') && li.textContent.includes('¥2,000')));
  check(true, 'UI: 編集で金額を 2,000 円に変更');
  await p.locator('#tx-list li', { hasText: 'UIテスト' }).getByText('削除').click();
  await p.waitForFunction(() => ![...document.querySelectorAll('#tx-list li')].some((li) => li.textContent.includes('UIテスト')));
  check(true, 'UI: 削除 → 一覧から消える');
  // 不正な入力は 400 のメッセージが出る（ブラウザの検証を外して送る）
  await p.evaluate(() => { document.getElementById('f-amount').removeAttribute('min'); });
  await p.fill('#f-amount', '-5');
  await p.click('#f-submit');
  await p.waitForFunction(() => /amount/.test(document.getElementById('form-msg').textContent));
  check(true, '不正な金額 → ' + await p.textContent('#form-msg'));
  await p.fill('#f-amount', '');

  // --- カテゴリ: 追加・名前の変更・削除、使用中は削除できない
  await p.fill('#c-name', 'ペット');
  await p.click('#cat-form button');
  await p.waitForFunction(() => [...document.querySelectorAll('#cat-list li')].some((li) => li.textContent.includes('ペット')));
  await p.locator('#cat-list li', { hasText: 'ペット' }).getByText('名前を変える').click();
  await p.waitForFunction(() => [...document.querySelectorAll('#cat-list li')].some((li) => li.textContent.includes('ペット用品')));
  await p.locator('#cat-list li', { hasText: 'ペット用品' }).getByText('削除').click();
  await p.waitForFunction(() => ![...document.querySelectorAll('#cat-list li')].some((li) => li.textContent.includes('ペット用品')));
  check(true, 'カテゴリ: 追加 → 名前を変える → 削除');
  const usedDisabled = await p.locator('#cat-list li', { hasText: '食費' }).getByText('削除').isDisabled();
  const conflict = await p.evaluate(async () => {
    const id = (await (await fetch('api/categories')).json()).find((c) => c.name === '食費').id;
    const r = await fetch('api/categories/' + id, { method: 'DELETE' });
    return [r.status, (await r.json()).error];
  });
  check(usedDisabled && conflict[0] === 409, `取引で使っているカテゴリは削除できない（ボタン無効・API は ${conflict.join(' ')}）`);

  // --- 月の切替と絞り込み
  const label0 = await p.textContent('#month-label');
  await p.click('#prev');
  await p.waitForFunction((l) => document.getElementById('month-label').textContent !== l, label0);
  await p.waitForFunction(() => document.querySelectorAll('#tx-list li').length > 0);
  const prevRows = await p.$$eval('#tx-list li', (l) => l.length);
  check(prevRows === 8, `月の切替: ${label0} → ${await p.textContent('#month-label')}（先月の取引 ${prevRows} 件）`);
  await p.click('#next');
  await p.fill('#q-text', 'スーパー');
  await p.waitForFunction(() => { const l = [...document.querySelectorAll('#tx-list li')]; return l.length > 0 && l.every((li) => li.textContent.includes('スーパー')); });
  check(true, '検索「スーパー」: ' + (await p.$$eval('#tx-list li', (l) => l.length)) + ' 件');
  await p.fill('#q-text', '');
  await p.selectOption('#q-category', { label: '給与' });
  await p.waitForFunction(() => { const l = [...document.querySelectorAll('#tx-list li')]; return l.length === 1 && l[0].textContent.includes('給与'); });
  check(true, 'カテゴリで絞り込み（給与）: 1 件');
  await p.selectOption('#q-category', '');

  // --- CSV の書き出しと取り込み
  const [csvDl] = await Promise.all([p.waitForEvent('download'), p.click('#export')]);
  const csv = fs.readFileSync(await csvDl.path(), 'utf8');
  check(csv.startsWith('﻿日付,種別,カテゴリ,金額,メモ\r\n') && csvDl.suggestedFilename().endsWith('.csv'),
    `CSV 書き出し: ${csvDl.suggestedFilename()}（BOM 付き、${csv.trim().split('\r\n').length - 1} 行）`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakeibo-e2e-'));
  const good = path.join(tmp, 'good.csv');
  fs.writeFileSync(good, '日付,種別,カテゴリ,金額,メモ\n2026-01-05,支出,書籍,1800,技術書\n2026-01-06,収入,お祝い,10000,\n');
  await p.setInputFiles('#import', good);
  await p.waitForFunction(() => /件を取り込みました/.test(document.getElementById('data-msg').textContent), null, { timeout: 60000 });
  check(true, 'CSV 取り込み: ' + await p.textContent('#data-msg'));
  const bad = path.join(tmp, 'bad.csv');
  fs.writeFileSync(bad, '日付,種別,カテゴリ,金額,メモ\n2026-01-05,支出,食費,100,\n2026-13-01,支出,食費,100,\n2026-01-07,支出,食費,abc,\n');
  const before = (await apiJson(p, 'api/transactions')).length;
  await p.setInputFiles('#import', bad);
  await p.waitForFunction(() => document.querySelectorAll('#data-errors li').length > 0, null, { timeout: 60000 });
  const errs = await p.$$eval('#data-errors li', (l) => l.map((x) => x.textContent));
  check(errs.length === 2 && errs[0].startsWith('3 行目') && errs[1].startsWith('4 行目') && (await apiJson(p, 'api/transactions')).length === before,
    `不正な CSV は全体を取り込まない: ${await p.textContent('#data-msg')} / ${errs.join(' / ')}`);

  // --- 永続化: 取引とカテゴリを足して、ページを読み込み直す
  await p.evaluate(async () => {
    const cat = await (await fetch('api/categories', { method: 'POST', body: JSON.stringify({ name: 'リロード確認', type: 'EXPENSE' }) })).json();
    await fetch('api/transactions', { method: 'POST', body: JSON.stringify({ date: '2026-01-20', amount: 4321, categoryId: cat.id, memo: '永続化テスト' }) });
  });
  const txBefore = await apiJson(p, 'api/transactions');
  const catsBefore = await apiJson(p, 'api/categories');
  const times1 = await p.evaluate(() => window.__apiTimes);
  await p.reload();
  say('起動（2回目・再読込）:', await waitReady(p));
  const txAfter = await apiJson(p, 'api/transactions');
  const catsAfter = await apiJson(p, 'api/categories');
  const h2 = await apiJson(p, 'api/health');
  check(JSON.stringify(txAfter) === JSON.stringify(txBefore) && JSON.stringify(catsAfter) === JSON.stringify(catsBefore)
    && txAfter.some((t) => t.memo === '永続化テスト'),
    `リロード後も取引 ${txAfter.length} 件・カテゴリ ${catsAfter.length} 件がそのまま残る（${h2.persistence.startedFrom}）`);
  const times2 = await p.evaluate(() => window.__apiTimes);

  // --- バックアップ → ブラウザのデータを消す → 復元
  const [sqlDl] = await Promise.all([p.waitForEvent('download'), p.click('#backup')]);
  const backupFile = path.join(tmp, sqlDl.suggestedFilename());
  await sqlDl.saveAs(backupFile);
  say('バックアップ:', sqlDl.suggestedFilename(), fs.statSync(backupFile).size, 'bytes');
  await shot(p, 'kakeibo-before-erase.png');
  // 同じオリジンの別のページで、IndexedDB と Service Worker を消す（ブラウザの「データを消す」に相当）
  await p.goto(ORIGIN + '/');
  const erased = await p.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name);
    await Promise.all(names.map((n) => new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(n);
      r.onsuccess = res; r.onerror = rej; r.onblocked = () => rej(new Error('blocked ' + n));
    })));
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    return names;
  });
  say('消した IndexedDB:', erased.join(', '));
  await p.goto(BASE);
  await waitReady(p);
  const fresh = await apiJson(p, 'api/transactions');
  const h3 = await apiJson(p, 'api/health');
  check(fresh.length === 0 && h3.persistence.startedFrom === 'new', `データを消したあとは空（取引 ${fresh.length} 件、${h3.persistence.startedFrom}）`);
  await p.setInputFiles('#restore', backupFile);
  await p.waitForFunction(() => /復元しました|失敗|エラー|できない/.test(document.getElementById('data-msg').textContent), null, { timeout: 60000 });
  say('復元:', await p.textContent('#data-msg'));
  const restoredTx = await apiJson(p, 'api/transactions');
  const restoredCats = await apiJson(p, 'api/categories');
  check(JSON.stringify(restoredTx) === JSON.stringify(txBefore) && JSON.stringify(restoredCats) === JSON.stringify(catsBefore),
    `バックアップ → データ消去 → 復元で元に戻る（取引 ${restoredTx.length} 件・カテゴリ ${restoredCats.length} 件）`);
  // 復元した内容もリロード後に残る
  await p.reload();
  await waitReady(p);
  check(JSON.stringify(await apiJson(p, 'api/transactions')) === JSON.stringify(txBefore), '復元した内容もリロード後に残る');

  // --- 経路と外部への通信
  const notSW = apiResponses.filter((r) => !r.sw);
  check(apiResponses.length > 0 && notSW.length === 0, `api/* の応答 ${apiResponses.length} 件がすべて Service Worker 経由`);
  const external = [...hosts].filter((h) => h !== new URL(ORIGIN).host);
  check(external.every((h) => h === 'cjrtnc.leaningtech.com'), '外部への通信は CheerpJ のローダーとランタイムだけ: ' + external.join(', '));

  // --- 時間（最初のリクエストと以降）
  const summarize = (list) => {
    const ms = list.filter((x) => x.status < 500).map((x) => x.ms);
    const later = ms.slice(1).sort((a, z) => a - z);
    return `最初 ${Math.round(ms[0])}ms（${list[0]?.url.split('/api/')[1]}）・以降の中央値 ${Math.round(later[Math.floor(later.length / 2)])}ms・最大 ${Math.round(later.at(-1))}ms（${ms.length} 件）`;
  };
  say('リクエスト時間（1回目の起動）:', summarize(times1));
  say('リクエスト時間（2回目の起動）:', summarize(times2));

  // --- 2つ目のタブ（スマホ幅）: 1つ目のタブで Spring が動いている間は起動せず、そのタブの Spring を使う
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(BASE);
  await phone.waitForFunction(() => /別のタブで Spring が動いています/.test(document.getElementById('role').textContent), null, { timeout: 60000 });
  await phone.waitForFunction(() => document.querySelectorAll('#tx-list li').length > 0, null, { timeout: 60000 });
  const standby = await phone.evaluate(() => document.getElementById('backend').textContent);
  check(/停止中/.test(standby), `2つ目のタブは Spring を起動せず（${standby}）、1つ目のタブの Spring のデータを表示する`);
  await phone.evaluate(async () => {
    const cat = (await (await fetch('api/categories')).json())[0];
    await fetch('api/transactions', { method: 'POST', body: JSON.stringify({ date: '2026-01-21', amount: 777, categoryId: cat.id, memo: 'タブ2から' }) });
  });
  // 1つ目のタブを閉じると、2つ目のタブが引き継いで起動し、最新のデータ（タブ2から書いた分も）を戻す
  await p.close();
  await waitReady(phone);
  const handedOver = await apiJson(phone, 'api/transactions');
  check(handedOver.some((t) => t.memo === 'タブ2から') && handedOver.length === txBefore.length + 1,
    `1つ目のタブを閉じると2つ目のタブが引き継いで起動し、最新のデータを使う（取引 ${handedOver.length} 件）`);
  await phone.waitForFunction(() => document.querySelectorAll('#tx-list li').length > 0);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `スマホ幅（390px）で横にはみ出さない（はみ出し ${overflow}px）`);
  await shot(phone, 'kakeibo-phone.png');

  say(failures ? `${failures} 件失敗` : 'すべて成功');
  await b.close();
  process.exitCode = failures ? 1 : 0;
})();

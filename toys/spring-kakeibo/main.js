const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');

// CheerpJ が投げる例外オブジェクトは、そのまま文字列と連結すると
// "Cannot convert object to primitive value" になり、catch の中で再びエラーになる。
// message → stack → String() → JSON の順に試して、安全に文字列にする（spring-sw-bridge と同じ）
function errText(e) {
  const tries = [
    () => e?.message,
    () => e?.stack,
    () => String(e),
    () => JSON.stringify(e),
    () => Object.prototype.toString.call(e),
  ];
  for (const f of tries) {
    try {
      const s = f();
      if (typeof s === 'string' && s && s !== '{}') return s;
    } catch { /* 次の方法を試す */ }
  }
  return '(内容を表示できない例外)';
}

// ---------------------------------------------------------------------------
// API（相対パスなので GitHub Pages のサブパスでも動く。Service Worker が Spring へ転送する）
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, data) {
    super(data?.message || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function api(method, path, body, contentType = 'application/json') {
  const started = performance.now();
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = contentType;
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  addLog(method, path, res.status, performance.now() - started, res.headers.get('x-served-by'));
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* JSON でなければ文字列のまま */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return { res, data, text };
}

/** エラーを画面の文に。503（起動中・停止中）は分かりやすく言い換える */
function apiMessage(e) {
  if (e instanceof ApiError) {
    if (e.status === 503) return 'Spring がまだ動いていません（' + (e.data?.message || '起動を待っています') + '）';
    return e.data?.message || `エラー（HTTP ${e.status}）`;
  }
  return errText(e);
}

function show(id, text, ok = false) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : text ? 'err' : '');
}

// ---------------------------------------------------------------------------
// Service Worker 登録
// ---------------------------------------------------------------------------

function setBadge(id, label, text, kind) {
  const el = $(id);
  el.textContent = label + ': ' + text;
  el.className = 'badge ' + kind;
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    setBadge('sw', 'Service Worker', '非対応のブラウザ', 'ng');
    return false;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // 初回は clients.claim() で制御が移るのを少し待つ
      await Promise.race([
        new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })),
        sleep(1500),
      ]);
    }
    if (navigator.serviceWorker.controller) {
      setBadge('sw', 'Service Worker', '有効', 'ok');
      return true;
    }
    setBadge('sw', 'Service Worker', '未制御 (一度リロードしてください)', 'ng');
    return false;
  } catch (e) {
    console.error(e);
    setBadge('sw', 'Service Worker', '登録失敗: ' + errText(e), 'ng');
    return false;
  }
}

/** Service Worker へ知らせる（返事はいらない） */
async function tellWorker(type) {
  try {
    // pagehide の中でも届くよう、制御中の Service Worker があればその場で送る
    const controller = navigator.serviceWorker.controller;
    if (controller) controller.postMessage({ type });
    else (await navigator.serviceWorker.ready).active?.postMessage({ type });
  } catch (e) {
    console.error(e);
  }
}

/** Service Worker に聞く（MessageChannel で返事をもらう） */
async function askWorker(type) {
  const active = (await navigator.serviceWorker.ready).active;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    active.postMessage({ type }, [channel.port2]);
    setTimeout(() => resolve(null), 2000);
  });
}

// ---------------------------------------------------------------------------
// バックエンド: CheerpJ 上の Spring Boot（spring-sw-bridge と同じ仕組み）
// ---------------------------------------------------------------------------

// CheerpJ の /app/ は Web サーバーのルートを指す。
// GitHub Pages のサブパス(/<repo>/toys/…)でも読めるよう、このページの URL パスから組み立てる
const jarPath = new URLSearchParams(location.search).get('jar')
  || '/app' + new URL('probe.jar', location.href).pathname;

// idle / booting / ready / failed
let state = 'idle';
let Bridge = null;
// ランタイムや jar の段階で失敗すると、同じページの CheerpJ は使えなくなる
// （ライブラリはページごとに1回しか読めない）。そのときの再試行は、ページの読み込み直しで行う
let needsReload = false;
// ほかのタブの Spring を使っている（このタブでは起動していない）
let standby = false;

function setState(next) {
  state = next;
  const labels = { idle: ['停止中', ''], booting: ['起動中…', ''], ready: ['実行中', 'ok'], failed: ['起動失敗', 'ng'] };
  setBadge('backend', 'Spring', ...labels[next]);
  $('boot').disabled = next === 'booting' || next === 'ready';
  $('boot').textContent = next !== 'failed' ? '起動する'
    : needsReload ? 'ページを読み込み直して再試行' : '再試行する';
  document.body.classList.toggle('not-ready', next !== 'ready' && !standby);
}

function setStep(name, cls, text = '') {
  const li = document.querySelector(`#steps [data-step="${name}"]`);
  li.className = cls;
  li.querySelector('.time').textContent = text;
}

/** 時間を計りながら1段階を実行する */
async function step(name, fn) {
  setStep(name, 'run', '実行中…');
  const t = performance.now();
  try {
    const result = await fn();
    setStep(name, 'ok', fmt(performance.now() - t));
    return result;
  } catch (e) {
    setStep(name, 'err', fmt(performance.now() - t));
    throw e;
  }
}

async function boot() {
  if (state === 'booting' || state === 'ready') return;
  if (needsReload) {
    location.reload();
    return;
  }
  standby = false;
  setState('booting');
  $('error').hidden = true;
  tellWorker('backend-booting');
  try {
    // ランタイムと jar は、成功していれば再試行のときは飛ばす（Spring の初期化だけやり直す）
    if (!Bridge) {
      needsReload = true;
      await step('runtime', () => cheerpjInit({ version: 11, status: 'none' }));
      Bridge = await step('jar', async () => (await cheerpjRunLibrary(jarPath)).demo.Bridge);
      needsReload = false;
    }
    await step('spring', async () => {
      const r = JSON.parse(String(await Bridge.start()));
      if (!r.ok) throw new Error('Spring の起動に失敗しました\n' + r.error);
    });
    setState('ready');
    await tellWorker('backend-ready');
    await showRole();
    await loadAll();
  } catch (e) {
    console.error(e);
    tellWorker('backend-failed');
    $('error').hidden = false;
    $('error').textContent = errText(e) + '\n\n' + (needsReload
      ? `jar（${jarPath}）を読み込めませんでした。パスが正しいか、`
        + 'サーバーが HTTP の Range リクエストに対応しているか確認してください'
        + '（CheerpJ に必要。Python の http.server は非対応）。詳しくはブラウザのコンソールを見てください。'
      : 'Spring の初期化に失敗しました。上のスタックトレースが原因です。');
    setState('failed');
  }
}

/** このタブが API の宛先になっているか、保存データの状態を表示する */
async function showRole() {
  const info = await askWorker('backend-info');
  if (info) {
    $('role').textContent = info.backendId === info.you
      ? 'このタブの Spring が API に答えています'
      : '別のタブの Spring が API に答えています（このタブの Spring は予備）';
  }
  try {
    const { data } = await api('GET', 'api/health');
    const p = data.persistence;
    $('role').textContent += ` ・ 保存データ: ${p.startedFrom === 'new' ? '新規' : p.startedFrom}`;
    $('warning').hidden = !p.warning;
    $('warning').textContent = p.warning || '';
  } catch (e) {
    console.error(e);
  }
}

// Java の呼び出しは1件ずつ順番に行う
let queue = Promise.resolve();
function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

/** Service Worker から転送されてきたリクエストを Spring に渡す */
async function handleRequest({ method, path, body }) {
  if (state !== 'ready') return { error: 'not-ready' };
  try {
    return JSON.parse(String(await serial(() => Bridge.dispatch(method, path, body ?? ''))));
  } catch (e) {
    // Java 側では例外を 500 にして返すので、ここに来るのは CheerpJ レベルの失敗
    return {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'bridge_error', message: errText(e) }),
    };
  }
}

navigator.serviceWorker?.addEventListener('message', async (event) => {
  const port = event.ports[0];
  if (!port) return;
  const { type } = event.data ?? {};
  if (type === 'backend-status') port.postMessage({ state });
  if (type === 'api-request') port.postMessage(await handleRequest(event.data));
});
// メッセージの受け取りを始める（読み込み完了を待たずに転送を受けられるように）
navigator.serviceWorker?.startMessages();

addEventListener('pagehide', () => tellWorker('backend-stopped'));

// ---------------------------------------------------------------------------
// ログ
// ---------------------------------------------------------------------------

function addLog(method, path, status, ms, servedBy) {
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  li.textContent = t + '  ' + method + ' /' + decodeURI(path).replace(/^\//, '') + ' → ' + status
    + ' (' + ms.toFixed(1) + 'ms' + (servedBy ? ', ' + servedBy : '') + ')';
  if (status >= 400) li.className = 'err';
  const log = $('log');
  log.prepend(li);
  while (log.children.length > 8) log.lastChild.remove();
}

// ---------------------------------------------------------------------------
// 家計簿の画面
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
let month = today().slice(0, 7);          // 表示している月 yyyy-MM
let categories = [];
let editing = null;                        // 編集中の取引

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${ym}-01`, `${ym}-${pad(last)}`];
}

function shiftMonth(delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  [$('q-from').value, $('q-to').value] = monthRange(month);
  loadSummary();
  loadList();
}

async function loadAll() {
  await loadCategories();
  await loadSummary();
  await loadList();
}

async function loadSummary() {
  const [y, m] = month.split('-');
  $('month-label').textContent = `${y}年${Number(m)}月`;
  try {
    const { data } = await api('GET', 'api/summary?month=' + month);
    $('income').textContent = yen(data.income);
    $('expense').textContent = yen(data.expense);
    $('balance').textContent = yen(data.balance);
    $('balance').className = data.balance < 0 ? 'out' : 'in';
    const max = Math.max(1, ...data.expenses.map((c) => c.total));
    $('bars').replaceChildren(...data.expenses.map((c) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = c.name;
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.setProperty('--w', (c.total / max * 100).toFixed(1) + '%');
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = yen(c.total);
      li.append(name, bar, value);
      return li;
    }));
    $('bars-empty').hidden = data.expenses.length > 0;
  } catch (e) {
    console.error(e);
  }
}

async function loadCategories() {
  try {
    ({ data: categories } = await api('GET', 'api/categories'));
  } catch (e) {
    show('cat-msg', apiMessage(e));
    return;
  }
  // 入力フォームと絞り込みの選択肢（支出・収入に分ける）
  const options = (withAll) => {
    const out = [];
    if (withAll) out.push(new Option('すべて', ''));
    for (const [type, label] of [['EXPENSE', '支出'], ['INCOME', '収入']]) {
      const group = document.createElement('optgroup');
      group.label = label;
      for (const c of categories.filter((c) => c.type === type)) group.append(new Option(c.name, c.id));
      out.push(group);
    }
    return out;
  };
  const keep = [$('f-category').value, $('q-category').value];
  $('f-category').replaceChildren(...options(false));
  $('q-category').replaceChildren(...options(true));
  if (keep[0]) $('f-category').value = keep[0];
  $('q-category').value = keep[1];

  $('cat-list').replaceChildren(...categories.map((c) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = c.name;
    const type = document.createElement('small');
    type.textContent = (c.type === 'INCOME' ? '収入' : '支出') + ` ・ ${c.transactionCount}件`;
    const rename = document.createElement('button');
    rename.className = 'ghost';
    rename.textContent = '名前を変える';
    rename.addEventListener('click', async () => {
      const next = prompt('新しい名前', c.name);
      if (next === null || next.trim() === c.name) return;
      try {
        await api('PUT', 'api/categories/' + c.id, { name: next, type: c.type });
        show('cat-msg', '');
        await loadAll();
      } catch (e) {
        show('cat-msg', apiMessage(e));
      }
    });
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '削除';
    del.disabled = c.transactionCount > 0;
    del.title = c.transactionCount > 0 ? '取引で使っているカテゴリは削除できません' : '';
    del.addEventListener('click', async () => {
      try {
        await api('DELETE', 'api/categories/' + c.id);
        show('cat-msg', '');
        await loadCategories();
      } catch (e) {
        show('cat-msg', apiMessage(e));
      }
    });
    li.append(name, type, rename, del);
    return li;
  }));
}

function listQuery() {
  const p = new URLSearchParams();
  if ($('q-from').value) p.set('from', $('q-from').value);
  if ($('q-to').value) p.set('to', $('q-to').value);
  if ($('q-category').value) p.set('categoryId', $('q-category').value);
  if ($('q-text').value.trim()) p.set('q', $('q-text').value.trim());
  return p.toString();
}

async function loadList() {
  let rows;
  try {
    ({ data: rows } = await api('GET', 'api/transactions?' + listQuery()));
    show('list-msg', '');
  } catch (e) {
    show('list-msg', apiMessage(e));
    return;
  }
  $('tx-list').replaceChildren(...rows.map((t) => {
    const li = document.createElement('li');
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = t.date.slice(5).replace('-', '/');
    const what = document.createElement('span');
    what.className = 'what';
    const cat = document.createElement('b');
    cat.textContent = t.categoryName;
    const memo = document.createElement('small');
    memo.textContent = t.memo ?? '';   // ユーザー入力なので textContent で入れる
    what.append(cat, memo);
    const amount = document.createElement('span');
    amount.className = 'amount ' + (t.type === 'INCOME' ? 'in' : 'out');
    amount.textContent = (t.type === 'INCOME' ? '+' : '−') + yen(t.amount);
    const edit = document.createElement('button');
    edit.className = 'ghost';
    edit.textContent = '編集';
    edit.addEventListener('click', () => startEdit(t));
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = '削除';
    del.addEventListener('click', async () => {
      if (!confirm(`${t.date} ${t.categoryName} ${yen(t.amount)} を削除しますか？`)) return;
      try {
        await api('DELETE', 'api/transactions/' + t.id);
        if (editing?.id === t.id) stopEdit();
        await refreshAfterChange();
      } catch (e) {
        show('list-msg', apiMessage(e));
      }
    });
    li.append(date, what, amount, edit, del);
    return li;
  }));
  $('tx-empty').hidden = rows.length > 0;
}

async function refreshAfterChange() {
  await loadSummary();
  await loadList();
  await loadCategories();   // 件数（削除できるか）を更新する
}

// --- 入力フォーム（追加と編集） ---

function startEdit(t) {
  editing = t;
  $('f-date').value = t.date;
  $('f-category').value = t.categoryId;
  $('f-amount').value = t.amount;
  $('f-memo').value = t.memo ?? '';
  $('form-title').textContent = '取引を編集';
  $('f-submit').textContent = '更新';
  $('f-cancel').hidden = false;
  show('form-msg', '');
  $('tx-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function stopEdit() {
  editing = null;
  $('form-title').textContent = '取引を入力';
  $('f-submit').textContent = '追加';
  $('f-cancel').hidden = true;
  $('f-amount').value = '';
  $('f-memo').value = '';
}

$('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    date: $('f-date').value,
    amount: Number($('f-amount').value),
    categoryId: Number($('f-category').value),
    memo: $('f-memo').value,
  };
  try {
    if (editing) {
      await api('PUT', 'api/transactions/' + editing.id, body);
      show('form-msg', '更新しました', true);
      stopEdit();
    } else {
      await api('POST', 'api/transactions', body);
      show('form-msg', '追加しました', true);
      $('f-amount').value = '';
      $('f-memo').value = '';
    }
    // 入力した日の月を表示する
    if (body.date.slice(0, 7) !== month) {
      month = body.date.slice(0, 7);
      [$('q-from').value, $('q-to').value] = monthRange(month);
    }
    await refreshAfterChange();
  } catch (err) {
    show('form-msg', apiMessage(err));
  }
});
$('f-cancel').addEventListener('click', stopEdit);

// --- カテゴリの追加 ---

$('cat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', 'api/categories', { name: $('c-name').value, type: $('c-type').value });
    $('c-name').value = '';
    show('cat-msg', '追加しました', true);
    await loadCategories();
  } catch (err) {
    show('cat-msg', apiMessage(err));
  }
});

// --- 絞り込み ---

for (const id of ['q-from', 'q-to', 'q-category']) $(id).addEventListener('change', loadList);
let searchTimer;
$('q-text').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadList, 300);
});
$('prev').addEventListener('click', () => shiftMonth(-1));
$('next').addEventListener('click', () => shiftMonth(1));

// --- データ: CSV・バックアップ・初期化 ---

/** API の応答をファイルとして保存させる（ファイル名は Content-Disposition から） */
async function download(path, fallbackName) {
  const { res, text } = await api('GET', path);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(new Blob([text], { type: res.headers.get('content-type') || 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

function dataResult(text, ok, errors = []) {
  show('data-msg', text, ok);
  $('data-errors').replaceChildren(...errors.map((p) => {
    const li = document.createElement('li');
    li.textContent = (p.line ? `${p.line} 行目: ` : '') + p.message;
    return li;
  }));
}

$('export').addEventListener('click', async () => {
  try {
    dataResult(`${await download('api/export.csv', 'kakeibo.csv')} を保存しました`, true);
  } catch (e) {
    dataResult(apiMessage(e), false);
  }
});

$('backup').addEventListener('click', async () => {
  try {
    dataResult(`${await download('api/backup.sql', 'kakeibo-backup.sql')} を保存しました。ブラウザのデータを消しても、これから復元できます`, true);
  } catch (e) {
    dataResult(apiMessage(e), false);
  }
});

$('import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const { data } = await api('POST', 'api/import', await file.text(), 'text/csv');
    const created = data.createdCategories.length ? `（新しいカテゴリ: ${data.createdCategories.join('、')}）` : '';
    dataResult(`${file.name} から ${data.imported} 件を取り込みました${created}`, true);
    await loadAll();
  } catch (err) {
    dataResult(apiMessage(err), false, err.data?.errors || []);
  }
});

$('restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!confirm(`今のデータを ${file.name} の内容で置き換えます。よろしいですか？`)) return;
  try {
    const { data } = await api('POST', 'api/restore', await file.text(), 'text/plain');
    dataResult(`${file.name} から復元しました（カテゴリ ${data.categories} 件・取引 ${data.transactions} 件）`, true);
    await loadAll();
  } catch (err) {
    dataResult(apiMessage(err), false);
  }
});

$('reset').addEventListener('click', async () => {
  if (!confirm('今のデータを消して、サンプルデータ（今月と先月の取引）を入れます。よろしいですか？')) return;
  try {
    const { data } = await api('POST', 'api/_reset');
    dataResult(`サンプルデータを入れました（カテゴリ ${data.categories} 件・取引 ${data.transactions} 件）`, true);
    month = today().slice(0, 7);
    [$('q-from').value, $('q-to').value] = monthRange(month);
    await loadAll();
  } catch (err) {
    dataResult(apiMessage(err), false);
  }
});

$('boot').addEventListener('click', boot);

// ---------------------------------------------------------------------------

(async () => {
  $('f-date').value = today();
  [$('q-from').value, $('q-to').value] = monthRange(month);
  setState('idle');
  if (!(await setupServiceWorker())) return;
  if (typeof cheerpjInit !== 'function') {
    setState('failed');
    $('error').hidden = false;
    $('error').textContent = 'CheerpJ のローダー（cjrtnc.leaningtech.com）を読み込めませんでした。ネットワークを確認してください。';
    return;
  }
  await startWhenFree();
})();

/**
 * Spring を動かすのは1つのタブだけにする（Web Locks）。
 * どのタブも同じ /files/ のダンプから戻して書き戻すので、2つのタブで動かすと、
 * 古い中身を持ったタブが新しいデータを上書きしてしまう。ほかのタブで動いている間は起動せず、
 * Service Worker 経由でそのタブの Spring を使う。そのタブが閉じられたら、このタブが引き継いで起動する
 */
async function startWhenFree() {
  if (!navigator.locks) {
    await boot();
    return;
  }
  const LOCK = 'spring-kakeibo-backend';
  const held = (await navigator.locks.query()).held?.some((l) => l.name === LOCK);
  if (held) {
    standby = true;
    setState('idle');
    $('role').textContent = '別のタブで Spring が動いています（そのタブの Spring を使います）。そのタブを閉じると、このタブで起動します';
    await loadAll();
  }
  navigator.locks.request(LOCK, async () => {
    await boot();
    // タブが閉じられるまで持ち続ける
    return new Promise(() => {});
  });
}

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// fetch ラッパ（相対パスなので GitHub Pages のサブパスでも動く）
// ---------------------------------------------------------------------------

async function api(method, path, body) {
  const started = performance.now();
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const ms = performance.now() - started;

  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* JSONでなければ文字列のまま */ }

  addLog(method, path, res.status, ms);
  return { res, data, text, ms };
}

// ---------------------------------------------------------------------------
// Service Worker 登録
// ---------------------------------------------------------------------------

function setBadge(text, kind) {
  const el = $('sw');
  el.textContent = 'Service Worker: ' + text;
  el.className = 'badge ' + kind;
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    setBadge('非対応のブラウザ', 'ng');
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
      setBadge('有効', 'ok');
      return true;
    }
    setBadge('未制御 (一度リロードしてください)', 'ng');
    return false;
  } catch (e) {
    console.error(e);
    setBadge('登録失敗: ' + e.message, 'ng');
    return false;
  }
}

// ---------------------------------------------------------------------------
// ログ
// ---------------------------------------------------------------------------

function addLog(method, path, status, ms) {
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  li.textContent = t + '  ' + method + ' /' + path.replace(/^\//, '') + ' → ' + status + ' (' + ms.toFixed(1) + 'ms)';
  const log = $('log');
  log.prepend(li);
  while (log.children.length > 12) log.lastChild.remove();
}

// ---------------------------------------------------------------------------
// Todoアプリ（APIの利用側）
// ---------------------------------------------------------------------------

async function refresh() {
  const { data } = await api('GET', 'api/todos');
  if (!Array.isArray(data)) return; // SWが効いていない場合など
  $('list').replaceChildren(...data.map(renderTodo));
  $('empty').hidden = data.length > 0;
}

function renderTodo(todo) {
  const li = document.createElement('li');
  li.className = todo.done ? 'done' : '';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = todo.done;
  check.style.flex = '0 0 auto';
  check.addEventListener('change', async () => {
    await api('PATCH', 'api/todos/' + todo.id, { done: check.checked });
    await refresh();
  });

  const title = document.createElement('span');
  title.textContent = todo.title; // ユーザー入力なので textContent で挿入

  const del = document.createElement('button');
  del.className = 'ghost';
  del.textContent = '削除';
  del.addEventListener('click', async () => {
    await api('DELETE', 'api/todos/' + todo.id);
    await refresh();
  });

  li.append(check, title, del);
  return li;
}

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('title');
  const title = input.value.trim();
  if (!title) return;
  await api('POST', 'api/todos', { title });
  input.value = '';
  await refresh();
});

// ---------------------------------------------------------------------------
// APIコンソール
// ---------------------------------------------------------------------------

const PRESETS = [
  { label: '一覧', method: 'GET', path: 'api/todos' },
  { label: '未完了のみ', method: 'GET', path: 'api/todos?done=false' },
  { label: '検索', method: 'GET', path: 'api/todos?q=api' },
  { label: '作成', method: 'POST', path: 'api/todos', body: '{"title":"curlでは叩けないAPI"}' },
  { label: '1件取得', method: 'GET', path: 'api/todos/1' },
  { label: '更新(PATCH)', method: 'PATCH', path: 'api/todos/1', body: '{"done":true}' },
  { label: '削除', method: 'DELETE', path: 'api/todos/1' },
  { label: '不正なボディ', method: 'POST', path: 'api/todos', body: '{"title":""}' },
  { label: '存在しないID', method: 'GET', path: 'api/todos/9999' },
  { label: 'health', method: 'GET', path: 'api/health' },
  { label: 'サンプル投入', method: 'POST', path: 'api/_reset' },
];

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.className = 'ghost';
  b.textContent = p.label;
  b.addEventListener('click', () => {
    $('method').value = p.method;
    $('path').value = p.path;
    $('reqbody').value = p.body ?? '';
    sendConsole();
  });
  $('presets').appendChild(b);
}

async function sendConsole() {
  const method = $('method').value;
  const path = $('path').value.trim();
  const raw = $('reqbody').value.trim();
  const body = raw && method !== 'GET' && method !== 'DELETE' ? raw : undefined;

  try {
    const { res, data, ms } = await api(method, path, body);
    const status = $('status');
    status.textContent = res.status + ' ' + (res.statusText || '');
    status.className = 'code ' + (res.ok ? 'ok' : 'err');
    $('time').textContent = ms.toFixed(1) + ' ms';
    $('headers').textContent = [...res.headers.entries()].map(([k, v]) => k + ': ' + v).join('\n');
    $('body').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2) ?? '';
  } catch (e) {
    $('status').textContent = 'ERROR';
    $('status').className = 'code err';
    $('body').textContent = String(e);
  }
  await refresh(); // コンソールで変更した内容をTodo側にも反映
}

$('send').addEventListener('click', sendConsole);

// ---------------------------------------------------------------------------

(async () => {
  await setupServiceWorker();
  await refresh();
})();

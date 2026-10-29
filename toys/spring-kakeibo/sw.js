/*
 * Service Worker × CheerpJ: ブラウザ内 Spring Boot REST API
 *
 * <scope>/api/* への fetch を横取りし、Spring を動かしているページ（バックエンド役のタブ）へ
 * MessageChannel で転送する。返ってきた {status, headers, body} を Response に戻して返す。
 * CheerpJ（JVM）は Service Worker の中では動かさない。
 *
 *   fetch('api/todos') → sw.js → postMessage → ページの CheerpJ → Spring MVC → JSON
 */

// 起動中のタブがあるとき、ready になるのを待つ最大時間。過ぎたら 503 + Retry-After
const WAIT_FOR_READY_MS = 60000;
// バックエンドのタブが 1 件に答えるまでの最大時間。過ぎたら 504
const RESPONSE_TIMEOUT_MS = 30000;
// 503 のときに Retry-After で伝える秒数（Spring の起動にかかる時間の目安）
const RETRY_AFTER_S = 15;

// ready を通知したタブ（宛先は 1 つに絞る）。Service Worker が止まると消えるので、
// そのときは各タブに状態を聞き直して選び直す
let backendId = null;
// ready / failed などの知らせを待っている関数
const waiters = new Set();

const notifyAll = () => { for (const f of [...waiters]) f(); };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// ---------------------------------------------------------------------------
// タブとのやりとり
// ---------------------------------------------------------------------------

/** タブにメッセージを送り、MessageChannel で返事を待つ */
function ask(client, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('timeout'));
    }, timeoutMs);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(e.data);
    };
    client.postMessage(message, [channel.port2]);
  });
}

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  const id = event.source?.id;
  event.waitUntil((async () => {
    if (type === 'backend-ready') {
      // すでに生きている宛先があれば、そのまま使い続ける（タブごとにデータが別なので切り替えない）
      if (!backendId || !(await self.clients.get(backendId))) backendId = id;
    } else if (type === 'backend-stopped' && id === backendId) {
      backendId = null;
    } else if (type === 'backend-info') {
      // ページから「いまの宛先はどのタブか」を聞かれた
      event.ports[0]?.postMessage({ backendId, you: id });
    }
    notifyAll();
  })());
});

/** 今使えるバックエンドのタブを探す。無ければ、起動中のタブがあるかどうかを返す */
async function findBackend() {
  if (backendId) {
    const client = await self.clients.get(backendId);
    if (client) return { client };
    backendId = null;
  }
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const states = await Promise.all(list.map((client) =>
    ask(client, { type: 'backend-status' }, 1000)
      .then((r) => ({ client, state: r?.state }), () => ({ client, state: null }))));
  const ready = states.find((s) => s.state === 'ready');
  if (ready) {
    backendId = ready.client.id;
    return { client: ready.client };
  }
  return { booting: states.some((s) => s.state === 'booting') };
}

/** 知らせが来るか ms 経つまで待つ */
function waitChange(ms) {
  return new Promise((resolve) => {
    const done = () => {
      waiters.delete(done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.add(done);
  });
}

/**
 * バックエンドが使えるようになるまで待つ。
 * 起動中のタブが無ければ待たずに諦める（待っても ready にならないため）
 */
async function waitForBackend() {
  const deadline = Date.now() + WAIT_FOR_READY_MS;
  for (;;) {
    const found = await findBackend();
    if (found.client) return found;
    if (!found.booting) return { reason: 'none' };
    const left = deadline - Date.now();
    if (left <= 0) return { reason: 'timeout' };
    await waitChange(Math.min(left, 2000));
  }
}

// ---------------------------------------------------------------------------
// レスポンス
// ---------------------------------------------------------------------------

function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-served-by': 'service-worker', ...extraHeaders },
  });
}

function unavailable(reason) {
  const message = reason === 'timeout'
    ? `Spring の起動が ${WAIT_FOR_READY_MS / 1000} 秒以内に終わりませんでした`
    : 'Spring を動かしているタブがありません（起動に失敗したか、タブが閉じられた）';
  return json(503, { error: 'backend_unavailable', reason, message }, { 'retry-after': String(RETRY_AFTER_S) });
}

// 本文を持てないステータス
const NULL_BODY = new Set([101, 204, 205, 304]);

/** バックエンドの返事 {status, headers, body} を Response に戻す */
function toResponse(result, apiBase) {
  const headers = new Headers(result.headers);
  // Spring は Location を "/api/todos/1" で返すので、このページの場所（GitHub Pages のサブパス）に合わせる
  const location = headers.get('location');
  if (location?.startsWith('/api/')) {
    headers.set('location', new URL(location.slice('/api/'.length), apiBase).pathname);
  }
  const body = NULL_BODY.has(result.status) ? null : result.body;
  return new Response(body, { status: result.status, headers });
}

// ---------------------------------------------------------------------------
// fetch の横取り
// ---------------------------------------------------------------------------

async function forward(request, url, apiBase) {
  const found = await waitForBackend();
  if (!found.client) return unavailable(found.reason);

  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? '' : await request.text();
  // Spring 側のパスは "/api/…"（ページの場所に関係なく同じ）
  const path = '/api/' + url.pathname.slice(apiBase.pathname.length) + url.search;

  let result;
  try {
    result = await ask(found.client, { type: 'api-request', method, path, body }, RESPONSE_TIMEOUT_MS);
  } catch {
    return json(504, { error: 'backend_timeout', message: `バックエンドが ${RESPONSE_TIMEOUT_MS / 1000} 秒以内に答えませんでした` });
  }
  // 宛先のタブがまだ（もう）準備できていなかった
  if (result?.error === 'not-ready') {
    if (backendId === found.client.id) backendId = null;
    return unavailable('none');
  }
  return toResponse(result, apiBase);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // GitHub Pages のサブパス(/repo/…)でも動くよう、scope 基準で API のルートを決める
  const apiBase = new URL('api/', self.registration.scope);
  if (url.origin !== apiBase.origin || !url.pathname.startsWith(apiBase.pathname)) return;

  event.respondWith(
    forward(event.request, url, apiBase).catch((err) =>
      json(500, { error: 'bridge_error', message: String(err) })
    )
  );
});

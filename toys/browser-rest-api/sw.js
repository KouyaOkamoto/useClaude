/*
 * ブラウザ内REST API
 * Service Worker が <scope>/api/* へのfetchを横取りして、サーバーなしでJSONを返す。
 * データは IndexedDB に保存（IndexedDBが無い環境＝テスト時はメモリ）。
 *
 * 依存ライブラリなし。classic script なので importScripts/ビルドも不要。
 */

const DB_NAME = 'browser-rest-api';
const STORE = 'todos';

// ---------------------------------------------------------------------------
// ストレージ (list / get / create / replace / remove / clear の共通インターフェース)
// ---------------------------------------------------------------------------

function createMemoryStore() {
  const items = new Map();
  let seq = 0;
  return {
    async list() { return [...items.values()]; },
    async get(id) { return items.get(id) ?? null; },
    async create(data) {
      const item = { id: ++seq, ...data };
      items.set(item.id, item);
      return item;
    },
    async replace(item) { items.set(item.id, item); return item; },
    async remove(id) { return items.delete(id); },
    async clear() { items.clear(); seq = 0; },
  };
}

function createIdbStore() {
  let dbPromise = null;

  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () =>
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const wrap = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const objectStore = async (mode) => {
    dbPromise ??= openDb();
    const db = await dbPromise;
    return db.transaction(STORE, mode).objectStore(STORE);
  };

  return {
    async list() { return wrap((await objectStore('readonly')).getAll()); },
    async get(id) { return (await wrap((await objectStore('readonly')).get(id))) ?? null; },
    async create(data) {
      const id = await wrap((await objectStore('readwrite')).add(data));
      return { id, ...data };
    },
    async replace(item) { await wrap((await objectStore('readwrite')).put(item)); return item; },
    async remove(id) {
      if (!(await this.get(id))) return false;
      await wrap((await objectStore('readwrite')).delete(id));
      return true;
    },
    // store.clear() だけでは自動採番が続きから始まる（id が 1 に戻らない）ので、
    // DBごと削除して作り直す。メモリ版の clear() と同じく id は 1 から振り直される
    async clear() {
      if (dbPromise) (await dbPromise).close();
      dbPromise = null;
      await wrap(indexedDB.deleteDatabase(DB_NAME));
    },
  };
}

// ---------------------------------------------------------------------------
// レスポンス / バリデーション
// ---------------------------------------------------------------------------

function respond(status, data, extraHeaders = {}) {
  const headers = { 'x-served-by': 'service-worker', ...extraHeaders };
  if (data === undefined) return new Response(null, { status, headers });
  headers['content-type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(data), { status, headers });
}

const badRequest = (message) => respond(400, { error: 'validation_error', message });
const notFound = (message = 'resource not found') => respond(404, { error: 'not_found', message });
const methodNotAllowed = (allow) =>
  respond(405, { error: 'method_not_allowed', allow }, { allow: allow.join(', ') });

async function readJson(request) {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

// partial=true なら PATCH 用（指定されたフィールドだけ検証）
function validate(input, { partial }) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'body must be a JSON object' };
  }
  const out = {};
  if (!partial || 'title' in input) {
    if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > 200) {
      return { error: 'title must be a non-empty string (max 200 chars)' };
    }
    out.title = input.title.trim();
  }
  if ('done' in input) {
    if (typeof input.done !== 'boolean') return { error: 'done must be a boolean' };
    out.done = input.done;
  }
  return { value: out };
}

const SAMPLE = [
  { title: 'Service Worker でAPIを作る', done: true },
  { title: 'IndexedDB に保存する', done: false },
  { title: 'GitHub Pages に置く', done: false },
];

// ---------------------------------------------------------------------------
// ルーティング本体: Request -> Response （環境非依存なのでNodeでもテストできる）
// apiBase は "https://host/app/api/" のような API ルートURL
// ---------------------------------------------------------------------------

async function handle(request, store, apiBase) {
  const url = new URL(request.url);
  const sub = '/' + url.pathname.slice(apiBase.pathname.length).replace(/\/+$/, '');
  const method = request.method.toUpperCase();
  const itemUrl = (id) => new URL('todos/' + id, apiBase).pathname;

  if (sub === '/') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return respond(200, {
      name: 'browser-rest-api',
      endpoints: [
        'GET /health',
        'GET /todos?done=true|false&q=text',
        'POST /todos',
        'GET /todos/:id',
        'PUT /todos/:id',
        'PATCH /todos/:id',
        'DELETE /todos/:id',
        'POST /_reset',
      ],
    });
  }

  if (sub === '/health') {
    if (method !== 'GET') return methodNotAllowed(['GET']);
    return respond(200, { status: 'ok', runtime: 'service-worker', time: new Date().toISOString() });
  }

  if (sub === '/_reset') {
    if (method !== 'POST') return methodNotAllowed(['POST']);
    await store.clear();
    const now = new Date().toISOString();
    for (const s of SAMPLE) await store.create({ ...s, createdAt: now });
    return respond(204);
  }

  if (sub === '/todos') {
    if (method === 'GET') {
      let items = await store.list();
      const done = url.searchParams.get('done');
      const q = url.searchParams.get('q');
      if (done === 'true' || done === 'false') items = items.filter((t) => t.done === (done === 'true'));
      if (q) items = items.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
      items.sort((a, b) => a.id - b.id);
      return respond(200, items);
    }
    if (method === 'POST') {
      const body = await readJson(request);
      if (!body.ok) return badRequest('body must be valid JSON');
      const v = validate(body.value, { partial: false });
      if (v.error) return badRequest(v.error);
      const item = await store.create({
        title: v.value.title,
        done: v.value.done ?? false,
        createdAt: new Date().toISOString(),
      });
      return respond(201, item, { location: itemUrl(item.id) });
    }
    return methodNotAllowed(['GET', 'POST']);
  }

  const m = sub.match(/^\/todos\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const existing = await store.get(id);

    if (method === 'GET') return existing ? respond(200, existing) : notFound(`todo ${id} not found`);
    if (method === 'DELETE') {
      return (await store.remove(id)) ? respond(204) : notFound(`todo ${id} not found`);
    }
    if (method === 'PUT' || method === 'PATCH') {
      if (!existing) return notFound(`todo ${id} not found`);
      const body = await readJson(request);
      if (!body.ok) return badRequest('body must be valid JSON');
      const partial = method === 'PATCH';
      const v = validate(body.value, { partial });
      if (v.error) return badRequest(v.error);
      const next = partial
        ? { ...existing, ...v.value }
        : { id, title: v.value.title, done: v.value.done ?? false, createdAt: existing.createdAt };
      return respond(200, await store.replace(next));
    }
    return methodNotAllowed(['GET', 'PUT', 'PATCH', 'DELETE']);
  }

  return notFound(`no route for ${method} ${sub}`);
}

// ---------------------------------------------------------------------------
// Service Worker 配線
// ---------------------------------------------------------------------------

const store = typeof indexedDB !== 'undefined' ? createIdbStore() : createMemoryStore();

// テスト用に公開（Service Worker内では無害）
self.__restApi = { handle, createMemoryStore };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // GitHub Pages のサブパス(/repo/)でも動くよう、scope 基準でAPIルートを決める
  const apiBase = new URL('api/', self.registration.scope);
  if (url.origin !== apiBase.origin || !url.pathname.startsWith(apiBase.pathname)) return;

  event.respondWith(
    handle(event.request, store, apiBase).catch((err) =>
      respond(500, { error: 'internal_error', message: String(err) })
    )
  );
});

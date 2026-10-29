import { test } from 'node:test';
import assert from 'node:assert/strict';

// sw.js を Node 上で読み込む（self=globalThis、fetchイベントは無視）
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
await import('../sw.js');
const { handle, createMemoryStore } = globalThis.__restApi;

const base = new URL('http://localhost/app/api/');

function makeClient() {
  const store = createMemoryStore();
  return async (method, path, body) => {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await handle(new Request(new URL(path, base), init), store, base);
    const text = await res.text();
    return { res, status: res.status, json: text ? JSON.parse(text) : null };
  };
}

test('health / index', async () => {
  const call = makeClient();
  const h = await call('GET', 'health');
  assert.equal(h.status, 200);
  assert.equal(h.json.runtime, 'service-worker');
  assert.equal(h.res.headers.get('x-served-by'), 'service-worker');
  const root = await call('GET', '');
  assert.equal(root.status, 200);
  assert.ok(root.json.endpoints.length > 0);
});

test('CRUD flow', async () => {
  const call = makeClient();

  assert.deepEqual((await call('GET', 'todos')).json, []);

  const created = await call('POST', 'todos', { title: '  牛乳を買う  ' });
  assert.equal(created.status, 201);
  assert.equal(created.json.id, 1);
  assert.equal(created.json.title, '牛乳を買う');
  assert.equal(created.json.done, false);
  assert.equal(created.res.headers.get('location'), '/app/api/todos/1');

  assert.equal((await call('GET', 'todos/1')).json.title, '牛乳を買う');

  const patched = await call('PATCH', 'todos/1', { done: true });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.done, true);
  assert.equal(patched.json.title, '牛乳を買う');

  const put = await call('PUT', 'todos/1', { title: '卵を買う' });
  assert.equal(put.status, 200);
  assert.equal(put.json.done, false); // PUT は全置換なので done はデフォルトに戻る
  assert.equal(put.json.createdAt, created.json.createdAt);

  const del = await call('DELETE', 'todos/1');
  assert.equal(del.status, 204);
  assert.equal(del.json, null);
  assert.equal((await call('GET', 'todos/1')).status, 404);
  assert.equal((await call('DELETE', 'todos/1')).status, 404);
});

test('filters and sorting', async () => {
  const call = makeClient();
  await call('POST', 'todos', { title: 'Apple', done: true });
  await call('POST', 'todos', { title: 'banana' });
  await call('POST', 'todos', { title: 'Pineapple', done: true });

  assert.deepEqual((await call('GET', 'todos')).json.map((t) => t.id), [1, 2, 3]);
  assert.deepEqual((await call('GET', 'todos?done=true')).json.map((t) => t.id), [1, 3]);
  assert.deepEqual((await call('GET', 'todos?done=false')).json.map((t) => t.id), [2]);
  assert.deepEqual((await call('GET', 'todos?q=APPLE')).json.map((t) => t.id), [1, 3]);
});

test('validation errors', async () => {
  const call = makeClient();
  assert.equal((await call('POST', 'todos', '{not json')).status, 400);
  assert.equal((await call('POST', 'todos', {})).status, 400);
  assert.equal((await call('POST', 'todos', { title: '   ' })).status, 400);
  assert.equal((await call('POST', 'todos', { title: 'x'.repeat(201) })).status, 400);
  assert.equal((await call('POST', 'todos', { title: 'ok', done: 'yes' })).status, 400);
  assert.equal((await call('POST', 'todos', [1, 2])).status, 400);

  await call('POST', 'todos', { title: 'ok' });
  assert.equal((await call('PATCH', 'todos/1', { title: '' })).status, 400);
  assert.equal((await call('PUT', 'todos/1', { done: true })).status, 400); // PUTはtitle必須
  assert.equal((await call('PATCH', 'todos/99', { done: true })).status, 404);
});

test('routing errors', async () => {
  const call = makeClient();
  assert.equal((await call('GET', 'nope')).status, 404);
  assert.equal((await call('GET', 'todos/abc')).status, 404);

  const m = await call('DELETE', 'todos');
  assert.equal(m.status, 405);
  assert.equal(m.res.headers.get('allow'), 'GET, POST');
  assert.equal((await call('POST', 'health')).status, 405);
});

test('reset seeds sample data', async () => {
  const call = makeClient();
  await call('POST', 'todos', { title: 'temp' });
  assert.equal((await call('POST', '_reset')).status, 204);
  const list = (await call('GET', 'todos')).json;
  assert.equal(list.length, 3);
  assert.equal(list[0].id, 1);
  assert.equal(list.filter((t) => t.done).length, 1);
});

test('works under a different base path (GitHub Pages subpath / root)', async () => {
  const store = createMemoryStore();
  for (const b of ['http://localhost/api/', 'https://user.github.io/repo/sub/api/']) {
    const apiBase = new URL(b);
    const res = await handle(
      new Request(new URL('todos', apiBase), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x' }),
      }),
      store,
      apiBase
    );
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('location'), new URL('todos/' + (await res.json()).id, apiBase).pathname);
  }
});

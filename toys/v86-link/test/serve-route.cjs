// テスト用: サーバーを立てずに、Playwright の route で toys/v86-link/ のファイルを返す。
// ページの URL のホストが v86-link.test のときだけ使う（例: node toys/v86-link/test/e2e.cjs http://v86-link.test/）。
// それ以外の URL（http://localhost:8080/toys/v86-link/ など）なら何もしない（いままでどおり、そのサーバーから取る）
const fs = require('fs');
const path = require('path');

const ROUTE_HOST = 'v86-link.test';
const ROOT = path.resolve(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/** ctx（BrowserContext）に route を付ける。base のホストが v86-link.test でなければ何もしない */
async function serveLocal(ctx, base) {
  const u = new URL(base);
  if (u.host !== ROUTE_HOST) return false;
  await ctx.route(`${u.protocol}//${ROUTE_HOST}/**`, (route) => {
    let rel = decodeURIComponent(new URL(route.request().url()).pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const body = fs.readFileSync(file);
    route.fulfill({ status: 200, body, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', headers: { 'content-length': String(body.length) } });
  });
  return true;
}

/**
 * ページの URL に、環境変数 SNAPSHOT=off / memory なら ?snapshot=off / memory を足す（e2e を、スナップショットなし・
 * メモリだけでも通すため）。既定（SNAPSHOT 無し）は、保存した起動イメージも使う
 */
function withSnapshotParam(url, mode = process.env.SNAPSHOT) {
  if (mode !== 'off' && mode !== 'memory') return url;
  const u = new URL(url);
  u.searchParams.set('snapshot', mode);
  return u.toString();
}

module.exports = { serveLocal, withSnapshotParam, ROUTE_HOST };

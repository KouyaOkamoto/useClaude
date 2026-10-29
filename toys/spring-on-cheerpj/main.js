const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

// CheerpJ が投げる例外オブジェクトは、そのまま文字列と連結すると
// "Cannot convert object to primitive value" になり、原因が表示されないまま止まる。安全に文字列にする
function errText(e) {
  try { return String(e); } catch { /* 次の方法を試す */ }
  try { return (e?.constructor?.name ?? 'Error') + ': ' + (e?.message ?? JSON.stringify(e)); } catch { /* 次の方法を試す */ }
  return Object.prototype.toString.call(e);
}

let Probe = null;

function setEnabled(on) {
  document.querySelectorAll('#levels button, #all, #send').forEach((b) => (b.disabled = !on));
}

// ---------------------------------------------------------------------------
// 起動: CheerpJ 初期化 → jar 読込
// ---------------------------------------------------------------------------

async function boot() {
  $('boot').disabled = true;
  try {
    const t0 = performance.now();
    log('[boot] cheerpjInit (Java 11) ...');
    await cheerpjInit({ version: 11, status: 'none' });
    log('[boot] runtime ready ' + fmt(performance.now() - t0), 'ok');

    // CheerpJ の /app/ は「Webサーバーのルート」を指す想定。
    // サブパス配信(GitHub Pagesなど)でもURLのパスをそのまま付ける。
    const params = new URLSearchParams(location.search);
    const jarPath = params.get('jar') || '/app' + new URL('probe.jar', location.href).pathname;
    log('[boot] loading ' + jarPath + ' ...');

    const t1 = performance.now();
    const lib = await cheerpjRunLibrary(jarPath);
    Probe = await lib.demo.Probe;
    log('[boot] jar loaded ' + fmt(performance.now() - t1), 'ok');

    setEnabled(true);
  } catch (e) {
    log('[boot] FAILED: ' + errText(e), 'err');
    log('  詳しい理由はブラウザのコンソールに出ます。手元のサーバーで試している場合は、'
      + 'HTTP の Range リクエストに対応しているか確認してください（Python の http.server は非対応）', 'err');
    console.error(e);
    $('boot').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Java の static メソッド呼び出し
// Java側は常に "OK <ms>ms\n..." か "FAIL <ms>ms\n<stacktrace>" を返す。
// ---------------------------------------------------------------------------

async function call(name, ...args) {
  const label = name + (args.length ? '(' + args.map((a) => JSON.stringify(a)).join(', ') + ')' : '');
  log('> ' + label + ' ...');
  const t = performance.now();
  try {
    const result = String(await Probe[name](...args));
    const ok = result.startsWith('OK');
    log(result + '\n  (wall ' + fmt(performance.now() - t) + ')', ok ? 'ok' : 'err');
    return ok;
  } catch (e) {
    // Java側で捕捉しきれなかった例外（JVM/CheerpJレベルの失敗）
    log('JS-side exception: ' + errText(e) + '\n  (wall ' + fmt(performance.now() - t) + ')', 'err');
    console.error(e);
    return false;
  }
}

const LEVEL_ARGS = { level3: ['GET', '/api/todos', ''] };

document.querySelectorAll('#levels button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const m = btn.dataset.m;
    btn.disabled = true;
    await call(m, ...(LEVEL_ARGS[m] || []));
    btn.disabled = false;
  });
});

$('all').addEventListener('click', async () => {
  $('all').disabled = true;
  for (const m of ['level0', 'level1', 'level1Scan', 'level2', 'level3']) {
    const ok = await call(m, ...(LEVEL_ARGS[m] || []));
    if (!ok) {
      log('-- ' + m + ' で失敗したため中断 --', 'err');
      break;
    }
  }
  $('all').disabled = false;
});

$('send').addEventListener('click', async () => {
  const method = $('method').value;
  const body = method === 'POST' ? $('reqbody').value : '';
  await call('level3', method, $('path').value.trim(), body);
});

$('boot').addEventListener('click', boot);

$('copy').addEventListener('click', async () => {
  const header = 'UA: ' + navigator.userAgent + '\n\n';
  try {
    await navigator.clipboard.writeText(header + logEl.innerText);
    log('(ログをクリップボードにコピーしました)');
  } catch {
    log('(コピー失敗: ログを手動で選択してコピーしてください)', 'err');
  }
});

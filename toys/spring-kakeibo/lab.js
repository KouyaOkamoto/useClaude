const $ = (id) => document.getElementById(id);
const logEl = $('log');
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

function log(text, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// CheerpJ が投げる例外オブジェクトは、そのまま文字列と連結すると TypeError になる。安全に文字列にする
function errText(e) {
  const tries = [() => e?.message, () => e?.stack, () => String(e), () => JSON.stringify(e), () => Object.prototype.toString.call(e)];
  for (const f of tries) {
    try {
      const s = f();
      if (typeof s === 'string' && s && s !== '{}') return s;
    } catch { /* 次の方法を試す */ }
  }
  return '(内容を表示できない例外)';
}

// 検証で呼ぶ Java の static メソッド（クラス名.メソッド名 と引数）
const CALLS = [
  ['Stage A: H2(メモリ)+JdbcTemplate', 'Lab', 'stageA'],
  ['Stage A: 集計だけ', 'Lab', 'stageAQuery'],
  ...['default', 'nolock', 'nolock-wd0'].flatMap((v) => [
    [`Stage B ${v}: 書く`, 'Lab', 'stageBWrite', v],
    [`Stage B ${v}: 読む`, 'Lab', 'stageBRead', v],
    [`Stage B ${v}: 書き出しを強制`, 'Lab', 'stageBSync', v],
    [`Stage B ${v}: 閉じる`, 'Lab', 'stageBClose', v],
  ]),
  ['Stage B ダンプ: 書く', 'Lab', 'stageBDumpWrite'],
  ['Stage B ダンプ: 読む', 'Lab', 'stageBDumpRead'],
  ['Stage B ダンプ: 3000行足す', 'Lab', 'stageBDumpBulk', '3000'],
  ['Stage B: /files の中身', 'Lab', 'stageBFiles'],
  // Stage C: 1つのページでは1つの構成だけ起動する（クラスの読み込みが時間の大部分のため）
  ...['jdbc', 'jpa', 'jpa+lazy', 'jpa+osiv', 'jpa+ddlnone', 'jpa+meta', 'jpa+simpleds', 'jpa+hikari1', 'jpa+unused',
    'jpa+lazy+osiv+meta+simpleds+unused', 'jdbc+lazy+simpleds+unused']
    .map((spec) => [`Stage C 起動: ${spec}`, 'LabBoot', 'boot', spec]),
  ['Stage C: リクエスト', 'LabBoot', 'request'],
];

let lib = null;
const classes = {};

async function boot() {
  $('boot').disabled = true;
  try {
    const t0 = performance.now();
    log('[boot] cheerpjInit (Java 11) ...');
    await cheerpjInit({ version: 11, status: 'none' });
    log('[boot] runtime ready ' + fmt(performance.now() - t0), 'ok');

    // CheerpJ の /app/ は Web サーバーのルートを指す。サブパス配信でも URL のパスをそのまま付ける
    const jarPath = new URLSearchParams(location.search).get('jar') || '/app' + new URL('probe.jar', location.href).pathname;
    log('[boot] loading ' + jarPath + ' ...');
    const t1 = performance.now();
    lib = await cheerpjRunLibrary(jarPath);
    for (const name of new Set(CALLS.map((c) => c[1]))) classes[name] = await lib.demo[name];
    log('[boot] jar loaded ' + fmt(performance.now() - t1), 'ok');
    document.querySelectorAll('#levels button').forEach((b) => (b.disabled = false));
  } catch (e) {
    console.error(e);
    log('[boot] FAILED: ' + errText(e), 'err');
    $('boot').disabled = false;
  }
}

async function call(cls, method, ...args) {
  log('> ' + cls + '.' + method + '(' + args.map((a) => JSON.stringify(a)).join(', ') + ') ...');
  const t = performance.now();
  try {
    const result = String(await classes[cls][method](...args));
    log(result + '\n  (wall ' + fmt(performance.now() - t) + ')', result.startsWith('OK') ? 'ok' : 'err');
  } catch (e) {
    console.error(e);
    log('JS-side exception: ' + errText(e) + '\n  (wall ' + fmt(performance.now() - t) + ')', 'err');
  }
}

for (const [label, cls, method, ...args] of CALLS) {
  const b = document.createElement('button');
  b.textContent = label;
  b.disabled = true;
  // 引数つきの呼び出しも区別できるよう、メソッド名と引数を入れる
  b.dataset.call = [method, ...args].join(':');
  b.addEventListener('click', async () => {
    b.disabled = true;
    await call(cls, method, ...args);
    b.disabled = false;
  });
  $('levels').appendChild(b);
}

$('boot').addEventListener('click', boot);
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText('UA: ' + navigator.userAgent + '\n\n' + logEl.innerText);
    log('(ログをクリップボードにコピーしました)');
  } catch {
    log('(コピー失敗: ログを手動で選択してコピーしてください)', 'err');
  }
});

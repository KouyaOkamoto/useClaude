// ビルドせずに GitHub Pages で配信するため、依存は CDN から読む。
// WebContainer は importmap 経由、xterm と addon-fit は index.html の <script> でグローバルに入る
import { WebContainer } from '@webcontainer/api';
import { files, editable } from './template.js';

const { Terminal } = window;
const { FitAddon } = window.FitAddon;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const startBtn = $('start');
const fileSel = $('file');
const codeEl = $('code');
const previewEl = $('preview');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + kind;
}

// ---- cross-origin isolation の確認 ----
const iso = $('isolation');
if (window.crossOriginIsolated) {
  iso.textContent = 'crossOriginIsolated: OK';
  iso.className = 'badge ok';
} else {
  iso.textContent = 'crossOriginIsolated: NG (COOP/COEPヘッダ未設定。Service Worker が使えない環境の可能性)';
  iso.className = 'badge ng';
  startBtn.disabled = true;
  setStatus('COOP/COEPヘッダが無いため起動できません', 'err');
}

// ---- ターミナル ----
function makeTerm(el, opts = {}) {
  const term = new Terminal({
    convertEol: true,
    fontSize: 12,
    theme: { background: '#0f1419' },
    ...opts,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  return { term, fit };
}
const logT = makeTerm($('log'), { disableStdin: true });
const shellT = makeTerm($('shell'));

// タブ切り替え
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    for (const id of ['log', 'shell']) {
      $(id).classList.toggle('hidden', id !== tab.dataset.target);
    }
    (tab.dataset.target === 'log' ? logT : shellT).fit.fit();
  });
});
window.addEventListener('resize', () => {
  logT.fit.fit();
  shellT.fit.fit();
});
requestAnimationFrame(() => logT.fit.fit());

// ---- エディタ ----
for (const path of editable) {
  const opt = document.createElement('option');
  opt.value = path;
  opt.textContent = path;
  fileSel.appendChild(opt);
}

const contentOf = (path) => {
  let node = { directory: files };
  for (const part of path.split('/')) node = node.directory[part];
  return node.file.contents;
};

let wc = null;
let currentPath = editable[0];
codeEl.value = contentOf(currentPath);

fileSel.addEventListener('change', async () => {
  currentPath = fileSel.value;
  codeEl.value = wc ? await wc.fs.readFile(currentPath, 'utf-8') : contentOf(currentPath);
});

let timer = null;
codeEl.addEventListener('input', () => {
  if (!wc) return;
  clearTimeout(timer);
  timer = setTimeout(() => wc.fs.writeFile(currentPath, codeEl.value), 300);
});

// ---- 起動 ----
async function run(cmd, args, term) {
  const proc = await wc.spawn(cmd, args);
  proc.output.pipeTo(new WritableStream({ write: (d) => term.write(d) }));
  return proc;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    setStatus('WebContainer を起動中…');
    wc = await WebContainer.boot();

    wc.on('server-ready', (port, url) => {
      previewEl.src = url;
      setStatus('実行中 (port ' + port + ')', 'ok');
    });
    wc.on('error', (e) => {
      logT.term.writeln('\r\n[webcontainer error] ' + e.message);
      setStatus('エラー', 'err');
    });

    await wc.mount(files);
    codeEl.disabled = false;

    setStatus('npm install 実行中…');
    logT.term.writeln('$ npm install');
    const install = await run('npm', ['install'], logT.term);
    if ((await install.exit) !== 0) {
      setStatus('npm install に失敗', 'err');
      return;
    }

    setStatus('dev server 起動中…');
    logT.term.writeln('\r\n$ npm run dev');
    await run('npm', ['run', 'dev'], logT.term);

    // 対話シェル
    const sh = await wc.spawn('jsh', { terminal: { cols: shellT.term.cols, rows: shellT.term.rows } });
    sh.output.pipeTo(new WritableStream({ write: (d) => shellT.term.write(d) }));
    const input = sh.input.getWriter();
    shellT.term.onData((d) => input.write(d));
    shellT.term.onResize(({ cols, rows }) => sh.resize({ cols, rows }));
  } catch (e) {
    console.error(e);
    setStatus('起動に失敗: ' + e.message, 'err');
    startBtn.disabled = false;
  }
});

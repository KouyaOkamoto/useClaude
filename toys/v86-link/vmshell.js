// シナリオの検査用: 学習者の VM の2本目のシリアル（ttyS1）のシェルで、コマンドを実行する。DOM にも v86 にも依存しない。
//
// 学習者の端末は ttyS0。検査は ttyS1 だけを使うので、学習者の入力と衝突せず、端末にも何も出ない
// （ステップ0の調査。docs/scenario-step0.md）。
//
//   VmShell.bootstrapCommand  … ttyS0 で1回だけ実行して、ttyS1 にシェルを起動するコマンド（シナリオの起動中、端末を渡す前に）
//   shell.run(cmd, {timeoutMs}) → { exitCode, output } / { error: 'shell-unresponsive' }
//   shell.alive()             … ttyS1 のシェルが応答するか
//
// node は VmNode に、2本目のシリアルの writeSerialPort(1, text) と、"serial1" イベント（Uint8Array）を足したもの（vm.js）。
// 実行は1つずつ（前のコマンドが終わってから次を送る）。応答が無ければ shell-unresponsive（ttyS0 には何も入れない）。
//
// 下の build* / parse* は、検査の種類ごとのコマンドと出力の解析（純粋な関数。単体テストする）。
// コマンドに入れる値（IP・ポート・パス）は、スキーマで検証したものだけ。ここでも形を確かめて、違えば実行しない。

/** ttyS1 にシェルを起動する（エコーを切る。setsid で ttyS0 のシェルから切り離す） */
// プロンプトも消す（PS1・PS2 を空に。出力にプロンプトが混ざらないように）
// ( … &) のサブシェルで起動する（対話シェルのジョブにしない。端末に「[1]+ Done …」を出さない）
export const BOOTSTRAP = "(setsid sh -c 'stty -echo </dev/ttyS1; PS1= PS2= exec /bin/sh </dev/ttyS1 >/dev/ttyS1 2>&1' &)";

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._~\/-]{0,200}$/;
const ensure = (ok, what) => { if (!ok) throw new Error(`検査のコマンドに使えない値: ${what}`); };
const secs = (ms) => Math.max(1, Math.min(30, Math.round(ms / 1000)));

export function buildPing(to, timeoutMs) {
  ensure(IPV4.test(to), to);
  return `ping -c 2 -w ${secs(timeoutMs)} ${to} 2>&1`;
}
export function parsePing(output, exitCode) {
  const m = /(\d+) packets transmitted, (\d+) received/.exec(output);
  const received = m ? Number(m[2]) : 0;
  const ttl = /ttl=(\d+)/.exec(output);
  if (received > 0) return { ok: true, ttl: ttl ? Number(ttl[1]) : undefined };
  if (/Time to live exceeded/i.test(output)) return { ok: false, reason: 'ttl-exceeded' };
  if (/Unreachable/i.test(output)) return { ok: false, reason: 'unreachable' };
  if (/Network is unreachable/i.test(output) || exitCode === 2) return { ok: false, reason: 'unreachable' };
  return { ok: false, reason: 'timeout' };
}

export function buildTcp(to, port, timeoutMs) {
  ensure(IPV4.test(to), to);
  ensure(Number.isInteger(port) && port >= 1 && port <= 65535, port);
  return `nc -z -w ${secs(timeoutMs)} ${to} ${port}`;
}
/** BusyBox の nc -z は、つながれば 0。つながらない（RST・無応答・届かない）は区別できないので not-open */
export const parseTcp = (output, exitCode) => ({ state: exitCode === 0 ? 'open' : 'not-open' });

export function buildHttp(to, port, path, timeoutMs) {
  ensure(IPV4.test(to), to);
  ensure(Number.isInteger(port) && port >= 1 && port <= 65535, port);
  ensure(SAFE_PATH.test(path), path);
  return `wget -S -q -O - -T ${secs(timeoutMs)} http://${to}:${port}${path} 2>&1 | head -c 65536`;
}
/** wget -S の出力（ヘッダは "  HTTP/1.1 200 OK"、本文は空行のあと） */
export function parseHttp(output) {
  const text = String(output ?? '').replace(/\r/g, '');
  const st = /^\s*HTTP\/\d\.\d (\d{3})/m.exec(text);
  if (st) {
    const status = Number(st[1]);
    const lines = text.split('\n');
    const blank = lines.findIndex((l, i) => i > 0 && /^\s*$/.test(l) && /^\s+\S/.test(lines[i - 1] ?? ''));
    const body = blank >= 0 ? lines.slice(blank + 1).filter((l) => !/^wget: /.test(l)).join('\n') : '';
    return { ok: true, status, body };
  }
  if (/Connection refused/i.test(text)) return { ok: false, reason: 'refused' };
  if (/timed out/i.test(text)) return { ok: false, reason: 'timeout-connect' };
  if (/unreachable|No route/i.test(text)) return { ok: false, reason: 'unreachable' };
  return { ok: false, reason: 'bad-response' };
}

export const buildRoute = () => 'ip -4 route show default';
export function parseRoute(output) {
  const m = /^default via (\S+)/m.exec(String(output ?? ''));
  return { defaultGateway: m && IPV4.test(m[1]) ? m[1] : null };
}

/** tcp_source の検査: 相手（プローブ）へ TCP で接続し、1行送って閉じる（送り元はプローブが記録する） */
export function buildConnect(to, port, timeoutMs) {
  ensure(IPV4.test(to), to);
  ensure(Number.isInteger(port) && port >= 1 && port <= 65535, port);
  return `echo V86-SOURCE | nc -w ${secs(timeoutMs)} ${to} ${port} >/dev/null 2>&1`;
}

/** capture の検査のきっかけ（ARP の問い合わせ / ping） */
export function buildStimulus({ action, target }) {
  ensure(IPV4.test(target), target);
  if (action === 'arp') return `arping -c 2 -w 3 -I eth0 ${target} >/dev/null 2>&1; true`;
  if (action === 'ping') return `ping -c 2 -w 3 ${target} >/dev/null 2>&1; true`;
  throw new Error(`知らないきっかけ: ${action}`);
}

let seq = 0;

export class VmShell {
  /**
   * @param {object} node  writeSerialPort(port, text) と on('serial1', bytes) を持つもの（vm.js の V86Node）
   * @param {{ setTimer?: Function, clearTimer?: Function }} env
   */
  constructor(node, env = {}) {
    this.node = node;
    this.setTimer = env.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = env.clearTimer ?? ((t) => clearTimeout(t));
    this.out = '';
    this.decoder = new TextDecoder();
    this.queue = Promise.resolve();
    this.unsubscribe = node.on('serial1', (bytes) => {
      this.out += this.decoder.decode(bytes, { stream: true });
      if (this.out.length > 200000) this.out = this.out.slice(-100000);
      this.wake?.();
    });
  }

  static get bootstrapCommand() { return BOOTSTRAP; }

  dispose() { this.unsubscribe?.(); this.wake?.(); }

  /** コマンドを1つ実行する（前のものが終わってから）。{ exitCode, output } か { error } */
  run(cmd, { timeoutMs = 10000 } = {}) {
    const p = this.queue.then(() => this.exec(cmd, timeoutMs));
    this.queue = p.catch(() => {});
    return p;
  }

  exec(cmd, timeoutMs) {
    const tag = `V86CHK${++seq}x${Math.floor(Math.random() * 1e6)}`;
    const re = new RegExp(`^${tag}-END:(\\d+)\\s*$`, 'm');
    const mark = this.out.length;
    // 行の途中に残った入力があっても混ざらないよう、先に空行を送る（ttyS1 は学習者が使わないので、ふつうは空）
    this.node.writeSerialPort(1, `\n${cmd}; echo "${tag}""-END:$?"\n`);
    return new Promise((resolve) => {
      let timer;
      const check = () => {
        const text = this.out.slice(mark);
        const m = re.exec(text);
        if (!m) return false;
        this.clearTimer(timer);
        this.wake = null;
        // プロンプトは起動のときに消している（BOOTSTRAP の PS1=）。出力はそのまま返す
        // 先頭の改行と末尾の空白だけ除く（行頭の空白は残す。wget -S のヘッダ行は空白で始まる）
        const output = text.slice(0, m.index).replace(/\r/g, '').replace(/^\n+/, '').replace(/\s+$/, '');
        resolve({ exitCode: Number(m[1]), output });
        return true;
      };
      this.wake = check;
      timer = this.setTimer(() => { this.wake = null; resolve({ error: 'shell-unresponsive' }); }, timeoutMs);
      check();
    });
  }

  async alive(timeoutMs = 3000) {
    const r = await this.run('true', { timeoutMs });
    return !r.error && r.exitCode === 0;
  }

  // ---------------------------------------------------------------- 検査（evaluate.js の vm アダプタの中身）

  async ping(to, { timeoutMs = 5000 } = {}) {
    const r = await this.run(buildPing(to, timeoutMs), { timeoutMs: timeoutMs + 4000 });
    return r.error ? r : parsePing(r.output, r.exitCode);
  }
  async tcp(to, port, { timeoutMs = 5000 } = {}) {
    const r = await this.run(buildTcp(to, port, timeoutMs), { timeoutMs: timeoutMs + 4000 });
    return r.error ? r : parseTcp(r.output, r.exitCode);
  }
  async http(to, port, path, { timeoutMs = 8000 } = {}) {
    const r = await this.run(buildHttp(to, port, path, timeoutMs), { timeoutMs: timeoutMs + 4000 });
    return r.error ? r : parseHttp(r.output);
  }
  async route({ timeoutMs = 5000 } = {}) {
    const r = await this.run(buildRoute(), { timeoutMs });
    return r.error ? r : parseRoute(r.output);
  }
  async shell(command, { timeoutMs = 15000 } = {}) {
    return this.run(command, { timeoutMs });
  }
  async connect(to, port, { timeoutMs = 5000 } = {}) {
    return this.run(buildConnect(to, port, timeoutMs), { timeoutMs: timeoutMs + 4000 });
  }
  async stimulus(stim, { timeoutMs = 8000 } = {}) {
    return this.run(buildStimulus(stim), { timeoutMs });
  }
}

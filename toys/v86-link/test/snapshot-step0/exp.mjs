// スナップショット起動の調査（ステップ0）: v86 の save_state / restore_state を Node の v86 と仮想スイッチで試す
// 実行: node --expose-gc toys/v86-link/test/snapshot-step0/exp.mjs（v86 をのべ約 30 台、Node で動かす。1〜3 分）
// 結果は最後に RESULTS {...}（JSON）として出す。docs/snapshot-step0.md はこの出力をまとめたもの
import { webcrypto } from 'node:crypto';
import { VirtualSwitch } from '../../switch.js';
import { VmShell, BOOTSTRAP } from '../../vmshell.js';
import { vm, booted, log, sleep, gzipSize, gunzip, mem, macOfFrame } from './common.mjs';

const results = {};
const now = () => performance.now();
const ms = (t) => Math.round(now() - t);
const gc = () => globalThis.gc?.();
const hostMac = (ip) => '02:00:' + ip.split('.').map((x) => Number(x).toString(16).padStart(2, '0')).join(':');
// main.js の netCommand（ホスト）と同じ形
const netCommand = (host, ip) => `hostname ${host}; export PS1='\\h:\\w% '; ifconfig eth0 down; ip addr flush dev eth0; ip neigh flush dev eth0; ifconfig eth0 hw ether ${hostMac(ip)} && ` +
  `ifconfig eth0 ${ip} netmask 255.255.255.0 up && route add default gw 10.5.0.1 && ip addr show eth0 | grep -E 'ether|inet ' && echo "NET""-OK"`;
/** 復元した VM を、プロンプトが出るまで進める（"\n" を送る） */
async function wake(n, timeout = 20000) {
  n.send('\n');
  await booted(n, timeout);
}
/** フレームの種類（IPv6 なら ICMPv6 の型も） */
function kindOf(f) {
  const et = (f[12] << 8) | f[13];
  if (et === 0x0806) return 'arp';
  if (et === 0x0800) return 'ipv4/' + f[23];
  if (et === 0x86dd) {
    const nh = f[20];
    const src = [...f.slice(22, 38)].every((x) => x === 0) ? '::' : 'addr';
    return nh === 58 ? `ipv6/icmpv6-${f[54]}(src ${src})` : `ipv6/${nh}`;
  }
  return 'et-' + et.toString(16);
}
const field = (out, re) => (re.exec(out) || [])[1];
/** "KEY=値" の行を集める（コマンドのエコーは端末の幅で折り返されるので、行の位置では読まない） */
const kv = (out) => Object.fromEntries([...out.matchAll(/^([A-Z0-9]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const memAt = {};

memAt.start = mem();
// ================================================================ テンプレートを作る（通常の起動 → プロンプトで save_state）
let t = now();
const T = vm('T');
await booted(T);
const bootMs = ms(t);
t = now();
const tpl = await T.e.save_state();
const saveMs = ms(t);
const tplSavedAt = Date.now();
log('テンプレート', { bootMs, saveMs, bytes: tpl.byteLength });

t = now();
const TU = vm('TU', { uart1: true });
await booted(TU);
const tplU = await TU.e.save_state();
memAt.twoVms = mem();
log('テンプレート（uart1）', { bootMs: ms(t), bytes: tplU.byteLength });

// ================================================================ 1. save → restore が通るか・イメージを渡し直す必要があるか
{
  const r = {};
  // 方式A: new V86({ initial_state })。bzimage・BIOS も渡す / 渡さない
  for (const [key, noImage] of [['A_withImage', false], ['A_noImage', true]]) {
    const t1 = now();
    const n = vm(key, { initial_state: tpl.slice(0), noImage });
    await n.started;
    const startedMs = ms(t1);
    await wake(n);
    const x = await n.run('uname -r; echo OK-$((6*7))', 0, 10000);
    r[key] = { startedMs, promptMs: ms(t1), works: /OK-42/.test(x.out) };
    await n.e.destroy();
  }
  // 方式B: 起動してから restore_state()
  //   B1: イメージを渡さず autostart: false で作り、emulator-ready のあとで restore_state → run
  {
    const t1 = now();
    const n = vm('B1', { noImage: true, autostart: false });
    await new Promise((res) => n.e.add_listener('emulator-ready', res));
    await n.e.restore_state(tpl.slice(0));
    n.e.run();
    await wake(n);
    const x = await n.run('echo OK-$((6*7))', 0, 10000);
    r.B_noImage_restoreBeforeRun = { promptMs: ms(t1), works: /OK-42/.test(x.out) };
    await n.e.destroy();
  }
  //   B2: イメージを渡してふつうに起動を始め、BIOS の途中で restore_state（実行中の VM を上書き）
  {
    const t1 = now();
    const n = vm('B2');
    await n.started;
    await sleep(300);
    await n.e.restore_state(tpl.slice(0));
    await wake(n);
    const x = await n.run('echo OK-$((6*7))', 0, 10000);
    r.B_withImage_restoreWhileRunning = { promptMs: ms(t1), works: /OK-42/.test(x.out) };
    await n.e.destroy();
  }
  results.item1 = r;
  log('1', r);
}

// ================================================================ 2. 状態のサイズ・圧縮・時間
{
  const gz = await gzipSize(tpl);
  let t1 = now();
  const raw = await gunzip(gz.out);
  const gunzipMs = ms(t1);
  // gunzip した状態から復元できるか
  t1 = now();
  const n = vm('gz', { initial_state: raw, noImage: true });
  await n.started;
  const restoreMs = ms(t1);
  await wake(n);
  const ok = /OK-42/.test((await n.run('echo OK-$((6*7))', 0, 10000)).out);
  await n.e.destroy();
  // 起動して時間が経ったあと（ネットワーク設定・少し使ったあと）の状態のサイズも比べる
  await T.run(netCommand('t', '10.5.0.2'));
  await T.run('dd if=/dev/urandom of=/tmp/junk bs=1k count=2048 2>/dev/null; rm /tmp/junk; sync');
  const later = await T.e.save_state();
  const gzLater = await gzipSize(later);
  results.item2 = {
    memoryMB: 64, bootMs, saveMs, restoreToStartedMs: restoreMs,
    rawBytes: tpl.byteLength, gzipBytes: gz.bytes, gzipMs: gz.ms, gunzipMs, restoreFromGunzipWorks: ok,
    rawBytesUart1: tplU.byteLength,
    afterUse: { rawBytes: later.byteLength, gzipBytes: gzLater.bytes },
  };
  log('2', results.item2);
}

// ================================================================ 3・5. 復元した VM を 3 台同時に動かす
{
  const sw = new VirtualSwitch({ maxPorts: 16 });
  const seen = [];   // スイッチに来たフレーム
  // ev.frame は v86 の送信バッファをそのまま指すことがある（あとのフレームで上書きされる）ので複製する。capture.js も複製している
  sw.onFrame((ev) => seen.push({ ...ev, frame: ev.frame.slice() }));
  // テンプレートを作った VM 自身は、そのまま普通にネットワークを設定する（10.5.0.2 は上で設定済み）
  sw.addPort(T);
  const tRestore = Date.now();
  const V = [1, 2, 3].map((i) => vm('V' + i, { initial_state: tpl.slice(0), noImage: true }));
  for (const n of V) sw.addPort(n);
  await Promise.all(V.map((n) => n.started));
  // 何も入力しないで 3 秒待ち、ゲストが自分からフレームを出すかを見る
  await sleep(3000);
  const quietFrames = V.map((n) => n.sent.map((s) => ({ mac: macOfFrame(s.f), kind: kindOf(s.f), atMs: s.t - tRestore })));
  const macTableBefore = sw.entries().map((e) => `${e.mac}@P${e.port}`);
  // プロンプトの検出: "\n" を送ればプロンプトが出るか
  const promptBeforeEnter = V.map((n) => /% $/.test(n.out[0]));
  await Promise.all(V.map((n) => wake(n)));
  // 復元直後の状態（MAC・乱数・時計・稼働時間・eth0 の状態）
  const probeCmd = 'echo MAC=$(cat /sys/class/net/eth0/address); echo LINK=$(ip -o link show eth0 | grep -o "state [A-Z]*"); echo U1=$(cat /proc/sys/kernel/random/uuid); echo U2=$(cat /proc/sys/kernel/random/uuid); echo RND=$(head -c 8 /dev/urandom | od -An -tx1); echo DATE=$(date +%s); echo UP=$(cut -d" " -f1 /proc/uptime)';
  const st = await Promise.all(V.map((n) => n.run(probeCmd, 0, 10000)));
  const hostNowS = Math.round(Date.now() / 1000);
  const parsed = st.map((x) => {
    const k = kv(x.out);
    return { mac: k.MAC, link: k.LINK, uuid1: k.U1, uuid2: k.U2, urandom: k.RND, guestDate: Number(k.DATE), uptime: Number(k.UP) };
  });
  // 2 秒待って、乱数が分かれるか（crng の再シードは起動直後は短い間隔で起きる）
  await sleep(2000);
  const later = await Promise.all(V.map((n) => n.run('echo U=$(cat /proc/sys/kernel/random/uuid)', 0, 10000)));
  const uuidAfter2s = later.map((x) => kv(x.out).U);
  results.item5 = {
    templateMac: kv((await T.run('echo MAC=$(cat /sys/class/net/eth0/address)')).out).MAC,
    restoredMacs: parsed.map((p) => p.mac), eth0: parsed.map((p) => p.link),
    framesBeforeInput: quietFrames,
    macTableBeforeNet: macTableBefore,
    promptVisibleBeforeEnter: promptBeforeEnter, promptAfterEnter: true,
    uuidFirst: parsed.map((p) => p.uuid1), uuidSecond: parsed.map((p) => p.uuid2), urandom8: parsed.map((p) => p.urandom),
    uuidAfter2s,
    guestDateMinusHost: parsed.map((p) => p.guestDate - hostNowS), guestUptimeS: parsed.map((p) => p.uptime),
    secondsSinceSave: Math.round((Date.now() - tplSavedAt) / 1000),
  };
  log('5', results.item5);

  // 3. netCommand で MAC を変えたあと、ping・TCP が通るか
  const ips = ['10.5.0.11', '10.5.0.12', '10.5.0.13'];
  const t3 = now();
  const net = await Promise.all(V.map((n, i) => n.run(netCommand('v' + (i + 1), ips[i]), 0, 20000)));
  const netMs = ms(t3);
  const ping = {};
  for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const x = await V[a].run(`ping -c 2 -w 4 ${ips[b]}`, 0, 15000);
    ping[`V${a + 1}->V${b + 1}`] = field(x.out, /(\d+) received/);
  }
  ping['V1->T(テンプレート元)'] = field((await V[0].run('ping -c 2 -w 4 10.5.0.2', 0, 15000)).out, /(\d+) received/);
  // TCP: V1 で nc -l、V2・V3 から同時に送る。送り元ポート（エフェメラル）も見る
  await V[0].run('(nc -l -p 5000 > /tmp/got5000 &) ; (nc -l -p 5001 > /tmp/got5001 &) ; sleep 0.5');
  const synBefore = seen.length;
  await Promise.all([V[1].run('echo from-v2 | nc -w 2 10.5.0.11 5000', 0, 10000), V[2].run('echo from-v3 | nc -w 2 10.5.0.11 5001', 0, 10000)]);
  await sleep(500);
  const got = (await V[0].run('cat /tmp/got5000 /tmp/got5001')).out;
  const syns = seen.slice(synBefore).map((ev) => ev.frame).filter((f) => ((f[12] << 8) | f[13]) === 0x0800 && f[23] === 6 && (f[47] & 0x12) === 0x02)
    .map((f) => ({ from: `${f[26]}.${f[27]}.${f[28]}.${f[29]}`, sport: (f[34] << 8) | f[35], isn: ((f[38] << 24) | (f[39] << 16) | (f[40] << 8) | f[41]) >>> 0 }));
  results.item3 = {
    netOk: net.map((x) => /^NET-OK$/m.test(x.out)), netMsAll3: netMs, ping,
    tcpDelivered: /from-v2/.test(got) && /from-v3/.test(got), synSourcePorts: syns,
    macTableAfterNet: sw.entries().map((e) => `${e.mac}@P${e.port}`),
  };
  log('3', results.item3);

  // 5 の続き: /dev/urandom に書けば分かれるか（新しく 2 台を復元。書く前と書いたあとの uuid）
  const W = [1, 2].map((i) => vm('W' + i, { initial_state: tpl.slice(0), noImage: true }));
  await Promise.all(W.map((n) => n.started.then(() => wake(n))));
  const mixRes = await Promise.all(W.map((n) => {
    const hex = Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString('hex');
    return n.run(`echo B=$(cat /proc/sys/kernel/random/uuid); echo ${hex} > /dev/urandom; echo A=$(cat /proc/sys/kernel/random/uuid); echo R=$(head -c 8 /dev/urandom | od -An -tx1)`, 0, 10000);
  }));
  const mp = mixRes.map((x) => kv(x.out));
  // 時計を合わせる（date -s @秒）
  const clk = await W[0].run(`date -s @${Math.round(Date.now() / 1000)} >/dev/null; echo D=$(date +%s)`);
  results.item5.mix = { before: mp.map((x) => x.B), afterWrite: mp.map((x) => x.A), urandomAfterWrite: mp.map((x) => x.R) };
  results.item5.clockSet = { guestMinusHost: Number(kv(clk.out).D) - Math.round(Date.now() / 1000) };
  log('5 mix', results.item5.mix, results.item5.clockSet);
  // 時間が経つと分かれるか: 復元してすぐの 2 台で、書く / 書かないそれぞれ、0・1・2・4 秒後の uuid
  const sep = {};
  for (const write of [false, true]) {
    const X = [1, 2].map((i) => vm('X' + i, { initial_state: tpl.slice(0), noImage: true }));
    await Promise.all(X.map((n) => n.started.then(() => wake(n))));
    if (write) await Promise.all(X.map((n) => n.run(`echo ${Buffer.from(webcrypto.getRandomValues(new Uint8Array(64))).toString('hex')} > /dev/urandom`)));
    const rows = [];
    let waited = 0;
    for (const w of [0, 1, 2, 4]) {
      await sleep((w - waited) * 1000); waited = w;
      const u = await Promise.all(X.map((n) => n.run('echo U=$(cat /proc/sys/kernel/random/uuid)').then((x) => kv(x.out).U)));
      rows.push({ afterS: w, same: u[0] === u[1] });
    }
    sep[write ? 'withWrite' : 'noWrite'] = rows;
    for (const n of X) await n.e.destroy();
  }
  results.item5.separateOverTime = sep;
  log('5 sep', sep);
  for (const n of [...V, ...W]) await n.e.destroy();
}

// ================================================================ 4. uart1 あり / なしの状態を、あり / なしで復元
{
  const r = {};
  for (const [key, state, uart1] of [['u1->u1', tplU, true], ['u1->none', tplU, false], ['none->u1', tpl, true]]) {
    const n = vm(key, { initial_state: state.slice(0), noImage: true, uart1 });
    let err = null;
    const errs = [];
    const onErr = (e) => errs.push(String(e?.message ?? e));
    process.on('uncaughtException', onErr);
    try {
      await Promise.race([n.started, sleep(8000).then(() => { throw new Error('started が来ない'); })]);
      await wake(n, 8000);
      const x = await n.run('echo OK-$((6*7)); cat /proc/tty/driver/serial | head -3', 0, 8000);
      r[key] = { ttyS0: /OK-42/.test(x.out) };
      // ttyS1 が使えるか（ttyS1 にシェルを起動して echo）
      if (uart1) {
        await n.run(BOOTSTRAP);
        await sleep(500);
        const y = await n.run('echo S1-$((6*7))', 1, 4000);
        r[key].ttyS1 = /S1-42/.test(y.out);
      }
    } catch (e) { err = String(e.message ?? e); }
    process.off('uncaughtException', onErr);
    if (err || errs.length) r[key] = { ...(r[key] ?? {}), error: err, uncaught: errs.slice(0, 2) };
    await n.e.destroy().catch(() => {});
  }
  // 方式B（イメージを渡し autostart: false → restore_state）で、uart1 なしの状態を uart1 ありへ: 失敗を受けられるか
  {
    const errs = [];
    const onErr = (e) => errs.push('uncaught: ' + String(e?.message ?? e).slice(0, 100));
    process.on('uncaughtException', onErr);
    process.on('unhandledRejection', onErr);
    const n = vm('none->u1(B)', { autostart: false, uart1: true });
    await new Promise((res) => n.e.add_listener('emulator-ready', res));
    let caught = null;
    try { await n.e.restore_state(tpl.slice(0)); } catch (e) { caught = String(e.message).slice(0, 100); }
    // 失敗した restore_state は、途中まで状態を書き換えている。同じ VM で run() すると、呼び出しのスタックがあふれ、
    // スレッドが止まったまま戻らないことがある（手で試して確認。ここで run() すると、この台本自体が止まるので呼ばない）。
    // → この失敗のあとは、VM を destroy して作り直す
    process.off('uncaughtException', onErr);
    process.off('unhandledRejection', onErr);
    r['none->u1(方式B)'] = { caught, errors: errs.slice(0, 2) };
    await n.e.destroy().catch(() => {});
  }
  results.item4 = r;
  log('4', r);
}

// ================================================================ 6. シナリオ: ttyS1 のシェルを起動したあとの状態をテンプレートに
{
  const S = vm('S', { initial_state: tplU.slice(0), noImage: true, uart1: true });
  await S.started;
  await wake(S);
  await S.run(`hostname s; ${BOOTSTRAP}`);
  // vmshell.js が使う形（writeSerialPort・on('serial1')）に合わせる
  const adapt = (n) => {
    const fns = new Set();
    n.e.add_listener('serial1-output-byte', (b) => fns.forEach((fn) => fn(Uint8Array.of(b))));
    return { writeSerialPort: (p, text) => n.send(text, p), on: (type, fn) => { fns.add(fn); return () => fns.delete(fn); } };
  };
  const sh = new VmShell(adapt(S));
  let aliveBefore = false;
  for (let i = 0; i < 5 && !aliveBefore; i++) aliveBefore = await sh.alive(2000);
  sh.dispose();
  const st6 = await S.e.save_state();
  await S.e.destroy();
  const R = [1, 2].map((i) => vm('S' + i, { initial_state: st6.slice(0), noImage: true, uart1: true }));
  const r = { aliveBeforeSave: aliveBefore, restored: [] };
  for (const n of R) {
    await n.started;
    const s = new VmShell(adapt(n));
    const alive = await s.alive(3000);
    const route = await s.route();
    const sh2 = await s.shell('hostname; ip -o link show eth0 | grep -o "link/ether [0-9a-f:]*"');
    // ttyS0 にはプロンプトが出せるか
    n.send('\n');
    await booted(n, 5000).catch(() => {});
    r.restored.push({ alive, route, shell: sh2, ttyS0Prompt: /% $/.test(n.out[0]), ttyS0Text: JSON.stringify(n.out[0].slice(-30)) });
    s.dispose();
  }
  results.item6 = r;
  log('6', r);
  for (const n of R) await n.e.destroy();
}

// ================================================================ 参考: 壊れた状態を渡したときの失敗の仕方（次の実装のフォールバック用）
{
  const r = {};
  const cut = tpl.slice(0, 1 << 20);
  const flipped = new Uint8Array(tpl.slice(0)); flipped[0] ^= 0xff;
  const bodyNoise = new Uint8Array(tpl.slice(0)); for (let i = 4096; i < bodyNoise.length; i += 4099) bodyNoise[i] ^= 0x5a;
  for (const [key, state] of [['truncated1MB', cut], ['badHeader', flipped.buffer], ['noiseInBody', bodyNoise.buffer]]) {
    const errs = [];
    const onErr = (e) => errs.push(String(e?.message ?? e).slice(0, 120));
    process.on('uncaughtException', onErr);
    process.on('unhandledRejection', onErr);
    const n = vm(key, { initial_state: state, noImage: true });
    const started = await Promise.race([n.started.then(() => true), sleep(5000).then(() => false)]);
    let prompt = false;
    if (started) { n.send('\n'); prompt = await booted(n, 5000).then(() => true, () => false); }
    process.off('uncaughtException', onErr);
    process.off('unhandledRejection', onErr);
    r[key] = { started, prompt, errors: errs };
    await n.e.destroy().catch(() => {});
  }
  // 方式B（イメージを渡し autostart: false。emulator-ready のあとで restore_state）なら、失敗を try/catch で受けて、
  // 同じ VM で run()（通常の起動）に切り替えられるか
  for (const [key, state] of [['B_ok', tpl.slice(0)], ['B_truncated1MB', cut], ['B_badHeader', flipped.buffer], ['B_noiseInBody', bodyNoise.buffer]]) {
    const errs = [];
    const onErr = (e) => errs.push('uncaught: ' + String(e?.message ?? e).slice(0, 100));
    process.on('uncaughtException', onErr);
    process.on('unhandledRejection', onErr);
    const t1 = now();
    const n = vm(key, { autostart: false });
    await new Promise((res) => n.e.add_listener('emulator-ready', res));
    let caught = null;
    try { await n.e.restore_state(state); } catch (e) { caught = String(e.message).slice(0, 100); }
    n.e.run();
    if (!caught) n.send('\n');
    const prompt = await booted(n, 60000).then(() => true, () => false);
    const x = prompt ? await n.run('echo OK-$((6*7))', 0, 10000) : { out: '' };
    process.off('uncaughtException', onErr);
    process.off('unhandledRejection', onErr);
    r[key] = { caught, fellBackToBoot: !!caught, prompt, works: /OK-42/.test(x.out), promptMs: ms(t1), errors: errs };
    await n.e.destroy().catch(() => {});
  }
  results.broken = r;
  log('broken', r);
}

// ================================================================ 7. destroy() でメモリが解放されるか・restore を繰り返して増えないか
gc(); await sleep(200); gc();
memAt.before7 = mem();
{
  gc(); await sleep(200); gc();
  const base = mem();
  const series = [];
  for (let i = 0; i < 12; i++) {
    const n = vm('M' + i, { initial_state: tpl.slice(0), noImage: true });
    await n.started;
    await wake(n);
    await n.e.destroy();
    gc(); await sleep(100); gc();
    series.push(mem().rssMB);
  }
  // 1 台を動かしたまま restore_state を繰り返す
  const n = vm('MR', { initial_state: tpl.slice(0), noImage: true });
  await n.started;
  const series2 = [];
  for (let i = 0; i < 12; i++) {
    await n.e.restore_state(tpl.slice(0));
    await wake(n);
    gc(); await sleep(100); gc();
    series2.push(mem().rssMB);
  }
  await n.e.destroy();
  gc();
  results.item7 = { memAt, gcAvailable: !!globalThis.gc, baseline: base, rssAfterEachCreateDestroy: series, rssAfterEachRestoreInPlace: series2, end: mem() };
  log('7', results.item7);
}

console.log('RESULTS ' + JSON.stringify(results, null, 1));
process.exit(0);

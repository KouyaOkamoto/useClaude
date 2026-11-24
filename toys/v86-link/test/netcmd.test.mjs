// VM のネットワーク設定のコマンドの組み立て（netcmd.js）を Node で確かめる。ゲストでの動きは docs/results.md の「ネットワーク設定の短縮」。
//
//   node --test toys/v86-link/test/netcmd.test.mjs
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netFunction, netCall, routerSysctl, netCommand, legacyNetCommand, scenarioMacCommand, NET_FN } from '../netcmd.js';

const HOST = { role: 'host', host: 'b', mac: '02:00:0a:05:00:03', ip: '10.5.0.3', gateway: '10.5.0.1' };
const ROUTER = { role: 'router', host: 'r', mac: '02:00:0a:05:00:01', routerAddrs: ['10.5.0.1/24', '10.5.1.1/24', '10.5.2.1/24'] };

test('関数の定義: ホスト名は /proc、ip のバッチ 1 回（printf で /tmp/net に書く）、表示は addr → link の順、NET-OK は分けて書く', () => {
  const f = netFunction();
  assert.ok(f.startsWith(`${NET_FN}() { `) && f.endsWith('; }'));
  assert.ok(f.includes('echo $1 > /proc/sys/kernel/hostname'));
  assert.ok(f.includes("export PS1='\\h:\\w% '"));
  assert.ok(f.includes('ip -br -batch /tmp/net && echo "NET""-OK"'));
  assert.ok(f.includes("route replace default via %s"), 'add ではなく replace（何度実行しても通る）');
  assert.ok(f.indexOf('addr show dev eth0') < f.indexOf('link show dev eth0'), '-br のバッチでは addr show を先に');
  assert.ok(f.indexOf('link set eth0 down') < f.indexOf('link set eth0 address'), 'MAC を変える前に down');
  assert.equal(/[^|]\|[^|]/.test(f), false, 'パイプを使わない（|| は「または」なのでよい）');
  assert.equal(/<</.test(f), false, 'ヒアドキュメントを使わない');
  assert.equal(/NET-OK/.test(f), false, 'エコーに NET-OK が出ない');
  for (const exe of ['hostname ', 'ifconfig', 'route add', 'sysctl', 'grep']) assert.equal(f.includes(exe), false, `${exe} を起動しない`);
});

test('呼び出し: ホスト・ルーター（ゲートウェイ無し・アドレス複数）', () => {
  assert.equal(netCall({ host: 'b', mac: '02:00:0a:05:00:03', addrs: ['10.5.0.3/24'], gateway: '10.5.0.1' }), 'v86net b 02:00:0a:05:00:03 10.5.0.1 10.5.0.3/24');
  assert.equal(netCall({ host: 'r', mac: '02:00:0a:05:00:01', addrs: ROUTER.routerAddrs, gateway: null }), 'v86net r 02:00:0a:05:00:01 - 10.5.0.1/24 10.5.1.1/24 10.5.2.1/24');
});

test('netCommand: 関数の定義つき / 呼び出しだけ（復元した VM の最初の設定）/ 先頭に乱数・時計 / ルーターは /proc に書く', () => {
  const full = netCommand(HOST);
  assert.equal(full, `${netFunction()}; v86net b 02:00:0a:05:00:03 10.5.0.1 10.5.0.3/24`);
  const pre = 'printf %s abcd > /dev/urandom; date -s @1 >/dev/null; ';
  assert.equal(netCommand(HOST, { withFunction: false, prelude: pre }), pre + 'v86net b 02:00:0a:05:00:03 10.5.0.1 10.5.0.3/24');
  const r = netCommand(ROUTER, { withFunction: false });
  assert.equal(r, routerSysctl() + 'v86net r 02:00:0a:05:00:01 - 10.5.0.1/24 10.5.1.1/24 10.5.2.1/24');
  assert.match(routerSysctl(), /^echo 1 > \/proc\/sys\/net\/ipv4\/ip_forward; echo 0 > \/proc\/sys\/net\/ipv4\/conf\/all\/send_redirects; echo 0 > \/proc\/sys\/net\/ipv4\/conf\/eth0\/send_redirects; $/);
  // 呼び出しだけなら、以前のコマンドよりずっと短い
  assert.ok(netCommand(HOST, { withFunction: false }).length < legacyNetCommand(HOST).length / 4);
});

test('以前のイメージ（fast: false）: 以前と同じコマンド（ifconfig・route・ip addr show | grep）', () => {
  assert.equal(netCommand(HOST, { fast: false }),
    "hostname b; export PS1='\\h:\\w% '; ifconfig eth0 down; ip addr flush dev eth0; ip neigh flush dev eth0; ifconfig eth0 hw ether 02:00:0a:05:00:03 && " +
    "ifconfig eth0 10.5.0.3 netmask 255.255.255.0 up && route add default gw 10.5.0.1 && ip addr show eth0 | grep -E 'ether|inet ' && echo \"NET\"\"-OK\"");
  const r = netCommand(ROUTER, { fast: false, prelude: 'P; ' });
  assert.ok(r.startsWith('P; hostname r; '));
  assert.ok(r.includes('ifconfig eth0 10.5.0.1 netmask 255.255.255.0 up && ip addr add 10.5.1.1/24 dev eth0 && ip addr add 10.5.2.1/24 dev eth0 && sysctl -q -w net.ipv4.ip_forward=1'));
});

test('シナリオの MAC の設定: ip のバッチ 1 回。復元した VM はホスト名も設定し直す', () => {
  assert.equal(scenarioMacCommand({ mac: '02:00:c0:a8:0a:0b' }),
    "printf 'link set eth0 down\\nlink set eth0 address %s\\nlink set eth0 up\\n' 02:00:c0:a8:0a:0b > /tmp/mac && ip -batch /tmp/mac");
  assert.ok(scenarioMacCommand({ mac: '02:00:c0:a8:0a:0b', host: 'pc1' }).startsWith('echo pc1 > /proc/sys/kernel/hostname; printf '));
});

test('不正な入力は例外（コマンドに入れない）', () => {
  const bad = [
    { ...HOST, host: 'B;rm -rf /' }, { ...HOST, host: '' }, { ...HOST, host: 'a'.repeat(40) },
    { ...HOST, mac: '02:00:0a:05:00' }, { ...HOST, mac: '02:00:0a:05:00:0g' }, { ...HOST, mac: "02:00:0a:05:00:03'" },
    { ...HOST, ip: '10.5.0.300' }, { ...HOST, ip: '10.5.0.3; reboot' }, { ...HOST, gateway: '10.5.0' }, { ...HOST, gateway: '$(id)' },
    { ...ROUTER, routerAddrs: [] }, { ...ROUTER, routerAddrs: ['10.5.0.1'] }, { ...ROUTER, routerAddrs: ['10.5.0.1/33'] },
  ];
  for (const m of bad) {
    assert.throws(() => netCommand(m), /使えない値/, JSON.stringify(m));
    assert.throws(() => netCommand(m, { fast: false }), /使えない値/, JSON.stringify(m));
  }
  assert.throws(() => scenarioMacCommand({ mac: 'zz' }));
  assert.throws(() => scenarioMacCommand({ mac: '02:00:c0:a8:0a:0b', host: 'PC1' }));
  assert.throws(() => netCall({ host: 'b', mac: '02:00:0a:05:00:03', addrs: Array(9).fill('10.5.0.3/24'), gateway: null }));
});

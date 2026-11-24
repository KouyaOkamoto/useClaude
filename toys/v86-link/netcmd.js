// VM のネットワーク設定のコマンドを組み立てる。DOM にも v86 にも依存しない（Node でテストできる）。
//
// ゲストで 1 つプロセスを起動すると、数十 ms かかる。全台が同じメインスレッドで動くので、ネットワーク設定のコマンドが
// 8 台同時に走ると、その台数倍で効く。さらに、コマンドはシリアルから 1 文字ずつ打ち込まれてエコーされるので、
// 文字数も効く（1 文字 約 0.26ms。docs/results.md の「ネットワーク設定の短縮」）。そこで:
//
//   - シェルの組み込み（echo・printf・export）で済むものは組み込みにする（ホスト名・sysctl は /proc への書き込み）
//   - ip / ifconfig / route を、iproute2 の ip のバッチ（ip -br -batch）1 回にまとめる。バッチの中身は printf（組み込み）で
//     /tmp/net に書く（パイプ・ヒアドキュメントは fork や端末の「> 」が出るので使わない）。表示（addr show・link show）もバッチの最後に入れる
//     （-br のバッチでは、link show のあとに addr show を置くとアドレスが出ないので、addr show を先にする）
//   - その手順をシェルの関数 v86net にして、スナップショットのテンプレートを保存する前に定義しておく。
//     復元した VM は関数を持って起きるので、短い呼び出しだけを打てばよい
//
// 以前のイメージ（?image=buildroot68）は BusyBox の ip しか無く、-batch も -br も無いので、以前のコマンド（legacyNetCommand）のまま。
//
//   netFunction()                     関数の定義（1 行）
//   netCall({ host, mac, addrs, gateway })   関数の呼び出し。addrs は CIDR の配列（ルーターは複数）、gateway は無ければ null
//   routerSysctl()                    ルーターの転送 ON・ICMP redirect を送らない（/proc への書き込み）
//   netCommand(m, { fast, withFunction, prelude })   1 行のコマンド全体（"NET-OK" で終わる）
//   legacyNetCommand(m)               以前のコマンド（ifconfig・route・ip addr show | grep）
//   scenarioMacCommand({ mac, host }) シナリオの MAC の設定（ttyS1 で実行する。ip のバッチ 1 回）

export const NET_FN = 'v86net';

const HOST = /^[a-z][a-z0-9-]{0,31}$/;
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const CIDR = (s) => typeof s === 'string' && /^[\d.]+\/(\d|[12]\d|3[0-2])$/.test(s) && IPV4.test(s.split('/')[0]);
const ensure = (ok, what) => { if (!ok) throw new Error(`ネットワーク設定のコマンドに使えない値: ${what}`); };

function check({ host, mac, addrs, gateway }) {
  ensure(typeof host === 'string' && HOST.test(host), `host=${host}`);
  ensure(typeof mac === 'string' && MAC.test(mac), `mac=${mac}`);
  ensure(Array.isArray(addrs) && addrs.length >= 1 && addrs.length <= 8 && addrs.every(CIDR), `addrs=${addrs}`);
  ensure(gateway === null || gateway === undefined || (typeof gateway === 'string' && IPV4.test(gateway)), `gateway=${gateway}`);
}

/**
 * 関数の定義。v86net <ホスト名> <MAC> <ゲートウェイか -> <アドレス/プレフィックス>...
 *   ホスト名とプロンプト → eth0 を down（ne2k は up のままでは MAC を変えられない）→ アドレス・ARP の表を消す → MAC → アドレス → up →
 *   デフォルトルート（replace なので、何度実行しても通る）→ 結果の表示（IP と MAC）。途中で失敗したら ip が 0 以外で終わり、NET-OK を出さない
 * "NET""-OK" と分けて書くので、コマンドのエコーには NET-OK が出ない
 */
export function netFunction() {
  return `${NET_FN}() { echo $1 > /proc/sys/kernel/hostname; export PS1='\\h:\\w% '; m=$2; g=$3; shift 3; ` +
    `{ printf 'link set eth0 down\\naddr flush dev eth0\\nneigh flush dev eth0\\nlink set eth0 address %s\\n' $m; ` +
    `for a; do printf 'addr add %s dev eth0\\n' $a; done; printf 'link set eth0 up\\n'; ` +
    `[ $g = - ] || printf 'route replace default via %s\\n' $g; printf 'addr show dev eth0\\nlink show dev eth0\\n'; } > /tmp/net && ` +
    `ip -br -batch /tmp/net && echo "NET""-OK"; }`;
}

export function netCall({ host, mac, addrs, gateway = null }) {
  check({ host, mac, addrs, gateway });
  return `${NET_FN} ${host} ${mac} ${gateway ?? '-'} ${addrs.join(' ')}`;
}

/** ルーター: 転送 ON・ICMP redirect を送らない（同じ eth0 で出入りするので）。sysctl の代わりに /proc に書く（組み込みの echo） */
export function routerSysctl() {
  return 'echo 1 > /proc/sys/net/ipv4/ip_forward; echo 0 > /proc/sys/net/ipv4/conf/all/send_redirects; echo 0 > /proc/sys/net/ipv4/conf/eth0/send_redirects; ';
}

/**
 * 1 行のコマンド全体。
 *   m: { role: 'host'|'router', host, mac, ip（ホスト）, gateway（ホスト）, routerAddrs（ルーター。CIDR の配列） }
 *   fast: 短いコマンド（ip のバッチ）を使えるイメージか。false なら legacyNetCommand
 *   withFunction: 関数の定義も付けるか（関数をまだ持っていない VM・「ネットワーク設定をやり直す」）。復元した VM の最初の設定では false
 *   prelude: 先頭に付けるもの（復元した VM の乱数・時計。snapshot.js の restorePrelude）
 */
export function netCommand(m, { fast = true, withFunction = true, prelude = '' } = {}) {
  if (!fast) return prelude + legacyNetCommand(m);
  const isRouter = m.role === 'router';
  const call = netCall({ host: m.host, mac: m.mac, addrs: isRouter ? m.routerAddrs : [`${m.ip}/24`], gateway: isRouter ? null : m.gateway });
  return (withFunction ? netFunction() + '; ' : '') + prelude + (isRouter ? routerSysctl() : '') + call;
}

/** 以前のコマンド（BusyBox の ifconfig・route・ip。?image=buildroot68 と、比べるための計測で使う） */
export function legacyNetCommand(m) {
  const isRouter = m.role === 'router';
  const addrs = isRouter ? m.routerAddrs : [`${m.ip}/24`];
  check({ host: m.host, mac: m.mac, addrs, gateway: isRouter ? null : m.gateway });
  const head = `hostname ${m.host}; export PS1='\\h:\\w% '; ifconfig eth0 down; ip addr flush dev eth0; ip neigh flush dev eth0; ifconfig eth0 hw ether ${m.mac} && `;
  const tail = `ip addr show eth0 | grep -E 'ether|inet ' && echo "NET""-OK"`;
  if (isRouter) {
    const [first, ...rest] = addrs;
    return head + `ifconfig eth0 ${first.split('/')[0]} netmask 255.255.255.0 up && ` +
      rest.map((a) => `ip addr add ${a} dev eth0 && `).join('') +
      'sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.all.send_redirects=0 net.ipv4.conf.eth0.send_redirects=0; ' + tail;
  }
  return head + `ifconfig eth0 ${m.ip} netmask 255.255.255.0 up && route add default gw ${m.gateway} && ` + tail;
}

/**
 * シナリオの MAC の設定（ttyS1 の検査用シェルで実行する）。ホスト名（復元した VM だけ。テンプレートのホスト名は 1 台目のもの）→
 * eth0 を down → MAC → up。ip のバッチ 1 回（以前は ifconfig を 3 回）。IP はシナリオの init が設定する
 */
export function scenarioMacCommand({ mac, host = null }) {
  ensure(typeof mac === 'string' && MAC.test(mac), `mac=${mac}`);
  ensure(host === null || (typeof host === 'string' && HOST.test(host)), `host=${host}`);
  return (host ? `echo ${host} > /proc/sys/kernel/hostname; ` : '') +
    `printf 'link set eth0 down\\nlink set eth0 address %s\\nlink set eth0 up\\n' ${mac} > /tmp/mac && ip -batch /tmp/mac`;
}

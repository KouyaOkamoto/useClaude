// シナリオの模範解答と、途中までの解答（結合テスト test/scenario-e2e.cjs で使う）。
//
// ※ 自習するときは、このファイルを見ないでください（公開のディレクトリ scenarios/ には置いていない）。
//
// 解答は「どの VM の端末（ttyS0）に何を打つか」と「スイッチのポートの設定（画面のポートの設定パネルでする操作）」で書く。
//   vm:   [ノードの ID, コマンド]   学習者の端末に打つのと同じ
//   port: [ノードの ID, VLAN の設定] トポロジー図のポートの設定パネルで変えるのと同じ
module.exports = {
  'small-office': {
    none: { steps: [], expect: { R1: 'fail', R2: 'fail', R3: 'notrun' } },
    // ゲートウェイは足したが、ルーターの転送を忘れた
    partial: {
      steps: [{ vm: ['pc1', 'ip route add default via 192.168.10.1'] }],
      expect: { R1: 'fail', R2: 'pass', R3: 'fail' },
    },
    full: {
      steps: [
        { vm: ['pc1', 'ip route add default via 192.168.10.1'] },
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
      ],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass' },
    },
  },
  'dept-vlan': {
    // VLAN 1 のまま: ゲートウェイに届かず、ブロードキャストも開発部に届く
    none: { steps: [], expect: { R1: 'fail', R2: 'notrun', R3: 'notrun', R4: 'fail' } },
    // VLAN は分けたが、ルーターのフィルタを入れていない（部署の間が全部通る）
    partial: {
      steps: [
        { port: ['sales1', { mode: 'access', access: 10 }] },
        { port: ['dev1', { mode: 'access', access: 20 }] },
        { port: ['devweb', { mode: 'access', access: 20 }] },
      ],
      expect: { R1: 'pass', R2: 'pass', R3: 'fail', R4: 'pass' },
    },
    full: {
      steps: [
        { port: ['sales1', { mode: 'access', access: 10 }] },
        { port: ['dev1', { mode: 'access', access: 20 }] },
        { port: ['devweb', { mode: 'access', access: 20 }] },
        { vm: ['router', 'iptables -P FORWARD DROP'] },
        { vm: ['router', 'iptables -A FORWARD -s 10.10.10.0/24 -d 10.10.20.80 -p tcp --dport 80 -j ACCEPT'] },
        { vm: ['router', 'iptables -A FORWARD -s 10.10.20.80 -p tcp --sport 80 -d 10.10.10.0/24 -j ACCEPT'] },
      ],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass' },
    },
  },

  // S3: 3ゾーン（社内 eth0.10・DMZ eth0.20・外部 eth0.30）。ルーターだけを設定する
  'web-publish': {
    none: { steps: [], expect: { R1: 'fail', R2: 'notrun', R3: 'fail', R4: 'fail' } },
    // 転送だけ有効にした: DNAT が無いので外から見えない。NAT が無いので送り元は社内のアドレス。DMZ から社内に入れる
    forwardOnly: {
      steps: [{ vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] }],
      expect: { R1: 'fail', R2: 'notrun', R3: 'fail', R4: 'fail' },
    },
    // DNAT だけ（＋転送）: 公開はできたが、外から内側のアドレスへ直接届き、送り元も書き換わらない
    dnatOnly: {
      steps: [
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
        { vm: ['router', 'iptables -t nat -A PREROUTING -i eth0.30 -p tcp --dport 80 -j DNAT --to-destination 10.0.20.80'] },
      ],
      expect: { R1: 'pass', R2: 'fail', R3: 'fail', R4: 'fail' },
    },
    // 近道: 模範解答のあと、FORWARD を空にして方針を ACCEPT に（NAT は残る）→ 公開と NAT はできるが、守りが無い
    flushAccept: {
      steps: [
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
        { vm: ['router', 'iptables -t nat -A PREROUTING -i eth0.30 -p tcp --dport 80 -j DNAT --to-destination 10.0.20.80'] },
        { vm: ['router', 'iptables -t nat -A POSTROUTING -o eth0.30 -j MASQUERADE'] },
        { vm: ['router', 'iptables -P FORWARD ACCEPT; iptables -F FORWARD'] },
      ],
      expect: { R1: 'pass', R2: 'fail', R3: 'pass', R4: 'fail' },
    },
    // 近道: 模範解答のあと iptables -F（方針は DROP のまま）→ 全部止まる
    flushDrop: {
      steps: [
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
        { vm: ['router', 'iptables -t nat -A PREROUTING -i eth0.30 -p tcp --dport 80 -j DNAT --to-destination 10.0.20.80'] },
        { vm: ['router', 'iptables -t nat -A POSTROUTING -o eth0.30 -j MASQUERADE'] },
        { vm: ['router', 'iptables -P FORWARD DROP'] },
        { vm: ['router', 'iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'] },
        { vm: ['router', 'iptables -A FORWARD -i eth0.10 -j ACCEPT'] },
        { vm: ['router', 'iptables -F'] },
      ],
      expect: { R1: 'fail', R2: 'notrun', R3: 'fail', R4: 'fail' },
    },
    full: {
      steps: [
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
        { vm: ['router', 'iptables -t nat -A PREROUTING -i eth0.30 -p tcp --dport 80 -j DNAT --to-destination 10.0.20.80'] },
        { vm: ['router', 'iptables -t nat -A POSTROUTING -o eth0.30 -j MASQUERADE'] },
        { vm: ['router', 'iptables -P FORWARD DROP'] },
        { vm: ['router', 'iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT'] },
        { vm: ['router', 'iptables -A FORWARD -i eth0.10 -j ACCEPT'] },
        { vm: ['router', 'iptables -A FORWARD -i eth0.30 -o eth0.20 -d 10.0.20.80 -p tcp --dport 80 -j ACCEPT'] },
      ],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass' },
    },
  },
  // S4: 不具合は3つ（PC1 のゲートウェイ違い・転送 OFF・80番を落とすルール）。22番を落とすルールは残す
  'find-cause': {
    none: { steps: [], expect: { R1: 'fail', R2: 'notrun' } },
    forwardOnly: {
      steps: [{ vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] }],
      expect: { R1: 'fail', R2: 'notrun' },
    },
    // 近道: ゲートウェイと転送を直し、iptables -F で全部消す → Web は見られるが、22番の遮断も消える
    flush: {
      steps: [
        { vm: ['pc1', 'ip route replace default via 192.168.50.1'] },
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
        { vm: ['router', 'iptables -F'] },
      ],
      expect: { R1: 'pass', R2: 'fail' },
    },
    full: {
      steps: [
        { vm: ['pc1', 'ip route replace default via 192.168.50.1'] },
        { vm: ['router', 'echo 1 > /proc/sys/net/ipv4/ip_forward'] },
        { vm: ['router', "iptables -D FORWARD -p tcp --dport 80 -m comment --comment 'temporary: wiki maintenance 10/31' -j DROP"] },
      ],
      expect: { R1: 'pass', R2: 'pass' },
    },
  },
};

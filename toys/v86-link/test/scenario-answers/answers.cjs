// シナリオの模範解答と、途中までの解答（結合テスト test/scenario-e2e.cjs で使う）。
//
// ※ 自習するときは、このファイルを見ないでください（公開のディレクトリ scenarios/ には置いていない）。
//
// 解答は「どの VM の端末（ttyS0）に何を打つか」と「スイッチのポートの設定（画面のポートの設定パネルでする操作）」で書く。
//   vm:   [ノードの ID, コマンド]   学習者の端末に打つのと同じ
//   port: [ノードの ID, VLAN の設定] トポロジー図のポートの設定パネルで変えるのと同じ
//   daiVlan: [VLAN, true/false]       観察の「DAI」タブで、その VLAN の DAI を有効 / 無効にするのと同じ（S6）
//   daiBinding: { vlan, ip, mac }     「DAI」タブで、バインディング表に足すのと同じ（S6）
//   daiTrusted: [ノードの ID, true/false] ポートの設定パネルの「DAI で trusted にする」と同じ（S6）
//   wait: ms                          待つ（学習者が読んでいる間。攻撃者が汚染し終わるのを待つ）
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

  // S5: 不明な機器 X（攻撃者ノード）が PC1 と R の ARP を汚染し、中継しながら盗み見ている。
  // MAC: PC1 02:00:c0:a8:0a:0b・R 02:00:c0:a8:0a:01（scenarios/arp-spoof.json で mac を省いたので 02:00 ＋ IP）
  'arp-spoof': {
    // 何もしない: 通信は通る（X が中継する）が、行きも戻りも X を経由する
    none: { steps: [], expect: { R1: 'pass', R2: 'fail', R3: 'fail' } },
    // PC1 だけ静的 ARP: 行きは守れたが、戻り（R から PC1）は X を経由したまま（片方向だけの対策）
    pc1Only: {
      steps: [{ vm: ['pc1', 'ip neigh replace 192.168.10.1 lladdr 02:00:c0:a8:0a:01 nud permanent dev eth0'] }],
      expect: { R1: 'pass', R2: 'pass', R3: 'fail' },
    },
    // ARP を全部止める（PC1 で ARP を全部落とし、キャッシュを消す）: 盗聴はされないが、ゲートウェイの MAC も分からず通信できない
    dropAllArp: {
      steps: [{ vm: ['pc1', "nft add table arp f && nft add chain arp f in '{ type filter hook input priority 0; policy drop; }' && ip neigh flush dev eth0"] }],
      expect: { R1: 'fail', R2: 'notrun', R3: 'notrun' },
    },
    // キャッシュを消すだけ: X がすぐに汚染し直すので、検査のときにはまた経由している（「一時的に直った」だけ）
    flushOnly: {
      steps: [{ vm: ['pc1', 'ip neigh flush dev eth0'] }, { vm: ['router', 'ip neigh flush dev eth0'] }],
      expect: { R1: 'pass', R2: 'fail', R3: 'fail' },
    },
    // 解答B: nft の arp ファミリーで、正しい MAC 以外からの 192.168.10.1 / 192.168.10.11 の ARP を落とす（両方の向き）
    nftFilter: {
      steps: [
        { vm: ['pc1', "nft add table arp f && nft add chain arp f in '{ type filter hook input priority 0; }' && nft add rule arp f in arp saddr ip 192.168.10.1 arp saddr ether != 02:00:c0:a8:0a:01 drop && ip neigh flush dev eth0"] },
        { vm: ['router', "nft add table arp f && nft add chain arp f in '{ type filter hook input priority 0; }' && nft add rule arp f in arp saddr ip 192.168.10.11 arp saddr ether != 02:00:c0:a8:0a:0b drop && ip neigh flush dev eth0"] },
      ],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass' },
    },
    // 解答A: 静的 ARP（両方の向き）
    full: {
      steps: [
        { vm: ['pc1', 'ip neigh replace 192.168.10.1 lladdr 02:00:c0:a8:0a:01 nud permanent dev eth0'] },
        { vm: ['router', 'ip neigh replace 192.168.10.11 lladdr 02:00:c0:a8:0a:0b nud permanent dev eth0'] },
      ],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass' },
    },
  },

  // S6: S5 と同じ構成で、スイッチの DAI で守る。端末の固定の設定は R5 で禁止。
  // MAC: PC1 02:00:c0:a8:0a:0b・R 02:00:c0:a8:0a:01（192.168.10.1 と 192.168.20.1 の両方）・SV 02:00:c0:a8:14:0a。全部 VLAN 1。
  // どの解答も、まず 5 秒待つ（攻撃者が PC1 と R を汚染し終わってから。学習者が依頼を読んでいる間と同じ）
  'switch-dai': {
    none: { steps: [], expect: { R1: 'pass', R2: 'fail', R3: 'fail', R4: 'fail', R5: 'pass' } },
    // DAI を有効にしたが、表が空: 正規の PC1・R・SV の ARP も捨てられ、キャッシュを消すと通信できない
    emptyTable: {
      steps: [{ wait: 5000 }, { daiVlan: [1, true] }, { vm: ['pc1', 'ip neigh flush dev eth0'] }, { vm: ['router', 'ip neigh flush dev eth0'] }],
      expect: { R1: 'fail', R2: 'notrun', R3: 'notrun', R4: 'notrun', R5: 'notrun' },
    },
    // 全部のポートを trusted: 何も検査しないのと同じ。X の ARP も通り、すぐまた汚染される
    allTrusted: {
      steps: [{ wait: 5000 }, { daiVlan: [1, true] }, { daiTrusted: ['pc1', true] }, { daiTrusted: ['server', true] }, { daiTrusted: ['router', true] }, { daiTrusted: ['atk', true] },
        { vm: ['pc1', 'ip neigh flush dev eth0'] }, { vm: ['router', 'ip neigh flush dev eth0'] }],
      expect: { R1: 'pass', R2: 'fail', R3: 'fail', R4: 'fail', R5: 'pass' },
    },
    // DAI と表は正しいが、汚染済みのキャッシュを消していない: 新しい汚染は止まるが、PC1 と R はまだ X を経由する（学びの中心）。
    // ただし汚染されたエントリは、40〜55 秒ほどで Linux が確かめ直して治る（R が ARP を引き直し、その要求で PC1 も治る）。
    // ARP のエントリの時間切れは 15〜45 秒の乱数なので、検査の間に片方だけ治っていることがある → R2・R3 の少なくとも 1 つが不合格（docs/scenarios.md の S6）
    noFlush: {
      steps: [{ wait: 5000 }, { daiVlan: [1, true] },
        { daiBinding: { vlan: 1, ip: '192.168.10.11', mac: '02:00:c0:a8:0a:0b' } }, { daiBinding: { vlan: 1, ip: '192.168.10.1', mac: '02:00:c0:a8:0a:01' } },
        { daiBinding: { vlan: 1, ip: '192.168.20.1', mac: '02:00:c0:a8:0a:01' } }, { daiBinding: { vlan: 1, ip: '192.168.20.10', mac: '02:00:c0:a8:14:0a' } }],
      expect: { R1: 'pass', R4: 'pass', R5: 'pass' }, anyFail: ['R2', 'R3'],
    },
    // S5 の解答（静的 ARP）: 盗聴は止まるが、スイッチでは守っていない（R4）し、端末に固定の設定がある（R5）
    staticArp: {
      steps: [{ wait: 5000 }, { vm: ['pc1', 'ip neigh replace 192.168.10.1 lladdr 02:00:c0:a8:0a:01 nud permanent dev eth0'] },
        { vm: ['router', 'ip neigh replace 192.168.10.11 lladdr 02:00:c0:a8:0a:0b nud permanent dev eth0'] }],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'fail', R5: 'fail' },
    },
    // 模範解答（別解）: 表に PC1 と SV、R のポートは trusted（R は 2 つのアドレスを持つので）。キャッシュを消す
    trustedRouter: {
      steps: [{ wait: 5000 }, { daiVlan: [1, true] },
        { daiBinding: { vlan: 1, ip: '192.168.10.11', mac: '02:00:c0:a8:0a:0b' } }, { daiBinding: { vlan: 1, ip: '192.168.20.10', mac: '02:00:c0:a8:14:0a' } },
        { daiTrusted: ['router', true] },
        { vm: ['pc1', 'ip neigh flush dev eth0'] }, { vm: ['router', 'ip neigh flush dev eth0'] }],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'pass' },
    },
    // 模範解答: DAI を VLAN 1 で有効にし、表に VLAN 1 の正規の機器（PC1・R の 2 つのアドレス・SV）。PC1 と R でキャッシュを消す
    full: {
      steps: [{ wait: 5000 }, { daiVlan: [1, true] },
        { daiBinding: { vlan: 1, ip: '192.168.10.11', mac: '02:00:c0:a8:0a:0b' } }, { daiBinding: { vlan: 1, ip: '192.168.10.1', mac: '02:00:c0:a8:0a:01' } },
        { daiBinding: { vlan: 1, ip: '192.168.20.1', mac: '02:00:c0:a8:0a:01' } }, { daiBinding: { vlan: 1, ip: '192.168.20.10', mac: '02:00:c0:a8:14:0a' } },
        { vm: ['pc1', 'ip neigh flush dev eth0'] }, { vm: ['router', 'ip neigh flush dev eth0'] }],
      expect: { R1: 'pass', R2: 'pass', R3: 'pass', R4: 'pass', R5: 'pass' },
    },
  },
};

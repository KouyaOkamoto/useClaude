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
};

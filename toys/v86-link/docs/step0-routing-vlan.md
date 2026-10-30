# ステップ0の調査: ルーティング（L3）と VLAN の前提

ルーティングと VLAN を足す前に、v86 とゲストのイメージで何ができるかを確かめた（2026-10-30）。
v86 は npm の `v86@0.5.472`（このおもちゃが同梱しているものと同じ）を Node で動かし、ゲストのシリアルにコマンドを送って確かめた。
ブラウザではなく Node で確かめたが、どちらも同じ v86（WebAssembly）とゲストのイメージなので、結果は変わらないはず。

## a. 1つの VM に NIC を複数持たせられるか → **できない（1枚だけ）**

- `v86.d.ts` の `V86Options.net_device` は**1つのオブジェクト**（配列ではない）。NIC の種類（`ne2k` / `virtio`）と
  ネットワークのバックエンドの設定だけを持つ
- v86 の CPU の初期化（`build/libv86.mjs`）は、`net_device.type` が `ne2k` なら `this.devices.net = new Ne2k(...)`、
  `virtio` なら `this.devices.virtio_net = new VirtioNet(...)` を**1つだけ**作る
- ne2k のクラス自体は `id` 引数を持ち（I/O ポート `0x300 + 0x100 × id`、イベント名 `net<id>-send`）、2枚目を作る下地はあるが、
  公開されたオプションからは指定できない（`id` は渡されず、常に 0）
- ゲストからも `ls /sys/class/net` は `eth0 lo` だけ（`dmesg`: `ne2k-pci 0000:00:05.0 eth0: RealTek RTL-8029(AS)`）

## b. ゲストのイメージ（`buildroot-bzimage68.bin`、Linux 6.8.12、BusyBox 1.36.1）で使えるもの

| もの | 結果 |
| --- | --- |
| `ip`（BusyBox）・`ifconfig`・`route` | **ある**。`ip addr add` で1枚の NIC に複数のサブネットの IP を付けられた（`10.5.1.1/24` と `10.5.2.1/24`） |
| `ip link add ... type vlan` | **使えない**: `RTNETLINK answers: Operation not supported`（カーネルに 8021q が無い） |
| `vconfig` | コマンドはある（BusyBox）が、`vconfig add eth0 10` は `ioctl error for add: Package not installed`（同じ理由） |
| 8021q のモジュール | 無い（`/lib/modules` が無い。`/proc/net/vlan` も無い。`/proc/config.gz` も無い） |
| ほかの仮想インターフェース | `macvlan`・`ipvlan`・`bridge`・`dummy`・`veth`・`vxlan`・`gre` もすべて `Operation not supported` |
| `/proc/sys/net/ipv4/ip_forward`・`sysctl` | **ある**。既定は 0。`sysctl -w net.ipv4.ip_forward=1` / `echo 0 > /proc/sys/net/ipv4/ip_forward` で切り替えられる |
| `send_redirects` / `accept_redirects` | ある（どちらも既定 1） |
| `iptables` / `nft` | **無い** |
| `traceroute` | **ある**（`/usr/bin/traceroute`、BusyBox） |
| `tcpdump` | ある（`-e` で VLAN タグも表示する） |
| `ping` / `arping` | ある |

参考: v86 が配っているほかの小さなイメージも確かめたが、どれも VLAN を作れなかった。

| イメージ | カーネル | `type vlan` |
| --- | --- | --- |
| `buildroot-bzimage.bin`（5.2MB） | 5.6.15 | `Operation not supported` |
| `linux4.iso`（7.7MB） | 4.16.13 | `Operation not supported` |

8021q 入りのカーネルを自分でビルドする案は、この環境から `cdn.kernel.org` と `buildroot.org` に届かない（接続できない）ので、今は試せない。

## c. v86 の NIC が 802.1Q のタグ付きフレームをそのまま通すか

**受信**（スイッチ → ゲスト）: JS からゲストの NIC にタグ付きフレームを入れ、ゲストの `tcpdump -e` で見た。

| 入れたフレーム | ゲストで |
| --- | --- |
| タグ付き 60 バイト | 見えた: `ethertype 802.1Q (0x8100), length 60: vlan 10, p 0, ethertype ARP` |
| タグ付き 1514 バイト | 見えた |
| タグ付き **1518 バイト**（タグ付きの最大。ペイロード 1500 + タグ 4） | **見えた** |
| タグ付き 1522・1536・1600 バイト | 届かない（`/proc/net/dev` の受信エラーに数えられる。Linux の 8390 ドライバが 1518 バイトを超えるフレームを捨てる） |
| 二重タグ（外 VLAN 10・内 VLAN 20） | 見えた: `vlan 10, p 0, ethertype 802.1Q (0x8100), vlan 20, p 0, ethertype ARP` |

v86 の ne2k（`Ne2k.prototype.receive`）は長さを制限せずにゲストのメモリへ書き込む。宛先 MAC による受信フィルタ
（自分宛て・ブロードキャスト・マルチキャスト（設定による）以外は、promiscuous でなければ捨てる）だけがある。

**送信**（ゲスト → スイッチ）: ゲストのカーネルに 8021q が無いので、**ゲストはタグ付きフレームを作れない**
（タグを付ける VLAN インターフェースを作れない。生のフレームを送る道具も無い）。ne2k の送信は、ゲストが書いたバイト列をそのまま `net0-send` で出すので、
タグ付きのフレームを書ければ通るはずだが、このイメージでは試せない。

**つまり**: タグはゲストに届くが、ゲストはタグを理解して返すことができない。router-on-a-stick（1本のトランクに `eth0.10` / `eth0.20`）を
**ゲストの中で**作ることは、このイメージではできない。

## d. ルーターの実現方法

| 案 | 中身 | 評価 |
| --- | --- | --- |
| 1-a. NIC 2枚の Linux ルーター | サブネットごとに NIC を分ける | **できない**（a） |
| 1-b. Linux ルーターで router-on-a-stick | ゲストで `eth0.10` / `eth0.20` | **できない**（b: 8021q が無い） |
| 1-c. Linux ルーター（NIC 1枚・複数 IP）+ スイッチ側でタグの付け外し | ルーターの eth0 に各サブネットの .1 を付け、`ip_forward` で転送する（L3 は本物の Linux）。ルーターのポートで、スイッチ（JS）がタグを外して渡し、ルーターが送ったフレームには宛先の IP（ARP なら対象の IP）のサブネットから VLAN を決めてタグを付ける | できる（b の「1枚の NIC に複数サブネット」「ip_forward」は確認済み）。ルーティング・TTL の減少・ICMP time exceeded・ip_forward の ON/OFF・default route の有無は、すべてゲストの Linux が行う。VLAN のタグの付け外しだけを JS が NIC の代わりに行う |
| 2. JS の仮想ルーター | ルーティングテーブル・ARP・TTL・ICMP を JS で | できるが、「本物の Linux で設定する」学びが減る |
| 3. 8021q 入りのイメージを作る | カーネルを作り直す | この環境からソースに届かないので、今は不可。届くようにすれば検討できる（イメージは今と同じ 10MB 程度の見込み） |

ここまでの結果で、依頼の「優先 1」（本物の Linux ルーターで、NIC 2枚、または router-on-a-stick）は、**そのままの形ではできない**。
スコープが変わるので、実装の前に依頼者に方針を確認した。

**決定: 案 1-c**（依頼者が選択）。ルーターは本物の Linux（1枚の eth0 に各サブネットの .1、ip_forward）にし、
VLAN のタグの付け外しだけを、ルーターの NIC とスイッチのトランクポートの間の JS（`vlanlink.js` の `VlanLink`）が行う。

### 決定のあとの確認（Node 上の v86 で、実装したスイッチと VlanLink を使って）

A（10.5.1.2・アクセス VLAN 10）・B（10.5.2.2・アクセス VLAN 20）・R（トランク、VlanLink）をつないで確かめた:

| 確かめたこと | 結果 |
| --- | --- |
| A → B の ping | 通る。`ttl=63`（ルーターで 1 減る） |
| `traceroute -n 10.5.2.2`（A） | `1  10.5.1.1` → `2  10.5.2.2` |
| `ping -c 1 -t 1 10.5.2.2`（A） | `From 10.5.1.1 icmp_seq=1 Time to live exceeded` |
| R で `echo 0 > /proc/sys/net/ipv4/ip_forward` | A の ping が 100% packet loss |
| A で `ip route del default` | `ping: connect: Network is unreachable`。`route add default gw 10.5.1.1` で戻る |
| スイッチの MAC テーブル | R の MAC が VLAN 1・10・20 にそれぞれ P8 で入る（VLAN ごとのテーブル） |
| R の ICMP redirect | `send_redirects=0` にしている（同じ eth0 で出入りするため） |

同じことを、ブラウザ（ヘッドレス Chromium）の e2e でも確かめている（`test/e2e.cjs`。README の「自動テスト」）。

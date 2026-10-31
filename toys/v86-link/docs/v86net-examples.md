# 新しいイメージ（v86net）で試せること

Buildroot で作った新しいゲスト Linux（`images/build/`）では、いまのイメージに無い機能が使える。
この文書は、手で打って確かめるためのコマンドの例。学習用のプリセット（画面のボタン）には、まだ入れていない。

新しいイメージは既定ではない。v86-link を `?image=<名前>`（`main.js` の `IMAGES` に登録した名前）で開くと使える。
コマンドの動作は、`images/build/test-image.cjs`（CI のテスト）で確かめているものを中心に書く。CI のテストで確かめていないものには「未確認」と書く。

## ゲストの中で VLAN（eth0.10）を作る

```sh
# A: VLAN 10 のサブインターフェース（ip でも vconfig でも作れる）
ip link add link eth0 name eth0.10 type vlan id 10
ip addr add 10.10.0.2/24 dev eth0.10
ip link set eth0.10 up
cat /proc/net/vlan/config
# B: 同じく（vconfig で）
vconfig add eth0 10
ip addr add 10.10.0.3/24 dev eth0.10
ip link set eth0.10 up
# A → B
ping -c 2 10.10.0.3
```

v86-link のスイッチにつなぐときは、**そのポートをトランク**（VLAN 10 を許可）にする（図の VM をクリックして、ポートの設定パネルで）。
アクセスポートのままだと、ゲストが付けたタグ付きのフレームは捨てられる（`vlan-tagged-access`）。キャプチャでは、タグ付きで入ってきたものが VLAN 列に `[10]` と出る。

## iptables（フィルタ・conntrack・LOG・NAT）と nft

```sh
iptables -L -n                 # filter テーブル（iptables-legacy / iptables-nft の両方がある）
iptables -t nat -L -n
# ルーター R: 転送は戻りの通信だけ許可し、LAN1 → LAN2 は許可、それ以外は記録して捨てる
iptables -P FORWARD DROP
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A FORWARD -i eth0.10 -o eth0.20 -j ACCEPT
iptables -A FORWARD -j LOG --log-prefix "FWD-DROP: "
dmesg | grep FWD-DROP
# NAT: LAN2 へ出るものの送り元を R にする（MASQUERADE）、R:8080 を LAN1 の Web サーバーへ（DNAT）
iptables -t nat -A POSTROUTING -o eth0.20 -j MASQUERADE
iptables -t nat -A PREROUTING -i eth0.20 -p tcp --dport 8080 -j DNAT --to-destination 10.5.1.2:80
# nftables
nft add table inet lab
nft add chain inet lab input '{ type filter hook input priority 0; policy accept; }'
nft add rule inet lab input tcp dport 23 counter drop
nft list ruleset
```

## DHCP・DNS（dnsmasq）、Web（httpd）、SSH（dropbear）

```sh
# サーバー側（例: 10.5.0.2）
echo "10.5.0.80 web.lab" > /tmp/hosts.lab
dnsmasq --interface=eth0 --bind-interfaces --dhcp-range=10.5.0.100,10.5.0.150,12h \
  --addn-hosts=/tmp/hosts.lab --no-resolv --local=/lab/
mkdir -p /tmp/www && echo hello > /tmp/www/index.html && httpd -p 80 -h /tmp/www
dropbear -R -p 22             # ホスト鍵を作って起動（パスワードのログインは無効にしていない。root にパスワードは無い）
# クライアント側
udhcpc -i eth0                # アドレスを取る（/usr/share/udhcpc/default.script で設定される）
nslookup web.lab 10.5.0.2
wget -q -O - http://10.5.0.2/ ; curl -s http://10.5.0.2/
```

SSH でログインするには、公開鍵を使う（root にパスワードが無いため）:

```sh
# クライアント: 鍵を作って、公開鍵を表示する
dropbearkey -t ed25519 -f ~/.ssh/id_ed25519 | grep ^ssh-ed25519
# サーバー: 表示された行を authorized_keys に入れる
mkdir -p ~/.ssh && echo "ssh-ed25519 AAAA... " > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
# クライアント
dbclient -y -i ~/.ssh/id_ed25519 root@10.5.0.2 hostname
```

（SSH のログインまでは CI のテストでは確かめていない。未確認。調査の試作では同じ手順でログインできた）

## スキャン（nmap・nc -z）、遅延（tc netem）、ブリッジ、ARP

```sh
nmap -sT -Pn -p 1-1024 10.5.0.2
nc -z -v -w 1 10.5.0.2 22      # BusyBox の nc
tc qdisc add dev eth0 root netem delay 100ms loss 5%
tc qdisc show dev eth0 ; tc qdisc del dev eth0 root
ip link add br0 type bridge ; bridge link ; brctl show
arping -c 1 -I eth0 10.5.0.3 ; ip neigh show
ebtables -L ; arptables -L
```

## ルーターのタグ付けを、ゲストに任せる構成（今後の可能性）

いまの v86-link のルーター R は、ゲストに VLAN が無いため、R の NIC とスイッチの間で JS（`vlanlink.js` の `VlanLink`）がタグを付け外ししている。
新しいイメージでは、R のゲストで `eth0.10`・`eth0.20` を作れるので、**本物の router-on-a-stick** にできる（調査の試作で、ブラウザで動作を確認済み: `docs/image-survey.md` の付録 B）。

```sh
# R（各サブネットの .1 を、eth0 ではなく VLAN のサブインターフェースに）
ip addr flush dev eth0
ip link add link eth0 name eth0.10 type vlan id 10 && ip addr add 10.5.1.1/24 dev eth0.10 && ip link set eth0.10 up
ip link add link eth0 name eth0.20 type vlan id 20 && ip addr add 10.5.2.1/24 dev eth0.20 && ip link set eth0.20 up
sysctl -w net.ipv4.ip_forward=1
```

この構成にするときの注意（この依頼では実装していない）:

- **VlanLink を止める**（`setMap([])`）。止めないと、ゲストが付けたタグの上に JS がもう1つタグを付けたり、届いたタグを JS が外してしまったりする
  （いまの VlanLink は、すでにタグ付きのフレームには付けないが、受け取る側では1つ外す）
- **R のポートはトランクのまま**（許可 VLAN 1・10・20、ネイティブ 1）。いまの設定と同じでよい
- ネイティブ VLAN（1）のサブネット（LAN0）を R が受け持つなら、`eth0` 自体に 10.5.0.1 を残す（タグなし = ネイティブ VLAN）
- R の設定のコマンド（`main.js` の `netCommand` のルーター用）と、学習の手順の「ルーターの方式」の説明を書き換える必要がある
- 古いイメージ（VLAN が無い）を選んだときは、いまの方式（VlanLink）に戻す必要がある。イメージごとに方式を切り替える仕組みが要る
- ゲストの `tcpdump -i eth0 -e` で、タグ付きのフレームが見えるようになる（教材としては良い点）

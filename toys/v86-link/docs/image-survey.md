# ゲスト Linux に足りない機能を載せる方法の調査

調査日: 2026-10-31。コードと、いま使っているイメージ（`images/buildroot-bzimage68.bin`）は変えていない。
調査のために取得・ビルドしたファイルは、すべてリポジトリの外（作業用ディレクトリ）に置いた。

## まとめ

- **いまのイメージと、v86 が配っている小さなイメージ（Buildroot 系 4種）には、iptables も VLAN も無い。** Linux 4.16（`linux4.iso`）だけ、カーネルに netfilter があるが、iptables のコマンドが無い
- **v86 が配っている Arch Linux（9p）は、A〜G のほとんどが動いた**（ヘッドレスブラウザで確認）。ただし、1台 512MB のメモリ、起動まで約 170 秒、起動と数個のコマンドだけで取得するデータ約 91MB、
  配布元が外部（i.copy.sh）。このおもちゃ（N 台・CDN を使わない・GitHub Pages）には向かない
- **カーネルとユーザーランドを自前でビルドしたイメージ（試作）で、A・B・C・E・F・G がヘッドレスブラウザの v86 上で動いた。**
  1ファイル 7.5MB・メモリ 64MB のまま（いまのイメージは 10MB・64MB）。ただし起動は いまの約 2 倍遅く、nmap はビルドできなかった
- この環境のネットワークの制限で、Buildroot（公式の再ビルド手順）と Alpine・Debian・Tiny Core の配布元には届かなかった。
  そのため、試作は「上流の Linux 6.8 のソース + Ubuntu 24.04 の i386 パッケージ」で作った（後述）
- **推奨（第1候補）: Buildroot でイメージを作り直す**（GitHub Actions でビルド）。カーネルの設定はこの調査の試作で確かめたものを使う。
  次点: この調査の試作の方式（上流のカーネル + Ubuntu の i386 パッケージ）

## 1. いまのイメージ

| 項目 | 内容 |
| --- | --- |
| ファイル | `buildroot-bzimage68.bin`（10,068,480 バイト。initramfs をカーネルに埋め込んだ bzImage 1つ） |
| 入手元 | https://i.copy.sh/buildroot-bzimage68.bin（v86 の公式イメージ。`src/browser/main.js` のプロファイル `buildroot6`） |
| 中身 | Linux 6.8.12（i686）、Buildroot 2024.05.2、BusyBox 1.36.1、socat、curl、wget、ping（iputils）、tcpdump、traceroute |
| カーネルの設定 | 確認できない（`/proc/config.gz` も `/lib/modules` も無い。Buildroot の設定は公開されていない） |
| メモリ | `memory_size` 64MB（ゲストからは total 約 100MB と見える） |
| 起動時間 | 2台同時で 9.5 秒、4台で 27.5 秒（ネットワーク設定まで。この環境。下の「計測」） |
| ライセンス | Buildroot で作られたもの。カーネル・BusyBox は GPL-2.0。このイメージに対応するソースの置き場所は、v86 側で確認できていない |

## 2. 調べ方と、確かめたこと

### 2-1. 確認の方法

- 「ある」と書いたものは、**ゲストの中で実際にコマンドを実行して確かめた**ものだけ。ファイルの一覧で確かめただけのものは「一覧で確認」と書く
- 実行した環境は2つ:
  - **Node 上の v86**（npm の `v86@0.5.472`。このおもちゃが同梱しているものと同じ）。シリアルコンソールでコマンドを送る。複数台はハブ（全ポートへ）でつなぐ
  - **ヘッドレス Chromium 上の v86**（Playwright）。v86-link を作業用ディレクトリに複製し、イメージだけ差し替えたもの（VLAN 対応の仮想スイッチ・キャプチャも使う）。
    Arch と Tiny Core は、v86 だけを動かす小さなページで確かめた
- 機能の確認に使ったコマンド（主なもの）:
  - A: `iptables -L` / `iptables -t nat -L` / `iptables -P FORWARD DROP` / `-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` / `-j LOG --log-prefix` → `dmesg` /
    `-t nat -A POSTROUTING -o eth0.20 -j MASQUERADE`（相手の tcpdump で送り元を見る）/ `-t nat -A PREROUTING ... -j DNAT --to-destination`（別の VM から wget）
  - B: `ip link add link eth0 name eth0.10 type vlan id 10`・`vconfig add eth0 10` → VLAN をまたいで ping、線の上のフレームのタグを JS で数える
  - C: `dnsmasq --dhcp-range=...` → 別の VM で `udhcpc` → `nslookup`
  - D: `nmap -sT`、無ければ `nc -z -v`
  - E: `ip link add br0 type bridge`、`tc qdisc add dev eth0 root netem delay 200ms` → ping の往復時間
  - F: `dropbear` を起動し、別の VM から `dbclient`（公開鍵）でログイン。`httpd`、`wget`
  - G: `arping`、`ip neigh`、`ebtables -L`、`arptables -L`

### 2-2. 既存の公開イメージ（v86 の配布元 https://i.copy.sh/ ）

| イメージ | 大きさ | カーネル / 中身 | 確認の方法 |
| --- | --- | --- | --- |
| `buildroot-bzimage68.bin`（いま使っているもの） | 10.1MB | Linux 6.8.12、Buildroot 2024.05.2、BusyBox 1.36.1 | Node の v86 で実行 |
| `buildroot-bzimage.bin` | 5.2MB | Linux 5.6.15、Buildroot 2020.05、BusyBox 1.31.1 | Node の v86 で実行 |
| `linux4.iso` | 7.7MB | Linux 4.16.13、Buildroot 2018.08、BusyBox 1.28.4 | Node の v86 で実行 |
| `linux3.iso` | 8.6MB | Linux 3.18.0、Buildroot 2016.02、BusyBox 1.24.1 | Node の v86 で実行 |
| `linux.iso` | 6.5MB | Linux 2.6 系 | シリアルにプロンプトが出ない（画面のみ）。**未確認** |
| `TinyCore-11.0.iso` | 19.9MB | Linux 5.4.3、Tiny Core 11.0 | ブラウザで起動（約 110 秒）。X（グラフィック）が起動し、文字の画面からコマンドを実行できなかった。**機能は未確認** |
| `slitaz-rolling-2024.iso` | 56.6MB | SliTaz | 取得のみ。時間の都合で起動していない。**未確認** |
| `dsl-4.11.rc2.iso` | 52.8MB | Damn Small Linux（Linux 2.4） | **未着手** |
| Arch Linux（9p。`fs.json` + `arch/` 以下のファイル） | `fs.json` 5.8MB + 読んだファイルだけ取得（全体 6.6GB） | Linux 5.19.7-arch、systemd / OpenRC、pacman で入れたパッケージ | ブラウザで起動して実行（下の表） |

Alpine Linux と Debian は、v86 のリポジトリに Dockerfile（`tools/docker/alpine/`、`tools/docker/debian/`）があるが、
**ビルド済みのイメージは i.copy.sh に無い**（`alpine-fs.json` などは 404）。自分でビルドするには Alpine・Debian のパッケージの配布元に届く必要がある（この環境では届かない）。

### 2-3. 自前ビルドの試作（この調査で作ったもの）

Buildroot（公式の再ビルド手順）は、この環境から buildroot.org とパッケージの配布元に届かず、使えなかった。
代わりに、この環境から届く Ubuntu のアーカイブ（archive.ubuntu.com）を使って、次の方法で 1つの bzImage を作った。

| 部品 | 中身 | 入手元 |
| --- | --- | --- |
| カーネル | Linux 6.8（上流のソースそのもの。Ubuntu の改変は入れていない）。`tinyconfig` から、v86 で動かすための最小限と、調べたい機能を足した（付録 A）。モジュールは使わず、すべて組み込み。initramfs は xz でカーネルに埋め込む | http://archive.ubuntu.com/ubuntu/pool/main/l/linux/linux_6.8.0.orig.tar.gz（sha256 `26512115…`） |
| ユーザーランド | Ubuntu 24.04（noble）の i386 パッケージを展開したもの: glibc 2.39、BusyBox 1.36.1（動的リンク版）、iptables 1.8.10（nft 版・legacy 版・ebtables・arptables）、iproute2 6.1.0（ip・tc・bridge）、netcat-openbsd、socat、libnftnl・libmnl・libbpf などのライブラリ | http://archive.ubuntu.com/ubuntu/pool/（`dists/noble/*/binary-i386/Packages` から） |
| 静的にビルドしたもの | i386 の deb が無いものを、Ubuntu のソースパッケージから `gcc -m32 -static` でビルド: dnsmasq 2.90、dropbear 2022.83（パスワード認証なし・公開鍵のみ）、tcpdump 4.99.4（libpcap 1.10.4） | 同上の `*.orig.tar.*` |
| ビルドできなかったもの | **nmap**: Ubuntu のソース（dfsg 版）は同梱のライブラリ（liblinear・libpcre など）が取り除かれていて、i386 の開発用パッケージも無い。上流の nmap.org にも届かない | — |

| 項目 | 結果 |
| --- | --- |
| 成果物 | bzImage 1つ 7,483,904 バイト（カーネル 1.6MB + 埋め込みの initramfs。展開後のルートファイルシステムは約 18MB） |
| ビルド時間（この環境、4コア） | カーネル（`tinyconfig` から）約 2 分、initramfs の作り直しのあとは約 20 秒。静的ビルド（dnsmasq・dropbear・tcpdump）合わせて 1 分弱 |
| `memory_size` | 64MB で起動する（ゲストからは total 42MB。initramfs の展開に使う分が大きい）。展開後のファイルを増やすと、64MB では「write error」でカーネルパニックになった（バイナリの strip と不要な glibc の部品の削除で解消） |

試作の途中でつまずいたこと（再ビルドするときの注意として残す）:

- **v86 の bzImage ローダーは、initrd を固定で 64MB の位置に置く**（`build/libv86.mjs` の bzImage の読み込み処理）。`memory_size` 64MB で initrd を別ファイルにすると範囲外で失敗する。
  initramfs はカーネルに埋め込む（`CONFIG_INITRAMFS_SOURCE`）か、メモリを増やす
- `tinyconfig` のままだと、ファイルロック・madvise などのシステムコールが無く、iptables が「Will be implemented real soon」（ENOSYS）、iptables-legacy がロックを取れない、などで失敗した。付録 A の「ユーザーランド用」を足して解消
- `i386_defconfig` を土台にすると、v86 上で IO-APIC の初期化で落ち（`noapic` で回避）、さらにシリアルの初期化のあとで止まった。`tinyconfig` を土台にする方が扱いやすかった
- Ubuntu の `busybox-static` は applet を PATH より優先する（`ip`・`tc` が BusyBox 版になる）。動的リンク版の `busybox` を使った
- Ubuntu の BusyBox の ash は、プロンプトのあとに端末の大きさの問い合わせ（`ESC[6n`）を出す。v86-link のプロンプトの検出（`/% $/`）が一致しなくなる

### 2-4. 機能ごとの対応表

○ = 実際に動かして確かめた / × = 無い・動かない（確かめた）/ △ = 一部だけ / 一覧 = ファイルの一覧で確認しただけ / 未 = 未確認

| 機能 | いまのイメージ（Buildroot 6.8） | Buildroot 5.6 / linux4 / linux3 | Arch Linux（9p） | 自前ビルドの試作 | JS 代替 |
| --- | --- | --- | --- | --- | --- |
| A. iptables / nftables（フィルタ・conntrack） | × コマンドも netfilter も無い | × コマンド無し（linux4 だけカーネルに netfilter・conntrack あり） | ○ iptables 1.8.8（legacy）で conntrack のルールが入る | ○ iptables 1.8.10（nft 版・legacy 版）。FORWARD の DROP と ESTABLISHED の許可が効く（片方向だけ通る）。`nft` コマンドは無い | 作れる（後述） |
| A. NAT（MASQUERADE・SNAT・DNAT） | × | × | ○ ルールが入る（転送の確認はしていない） | ○ MASQUERADE で相手の tcpdump の送り元がルーターになる。DNAT でポートフォワードした先の Web ページが取れる | 作れる |
| A. ログ（LOG → dmesg） | × | × | ○ ルールが入る（dmesg は見ていない） | ○ `dmesg` に `FWD-DROP: IN=eth0.20 OUT=eth0.10 … SRC=… DST=…` | 作れる（画面に出す） |
| B. VLAN（`type vlan`・`vconfig`） | × Operation not supported | × | ○ `ip link add ... type vlan` | ○ どちらも動く。ゲストが付けたタグ（VID 10・20）を、v86-link の VLAN 対応スイッチが受けて転送（ブラウザで確認）。router-on-a-stick が本物の Linux でできた | いまの VlanLink（v86-link） |
| C. DHCP サーバー | × udhcpd 無し | × | △ `dnsmasq --version`（2.86）は動く。サーバーとしては起動していない | ○ dnsmasq 2.90 で、別の VM の udhcpc がアドレスを取れた（ブラウザで確認）。BusyBox の udhcpd も入っている（未確認） | 作れる |
| C. DNS サーバー | △ BusyBox の dnsd（コマンドはある。動作は未確認） | △ dnsd（同左） | △ 同左（dnsmasq） | ○ dnsmasq で A レコードを返す（Node で確認）。上流サーバーを指定しないと AAAA に REFUSED を返すので `--local=/lab/` を付ける | 作れる |
| D. nmap / ポートスキャン | × nc も無い | × | ○ nmap 7.91 `-sT` | △ nmap は無い（ビルドできず）。`nc -z -v`（netcat-openbsd）で開いているポートが分かる（ブラウザで確認） | 作れる |
| E. ブリッジ | × | × | ○ `ip link add br0 type bridge` | ○ 同左（`brctl` は BusyBox 版で `show` が無い） | — |
| E. tc（netem） | × tc 無し | △ Buildroot 5.6 は BusyBox の tc のみで netem なし | ○ netem | ○ netem 200ms で ping の往復が 206〜216ms（ブラウザで確認） | いまの仮想スイッチの遅延・損失 |
| F. SSH サーバー | × | × | 一覧 OpenSSH の sshd（起動はしていない） | ○ dropbear に、別の VM から dbclient（公開鍵）でログインできた。パスワード認証は無し | — |
| F. Web サーバー | × httpd 無し（socat で代用） | × | × httpd 無し（未調査: python3 はある） | ○ BusyBox の httpd | — |
| F. curl / wget | ○ 両方 | △ wget のみ（linux4）/ 両方（linux3・5.6） | ○ 両方 | △ wget（BusyBox）のみ。curl は依存ライブラリが多く入れていない | — |
| G. arping・ip neigh | ○ arping（BusyBox）・ip neigh | ○ arping | ○ | ○ arping・iproute2 の ip neigh | — |
| G. ebtables / arptables | × | × | × コマンド無し（モジュールはある） | ○ `ebtables -L`・`arptables -L`（nft 版）が動く | — |
| G. VRRP（keepalived 等） | × | × | × | × | 作れる |

### 2-5. 評価の観点ごとの比較

| 観点 | いまのイメージ | Arch Linux（9p） | 自前ビルドの試作（上流カーネル + Ubuntu i386） | Buildroot で作り直し（推奨。未ビルド） | JS 代替 |
| --- | --- | --- | --- | --- | --- |
| ダウンロード量 | 10.1MB | `fs.json` 5.8MB + 起動とこの調査のコマンドで 318 ファイル・85MB（計 約 91MB。使うコマンドが増えるほど増える） | 7.5MB | 見込み 5〜10MB（入れるパッケージ次第） | 増えない |
| `memory_size` | 64MB | 512MB（v86 のプロファイルの値） | 64MB（余裕は少ない） | 見込み 64MB | 64MB |
| 起動時間（PC。この環境は遅い CPU） | 2台 9.5 秒・4台 27.5 秒 | 1台 約 170 秒（ブラウザで、9p のファイルを取りながら） | 2台 18.5 秒・4台 52.7 秒（いまの約 2 倍。xz の展開と動的リンクの分と見ている。未検証） | 見込み いまと同程度（同じ Buildroot・musl/uClibc なら）。**測れていない** | 変わらない |
| 起動時間（スマホ） | 測れていない | 測れていない | 測れていない | 測れていない | — |
| N 台のときの重さ | メモリ 2台 417MB・4台 854MB（レンダラー RSS） | 1台で JS ヒープ 670MB。N 台は現実的でない | 2台 428MB・4台 861MB（いまとほぼ同じ） | 見込み いまと同程度 | 変わらない |
| 移行コスト | — | 大（ログインの方式・ホスト名・プロンプト・パッケージの版がすべて違う。外部の配布元に依存） | 中（下の「移行で直すこと」） | 小〜中（BusyBox・iputils の ping などを今と同じにできる） | 中〜大（JS の実装量） |
| ライセンスと配布の義務 | GPL のソースの置き場所が分からない（v86 側） | 各パッケージ。配布は i.copy.sh 側 | GPL（カーネル・BusyBox・iptables・iproute2・dnsmasq・glibc は LGPL）の対応するソースを自分で用意する | 同左。Buildroot の `make legal-info` で、ソースとライセンスの一覧をまとめて出せる | なし |
| 再現性・保守 | 作り方が分からない（v86 の作者に依存） | 作り方は `docs/archlinux.md`（packer・QEMU）。重い | 手順はスクリプト化できる（この調査では手作業に近い）。Ubuntu の i386 は一部のパッケージしか無い（nmap・dnsmasq・dropbear・tcpdump は自分でビルド） | Buildroot の defconfig とカーネルの設定の断片をリポジトリに置けば、誰でも同じものを作れる。版を固定できる | コードの保守だけ |
| 学習用途 | 本物の Linux だが、道具が足りない | 本物のディストリビューション。道具がそろう。重い | 本物の iptables・iproute2・dnsmasq。nmap が無い。ping が BusyBox 版 | 本物。必要な道具をそろえられる（nmap も Buildroot にある） | 「本物の Linux のコマンドで学ぶ」ことができない |

#### 移行で直すこと（試作のイメージで、いまの e2e と画面を動かして分かったこと）

いまの e2e（`test/e2e.cjs`）を、イメージだけ差し替えた複製で動かすと、起動・自動のネットワーク設定（`ifconfig`・`route`・MAC の設定）・キー入力・日本語は通り、
**ping の結果の確認で止まった**。試作では次を直す必要がある（Buildroot で作り直す場合は、今と同じ部品を選べば多くは不要）:

- プロンプトの検出: BusyBox の ash が出す `ESC[6n` に対応する（`/% (\x1b\[6n)?$/`）か、その機能を切った BusyBox を使う
- ping の出力: BusyBox の ping は `seq=0 ttl=63`・`2 packets received`、iputils の ping は `icmp_seq=1 ttl=63`・`2 received`。学習の手順の確認ポイント・e2e の正規表現を両方に合わせるか、iputils を入れる
- `ping -M do`（DF）は BusyBox の ping に無い
- curl が無い（HTTP の手順は wget に）。`traceroute` は BusyBox 版
- dnsmasq を DNS に使うときは `--local=/ドメイン/`（または上流を指定）
- udhcpc の設定スクリプト（`/usr/share/udhcpc/default.script`）が無い

## 3. 推奨案

### 第1候補: Buildroot でイメージを作り直す（CI でビルドし、成果物の bzImage を使う）

- **理由**: 本物の Linux のコマンド（iptables・nft・ip・tc・dnsmasq・nmap・dropbear・tcpdump）で学べる。いまのイメージも Buildroot 製なので、
  BusyBox・iputils の ping・プロンプトなどを今と同じにでき、**既存の学習の手順や e2e をほぼそのまま使える**。版を固定でき、`make legal-info` でライセンスとソースをまとめられる。
  カーネルの設定は、この調査の試作で「v86 で起動し、A〜G の機能が動く」ことを確かめたもの（付録 A）を使える
- **この調査で確かめていないこと**: Buildroot のビルドそのもの（この環境から buildroot.org とパッケージの配布元に届かない）。起動時間・大きさは見込み
- **想定スケジュール（目安）**: 1〜2日（defconfig と付録 A の設定で、CI でビルドが通るまで）+ 1日（v86-link で e2e を通し、起動時間・メモリを計測）+ 0.5日（ライセンス・ソースの置き場所・README）

### 次点: この調査の試作の方式（上流の Linux + Ubuntu の i386 パッケージ）

- **理由**: この環境で、実際にビルドして v86（ブラウザ）で A・B・C・E・F・G の動作まで確かめた。Ubuntu のアーカイブだけで作れる
- **弱点**: nmap が無い（ポートスキャンは `nc -z`）。glibc の動的リンクで、ファイルが大きく（展開後 18MB）、64MB のメモリでは余裕が少なく、起動がいまの約 2 倍遅い。
  BusyBox の版の違いによる移行の手直しが要る（上の「移行で直すこと」）。Ubuntu の i386 は、パッケージがそろっていない（今後も減る見込み）

### 向いていないもの

- **Arch Linux（9p）**: 機能はそろうが、1台 512MB・起動 約 170 秒・取得 約 91MB（起動と数個のコマンドだけで）で、N 台の LAN には重すぎる。配布元が外部（i.copy.sh）で、GitHub Pages（サイト全体 1GB まで）には載せられない
- **既存の小さなイメージ**: どれも iptables・VLAN が無い
- **JS 代替だけで割り切る**: 下の 4 章。本物のコマンドで学べないので、イメージで実現できるものは JS にしない方がよい

## 4. JS 側での代替（参考）

イメージに載せられない場合に、仮想スイッチ・ルーター（JS）の側で作る案。いまの v86-link には、VLAN のタグの付け外し（`vlanlink.js`）がすでにある。

| 機能 | JS での方式 | 実装量の目安 | 学習効果の低下 |
| --- | --- | --- | --- |
| ファイアウォール（フィルタ） | ルーターの VlanLink のように、ポートとルーターの間に「フィルタ」を置き、IP・ポート・状態（TCP のフラグから簡易な conntrack）でフレームを捨てる。ルールは画面から設定 | 中（解析は `packet.js` がある。状態の追跡が要る） | 大: `iptables` のコマンドを打てない。表示用の独自の書式になる |
| NAT（MASQUERADE・DNAT） | 同じ場所で、IP・ポートを書き換え、チェックサムを計算し直し、対応表を持つ | 中〜大（TCP/UDP/ICMP のチェックサムと対応表、ARP の代理応答） | 大 |
| LOG | 捨てたフレームをキャプチャ・画面に出す（いまのキャプチャで「捨てた理由」を出しているのと同じ） | 小 | 中 |
| DHCP・DNS サーバー | JS の仮想サーバー（DHCP の DISCOVER/OFFER などに答える） | 中 | 中（設定ファイルを書く練習にならない） |
| VLAN のサブインターフェース | いまの VlanLink（ゲストの代わりに、宛先 IP のサブネットでタグを付ける） | 済み | 中（`eth0.10` を作る練習にならない） |
| ポートスキャン | 画面から「スキャン」ボタン（JS が SYN を送る）| 小〜中 | 中 |

## 5. 再ビルドする場合の手順案

### スクリプト化の方針

- リポジトリに置くもの（小さなテキストだけ）: Buildroot の defconfig（`board/v86/defconfig`）、カーネルの設定の断片（付録 A をもとに）、BusyBox の設定の断片、
  ルートファイルシステムの追加ファイル（`/etc/inittab`・`/etc/profile`・udhcpc のスクリプトなど）、ビルドスクリプト（`build.sh`: Buildroot の版を固定して取得 → `make` → bzImage を出す）
- Buildroot の版は LTS（例: 2025.02.x）に固定する。パッケージ: BusyBox、iptables（nft と legacy）、nftables、iproute2、dnsmasq、nmap、dropbear、tcpdump、socat、curl、iputils、ebtables、bridge-utils、ethtool など
- カーネル: i386、`tinyconfig` 相当から（`BR2_LINUX_KERNEL_CONFIG_FRAGMENT_FILES` で付録 A を当てる）。initramfs をカーネルに埋め込む（`BR2_TARGET_ROOTFS_INITRAMFS=y`）
- 確認: ビルドのあとに Node 上の v86 で起動し、この調査と同じコマンド（付録 B）を自動で実行するテストを置く

### CI でビルドするか、手元でビルドして成果物をコミットするか

| | CI（GitHub Actions）でビルド | 手元でビルドして bzImage をコミット |
| --- | --- | --- |
| 再現性 | 高い（手順がそのまま CI の設定になる。誰でも同じ手順） | 手元の環境に依存する |
| 時間 | 初回 30〜60 分の見込み（Buildroot はツールチェーンからビルドする。キャッシュで短くできる）。**未計測** | 同程度（初回だけ） |
| 成果物の置き場所 | Actions の成果物（Artifact）か Release。GitHub Pages へは、Actions からデプロイするか、PR でコミットする | リポジトリにコミット（いまと同じ。10MB 前後） |
| 公開の方法の変更 | Pages を Actions でデプロイする方式に変えるなら、公開の方法が変わる（要相談） | 変わらない |
| GPL のソース | Release に、ビルドに使ったソース一式（`make legal-info` の出力）を一緒に置ける | 同じものを別に用意する必要がある |

おすすめ: **CI でビルドし、成果物の bzImage は PR でリポジトリにコミット**（公開の方法は今のまま）。ソース一式は同じ CI で Release に置く。

### サイズの大きな成果物を GitHub Pages に載せるときの注意

- GitHub のリポジトリの1ファイルは 100MB まで（50MB 以上で警告）。Pages のサイトは 1GB まで、帯域の目安は月 100GB（いずれも GitHub のドキュメントの値。この調査では確認していない）
- いまの規模（10MB 前後）なら問題ない。Arch のような 9p の大きなイメージは載せられない
- イメージを差し替えるたびに、リポジトリの履歴に古いバイナリが残る。頻繁に作り直すなら、Release や Git LFS（Pages では LFS のファイルは配信されない点に注意）を検討する
- ブラウザのキャッシュ: ファイル名に版や日付を入れる（例: `v86net-2026.11.bin`）と、古いイメージがキャッシュに残る問題を避けられる

### ライセンスと配布の義務（法的な助言ではない）

- カーネル・BusyBox・iptables・iproute2・dnsmasq は GPL、glibc・libnftnl などは LGPL、dropbear・tcpdump・libpcap・netcat-openbsd は BSD/MIT 系
- GPL のバイナリを配布する（GitHub Pages で公開する）ときは、**対応するソース（使った版のソースと、ビルドの設定・スクリプト）を一緒に提供する**のが確実。
  他人の配布元（Ubuntu のアーカイブなど）を指すだけで済ませられるのは、条件が限られる（GPLv2 第3条c は非営利で、受け取ったときの申し出を引き継ぐ場合）
- 書く場所: `images/README.md` に、各部品の名前・版・ライセンス・ソースの置き場所（自分の Release の URL）・ビルドの手順を書く。ページの一覧かフッターから、その README へリンクする
- Buildroot なら `make legal-info` で、パッケージごとのライセンスの一覧（`manifest.csv`）とソースのアーカイブを出せる

## 6. 確認できていないこと・追加で必要な調査

- **Buildroot でのビルド**（第1候補）: この環境から buildroot.org・sources.buildroot.net・kernel.org などに届かない。CI（GitHub Actions）か、届く環境で試す必要がある
- nmap: 試作ではビルドできなかった（Ubuntu の dfsg 版のソースと i386 の開発用パッケージの不足。nmap.org に届かない）。Buildroot の nmap パッケージで試す
- `nft` コマンド（nftables）: Ubuntu の i386 に無く、試作に入れていない（カーネルの nf_tables は iptables-nft から使えている）
- Alpine Linux（x86）・Debian（i386）・Tiny Core の拡張: 配布元（dl-cdn.alpinelinux.org・deb.debian.org・tinycorelinux.net）に届かず、試せていない
- Tiny Core: 起動はしたが、X が立ち上がり、文字の画面でコマンドを実行できなかった。SliTaz・DSL・`linux.iso` は起動していない
- Arch: VLAN・iptables（ルールの追加）・ブリッジ・netem・nmap の動作は確認したが、NAT で実際に転送されるか・DHCP・SSH のログインは確かめていない
- 試作の起動が遅い理由（xz の展開・動的リンク・カーネルの設定のどれか）は切り分けていない
- スマホでの起動時間とメモリは測れていない
- この調査の確認は、すべてこの環境（遅い CPU）での値。実機の PC では 1/2〜1/3 程度の見込み（以前の計測からの推測）

## 7. 判断していただきたいこと

1. **イメージを自前でビルドして保守するか**（第1候補・次点）、**JS 代替で割り切るか**
2. 自前でビルドする場合: Buildroot（推奨）か、試作の方式か
3. ビルドを CI（GitHub Actions）で行ってよいか。そのために、この作業環境のネットワークの許可（buildroot.org・sources.buildroot.net・cdn.kernel.org など）を追加するか
4. 成果物の置き方: 今のまま bzImage をリポジトリにコミットするか、Release などに置くか（公開の方法の変更になる場合は要相談）
5. GPL のソースの提供方法（Release に置く、など）

## 付録 A. カーネルの設定の断片（試作で使ったもの）

`make ARCH=i386 tinyconfig` のあとに、次の2つを `scripts/kconfig/merge_config.sh` で重ね、`CONFIG_INITRAMFS_SOURCE`（cpio）と `CONFIG_INITRAMFS_COMPRESSION_XZ=y` を設定した。

v86 で動かす最小限とネットワークの機能:

```
CONFIG_M686=y CONFIG_SMP=n CONFIG_NOHIGHMEM=y CONFIG_PRINTK=y CONFIG_MULTIUSER=y CONFIG_FUTEX=y CONFIG_EPOLL=y
CONFIG_SIGNALFD=y CONFIG_TIMERFD=y CONFIG_EVENTFD=y CONFIG_SHMEM=y CONFIG_AIO=y CONFIG_POSIX_TIMERS=y
CONFIG_TTY=y CONFIG_VT=n CONFIG_UNIX98_PTYS=y CONFIG_SERIAL_8250=y CONFIG_SERIAL_8250_CONSOLE=y
CONFIG_BLK_DEV_INITRD=y CONFIG_RD_XZ=y CONFIG_KERNEL_XZ=y CONFIG_BINFMT_ELF=y CONFIG_BINFMT_SCRIPT=y
CONFIG_PROC_FS=y CONFIG_SYSFS=y CONFIG_DEVTMPFS=y CONFIG_DEVTMPFS_MOUNT=y CONFIG_TMPFS=y CONFIG_IKCONFIG=y CONFIG_IKCONFIG_PROC=y
CONFIG_PCI=y CONFIG_PCI_GOANY=y CONFIG_NETDEVICES=y CONFIG_ETHERNET=y CONFIG_NET_VENDOR_8390=y CONFIG_NE2K_PCI=y
CONFIG_RTC_CLASS=y CONFIG_RTC_DRV_CMOS=y CONFIG_INPUT=n
CONFIG_NET=y CONFIG_PACKET=y CONFIG_UNIX=y CONFIG_INET=y CONFIG_IP_MULTICAST=y CONFIG_IP_ADVANCED_ROUTER=y CONFIG_IP_MULTIPLE_TABLES=y
CONFIG_IPV6=y CONFIG_SYN_COOKIES=y CONFIG_VLAN_8021Q=y CONFIG_BRIDGE=y CONFIG_BRIDGE_VLAN_FILTERING=y CONFIG_VETH=y CONFIG_DUMMY=y CONFIG_MACVLAN=y CONFIG_TUN=y
CONFIG_NETFILTER=y CONFIG_NETFILTER_ADVANCED=y CONFIG_NETFILTER_XTABLES=y CONFIG_NF_CONNTRACK=y CONFIG_NF_CONNTRACK_FTP=y
CONFIG_NF_NAT=y CONFIG_NF_NAT_MASQUERADE=y CONFIG_NF_TABLES=y CONFIG_NF_TABLES_INET=y CONFIG_NF_TABLES_IPV4=y CONFIG_NF_TABLES_IPV6=y
CONFIG_NFT_CT=y CONFIG_NFT_NAT=y CONFIG_NFT_MASQ=y CONFIG_NFT_REDIR=y CONFIG_NFT_LOG=y CONFIG_NFT_REJECT=y CONFIG_NFT_COMPAT=y
CONFIG_NETFILTER_XT_MARK=y CONFIG_NETFILTER_XT_TARGET_LOG=y CONFIG_NETFILTER_XT_TARGET_MASQUERADE=y CONFIG_NETFILTER_XT_TARGET_REDIRECT=y
CONFIG_NETFILTER_XT_TARGET_NETMAP=y CONFIG_NETFILTER_XT_NAT=y CONFIG_NETFILTER_XT_MATCH_CONNTRACK=y CONFIG_NETFILTER_XT_MATCH_STATE=y
CONFIG_NETFILTER_XT_MATCH_MULTIPORT=y CONFIG_NETFILTER_XT_MATCH_LIMIT=y CONFIG_NETFILTER_XT_MATCH_MAC=y CONFIG_NETFILTER_XT_MATCH_IPRANGE=y
CONFIG_NETFILTER_XT_MATCH_COMMENT=y CONFIG_NF_LOG_IPV4=y CONFIG_NF_LOG_SYSLOG=y
CONFIG_IP_NF_IPTABLES=y CONFIG_IP_NF_FILTER=y CONFIG_IP_NF_TARGET_REJECT=y CONFIG_IP_NF_NAT=y CONFIG_IP_NF_TARGET_MASQUERADE=y
CONFIG_IP_NF_TARGET_REDIRECT=y CONFIG_IP_NF_MANGLE=y CONFIG_IP_NF_RAW=y CONFIG_IP6_NF_IPTABLES=y CONFIG_IP6_NF_FILTER=y
CONFIG_BRIDGE_NETFILTER=y CONFIG_BRIDGE_NF_EBTABLES=y CONFIG_BRIDGE_EBT_BROUTE=y CONFIG_BRIDGE_EBT_T_FILTER=y
CONFIG_IP_NF_ARPTABLES=y CONFIG_IP_NF_ARPFILTER=y
CONFIG_NET_SCHED=y CONFIG_NET_SCH_NETEM=y CONFIG_NET_SCH_TBF=y CONFIG_NET_SCH_HTB=y CONFIG_NET_SCH_INGRESS=y
CONFIG_NET_CLS=y CONFIG_NET_CLS_U32=y CONFIG_NET_CLS_ACT=y CONFIG_NET_ACT_MIRRED=y
```

ユーザーランド用（`tinyconfig` で抜けるシステムコール。これが無いと iptables・dnsmasq・dropbear が動かなかった）:

```
CONFIG_EXPERT=y CONFIG_FILE_LOCKING=y CONFIG_ADVISE_SYSCALLS=y CONFIG_MEMBARRIER=y CONFIG_RSEQ=y CONFIG_SYSVIPC=y
CONFIG_POSIX_MQUEUE=y CONFIG_FHANDLE=y CONFIG_CROSS_MEMORY_ATTACH=y CONFIG_KCMP=y CONFIG_SGETMASK_SYSCALL=y CONFIG_SYSFS_SYSCALL=y
CONFIG_COMPAT_32BIT_TIME=y CONFIG_BPF_SYSCALL=y CONFIG_INOTIFY_USER=y CONFIG_PROC_SYSCTL=y CONFIG_SYSCTL=y CONFIG_UNIX_SCM=y
CONFIG_NETFILTER_NETLINK_LOG=y CONFIG_NETFILTER_NETLINK_QUEUE=y CONFIG_NF_CT_NETLINK=y
```

## 付録 B. 確かめたときの構成と結果の抜粋（試作のイメージ）

- Node（ハブ）: A（`eth0.10` 10.9.1.2）・R（`eth0.10` 10.9.1.1・`eth0.20` 10.9.2.1、ip_forward=1）・B（`eth0.20` 10.9.2.2）・C（VLAN なし）
- ブラウザ（v86-link の VLAN 対応スイッチ）: A（LAN1・アクセス VLAN 10）・B（LAN2・アクセス VLAN 20）・R（P8・トランク 1/10/20。VlanLink のタグ付けを止め、ゲストの `eth0.10`・`eth0.20` で）・C（LAN2）

```
A$ ping -c 3 10.5.2.2                → 64 bytes from 10.5.2.2: seq=0 ttl=63 …（R のトランクから入ったフレームのタグ: VLAN 10・20。ゲストが付けた）
R$ iptables -P FORWARD DROP; … --ctstate ESTABLISHED,RELATED -j ACCEPT; -i eth0.10 -o eth0.20 -j ACCEPT; -j LOG --log-prefix "FWD-DROP: "
A$ ping 10.5.2.2 → 通る / B$ ping 10.5.1.2 → 100% packet loss
R$ dmesg → FWD-DROP: IN=eth0.20 OUT=eth0.10 … SRC=10.5.2.2 DST=10.5.1.2 … PROTO=ICMP TYPE=8
R$ iptables -t nat -A POSTROUTING -o eth0.20 -j MASQUERADE / -A PREROUTING -i eth0.20 -p tcp --dport 8080 -j DNAT --to-destination 10.5.1.2:80
B$ tcpdump → IP 10.5.2.1 > 10.5.2.2: ICMP echo request（A の ping の送り元が R に変わる）
B$ wget -q -O - http://10.5.2.1:8080/ → hello-from-A-behind-NAT
C$ udhcpc -i eth0 … → lease of 10.5.2.120 obtained from 10.5.2.1 / default via 10.5.2.1
C$ nc -z -v -w 1 10.5.2.1 20-25 53 80 8080 → 22・53・8080 が succeeded
C$ dbclient -y -i ~/.ssh/id_ed25519 root@10.5.2.1 "hostname; id -u" → r / 0
C$ tc qdisc add dev eth0 root netem delay 200ms; ping → round-trip 206.4/211.4/216.4 ms
```

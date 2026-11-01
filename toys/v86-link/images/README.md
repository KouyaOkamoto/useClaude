# ゲストの Linux イメージ

| 項目 | 内容 |
| --- | --- |
| ファイル | `buildroot-bzimage68.bin`（10,068,480 バイト。initramfs 入りの Linux カーネル） |
| 入手元 | v86 の公式イメージ https://i.copy.sh/buildroot-bzimage68.bin（v86 の `Readme.md` のテスト用イメージの一覧、`src/browser/main.js` のプロファイル `buildroot6`「Buildroot Linux 6.8」） |
| SHA-256 | `507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c` |
| 中身（起動して確認） | Linux 6.8.12（i686）、BusyBox 1.36.1、socat 1.8.0.0、curl、wget、ping（iputils）、ip、ifconfig、tcpdump など |
| 無いもの | `nc`（netcat）と `httpd`。BusyBox の applet にも入っていない。このおもちゃでは socat で代わりにする |
| ライセンス | Buildroot で作られたイメージで、Linux カーネルと BusyBox は GPL-2.0、ほかの各パッケージはそれぞれのライセンス。ソースはそれぞれの公式配布元（https://www.kernel.org/ 、https://busybox.net/ 、http://www.dest-unreach.org/socat/ 、https://curl.se/ など）。このイメージを作った Buildroot の設定は確認できていない |

v86 の公式の2台構成のサンプル（`examples/two_instances.html`）は `linux4.iso`（Linux 4.16、BusyBox 1.28.4）を使っているが、
起動して確かめると `nc`・`httpd` に加えて `curl`・`socat` も無く、HTTP サーバーや TCP の送受信を作れなかったため、こちらを選んだ。

## 新しいイメージ（v86net。Buildroot でこのリポジトリから作る）

作り方・設定は `images/build/`（`build.sh`・`buildroot/`）、CI は `.github/workflows/v86-image.yml`。
選んだもの（版・libc・圧縮）の理由と測った数値は `docs/buildroot-image.md`。

### 部品・版・ライセンス（uClibc-ng・gzip の構成）

Buildroot 2025.02.19 の `make legal-info` の一覧（`manifest.csv`。CI run 41231104746）から、イメージに入るものを書き出した。
正しい一覧は、Release に置く legal-info の `manifest.csv`（下の「ソース」）を見ること。

| 部品 | 版 | ライセンス（Buildroot の記載） |
| --- | --- | --- |
| Linux（カーネル） | 6.12.112 | GPL-2.0 |
| BusyBox | 1.37.0 | GPL-2.0（bzip2 の部分は bzip2-1.0.6） |
| uClibc-ng（libc） | 1.0.59 | LGPL-2.1+ |
| GCC のランタイム（libgcc_s） | 13.4.0 | GPL-3.0-with-GCC-exception |
| iputils（ping など） | 20250605 | GPL-2.0+, BSD-3-Clause |
| tcpdump / libpcap | 4.99.5 / 1.10.7 | BSD-3-Clause |
| socat | 1.8.1.3 | GPL-2.0 with OpenSSL exception |
| curl（libcurl） | 8.22.0 | curl |
| iptables | 1.8.11 | GPL-2.0 |
| nftables / libnftnl / libmnl | 1.1.0 / 1.2.7 / 1.0.5 | GPL-2.0 / GPL-2.0+ / LGPL-2.1+ |
| iproute2 | 6.14.0 | GPL-2.0+ |
| bridge-utils | 1.7.1 | GPL-2.0+ |
| dnsmasq | 2.93 | GPL-2.0 or GPL-3.0 |
| Dropbear | 2026.93 | MIT, BSD-2-Clause, Public domain, Unlicense, WTFPL |
| Buildroot の skeleton（`/etc` の土台など） | 2025.02.19 | GPL-2.0-or-later |

- 上の表は nmap を入れていたときの一覧から nmap とそれだけが使う部品（libstdc++・PCRE2・liblinear）を除いたもの。
  公開のときの Release の `manifest.csv` で確かめること

### nmap は標準のイメージに入れない

- **判断**: nmap は標準のイメージには入れない。ポートスキャンは BusyBox の `nc -z -v` の手順を使う（`docs/v86net-examples.md`）
- **理由**: nmap は独自のライセンス「Nmap Public Source License（NPSL）」で、イメージに同梱して配ることが再配布の条件にどう当たるかを、
  リポジトリの持ち主が確認できていない。また、64MB のゲストでは `-sV`・`-O` のデータを入れられない（`-sV` は OOM になる。
  `docs/buildroot-image.md`）ので、nmap を入れて得られるものも小さい
- **有効にする方法**（ビルドのオプション。標準では無効）:
  - 手元: `V86_NMAP=1 toys/v86-link/images/build/build.sh`（成果物の名前に `-nmap` が付く。C++ のランタイムも入る）
  - CI: 「v86-link image」を手動実行するときに `nmap` を選ぶ。nmap を入れたイメージは、`publish` を選んでも公開しない（ワークフローで止めている）
- **ライセンスの注意**: nmap を入れたイメージを配るなら、その前に NPSL（nmap のソースの `LICENSE`）の条件を読み、
  自分の配り方が条件に合うかを確かめること。合わない、または判断できないなら配らない
- `/etc/inittab`・`/etc/profile` など、このリポジトリのオーバーレイ（`images/build/buildroot/board/v86net/rootfs-overlay/`）は、いまのイメージの内容を写したもの

### ソース（GPL などの対応するソース）

ビルドに使ったすべてのパッケージのソースとライセンスの文書は、CI の公開（`workflow_dispatch` で publish を選ぶ）で作る
GitHub の Release に、`legal-info-*.tar.gz`（`make legal-info` の出力）として置く。あわせて、カーネルと Buildroot の設定、build-info も置く。
**まだ Release は作っていない**（公開の手順は下）。作ったら、ここに Release の URL を書く。

### 作り直しの手順

```sh
# Ubuntu 24.04 など。必要なもの: build-essential file wget cpio unzip rsync bc bzip2 flex bison libelf-dev libssl-dev python3 perl
toys/v86-link/images/build/build.sh                      # 既定: uClibc-ng・gzip。出力は ./work/dist
V86_LIBC=musl V86_COMPRESS=xz toys/v86-link/images/build/build.sh
node toys/v86-link/images/build/test-image.cjs work/dist/bzImage-uclibc-gzip --net   # Node の v86 で確かめる
```

- Buildroot は buildroot.org から取得し、配布元の `.sign` の SHA256 と、`build.sh` に記録した値の両方と照合する。
  ほかのソースは Buildroot の標準の取得経路（各パッケージのハッシュの照合を含む）で取る
- ビルドの時間: キャッシュ（ダウンロード・ccache）があれば 12〜16 分、無ければ 33 分ほど（GitHub Actions）
- 公開: Actions の「v86-link image」を `workflow_dispatch` で、publish を選んで実行すると、テストが通った bzImage を
  `toys/v86-link/images/v86net-<日付>-<libc>-<圧縮>.bin` として追加する PR と、ソース一式の Release を作る

### rootfs は ramfs（上限が無い。書き込みすぎると OOM になる）

- initramfs の展開先（rootfs、`/`）は **ramfs**。カーネルに組み込んだコマンドライン（`CONFIG_CMDLINE="rootfstype=ramfs"`）で選んでいる。
  v86-link が渡すコマンドラインは変えていない（組み込みのものの後ろに足される）
- 理由: tmpfs（いまのイメージと Linux の既定）だと、rootfs の大きさの上限が RAM の半分になる。
  `memory_size` 64MB では約 18MB で、それより大きい initramfs は展開の途中で `Kernel panic - not syncing: write error` になった
- **ramfs には大きさの上限が無い**。`/`（`/root` など）に大きなファイルを書き続けると、メモリを使い切って **OOM（プロセスが強制終了される、
  最悪はカーネルの panic）** になる。ramfs の中身はスワップにも追い出せない（`/proc/meminfo` の `Unevictable` に入る）。
  大きなファイルは `/tmp`（tmpfs。上限は RAM の半分）に置く。`df /` は ramfs では大きさを示さないので、空きは `free` か `/proc/meminfo` で見る
- `/tmp`・`/run` は tmpfs のまま（`CONFIG_TMPFS` は有効）

# ゲストの Linux イメージ

> **この文書の部品・版・ライセンスの表は「書き写し」です。正式な一覧ではありません。**
> - 新しいイメージ（v86net）の正式な一覧は、Release に置いた legal-info の **`manifest.csv`**（`legal-info-*.tar.gz` の中）。
>   表はそこから書き写したもので、食い違うときは `manifest.csv` が正しい（Release の場所は「ソース」の節）
> - いまのイメージ（buildroot-bzimage68.bin）は v86 の公式配布物で、**作った Buildroot の設定も `manifest.csv` も手に入らない**。
>   表は、イメージを起動して確かめた版と、同じ版の Buildroot（2024.05.2）のパッケージ定義のライセンスの記載を書き写したもの。
>   確かめられなかったものは「未確認」と書いた

## いまのイメージ（buildroot-bzimage68.bin。既定）

| 項目 | 内容 |
| --- | --- |
| ファイル | `buildroot-bzimage68.bin`（10,068,480 バイト。initramfs 入りの Linux カーネル） |
| 入手元 | **v86 の公式配布物**: https://i.copy.sh/buildroot-bzimage68.bin（v86 の `Readme.md` のテスト用イメージの一覧、`src/browser/main.js` のプロファイル `buildroot6`「Buildroot Linux 6.8」） |
| SHA-256 | `507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c` |
| 作り方 | Buildroot 2024.05.2（`/etc/os-release`）。**Buildroot の設定（defconfig・カーネルの設定）は公開されておらず、不明**。カーネルは 2024-08-31 に `builder@archlinux` でビルドされた（`/proc/version`） |
| ツールチェーン | `i686-linux-gcc` 13.2.0（「Buildroot 2021.11-11272-ge2962af」と表示）、GNU ld 2.42（`/proc/version`）。uClibc-ng の版（1.0.45）が Buildroot 2024.05.2 の定義（1.0.48）と違うので、Buildroot 2024.05.2 とは別に作られたツールチェーンと見られる（未確認） |
| 無いもの | `nc`（netcat）と `httpd`。BusyBox の applet にも入っていない。このおもちゃでは socat で代わりにする |
| ソース | このリポジトリは、このイメージの対応するソースを持っていない。各部品のソースは、それぞれの公式配布元（下の表の版）から得られる。このイメージそのものを作ったソース一式の置き場所は確認できていない |

v86 の公式の2台構成のサンプル（`examples/two_instances.html`）は `linux4.iso`（Linux 4.16、BusyBox 1.28.4）を使っているが、
起動して確かめると `nc`・`httpd` に加えて `curl`・`socat` も無く、HTTP サーバーや TCP の送受信を作れなかったため、こちらを選んだ。

### 部品・版・ライセンス（いまのイメージ。書き写し）

版は、イメージを起動して各コマンドの表示・ライブラリのファイル名で確かめた（2026-11-01。`docs/current-image.md`）。
ライセンスは、Buildroot 2024.05.2 のパッケージ定義（`package/*/*.mk` の `*_LICENSE`）の記載。イメージの中のライセンス文書は確かめていない。
lsof・tree・vi・wget・ip・ifconfig などは BusyBox の applet（別の部品ではない）。

| 部品 | 版（起動して確認） | ライセンス（Buildroot 2024.05.2 の記載） |
| --- | --- | --- |
| Linux（カーネル） | 6.8.12 | GPL-2.0 |
| BusyBox | 1.36.1 | GPL-2.0, bzip2-1.0.4 |
| uClibc-ng（libc） | 1.0.45 | LGPL-2.1+（定義の版は 1.0.48。1.0.45 のライセンス文書は未確認） |
| GCC のランタイム（libgcc_s・libatomic・libstdc++・libgomp・libgfortran・libquadmath） | 13.2.0 | GPL-3.0-with-GCC-exception（gcc-final の記載。ライブラリごとのライセンスは未確認） |
| iputils（ping・arping・tracepath・clockdiff） | 20240117 | GPL-2.0+, BSD-3-Clause |
| tcpdump / libpcap | 4.99.4 / 1.10.4 | BSD-3-Clause |
| socat | 1.8.0.0 | GPL-2.0 with OpenSSL exception |
| curl（libcurl） | 8.7.1 | curl |
| Lua | 5.4.6 | MIT |
| joe（エディタ） | 4.6 | GPL-2.0+ |
| links（テキストブラウザ） | 2.29 | GPL-2.0+ |
| GNU ed | 1.20.2 | GPL-2.0+ |
| ntp（ntpd・ntpq・ntpdate など） | 4.2.8p18 | NTP |
| tinyssh（tinysshd） | **未確認**（版を表示しない。定義の版は 20240101） | CC0-1.0 |
| tcping | **未確認**（版を表示しない。定義の版は 2.1.0） | MIT |
| libevent | **未確認**（ライブラリは `libevent-2.1.so.7.0.1`。定義の版は 2.1.12） | BSD-3-Clause, OpenBSD |
| libtelnet | **未確認**（ライブラリは `libtelnet.so.2.0.0`。定義の版は 0.23） | Public domain |
| libuuid（util-linux） | **未確認**（ライブラリは `libuuid.so.1.3.0`。定義の版は 2.39.3） | BSD-3-Clause（libuuid。util-linux 全体は GPL-2.0+ ほか） |

- 上の表に無いもの（Buildroot の skeleton の `/etc` など）があるかは未確認
- 「定義の版」は Buildroot 2024.05.2 のパッケージ定義の版で、イメージに入っているものの版であるとは確かめていない

## 新しいイメージ（v86net。Buildroot でこのリポジトリから作る）

| 項目 | 内容 |
| --- | --- |
| ファイル | `v86net-20261101-uclibc-gzip.bin`（6,357,504 バイト。initramfs 入りの Linux カーネル） |
| SHA-256 | `3a8dc90e5ed3415ffd8f886ebc487c2405038f0790532fce2e28ea303dec3bb1`（Release の bzImage と同じ） |
| 使い方 | 既定ではない。v86-link を `?image=v86net` で開くと使える（`main.js` の `IMAGES`） |
| 中身 | Buildroot 2025.02.19、Linux 6.12.112、uClibc-ng 1.0.59、BusyBox 1.37.0。部品の一覧は下 |

作り方・設定は `images/build/`（`build.sh`・`buildroot/`）、CI は `.github/workflows/v86-image.yml`。
選んだもの（版・libc・圧縮）の理由と測った数値は `docs/buildroot-image.md`。

### 部品・版・ライセンス（新しいイメージ、uClibc-ng・gzip の構成。書き写し）

**書き写し**（冒頭の注意を参照）。正式な一覧は、Release の legal-info の `manifest.csv`（下の「ソース」）。
Buildroot 2025.02.19 の `make legal-info` の一覧から、イメージに入るものを書き写した。

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

- 上の表は、nmap を外した標準のイメージの `manifest.csv`（CI run 41278395895）と一致することを確かめた
  （nmap・PCRE2・liblinear は一覧に無く、rootfs に libstdc++ も無い）

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
- いまの版（`images/v86net-20261101-uclibc-gzip.bin`）のソース一式・設定:
  https://github.com/KouyaOkamoto/useClaude/releases/tag/v86net-20261101-uclibc-gzip-run41299566572
  （作ったビルドの実行: https://github.com/KouyaOkamoto/useClaude/actions/runs/41299566572）

### 作り直しの手順

前提:

- ビルド: Linux（Ubuntu 24.04 で確認）。必要なもの: build-essential file wget cpio unzip rsync bc bzip2 flex bison libelf-dev libssl-dev python3 perl。
  作業場所に 5〜10GB の空き
- テスト（`test-image.cjs`）: **Node.js 22**（22.22.0 で確認）。このリポジトリが同梱する v86（`toys/v86-link/lib/v86`）を使い、npm のパッケージは要らない。
  22 より古い版では確かめていない（CI では ubuntu-24.04 のランナーに入っている Node で動かしているが、その版はログに記録していない）
- e2e・計測（`test/e2e.cjs`・`test/measure.cjs`、任意）: Node.js 22 と Playwright 1.56.1（CI と同じ版）

```sh
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

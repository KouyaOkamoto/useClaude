# 新しいゲスト Linux（v86net）: 作り方・選んだもの・測った数値

Buildroot で作り直したゲストの Linux（以下 v86net）について、版や設定を選んだ理由と、CI で測った数値をまとめる。
作り方は `images/build/`、部品とライセンスは `images/README.md`、手で試すコマンドは `docs/v86net-examples.md`。

数値は、特に書かないかぎり GitHub Actions（ubuntu-24.04）の上で、このリポジトリが同梱する v86（`lib/v86`）を Node で動かして測った
（`images/build/test-image.cjs`。`memory_size` 64MB、ne2k、v86-link と同じコマンドライン、2台をハブでつなぐ）。
CI のランナーは毎回違うので、時間（特に起動時間）は同じ条件でも 1.5 倍ほどばらつく。比べるときは同じ実行の中の数値で比べる。

## 選んだもの

| 項目 | 選んだもの | 理由 |
| --- | --- | --- |
| Buildroot | 2025.02.19（LTS） | ダウンロードのページに載っている唯一の LTS で、サポートは 2028 年 3 月まで。tarball の SHA256 を配布元の `.sign` と照合し、`build.sh` に記録している |
| カーネル | Linux 6.12.112（Buildroot 2025.02 の既定。LTS） | tinyconfig を土台に、必要なものだけを組み込みで足す（モジュールは使わない）。断片は `board/v86net/linux-*.fragment` |
| libc | uClibc-ng 1.0.59 | いまのイメージと同じ（挙動を合わせやすい）。musl とは大きさ・メモリがほぼ同じで、glibc は rootfs が 2.6MB 大きく、空きのメモリが 2〜3MB 減る（下の表） |
| カーネルの圧縮 | gzip | xz は bzImage が 1.8MB 小さいが、起動が倍以上遅い（下の表）。gzip でも、いまのイメージより 1.9MB 小さい |
| rootfs | ramfs（`CONFIG_CMDLINE="rootfstype=ramfs"`） | tmpfs だと大きさの上限が RAM の半分（64MB で約 18MB）で、それを超えると起動しない（下の「rootfs の上限」） |
| ping | iputils | いまのイメージと同じ形式（`icmp_seq=1 ttl=64`）。v86-link の e2e と学習の手順がこの形式に合わせている |
| nmap のデータ | `nmap-services` だけ残す | `-O`・`-sV`・MAC ベンダー名のデータ（計 9MB）は外した。`-sV` は 64MB では動かない（下の「nmap -sV」） |

## 圧縮の比較（uclibc、run 41231104746）

| 圧縮（カーネル・initramfs） | bzImage | プロンプトまで（A） | 起動直後の MemFree |
| --- | --- | --- | --- |
| gzip・gzip | 8,131,072 B | 7.6 秒 | 21,832 kB |
| xz・xz | 6,357,504 B | 16.2 秒 | 18,756 kB |

いまのイメージは 10,068,480 B。

注意: これより前の実行（run 41228181578 まで）は、「xz」と書いたものも、カーネル本体の圧縮は gzip だった。
Buildroot がビルドの前に、カーネルの設定の `CONFIG_KERNEL_*` を自分の設定（`BR2_LINUX_KERNEL_*`、既定は gzip）で書き換えるため
（`linux/linux.mk` の `LINUX_KCONFIG_FIXUP_CMDS`）。いまは `build.sh` が `BR2_LINUX_KERNEL_*` も合わせて設定し、
実際にビルドに使ったカーネルの設定を断片と1行ずつ突き合わせて、違うものをログに出す（`kernel-config-warnings-*.txt`）。

## libc の比較（run 41228181578。カーネルの圧縮はどれも gzip、rootfs は ramfs）

| libc | bzImage | rootfs（展開後） | 起動直後の MemFree | nmap -sT のピーク（VmHWM）/ 実行中の MemAvailable の最小 | conntrack 使用中の MemAvailable の最小 | ビルド（キャッシュあり） |
| --- | --- | --- | --- | --- | --- | --- |
| uClibc-ng 1.0.59 | 8,131,072 B | 15,728,589 B | 20,448 kB | 6,040 kB / 17,988 kB | 20,008 kB | 924 秒 |
| musl 1.2.6 | 8,217,088 B | 15,638,029 B | 19,380 kB | 5,916 kB / 18,076 kB | 20,280 kB | 679 秒 |
| glibc 2.41 | 9,212,416 B | 18,336,424 B | 19,196 kB | 6,948 kB / 15,256 kB | 17,332 kB | 797 秒 |

- 3つとも、64MB で起動し、機能のテスト（38 項目）がすべて通った
- musl では、起動時の `mount: mounting host9p on /mnt failed` の行がシリアルに出なかった（ほかの2つといまのイメージは出る）。原因は調べていない
- ビルド時間は、ccache の当たり方で変わる（同じ組み合わせでも 700〜930 秒）。キャッシュが無いときは、最小の構成で 1,980 秒（run 41202037413）

## rootfs の上限（tmpfs → ramfs）

initramfs の展開先（rootfs）は、Linux の既定では tmpfs で、大きさの上限が RAM の半分になる。
`memory_size` 64MB では、カーネルが使えるメモリ（managed）が約 35MB で、上限は約 18MB。
rootfs が 26MB・18.5MB のときは、展開の途中で `Kernel panic - not syncing: write error` になった。panic の時点の shmem は、
それぞれ 17,424 kB・18,144 kB で、managed（34,852 kB・36,292 kB）のちょうど半分だった（空きのメモリはまだ 15MB あった）。

`rootfstype=` に tmpfs 以外を渡すと、rootfs は ramfs になる（Linux 6.12 の `init/do_mounts.c` の `init_rootfs`）。
これをカーネルに組み込むコマンドライン（`CONFIG_CMDLINE`）に入れたので、v86-link のコマンドラインは変えていない。
CI のテストで、`/proc/cmdline` に `rootfstype=ramfs` があり、`/proc/mounts` の rootfs の行に `size=` が無い（ramfs）こと、
`/tmp` が tmpfs のままであることを確かめている。ramfs には上限が無いので、書き込みすぎると OOM になる（`images/README.md`）。

いまのイメージ（buildroot-bzimage68.bin）は rootfs が tmpfs で、上限は `size=16680k`（rootfs は約 15MB）。

## メモリ（64MB）: nmap・conntrack・OOM

uclibc・gzip（run 41231104746）:

| 場面 | 値 |
| --- | --- |
| 起動直後 | MemTotal 42,740 kB、MemFree 21,832 kB、MemAvailable 20,680 kB、rootfs（Unevictable）17,532 kB |
| `nmap -sT -p 22,23,80` の実行中 | nmap のピーク 5,928 kB、MemAvailable の最小 17,976 kB |
| conntrack の使用中（B → A:80 へ接続と切断を 900 回 + 1000 ポートのスキャン、60 秒） | 記録の数の最大 910（上限 1,024）、表が満杯 0 回、MemAvailable の最小 19,996 kB |
| OOM（`dmesg`） | A・B とも 0 |

いまのイメージ（同じテストの基本の部分）: MemTotal 39,976 kB、MemFree 20,780 kB、MemAvailable 19,784 kB。

### nmap -sV（nmap-service-probes を残した測定用の派生、run 41222635501）

| 項目 | 通常（probes なし） | probes あり |
| --- | --- | --- |
| rootfs（Unevictable） | 17,532 kB | 20,048 kB |
| 起動直後の MemFree / MemAvailable | 21,756 / 20,604 kB | 19,252 / 18,116 kB |
| `nmap -sT` の実行中の MemAvailable の最小 | 17,972 kB | 15,360 kB |
| `nmap -sV -p 22,80` | （データが無いので動かない） | OOM で強制終了（終了コード 137）。ピーク 19,400 kB、実行中の MemFree の最小 876 kB、B の dmesg に OOM 3 件 |

`-sV` は、起動直後の空き（約 18MB）より多くのメモリを使う。64MB のままで `-sV` を使うには、少なくとも数 MB の空きを別に作る必要がある。
`-sV` を戻すかは利用者の判断（いまは外したまま）。

## 2台・4台の起動（実ブラウザ、新旧のイメージ）

CI で `test/measure.cjs`（2・4 台）と `test/e2e.cjs` を、新しいイメージといまのイメージの両方で動かしている（ワークフローの「e2e・計測」）。
条件: GitHub Actions（ubuntu-24.04）、ランナーの Google Chrome（ヘッドレス）、v86-link のページ（`?image=` で切り替え）、
`memory_size` 64MB、同じジョブの中で続けて測った（run 41234401125、新しいイメージは uClibc-ng・gzip）。

| | 新しいイメージ（v86net） | いまのイメージ（buildroot68） |
| --- | --- | --- |
| e2e（`test/e2e.cjs`、74 項目） | すべて成功 | すべて成功 |
| e2e の初回の起動（ブート A / B） | 7,248 / 7,565 ms | 8,911 / 8,936 ms |
| e2e の再読込後の起動（ブート A / B） | 6,349 / 6,148 ms | 9,294 / 8,530 ms |
| 2 台: 全台の準備完了 / レンダラー RSS | 9.7 秒 / 742 MB | 10.8 秒 / 735 MB |
| 4 台: 全台の準備完了 / レンダラー RSS | 23.4 秒 / 1,192 MB | 29.4 秒 / 1,266 MB |
| 4 台: 入力のエコー（中央値 / 最大） | 11 / 96 ms | 11 / 244 ms |

- 起動は、いまのイメージと同じか少し速い（1回ずつの計測。CI ではばらつく）。レンダラーのメモリはほぼ同じ
- e2e のテストは変えていない（新しいイメージ用に足した設定は、CI の中で `main.js` の `IMAGES` に `v86net-ci` を足すことだけ）

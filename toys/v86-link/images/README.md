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

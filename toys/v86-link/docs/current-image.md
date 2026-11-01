# いまのイメージ（buildroot-bzimage68.bin）の起動後の挙動

Buildroot で作り直すイメージを、いまのイメージと同じ挙動にするため、いまのイメージを実際に起動して観察した（2026-10-31）。
Node 上の v86（このリポジトリが同梱している `lib/v86`）で、v86-link と同じ設定（`memory_size` 64MB・ne2k・
コマンドライン `tsc=reliable mitigations=off random.trust_cpu=on`）で起動し、シリアルからコマンドを送った。

## 起動とシェル

| 項目 | 観察した結果 |
| --- | --- |
| プロンプトまで | 約 3.6〜7 秒（1〜2台。この環境） |
| シリアルに出るもの | カーネルのメッセージは出ない（`console=` 指定なし → カーネルのコンソールは VGA の tty0。`dmesg` に `printk: legacy console [tty0] enabled`）。シリアルには `/etc/profile` の出力とプロンプトだけ |
| シリアルの出力（最後まで） | `mount: mounting host9p on /mnt failed: No such file or directory` → 空行 → `Enable networking using 'udhcpc'` → `Files send via emulator appear in /mnt/` → `~% ` |
| 端末の問い合わせ（`ESC[6n`） | **出さない**（BusyBox の `FEATURE_EDITING_ASK_TERMINAL` は無効と見られる） |
| `/init` | Buildroot の標準（`fs/cpio/init`）: devtmpfs をマウントし、`/dev/console` があればそれを標準入出力にして `/sbin/init` |
| `/etc/inittab` | `::sysinit` は**コメントアウト**（`/etc/init.d/rcS` は動かない）。`::respawn:-/bin/sh`（コンソール）・`tty2〜4::askfirst:-/bin/sh`・`ttyS0::respawn:-/bin/sh`・`::ctrlaltdel:/sbin/reboot -f` |
| `/etc/profile` | `mount -a` / `echo 0 > /proc/sys/kernel/printk` / `PS1='\W% '` / `HOME='/root'` / 案内の2行を表示 / `cd ~`。`/etc/profile.d/umask.sh`（`umask 022`） |
| `/etc/fstab` | proc・tmpfs（`/tmp`・`/run`）・sysfs・`host9p /mnt 9p`（9p はカーネルに無く、上の失敗のメッセージになる） |
| 環境 | `PS1=\W% `・`PATH=/sbin:/usr/sbin:/bin:/usr/bin`・`TERM=linux`・root・`HOME=/root`・`tty` は `/dev/ttyS0` |
| ホスト名 | `(none)`（`/etc/hostname` は `buildroot` だが、init スクリプトが動かないので設定されない） |
| ネットワークの初期状態 | `lo` も `eth0` も down、アドレスなし、ルートなし（`/etc/network/interfaces`・`/etc/resolv.conf` も無い） |
| メモリ | `MemTotal` 約 39MB（`memory_size` 64MB のうち）。ルートファイルシステムは initramfs（rootfs、約 15MB） |

## 中身

| 項目 | 内容 |
| --- | --- |
| OS | Buildroot 2024.05.2、Linux 6.8.12（`i686-linux-gcc` 13.2.0 でビルド）、**libc は uClibc-ng 1.0.45** |
| BusyBox | 1.36.1（applet の一覧は下） |
| BusyBox 以外 | ping・ping6・tracepath・clockdiff（**iputils 20240117**）、tcpdump 4.99.4（libpcap 1.10.4）、socat 1.8.0.0、curl 8.7.1、lua 5.4.6、joe（エディタ）、links（テキストブラウザ）、tinysshd、tcping、lsof、tree など |
| ping の出力 | `PING 10.5.0.9 (10.5.0.9) 56(84) bytes of data.` / `64 bytes from …: icmp_seq=1 ttl=64 time=…` / `2 packets transmitted, 2 received, 0% packet loss, time 1004ms`（iputils の形式。v86-link の e2e と学習の手順はこれに合わせている） |
| `traceroute` | BusyBox 版 |
| 無いもの | iptables・nft・VLAN（8021q）・iproute2・tc・ブリッジ・dnsmasq・udhcpd・httpd・nc・nmap・ssh サーバー（tinysshd はある）・ebtables |

BusyBox の applet（`busybox --list`）: `[ [[ addgroup adduser ar arch arp arping ascii ash awk base32 base64 basename bc blkid bunzip2 bzcat cat chattr chgrp chmod chown chroot chrt chvt cksum clear cmp cp cpio crc32 crond crontab cut date dc dd deallocvt delgroup deluser devmem df diff dirname dmesg dnsd dnsdomainname dos2unix du dumpkmap echo egrep eject env ether-wake expr factor fallocate false fbset fdflush fdformat fdisk fgrep find flock fold free freeramdisk fsck fsfreeze fstrim fuser getopt getty grep gunzip gzip halt hdparm head hexdump hexedit hostid hostname hwclock i2cdetect i2cdump i2cget i2cset i2ctransfer id ifconfig ifdown ifup inetd init insmod install ip ipaddr ipcrm ipcs iplink ipneigh iproute iprule iptunnel kill killall killall5 klogd last less link linux32 linux64 linuxrc ln loadfont loadkmap logger login logname losetup ls lsattr lsmod lsof lspci lsscsi lsusb lzcat lzma lzopcat makedevs md5sum mdev mesg microcom mim mkdir mkdosfs mke2fs mkfifo mknod mkpasswd mkswap mktemp modprobe more mount mountpoint mt mv nameif netstat nice nl nohup nologin nproc nslookup nuke od openvt partprobe passwd paste patch pidof ping pipe_progress pivot_root poweroff printenv printf ps pwd rdate readlink readprofile realpath reboot renice reset resize resume rm rmdir rmmod route run-init run-parts runlevel sed seedrng seq setarch setconsole setfattr setkeycodes setlogcons setpriv setserial setsid sh sha1sum sha256sum sha3sum sha512sum shred sleep sort start-stop-daemon strings stty su sulogin svc svok swapoff swapon switch_root sync sysctl syslogd tail tar tee telnet test tftp time top touch tr traceroute tree true truncate ts tsort tty ubirename udhcpc uevent umount uname uniq unix2dos unlink unlzma unlzop unxz unzip uptime usleep uudecode uuencode vconfig vi vlock w watch watchdog wc wget which who whoami xargs xxd xz xzcat yes zcat`

## Buildroot で作り直すイメージで合わせること

- `/etc/inittab`・`/etc/profile`・`/etc/profile.d/umask.sh`・`/etc/fstab` は、上の内容と同じものを置く（`images/build/buildroot/board/v86net/rootfs-overlay/`）
- カーネルは VT と VGA コンソールを入れ、`console=` を指定しない（カーネルのメッセージをシリアルに出さない。コンソールのシェルは tty0 に出る）
- BusyBox の `FEATURE_EDITING_ASK_TERMINAL` は無効（Buildroot の既定でも無効。明示する）
- ping は iputils、libc は uClibc-ng（Buildroot の既定）
- lua・joe・links・tinysshd などの、v86-link で使っていないものは、最初は入れない（必要になったら足す）

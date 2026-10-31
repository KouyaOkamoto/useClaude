#!/bin/sh
# ルートファイルシステムの仕上げ（オーバーレイのあとに動く）
set -eu
TARGET_DIR="$1"
# いまのイメージと同じく、init スクリプト（rcS）は動かさない（inittab に sysinit が無い）。ファイルは残す
# ビルドの版を残す（/etc/v86net-release）
{
  echo "V86NET_BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "V86NET_LIBC=${V86NET_LIBC:-unknown}"
  echo "V86NET_COMPRESS=${V86NET_COMPRESS:-unknown}"
} > "$TARGET_DIR/etc/v86net-release"

# initramfs はメモリ（64MB）に展開されるので、大きくて使わないものを外す（docs/buildroot-image.md）
#  - nmap のデータのうち、OS の判定（-O）・バージョンの判定（-sV）・MAC のベンダー名の表（計 約 9MB）。
#    ポートのスキャン（-sT・-sS・-p）に要る nmap-services は残す
#    （全部入れると rootfs が 26MB になり、64MB では initramfs の展開中にメモリが尽きて panic した）
#    nmap-service-probes（-sV、2.5MB）も外す: 残すと rootfs が 18.5MB になり、64MB では起動しなかった。
#    initramfs の展開先の rootfs は tmpfs で、大きさの上限が RAM の半分（約 18MB）のため（run 41215726840。
#    panic の時点の shmem 18144kB = managed 36292kB の半分。空きのメモリはまだ 15MB あった）
rm -f "$TARGET_DIR/usr/share/nmap/nmap-os-db" "$TARGET_DIR/usr/share/nmap/nmap-service-probes" \
      "$TARGET_DIR/usr/share/nmap/nmap-mac-prefixes"
#  - 使わないテスト用のプログラム
rm -f "$TARGET_DIR/usr/bin/pcre2test" "$TARGET_DIR/usr/bin/pcre2grep"
#  - iproute2 のうち、学習で使わないもの（RDMA・TIPC・DCB・devlink）
rm -f "$TARGET_DIR/sbin/rdma" "$TARGET_DIR/sbin/tipc" "$TARGET_DIR/sbin/dcb" "$TARGET_DIR/sbin/devlink" "$TARGET_DIR/sbin/vdpa"

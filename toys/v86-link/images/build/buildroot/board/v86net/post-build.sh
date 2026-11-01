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
  echo "V86NET_VARIANT=${V86NET_VARIANT:-}"
} > "$TARGET_DIR/etc/v86net-release"

# initramfs はメモリ（64MB）に展開されるので、大きくて使わないものを外す（docs/buildroot-image.md）
#  - nmap のデータのうち、OS の判定（-O）・バージョンの判定（-sV）・MAC のベンダー名の表（計 約 9MB）。
#    ポートのスキャン（-sT・-sS・-p）に要る nmap-services は残す
#    （全部入れると rootfs が 26MB になる。rootfs が tmpfs だったときは、64MB では展開中に上限（RAM の半分）を超えて panic した）
#    nmap-service-probes（-sV、2.5MB）も外す（rootfs は RAM に常駐するので、空きのメモリがその分減る）。
#    残せるかの判断のため、測定用の派生（V86NET_VARIANT=sv、公開しない）だけ残す
#    （経緯: rootfs が tmpfs だったときは、残すと上限（RAM の半分）を超えて起動しなかった。いまは ramfs）
rm -f "$TARGET_DIR/usr/share/nmap/nmap-os-db" "$TARGET_DIR/usr/share/nmap/nmap-mac-prefixes"
[ "${V86NET_VARIANT:-}" = sv ] || rm -f "$TARGET_DIR/usr/share/nmap/nmap-service-probes"
#  - 使わないテスト用のプログラム
rm -f "$TARGET_DIR/usr/bin/pcre2test" "$TARGET_DIR/usr/bin/pcre2grep"
#  - iproute2 のうち、学習で使わないもの（RDMA・TIPC・DCB・devlink）
rm -f "$TARGET_DIR/sbin/rdma" "$TARGET_DIR/sbin/tipc" "$TARGET_DIR/sbin/dcb" "$TARGET_DIR/sbin/devlink" "$TARGET_DIR/sbin/vdpa"

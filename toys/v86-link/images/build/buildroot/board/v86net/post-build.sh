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

#!/bin/bash
# v86-link のゲスト Linux を Buildroot で作る。
#
#   images/build/build.sh                 # 既定: uClibc-ng・xz
#   V86_LIBC=musl V86_COMPRESS=gzip images/build/build.sh
#
# 環境変数
#   WORK        作業ディレクトリ（Buildroot の展開先と出力。既定 ./work。大きくなる: 5〜10GB）
#   BR2_DL_DIR  ダウンロードしたソースの置き場（Buildroot の標準。CI ではキャッシュする）
#   V86_LIBC      uclibc（既定。いまのイメージと同じ）/ musl / glibc
#   V86_COMPRESS  xz（既定）/ gzip（カーネルと埋め込みの initramfs の圧縮）
#   （LIBC・COMPRESS という名前にしない。make に環境変数として渡り、host-python3 の Makefile の LIBC などに入り込んでビルドが壊れる）
#   JOBS        並列数（既定 nproc）
#
# 出力（$WORK/dist）
#   bzImage                 v86 にそのまま渡す1ファイル（initramfs 入り）
#   kernel.config           使ったカーネルの設定（全体）
#   buildroot.config        使った Buildroot の設定（全体）
#   legal-info.tar.gz       make legal-info の出力（ソースのアーカイブとライセンスの一覧）
#   build-info.txt          版・サイズ・時間
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$HERE/buildroot

# Buildroot の版（2025.02.x は LTS。サポートは 2028 年 3 月まで。docs/buildroot-image.md）
BR_VERSION=2025.02.19
BR_URL=https://buildroot.org/downloads/buildroot-$BR_VERSION.tar.xz
# 初回のビルドで、配布元の .sign に書かれた値と照合して記録したもの（以後はこれと一致しなければ止める）
BR_SHA256=${BR_SHA256:-}

LIBC=${V86_LIBC:-uclibc}
COMPRESS=${V86_COMPRESS:-xz}
# 以下の LIBC・COMPRESS はこのスクリプトの中だけの変数（export しない）
unset V86_LIBC V86_COMPRESS
JOBS=${JOBS:-$(nproc)}
WORK=${WORK:-$PWD/work}
OUT=$WORK/output-$LIBC-$COMPRESS
DIST=$WORK/dist
export BR2_DL_DIR=${BR2_DL_DIR:-$WORK/dl}
mkdir -p "$WORK" "$DIST" "$BR2_DL_DIR"

log() { echo "== [$(date -u +%H:%M:%S)] $*"; }
T0=$(date +%s)

# ---------------------------------------------------------------- Buildroot の取得と確認
BR=$WORK/buildroot-$BR_VERSION
if [ ! -d "$BR" ]; then
  log "Buildroot $BR_VERSION を取得"
  TARBALL=$BR2_DL_DIR/buildroot-$BR_VERSION.tar.xz
  [ -f "$TARBALL" ] || curl -fsSL -o "$TARBALL" "$BR_URL"
  curl -fsSL -o "$TARBALL.sign" "$BR_URL.sign"
  ACTUAL=$(sha256sum "$TARBALL" | cut -d' ' -f1)
  # 配布元の .sign（PGP で署名されたハッシュの一覧）に書かれた SHA256 と照合する
  SIGNED=$(grep -i -E '^SHA256:' "$TARBALL.sign" | awk '{print $2}' | head -1 || true)
  echo "sha256 (download) = $ACTUAL"
  echo "sha256 (.sign)    = ${SIGNED:-（見つからない）}"
  printf 'buildroot_sha256=%s\nbuildroot_sha256_sign=%s\n' "$ACTUAL" "${SIGNED:-}" > "$DIST/buildroot-tarball.txt"
  if [ -n "$SIGNED" ] && [ "$SIGNED" != "$ACTUAL" ]; then echo "ERROR: .sign の SHA256 と一致しない"; exit 1; fi
  if [ -n "$BR_SHA256" ] && [ "$BR_SHA256" != "$ACTUAL" ]; then echo "ERROR: 記録した SHA256（$BR_SHA256）と一致しない"; exit 1; fi
  if [ -z "$BR_SHA256" ]; then echo "WARNING: BR_SHA256 が未記録。上の値を確かめて build.sh に記録すること"; fi
  tar -xf "$TARBALL" -C "$WORK"
fi

# ---------------------------------------------------------------- 設定
log "設定（libc=$LIBC, 圧縮=$COMPRESS）"
make -C "$BR" O="$OUT" BR2_EXTERNAL="$EXT" v86net_defconfig > /dev/null
case "$LIBC" in
  uclibc) ;;
  musl)  sed -i 's/^BR2_TOOLCHAIN_BUILDROOT_UCLIBC=y/# BR2_TOOLCHAIN_BUILDROOT_UCLIBC is not set\nBR2_TOOLCHAIN_BUILDROOT_MUSL=y/' "$OUT/.config" ;;
  glibc) sed -i 's/^BR2_TOOLCHAIN_BUILDROOT_UCLIBC=y/# BR2_TOOLCHAIN_BUILDROOT_UCLIBC is not set\nBR2_TOOLCHAIN_BUILDROOT_GLIBC=y/' "$OUT/.config" ;;
  *) echo "LIBC は uclibc / musl / glibc"; exit 1 ;;
esac
make -C "$BR" O="$OUT" olddefconfig > /dev/null
grep -E '^BR2_TOOLCHAIN_BUILDROOT_(UCLIBC|MUSL|GLIBC)=y' "$OUT/.config"

# ---------------------------------------------------------------- カーネルの設定（tinyconfig + 断片）
# Buildroot の defconfig の方式では tinyconfig を土台にできないので、ここで Buildroot が取得したカーネルのソースから作る
log "カーネルを取得・展開"
make -C "$BR" O="$OUT" linux-extract
KSRC=$(ls -d "$OUT"/build/linux-[0-9]* | head -1)
KGEN=$OUT/kconfig-gen
rm -rf "$KGEN"; mkdir -p "$KGEN"
COMP_FRAG=$KGEN/compress.fragment
if [ "$COMPRESS" = xz ]; then
  printf 'CONFIG_KERNEL_XZ=y\nCONFIG_RD_XZ=y\nCONFIG_INITRAMFS_COMPRESSION_XZ=y\n' > "$COMP_FRAG"
else
  printf 'CONFIG_KERNEL_GZIP=y\nCONFIG_RD_GZIP=y\nCONFIG_INITRAMFS_COMPRESSION_GZIP=y\n' > "$COMP_FRAG"
fi
log "カーネルの設定を作る（$(basename "$KSRC")）"
make -s -C "$KSRC" O="$KGEN" ARCH=i386 tinyconfig
"$KSRC/scripts/kconfig/merge_config.sh" -m -O "$KGEN" "$KGEN/.config" \
  "$EXT/board/v86net/linux-base.fragment" "$EXT/board/v86net/linux-net.fragment" "$COMP_FRAG" > "$KGEN/merge.log"
make -s -C "$KSRC" O="$KGEN" ARCH=i386 olddefconfig
# 断片で指定したのに入らなかった項目（版で名前が変わったものなど）を残す
grep -E 'Value requested|not in final' "$KGEN/merge.log" > "$DIST/kernel-config-warnings-$LIBC-$COMPRESS.txt" || true
cp "$KGEN/.config" "$OUT/v86net-kernel.config"

# ---------------------------------------------------------------- ビルド
log "ビルド（-j$JOBS）"
TB=$(date +%s)
export V86NET_LIBC=$LIBC V86NET_COMPRESS=$COMPRESS   # post-build.sh が /etc/v86net-release に書く
# ログは全部ファイルへ、画面にはパッケージごとの進み具合（>>> の行）だけ出す
set +e +o pipefail
make -C "$BR" O="$OUT" -j"$JOBS" 2>&1 | tee "$OUT/build.log" | grep --line-buffered -E '^>>> '
RC=${PIPESTATUS[0]}
set -e -o pipefail
if [ "$RC" -ne 0 ]; then
  echo "ERROR: ビルドに失敗（終了コード $RC）。ログの最後:"
  tail -120 "$OUT/build.log"
  cp "$OUT/build.log" "$DIST/build-$LIBC-$COMPRESS.log"
  exit "$RC"
fi
TBUILD=$(( $(date +%s) - TB ))

log "legal-info"
make -C "$BR" O="$OUT" legal-info > /dev/null
tar -czf "$DIST/legal-info-$LIBC-$COMPRESS.tar.gz" -C "$OUT" legal-info

# ---------------------------------------------------------------- 成果物
cp "$OUT/images/bzImage" "$DIST/bzImage-$LIBC-$COMPRESS"
cp "$OUT/v86net-kernel.config" "$DIST/kernel-$LIBC-$COMPRESS.config"
cp "$OUT/.config" "$DIST/buildroot-$LIBC-$COMPRESS.config"
ROOTFS_BYTES=$(du -sb "$OUT/target" | cut -f1)
CPIO_BYTES=$(stat -c %s "$OUT/images/rootfs.cpio" 2>/dev/null || echo 0)
KVER=$(basename "$KSRC" | sed 's/^linux-//')
cat > "$DIST/build-info-$LIBC-$COMPRESS.txt" <<EOF
buildroot=$BR_VERSION
kernel=$KVER
libc=$LIBC
compress=$COMPRESS
bzimage_bytes=$(stat -c %s "$OUT/images/bzImage")
rootfs_target_bytes=$ROOTFS_BYTES
rootfs_cpio_bytes=$CPIO_BYTES
build_seconds=$TBUILD
total_seconds=$(( $(date +%s) - T0 ))
EOF
cat "$DIST/build-info-$LIBC-$COMPRESS.txt"
log "完了"

#!/bin/sh
# e2e.cjs で使うものをそろえる（コミットしない）
#   - Transformers.js・ONNX Runtime Web・小さなテスト用モデル: ../../tinyswallow-chat/test/setup.sh
#   - 本物の Qwen3 4B のトークナイザ（チャットテンプレートの確認用。モデル本体はダウンロードしない）
set -eu
cd "$(dirname "$0")"
sh ../../tinyswallow-chat/test/setup.sh
mkdir -p .cache/qwen3
for f in config.json generation_config.json tokenizer.json tokenizer_config.json; do
  [ -s ".cache/qwen3/$f" ] || curl -sSL --retry 3 -o ".cache/qwen3/$f" "https://huggingface.co/onnx-community/Qwen3-4B-ONNX/resolve/main/$f"
done
echo "ok: $(pwd)/.cache"

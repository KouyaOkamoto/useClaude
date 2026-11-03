#!/bin/sh
# e2e.cjs で使うものを test/.cache/ にそろえる（コミットしない。.gitignore 済み）
#   - Transformers.js と ONNX Runtime Web（ページが CDN から読むのと同じ版を、npm から）
#   - テスト用の小さなモデル（make-tiny-model.py。重みはランダム）
# 必要なもの: npm、python3（onnx・tokenizers・numpy。無ければ venv を作って入れる）
set -eu
cd "$(dirname "$0")"
mkdir -p .cache && cd .cache
TJS=4.3.2
# Transformers.js 4.3.2 の dist が読む onnxruntime-web の版（dist の中に書かれている）
ORT=1.31.0-dev.20260914-8d85527a0
if [ ! -d transformers ]; then
  npm pack -q "@huggingface/transformers@$TJS" >/dev/null
  mkdir -p transformers && tar xzf "huggingface-transformers-$TJS.tgz" -C transformers && rm "huggingface-transformers-$TJS.tgz"
fi
if [ ! -d ort ]; then
  npm pack -q "onnxruntime-web@$ORT" >/dev/null
  mkdir -p ort && tar xzf "onnxruntime-web-$ORT.tgz" -C ort && rm "onnxruntime-web-$ORT.tgz"
fi
if [ ! -d tiny-model ]; then
  PY=python3
  if ! $PY -c "import onnx, tokenizers, numpy" 2>/dev/null; then
    [ -x venv/bin/python ] || python3 -m venv venv
    ./venv/bin/python -c "import onnx, tokenizers, numpy" 2>/dev/null || ./venv/bin/pip install -q onnx tokenizers numpy
    PY=./venv/bin/python
  fi
  $PY ../make-tiny-model.py tiny-model
fi
echo "ok: $(pwd)"

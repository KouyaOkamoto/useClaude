#!/bin/sh
# Rust のソースから life.wasm を作り直す
# 必要なもの: rustup target add wasm32-unknown-unknown
set -eu
cd "$(dirname "$0")/rust"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/life.wasm ../life.wasm
ls -l ../life.wasm

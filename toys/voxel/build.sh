#!/bin/sh
# Rust のソースから world.wasm を作り直す
# 必要なもの: rustup target add wasm32-unknown-unknown
set -eu
cd "$(dirname "$0")/rust"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/world.wasm ../world.wasm
ls -l ../world.wasm

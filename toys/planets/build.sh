#!/bin/sh
# Rust のソースから terrain.wasm を作り直す
# 必要なもの: rustup target add wasm32-unknown-unknown
set -eu
cd "$(dirname "$0")/rust"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/terrain.wasm ../terrain.wasm
ls -l ../terrain.wasm

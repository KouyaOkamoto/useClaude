# useClaude
Claude Practice

Claude Code で小さな Web おもちゃ（静的サイト）を量産するリポジトリです。GitHub Pages で公開します。

## 構成

```
index.html        おもちゃの一覧ページ
toys/<name>/      おもちゃ1つにつき1ディレクトリ（中に index.html）
.nojekyll         GitHub Pages で Jekyll 処理を無効化
```

## おもちゃの追加手順

1. `toys/<name>/index.html` を作る（HTML/CSS/JS のみ、ビルド不要）
2. `index.html` の `TOYS` 配列に1行追加する

```js
{ path: "toys/<name>/", title: "タイトル", description: "説明文" },
```

## WebAssembly を使うおもちゃ

Rust のソースと、変換済みの `.wasm` の両方をコミットする（GitHub Pages ではビルドしない）。
Rust を直したら各おもちゃの `build.sh` で `.wasm` を作り直してからコミットする。

```sh
rustup target add wasm32-unknown-unknown   # 初回のみ
toys/particles/build.sh
```

## ローカル確認

```sh
python3 -m http.server 8000
# http://localhost:8000/ を開く
```

## 公開

GitHub の Settings → Pages で「Deploy from a branch」→ `main` / `/ (root)` を選択。

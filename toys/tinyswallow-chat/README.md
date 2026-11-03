# TinySwallow チャット（ブラウザ内 LLM）

日本語の小さな言語モデル [TinySwallow-1.5B-Instruct](https://huggingface.co/SakanaAI/TinySwallow-1.5B-Instruct) の ONNX 版
（既定は `onnx-community/TinySwallow-1.5B-Instruct-ONNX`）を、[Transformers.js](https://github.com/huggingface/transformers.js) で
**ブラウザの中で**動かすチャット。返答はトークンごとに少しずつ表示する（ストリーミング）。
WebGPU が使えれば GPU で、使えなければ WebAssembly（CPU）で動く。入力した文章はサーバーに送らない。

## 使い方

1. ページを開くと、使える実行環境（WebGPU・fp16 の対応）を調べて、表示する
2. 「モデルを読み込む」を押す。初回はモデルを Hugging Face からダウンロードする（数百 MB〜1 GB 以上。進み具合をファイルごとに表示）
3. 話しかける。Enter で送信、Shift+Enter で改行（日本語入力の変換を確定する Enter では送らない）。生成中は「停止」で止められる
4. 「設定」で、システムプロンプト・最大トークン数・temperature・top_p・repetition_penalty を変えられる（ブラウザに保存）

ダウンロードしたモデルは、ブラウザの Cache API（`transformers-cache`）に保存され、2回目からはダウンロードしない。
「保存したモデルを削除」で消せる。

## 実行環境と量子化の選び方

| 環境 | 実行 | 量子化（dtype） |
| --- | --- | --- |
| WebGPU が使え、`shader-f16` に対応 | WebGPU | `q4f16`（重み 4bit・計算 fp16） |
| WebGPU が使えるが fp16 に対応していない | WebGPU | `q4`（重み 4bit・計算 fp32） |
| WebGPU が無い | WebAssembly（CPU） | `q4` |
| WebGPU で読み込みに失敗した（メモリ不足など） | WebAssembly（CPU） | `q4`（worker を作り直して読み直す） |

URL で変えられる:

- `?device=wasm` / `?device=webgpu` … 実行環境を指定する
- `?dtype=q4f16|q4|q8|fp16|fp32` … 量子化を指定する（モデルのリポジトリに、その版のファイルがあるものだけ）
- `?model=<owner>/<name>` … 別の Hugging Face のリポジトリ（Transformers.js 用の ONNX があるもの）を使う

## 仕組み

```
index.html / main.js（画面）  ──postMessage──▶  worker.js（Web Worker）
  チャットの表示・入力・設定                       Transformers.js 4.3.2（jsDelivr から）
  textContent だけで表示                          ├ AutoTokenizer / AutoModelForCausalLM（device・dtype）
                              ◀── token・done ──   ├ apply_chat_template（ChatML）
                                                   └ generate（8トークンずつ。KV キャッシュで続ける）
```

- **推論は Web Worker で**動かす。読み込み・生成の間も、画面は固まらない
- **生成は 8 トークンずつ区切る。** `model.generate` は、WebAssembly では最後まで一度もイベントループに戻らないことがあり、
  そのままでは「停止」のメッセージを受け取れなかった（テストで確認）。区切りごとにイベントループに戻り、続きは前の区切りの
  KV キャッシュ（`past_key_values`）から生成する。停止は、押してから最大 8 トークンで効く
- **表示用のストリーマーを自作した**（`ChunkStreamer`）。日本語は 1 文字が複数のトークンにまたがることがあるので、
  UTF-8 の途中で切れた文字（U+FFFD）は、続きのトークンが来るまで表示しない
- **WebGPU の失敗は、worker を作り直して wasm で読み直す。** ONNX Runtime は一度失敗した初期化を覚えていて、
  同じ worker では wasm でも失敗するため（テストで確認）
- 文脈は 4096 トークン（から最大トークン数を引いたもの）まで。超えたら、古いやりとりから除いて答え、そう表示する
- モデルの返答も入力も、`textContent` で表示する（HTML・Markdown として解釈しない）
- 通信するのは、jsDelivr（Transformers.js・ONNX Runtime Web）と Hugging Face（モデル）だけ

## テスト

本物のモデルを使わず、ヘッドレス Chromium で確かめる（`test/e2e.cjs`、27 項目）。
CDN と Hugging Face への通信を Playwright で横取りし、npm から取った同じ版の Transformers.js・ONNX Runtime Web と、
`test/make-tiny-model.py` で作った小さなモデル（Qwen2 と同じ入出力・ChatML のチャットテンプレート・重みはランダム）を返す。

```sh
sh toys/tinyswallow-chat/test/setup.sh        # 初回だけ（test/.cache/ にそろえる。コミットしない）
python3 -m http.server 8000                   # リポジトリのルートで
node toys/tinyswallow-chat/test/e2e.cjs
```

確かめていること: 実行環境の選択（WebGPU が無ければ wasm・q4）/ 読み込みと進み具合 / 保存（2回目はダウンロードしない・削除）/
ストリーミング（少しずつ表示）/ トークン数と速さの表示 / 日本語入力の変換中の Enter では送らない / 会話の続き（前のやりとりを入力に含める）/
停止（押してから 0.1 秒以内に止まる）/ 文脈の切り詰め / HTML を文字として表示 / 設定の保存 / WebGPU を指定して失敗したときに wasm で読み直す /
モデルが見つからないときのエラー / `?model=` の検証 / スマホ幅 / CDN と Hugging Face 以外へ通信しない / ページのエラーが無い。

**確かめられていないこと**（このテストでは分からない）: 本物のモデルの読み込み（ファイル名・大きさ・量子化の版がそろっているか）、
返答の質と速さ、WebGPU での動作（ヘッドレス Chromium に WebGPU のアダプタが無い）、モバイル端末のメモリ。

### 手元のブラウザでの確認のしかた

1. Chrome（WebGPU 対応）でページを開き、右上が「WebGPU・q4f16」（または q4）になっていること
2. 「モデルを読み込む」でダウンロードが進み、「準備ができました」になること（ダウンロードの合計の大きさを控える）
3. 「日本の四季の魅力を、短く教えて」などで、日本語の返答が少しずつ表示され、トークン数・トークン/秒が出ること
4. 長い返答の途中で「停止」を押すと、すぐ止まること。続けて質問すると、前のやりとりを踏まえて答えること
5. ページを再読み込みして「モデルを読み込む」を押すと、ダウンロードせずにすぐ準備できること
6. `?device=wasm` を付けて開くと「WebAssembly（CPU）・q4」になり、遅いが同じように話せること
7. Safari・Firefox など WebGPU が無い（または無効の）ブラウザでは、自動で WebAssembly になること

## 既知の制約

- 初回のダウンロードが大きい（数百 MB〜1 GB 以上）。モバイル回線・ストレージの空きに注意
- WebAssembly（CPU）は遅い（WebGPU の数分の1〜10分の1程度のことがある）。cross-origin isolation（COOP/COEP）を付けていないので、wasm は1スレッドで動く
- メモリの少ない端末（スマホなど）では、読み込めないことがある
- 返答は Markdown として整形しない（そのままの文字で表示する）
- モデルの出力は誤りを含むことがある。モデルのライセンス・利用条件は、モデルのページで確認すること

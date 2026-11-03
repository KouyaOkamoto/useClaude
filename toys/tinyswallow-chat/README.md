# TinySwallow チャット（ブラウザ内 LLM）

日本語の小さな言語モデル [TinySwallow-1.5B-Instruct](https://huggingface.co/SakanaAI/TinySwallow-1.5B-Instruct) の ONNX 版
（既定は `onnx-community/TinySwallow-1.5B-Instruct-ONNX`）を、[Transformers.js](https://github.com/huggingface/transformers.js) で
**ブラウザの中で**動かすチャット。返答はトークンごとに少しずつ表示する（ストリーミング）。
WebGPU が使えれば GPU で、使えなければ WebAssembly（CPU）で動く。入力した文章はサーバーに送らない。

## モデル

| モデル | 既定にする端末 | 大きさ（q4f16 / q4） | 動く環境 | ライセンス |
| --- | --- | --- | --- | --- |
| [TinySwallow 1.5B](https://huggingface.co/onnx-community/TinySwallow-1.5B-Instruct-ONNX)（日本語に特化） | PC | 約 1.2 GB / 1.7 GB | WebGPU・WebAssembly | モデルのページを参照 |
| [Qwen2.5 0.5B Instruct](https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct)（多言語） | スマホ・タブレット | 約 461 MB / 750 MB | WebGPU・WebAssembly | Apache-2.0 |
| [LFM2 350M](https://huggingface.co/onnx-community/LFM2-350M-ONNX)（多言語・いちばん軽い） | （選ぶと使える） | 約 243 MB / 280 MB | **WebGPU だけ** | LFM Open License v1.0 |

- 画面の「モデル」で選べる。選ぶとページを読み直し、選んだものを覚える（`?model=` で指定したときは、そちらが優先）
- **スマホでは TinySwallow 1.5B は動かないことが多い。** iPhone（iOS 26・Chrome）で、本体（1.16 GB）のダウンロード中にページが止められた（診断情報で確認）。
  Transformers.js は、ダウンロードしたファイル全体をメモリに持ち、さらに ONNX Runtime と GPU に載せるので、
  読み込みの間に 2〜3.5 GB 前後を使い、iOS のブラウザの上限を超えると考えられる
- 前回、読み込み・生成の途中でページが終わっていたら（メモリ不足の可能性）、次に開いたときに、ひとつ小さいモデルを選ぶ
- **LFM2 は WebGPU でしか動かない。** LFM2 の ONNX は、どの量子化の版（q4・q4f16・q8）も `GatherBlockQuantized` という演算を使い、
  WebAssembly の ONNX Runtime にはその実装が無い。WebGPU が無いブラウザで選ぶと、読み込まずに知らせる
- 本物のモデルで確かめたこと（この作業環境。WebGPU はソフトウェアの SwiftShader）: Qwen2.5 0.5B は WebAssembly・q4 で、LFM2 350M は WebGPU・q4 で、
  読み込み → 日本語の会話まで通る。どちらも、TinySwallow より日本語の答えの質は低い

## 使い方

1. ページを開くと、使える実行環境（WebGPU・fp16 の対応）を調べて、表示する
2. 「モデルを読み込む」を押す。初回はモデルを Hugging Face からダウンロードする（数百 MB〜1 GB 以上。進み具合をファイルごとに表示）
3. 話しかける。Enter で送信、Shift+Enter で改行（日本語入力の変換を確定する Enter では送らない）。生成中は「停止」で止められる
4. 「設定」で、システムプロンプト・最大トークン数・temperature・top_p・repetition_penalty を変えられる（ブラウザに保存）

ダウンロードしたモデルは、ブラウザの Cache API（`transformers-cache`）に保存され、2回目からはダウンロードしない。
「保存したモデルを削除」で消せる。

### うまく動かないとき（診断情報）

スマホなど、開発者ツール（コンソール）が使えない環境でも、どこで止まったかを画面で確かめられる。

- 画面下の「診断情報」に、端末（User-Agent・メモリ・CPU）・WebGPU と fp16 の有無・保存領域・試す順番と、
  読み込み・ウォームアップ・生成の各段階が時刻つきで記録される。「診断情報をコピー」でコピーできる（入力した文章は含まない）
- 読み込みの各段階には経過時間を出し、60 秒以上 worker から知らせが無ければ「端末のメモリが足りないと、ここで止まることがある」と出す
- 記録はブラウザ（localStorage）にも残す。読み込み・生成の途中でページが終わった（メモリ不足でブラウザに止められた・再読み込みされた）ときは、
  次に開いたときに「前回は『…』の途中で終わっていました」と知らせ、前回の記録を出す
- スマホ・タブレットやメモリの少ない端末（`deviceMemory` が 4 GB 以下）では、読み込む前に、モデルがメモリに収まらないことがあると注意を出す

## 実行環境と量子化の選び方

| 環境 | 実行 | 量子化（dtype） |
| --- | --- | --- |
| WebGPU が使え、`shader-f16` に対応 | WebGPU | `q4f16`（重み 4bit・計算 fp16） |
| WebGPU が使えるが fp16 に対応していない | WebGPU | `q4`（重み 4bit・計算 fp32） |
| WebGPU が無い | WebAssembly（CPU） | `q4` |

読み込み（ウォームアップの生成を含む）に失敗したら、worker を作り直して、次の組み合わせで自動で読み直す:
**WebGPU・q4f16 → WebGPU・q4 → WebAssembly・q4**。WebAssembly では `q4f16` を使わない（下の「わかったこと」）。

ダウンロードの大きさ（モデルのリポジトリの値）: `q4f16` 約 1.2 GB、`q4` 約 1.8 GB（どちらも `model_*.onnx` ＋ `model_*.onnx_data`）。

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
- **読み込みの失敗は、worker を作り直して次の組み合わせで読み直す。** ONNX Runtime は一度失敗した初期化を覚えていて、
  同じ worker では別の組み合わせでも失敗するため（テストで確認）
- **ウォームアップで、チャットと同じ使い方を一度通す**（会話の入力をまとめて読む → KV キャッシュで数トークン → そのキャッシュから続ける）。
  量子化の版の不具合（下）を、読み込みの時点で見つけて、別の版に切り替えるため
- 最初の語が出るまでは「入力を読んでいます… N 秒」と経過時間を出す（WebAssembly では数十秒かかることがある）
- 文脈は 4096 トークン（から最大トークン数を引いたもの）まで。超えたら、古いやりとりから除いて答え、そう表示する
- モデルの返答も入力も、`textContent` で表示する（HTML・Markdown として解釈しない）
- 通信するのは、jsDelivr（Transformers.js・ONNX Runtime Web）と Hugging Face（モデル）だけ

## わかったこと（本物のモデルで確認）

- **`q4f16` は、CPU（WebAssembly）では2つめのトークンから失敗する。** 入力をまとめて読む1回目は通るが、KV キャッシュを使う次の実行で
  `Shape mismatch attempting to re-use buffer. {1,1,1536} != {1,32,1536}` になる。ONNX Runtime の Python 版（CPU）でも同じで、
  モデルのファイル（CPU が fp16 の計算のために自動で足す Cast の周り）の問題。メモリの再利用を切っても直らない。
  `q4`（計算は fp32）では起きない。このため、WebAssembly では `q4f16` を使わず、指定されても、ウォームアップで失敗して `q4` に切り替わる
- 本物の `q4` で、WebAssembly・WebGPU（ソフトウェアの SwiftShader）とも、読み込み → 会話（日本語の返答のストリーミング）まで通ることを確かめた。
  この作業環境は遅い（WebAssembly 1スレッドで 0.2 トークン/秒、最初の語まで約 7.5 秒）。8トークンずつの区切りを外しても速さは同じだった
- WebGPU の `q4f16`（fp16 対応の GPU）は、この作業環境では確かめられない（GPU が無い）

## テスト

本物のモデルを使わず、ヘッドレス Chromium で確かめる（`test/e2e.cjs`、39 項目）。
CDN と Hugging Face への通信を Playwright で横取りし、npm から取った同じ版の Transformers.js・ONNX Runtime Web と、
`test/make-tiny-model.py` で作った小さなモデル（Qwen2 と同じ入出力・ChatML のチャットテンプレート・重みはランダム）を返す。

```sh
sh toys/tinyswallow-chat/test/setup.sh        # 初回だけ（test/.cache/ にそろえる。コミットしない）
python3 -m http.server 8000                   # リポジトリのルートで
node toys/tinyswallow-chat/test/e2e.cjs
```

`test/make-shaped-model.py` は、本物の config・トークナイザ・28 層・外部データ・fp16 の KV キャッシュと同じ形で、
重みだけランダムで小さいモデルを作る（本物をダウンロードせずに、読み込み・生成の不具合を切り分けるため）。

確かめていること: 実行環境の選択（WebGPU が無ければ wasm・q4）/ 読み込みと進み具合 / 保存（2回目はダウンロードしない・削除）/
ストリーミング（少しずつ表示）/ トークン数と速さの表示 / 日本語入力の変換中の Enter では送らない / 会話の続き（前のやりとりを入力に含める）/
停止（押してから 0.1 秒以内に止まる）/ 文脈の切り詰め / HTML を文字として表示 / 設定の保存 / WebGPU を指定して失敗したときに wasm で読み直す / q4f16 で読み込めないときに q4 で読み直す / 診断情報の記録とコピー / 前回の途中終了の知らせ / スマホでのメモリの注意 / モデルの既定（PC・スマホ）と選び直し / 途中終了のあとに小さいモデルを選ぶ / WebGPU だけのモデルの扱い /
モデルが見つからないときのエラー / `?model=` の検証 / スマホ幅 / CDN と Hugging Face 以外へ通信しない / ページのエラーが無い。

**このテストでは分からないこと**: 返答の質と速さ、GPU での WebGPU（とくに `q4f16`）、モバイル端末のメモリ
（本物のモデルでの確認は、上の「わかったこと」）。

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

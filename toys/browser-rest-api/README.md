# ブラウザ内 REST API

サーバーなしで REST API を動かす最小デモ。
Service Worker が `api/*` への `fetch` を横取りして JSON を返し、データは IndexedDB に保存する。
依存ライブラリ・ビルドなし（静的ファイル4つだけ）。

```
fetch('api/todos')  →  Service Worker (sw.js)  →  IndexedDB
                          └ ルーティング / バリデーション / ステータスコード
```

## 動かす

```bash
# リポジトリのルートで
python3 -m http.server 8000      # または npx serve
# http://localhost:8000/toys/browser-rest-api/ を開く
```

`localhost` と `https` なら Service Worker が使える。`file://` では動かない。
GitHub Pages などにはこのディレクトリをそのまま置けばよい（サブパスでも動く）。
COOP/COEP ヘッダは不要。

## エンドポイント

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `api/health` | 稼働確認 |
| GET | `api/todos?done=true\|false&q=文字` | 一覧（絞り込み） |
| POST | `api/todos` | 作成 → 201 + `Location` |
| GET | `api/todos/:id` | 取得 / 404 |
| PUT | `api/todos/:id` | 全置換（`title` 必須） |
| PATCH | `api/todos/:id` | 部分更新 |
| DELETE | `api/todos/:id` | 削除 → 204 |
| POST | `api/_reset` | サンプルデータで初期化 |

不正入力は 400、未定義ルートは 404、許可されないメソッドは 405 (`Allow` ヘッダ付き)。

## テスト

API本体は `Request -> Response` の純粋関数なので Node で検証できる。

```bash
node --test test/api.test.mjs
```

## 仕様上の注意

- APIは **そのブラウザの中にだけ** 存在する。curl や他端末からは叩けない。データも端末ごとに別
- ユーザーが閲覧データを消すと、IndexedDB のデータも消える
- 強制リロード (Shift+リロード) 中はSWを経由しないので、一度通常リロードする
- `sw.js` を更新したら、DevTools の Application > Service Workers で反映を確認する

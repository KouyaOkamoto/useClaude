# ブラウザ内 Spring Boot REST API（Service Worker × CheerpJ）

`fetch('api/todos')` に、ブラウザの中で動く **Spring Boot（Spring MVC）** が答えるデモ。
[browser-rest-api](../browser-rest-api/) の「Service Worker が API を横取りする」仕組みと、
[spring-on-cheerpj](../spring-on-cheerpj/) の「CheerpJ（ブラウザ内 JVM）上の Spring」をつないだもの。
バックエンドの実体が、JS から Spring に替わっている。

## 構成

```
 ページ（このタブ）                         Service Worker (sw.js)
 ┌──────────────────────────┐              ┌──────────────────────────┐
 │ Todo UI / APIコンソール   │ fetch(api/*) │ api/* だけ横取り           │
 │   fetch('api/todos') ────┼─────────────▶│  ↓ 宛先のタブを選ぶ        │
 │                          │              │  （ready を通知した1つ）    │
 │ バックエンド役             │ postMessage  │                          │
 │   CheerpJ (Java 11)  ◀───┼──────────────┤  MessageChannel で転送     │
 │   Bridge.dispatch()      │              │                          │
 │     ↓                    │              │                          │
 │   Spring MVC             │  {status,    │  ↓ Response に戻す         │
 │   DispatcherServlet ─────┼─ headers, ──▶│  （Location も書き換え）    │
 │   TodoController         │   body}      │                          │
 └──────────────────────────┘              └──────────────────────────┘
```

- CheerpJ はページ（window）側で動かす。Service Worker の中では動かさない
- ページは起動が終わると Service Worker に `backend-ready` を知らせる
- 複数のタブを開いても、宛先は先に ready を知らせたタブ1つに絞る（タブごとに Spring とデータが別のため、途中で切り替えない）。
  そのタブが閉じられたら、残っている ready のタブへ移る
- Service Worker は止まると覚えていた宛先を忘れるので、そのときは `clients.matchAll` で各タブに状態を聞き直して選ぶ
- Spring 側の入口は `demo.Bridge`：
  - `start()`：Spring Boot + MVC を起動する
  - `dispatch(method, pathWithQuery, body)`：リクエスト1件を `DispatcherServlet` に流し、
    `{"status":200,"headers":{…},"body":"…"}` の JSON を返す。例外は 500 とその内容で返す
- サーバーを立てずに Spring MVC を動かす仕組み（Tomcat の代わりの「何もしない WebServer」と `MockServletContext`）は spring-on-cheerpj と同じ

## 起動中に来たリクエスト: 待たせる（最大60秒）→ 超えたら 503

起動中のタブがあるとき、Service Worker はリクエストを **最大60秒待たせ、起動が終わったら Spring に渡す**。
60秒を超えたら `503` + `Retry-After: 15` を返す。

この形にした理由:

- **ページを開いた直後の自然なリクエストが、そのまま成功する。** 起動は数十秒で終わるので、
  待ってもらえば呼び出し側（Todo UI など）に再試行の仕組みがいらない。503 をすぐ返す方式だと、
  クライアントがみな Retry-After を読んで再送する作りになる
- **60秒は、起動にかかる時間（実測 15〜40秒）に余裕を持たせた長さ。** これより長く待たせると、
  遅い端末で本当に詰まったときに、いつまでも返事がないように見える
- **待っても ready にならないときは、待たずに 503 を返す。** 起動に失敗したタブや、
  Spring を動かしているタブが無いとき（閉じた、まだ開いていない）は、待つ意味がないのですぐに返す

| 状況 | 応答 |
| --- | --- |
| ready のタブがある | Spring が答える |
| 起動中のタブがある | 最大60秒待って Spring が答える。超えたら 503（`reason: "timeout"`） |
| 起動中のタブも無い（失敗した・タブが無い） | すぐに 503（`reason: "none"`） |
| 宛先のタブが30秒以内に答えない | 504 |

## 動かす

CheerpJ は jar を **HTTP の Range リクエスト**で少しずつ読むので、Range に対応したサーバーが必要。
Python の `http.server` は非対応で、「CheerpJ cannot run」で止まる。GitHub Pages は対応している。

```bash
# リポジトリのルートで
npx http-server -p 8080
# http://localhost:8080/toys/spring-sw-bridge/ を開く
```

`localhost` と `https` なら Service Worker が使える。`file://` では動かない。
ページを開くと Spring の起動が自動で始まる。

jar のパスは既定で `/app` + このページのURLパス + `probe.jar`（CheerpJ の `/app/` はサーバーのルートを指すので、
GitHub Pages のサブパスでもそのまま読める）。`?jar=/app/…/probe.jar` で上書きできる。

## ビルド

JDK 11 以上と Maven 3.6 以上が必要。このフォルダで実行すると、テストのあと `probe.jar` が作り直される。

```bash
mvn -q package
```

GitHub Pages で配信するため、ビルド済みの `probe.jar`（約18MB）をリポジトリに入れている（spring-on-cheerpj と同じ方式）。
ソースを変えたら `probe.jar` もあわせてコミットする。

## テスト

```bash
# API の仕様（browser-rest-api の test/api.test.mjs と同じ内容）を通常の JVM で確かめる
mvn test

# ブラウザでの通し確認（playwright が必要。上の http-server を起動しておく）
node test/e2e.cjs http://localhost:8080/toys/spring-sw-bridge/
```

## エンドポイント

browser-rest-api と同じ仕様。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `api/health` | 稼働確認（`runtime: "spring-boot"`、`vm: "CheerpJ"`） |
| GET | `api/todos?done=true\|false&q=文字` | 一覧（絞り込み） |
| POST | `api/todos` | 作成 → 201 + `Location` |
| GET | `api/todos/:id` | 取得 / 404 |
| PUT | `api/todos/:id` | 全置換（`title` 必須） |
| PATCH | `api/todos/:id` | 部分更新 |
| DELETE | `api/todos/:id` | 削除 → 204 |
| POST | `api/_reset` | サンプルデータで初期化（id は 1 から） |

不正入力は 400、未定義ルートは 404、許可されないメソッドは 405 (`Allow` ヘッダ付き)。
Spring が答えた応答には `x-served-by: spring-boot (CheerpJ)` が付く。

## 既知の制約

- **起動に 15〜40秒ほどかかる。** ランタイムの読み込み・約18MBの jar の読み込み・Spring の初期化。
  ヘッドレス Chromium での実測は、ランタイム 1.3秒 + jar 11.7秒 + Spring 24.2秒
- **API は、Spring を動かしているタブを開いている間だけ生きている。** タブを閉じると、
  ほかに ready のタブが無ければ 503 になる。curl や他の端末からは叩けない
- **データはメモリ上にだけある。** リロードやタブを閉じると消える。タブごとに別の Spring なので、
  宛先のタブが替わると、見えるデータも替わる（永続化は次の段階）
- jar やランタイムの段階で起動に失敗すると、同じページでは CheerpJ を使い直せない
  （ライブラリはページごとに1回しか読めない）。そのため再試行はページの読み込み直しになる。
  Spring の初期化で失敗したときは、同じページのまま再試行できる
- 強制リロード (Shift+リロード) 中は Service Worker を経由しないので、一度通常リロードする

## ファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` / `main.js` / `style.css` | 画面。CheerpJ の起動、転送されてきたリクエストの処理、Todo UI と API コンソール |
| `sw.js` | `api/*` を横取りして、Spring を動かしているタブへ転送する Service Worker |
| `probe.jar` | ビルド済みの jar |
| `src/main/java/demo/Bridge.java` | 本番用の入口（`start` / `dispatch`） |
| `src/main/java/demo/TodoController.java` / `ApiErrors.java` | Todo API と、ルーティングのエラーを JSON にする処理 |
| `src/main/java/demo/Probe.java` | 起動の仕組み（spring-on-cheerpj から引き継いだ検証用の入口 level0〜3 も残している） |
| `src/test/java/demo/BridgeTest.java` / `test/e2e.cjs` | テスト |

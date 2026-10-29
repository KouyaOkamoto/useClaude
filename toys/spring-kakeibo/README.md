# 家計簿（ブラウザ内 Spring Boot + H2）

ブラウザの中で動く **Spring Boot + Spring Data JPA + H2** をバックエンドにした家計簿。
[spring-sw-bridge](../spring-sw-bridge/)（Service Worker → CheerpJ 上の Spring MVC）を土台に、DB と永続化を足した。
**データは一切ブラウザの外に出ない。** サーバーもアカウントも無く、保存先はこのブラウザの中（IndexedDB）だけ。

段階ごとの検証（Stage A〜D）の記録は [docs/results.md](docs/results.md) にある。検証用のページは [lab.html](lab.html)。

## 構成

```
 ページ（このタブ）                                    Service Worker (sw.js)
 ┌───────────────────────────────────┐              ┌───────────────────────────┐
 │ 家計簿の画面（main.js）              │ fetch(api/*) │ api/* だけ横取りして、       │
 │   fetch('api/summary?month=…') ────┼─────────────▶│ Spring が動いているタブへ     │
 │                                    │              │ MessageChannel で転送        │
 │ CheerpJ（ブラウザ内 JVM・Java 11）   │ postMessage  │                            │
 │   Bridge.dispatch() ◀──────────────┼──────────────┤                            │
 │     ↓                              │              │                            │
 │   Spring MVC（DispatcherServlet）   │              │                            │
 │   KakeiboController / Service       │  {status,    │ Response に戻す              │
 │   Spring Data JPA（Hibernate 5.6）  │ ─ headers, ─▶│ （Location も書き換え）       │
 │   H2（インメモリ）                   │   body}      │                            │
 │     ↕ 書き込みが確定するたびに SCRIPT TO / 起動時に RUNSCRIPT FROM                 │
 │   /files/kakeibo/dump.sql（CheerpJ の永続領域。中身は IndexedDB）                  │
 └───────────────────────────────────┘              └───────────────────────────┘
```

- **永続化は「インメモリ H2 + SQL ダンプ」**（Stage B で選んだ）。H2 のファイルモードは、CheerpJ の `/files/` では
  ファイルを閉じるまで中身が保存されず、リロードでデータが消えた。そこで H2 はメモリで動かし、
  書き込みが確定するたびに DB 全体を `SCRIPT TO` で `/files/kakeibo/dump.sql` に書く（一時ファイルに書いてから置き換える）。
  起動したら `RUNSCRIPT FROM` で戻す
- **JPA を採用**（Stage C）。起動を短くする設定（lazy-initialization、open-in-view=false、ddl-auto=none、
  SimpleDriverDataSource など）は、効果を測って選んだ。jar から Tomcat を外した
- **Spring を動かすのは1つのタブだけ**（Web Locks）。どのタブも同じダンプから戻して書き戻すので、
  2つのタブで動かすと古い中身で新しいデータを上書きしてしまう。2つ目以降のタブは Spring を起動せず、
  Service Worker 経由で1つ目のタブの Spring を使う。1つ目のタブを閉じると、残ったタブが引き継いで起動する
- 起動中に来たリクエストは、spring-sw-bridge と同じく **最大60秒待たせ、超えたら 503 + Retry-After**
- 外への通信は **CheerpJ のローダーとランタイム（`cjrtnc.leaningtech.com`）だけ**。
  CDN・分析・フォントなどは使っていない。家計簿のデータが送られることはない

## 結果（ヘッドレス Chromium 141 / CheerpJ 4.3）

詳しくは [docs/results.md](docs/results.md)。この環境は CPU が遅く、spring-sw-bridge の起動が
ここでは約37秒・依頼者の環境では約12秒だった。時間はおよそ 1/3 にして読むとよい。

| Stage | 内容 | 結果 | 判断 |
| --- | --- | --- | --- |
| A | H2（インメモリ）+ JdbcTemplate | 動く。初回の処理 5.3s、以降のクエリ 50〜90ms | |
| B | 永続化（`/files/`） | ファイルモードは閉じるまで保存されず、リロードで消える。ダンプ方式は残る | **インメモリ + SQL ダンプ方式を採用** |
| C | Spring Data JPA | 動く。Spring の初期化が JdbcTemplate より約 +9秒（この環境）。短縮で −7秒 | **JPA を採用**（換算で約 13〜17秒、目安の40秒未満） |
| D | 家計簿アプリ | 下の表 | |

Stage D（この jar、35.8MB）:

| 項目 | 初回（キャッシュなし） | 2回目（再読込） |
| --- | --- | --- |
| ランタイム | 1.6s | 0.1s |
| jar 読込 | 10.5s | 11.5s |
| Spring・DB 初期化（保存データの復元を含む） | 42.9s | 44.2s |
| 起動後の最初のリクエスト | 約0.9s | 約0.9s |
| 以降のリクエスト | 中央値 約130ms | |
| 永続化 | **できる**（リロード後も取引・カテゴリがそのまま残る） | |

## 動かす

CheerpJ は jar を **HTTP の Range リクエスト**で少しずつ読むので、Range に対応したサーバーが必要。
Python の `http.server` は非対応で、「CheerpJ cannot run」で止まる。GitHub Pages は対応している。

```bash
# リポジトリのルートで
npx http-server -p 8080
# http://localhost:8080/toys/spring-kakeibo/ を開く
```

`localhost` と `https` なら Service Worker が使える。`file://` では動かない。ページを開くと Spring の起動が自動で始まる。
初めて開いたときは、初期カテゴリ（食費・日用品・交通費・給与など）だけが入った空の家計簿になる。
「サンプルデータで初期化」で、今月と先月の取引が入る。

## ビルドとテスト

JDK 11 以上と Maven 3.6 以上が必要。このフォルダで実行すると、テストのあと `probe.jar` が作り直される。

```bash
mvn -q package        # テスト（通常の JVM）+ jar（probe.jar）
mvn test              # テストだけ

# ブラウザでの通し確認（playwright が必要。上の http-server を起動しておく）
node test/e2e.cjs http://localhost:8080/toys/spring-kakeibo/
```

- `KakeiboApiTest`（MockMvc、16件）: カテゴリと取引の CRUD とバリデーション、絞り込み、集計、CSV の書き出し・取り込み・
  往復、**途中で DB が失敗したときのロールバック**（テスト用の H2 トリガーで、取り込みの3件目・_reset の挿入を失敗させる）、
  再起動後にダンプから戻ること、バックアップと復元、危険な SQL を含む復元を断ること、壊れたダンプからの起動
- `test/e2e.cjs`: ブラウザ（CheerpJ 上）で、画面の操作・リロード後の永続化・バックアップ → データ消去 → 復元・
  2つのタブの引き継ぎ・Service Worker 経由であること・外への通信先・スマホ幅を確かめる

GitHub Pages で配信するため、ビルド済みの `probe.jar`（35.8MB）をリポジトリに入れている（spring-on-cheerpj・spring-sw-bridge と同じ方式）。
ソースを変えたら `probe.jar` もあわせてコミットする。

## API

すべて `api/` 配下。エラーは `{"error": "...", "message": "..."}`。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `api/health` | 稼働確認と、保存データの状態（`persistence`） |
| GET / POST | `api/categories` | 一覧（支出 → 収入、件数つき） / 作成 `{name, type: INCOME\|EXPENSE}` → 201 |
| GET / PUT / DELETE | `api/categories/{id}` | 取得 / 更新 / 削除 → 204。取引で使っているカテゴリの削除は **409** |
| GET / POST | `api/transactions?from=&to=&categoryId=&q=` | 一覧（新しい順。q はメモとカテゴリ名を検索） / 作成 `{date, amount, categoryId, memo}` → 201 |
| GET / PUT / DELETE | `api/transactions/{id}` | 取得 / 全置換 / 削除 → 204 |
| GET | `api/summary?month=yyyy-MM` | 収入合計・支出合計・収支、カテゴリ別の合計（多い順） |
| GET | `api/export.csv` | 取引の CSV（UTF-8・BOM 付き・CRLF） |
| POST | `api/import` | CSV の取り込み |
| GET | `api/backup.sql` | DB 全体の SQL ダンプ（バックアップ） |
| POST | `api/restore` | バックアップから復元 |
| POST | `api/_reset` | サンプルデータで初期化 |

- 金額は円の整数（1〜9,999,999,999）。`1.5` や `"100"` は 400。日付は `yyyy-MM-dd`（`2026-02-30` などは 400）
- カテゴリ名はユニーク（重複は 409）、1〜50文字。メモは200文字まで
- 存在しない ID は 404、許可されないメソッドは 405（`Allow` ヘッダ付き）

### CSV の取り込み: 1行でも問題があれば、全体を取り込まない

列は「日付,種別,カテゴリ,金額,メモ」（1行目は見出し。書き出しと同じ形）。種別は「収入」「支出」。
知らないカテゴリは、種別の列に従って作る。金額の `1,500` のようなカンマは取り除く。

**問題のある行が1つでもあれば、何も取り込まず、問題のある行をすべて行番号つきで返す。** 理由:

- 部分的に取り込むと、直したファイルをもう一度取り込んだときに、先に入った行が二重になる。
  全体を無効にすれば、直して同じファイルを取り込み直すだけでよい
- どこまで入ったかを利用者が確かめなくてよい
- 家計簿の CSV は、ほかのアプリや Excel から作ることが多く、列のずれなどは全体に及びやすい

取り込みは1つのトランザクションで行うので、確かめたあとに DB 側で失敗しても、途中まで入った状態は残らない（テストで確認）。

### バックアップと復元

「バックアップを保存」で DB 全体の SQL ダンプ（`kakeibo-backup-日付.sql`）をダウンロードする。
ブラウザのデータを消すと家計簿も消えるので、それに備えるためのもの。

復元では、SQL をいきなり本番の DB には流さない。

1. H2 の `SCRIPT` が書き出す種類の文（`CREATE TABLE`・`INSERT INTO` など）だけかを確かめる。
   `CALL`・`CREATE ALIAS`・`FILE_READ` などのファイルの読み書きや Java の呼び出しを含むものは断る
2. 別のインメモリ DB で最後まで実行でき、家計簿の表がそろっているかを確かめる
3. 問題がなければ入れ替えて、ダンプに保存する。入れ替えに失敗したら、元のデータに戻す

## 既知の制約

- **起動に時間がかかる。** この環境で、初回は合計約55秒（ランタイム + jar + Spring・DB 初期化）。
  依頼者の環境に換算すると約18秒の見込み。起動中のリクエストは最大60秒待たせるので、
  この環境ほど遅い端末では、初回の起動中に送ったリクエストが 503 になることがある（再読込で直る）
- **API は、Spring を動かしているタブを開いている間だけ生きている。** タブを全部閉じると止まる。
  curl や他の端末からは叩けない
- **ブラウザのデータを消すと、家計簿も消える。** 保存先はこのブラウザの IndexedDB だけなので、
  ときどきバックアップを保存しておく。端末やブラウザをまたいで共有もできない
- 書き込みのたびに DB 全体をダンプする。3000行（数年分）でダンプ 0.25〜0.7秒、起動時の復元 約4秒（Stage B）
- 強制リロード (Shift+リロード) 中は Service Worker を経由しないので、一度通常リロードする
- jar やランタイムの段階で起動に失敗すると、同じページでは CheerpJ を使い直せないため、再試行はページの読み込み直しになる

## ファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` / `main.js` / `style.css` | 家計簿の画面。CheerpJ の起動、転送されてきたリクエストの処理 |
| `sw.js` | `api/*` を横取りして、Spring を動かしているタブへ転送する Service Worker（spring-sw-bridge と同じ） |
| `probe.jar` | ビルド済みの jar |
| `src/main/java/demo/Bridge.java` | 本番用の入口（`start` / `dispatch`） |
| `src/main/java/demo/kakeibo/` | 家計簿（設定・エンティティ・リポジトリ・サービス・コントローラ・永続化・CSV） |
| `src/main/resources/kakeibo-schema.sql` | スキーマ（初めて起動したときだけ使う） |
| `src/main/java/demo/Lab.java` / `LabBoot.java` / `lab/` | Stage A〜C の検証用（`lab.html` から呼ぶ） |
| `src/test/java/demo/kakeibo/` / `test/e2e.cjs` | テスト |
| `docs/results.md` | Stage A〜D の検証結果と判断 |

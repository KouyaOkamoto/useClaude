# 検証結果（Stage A〜D）

ブラウザ内 JVM（CheerpJ 4.3 / Java 11）の上で、DB（H2）と Spring Data JPA がどこまで動くかを段階的に確かめた記録。

## 測り方

- ブラウザ: ヘッドレス Chromium 141（Playwright）。サーバー: `npx http-server`（Range 対応）
- 「初回」は新しいブラウザ（キャッシュなし）で開いたとき、「2回目」は同じブラウザでページを読み込み直したとき
- 検証ページ `lab.html` から `demo.Lab` の static メソッドを呼ぶ。`OK <ms>ms` は Java の中で測った時間、
  `wall` は JS から呼んで返るまでの時間（CheerpJ がクラスを読み込む時間を含む）
- **この環境は CPU が遅い。** 同じ spring-sw-bridge の起動（ランタイム+jar+Spring 初期化）が、ここでは約37秒、
  依頼者の環境では約12秒だった。時間の絶対値はおよそ 1/3 にして読むとよい

## Stage A: H2（インメモリ）+ JdbcTemplate

Spring Boot は起動せず、`SimpleDriverDataSource` + `JdbcTemplate` だけで H2 を開く。
家計簿と同じ形の表（category / tx）を作り、50行を INSERT して、JOIN + GROUP BY で集計する。

| 項目 | 初回 | 2回目（再読込） | 参考: 通常の JVM |
| --- | --- | --- | --- |
| jar サイズ | 21.9MB（spring-sw-bridge の 18.4MB + H2・spring-jdbc・HikariCP） | | |
| ランタイム | 1.5s | 0.1s | - |
| jar 読込 | 8.7s | 3.7s | - |
| 最初の処理（H2 を開く・表を作る・50行 INSERT・集計） | 5.3s（wall 9.8s） | 4.4s（wall 7.7s） | 356ms |
| 　うち H2 を開く | 3.3s | 2.4s | 232ms |
| 　うち 50行 INSERT | 1.4s | 1.3s | 78ms |
| 以降の集計クエリ（JOIN + GROUP BY） | 47〜91ms | 80ms | 6ms |
| 永続化 | 対象外（インメモリ） | | |

**結果: 動く。** スキーマ作成・INSERT・SELECT・GROUP BY の結果は通常の JVM と同じ。
初回はクラスの読み込みで数秒かかるが、2回目以降のクエリは数十ms。

## Stage B: 永続化（CheerpJ の `/files/`）

`/files/` は CheerpJ の永続領域（中身はブラウザの IndexedDB に保存される）。
接続はアプリと同じく開きっぱなしにして、1行書き込む → ページを読み込み直す → 残っているかを数えた。

### H2 のファイルモード（`jdbc:h2:/files/kakeibo-lab/<名前>`）

| URL オプション | 閉じずに再読込（直後） | 閉じずに再読込（5秒待つ） | `CHECKPOINT SYNC` 後に再読込 | `SHUTDOWN` で閉じてから再読込 |
| --- | --- | --- | --- | --- |
| なし（既定） | **消える**（0行。ファイル 0 bytes） | **消える** | **消える**（0 bytes） | 残る |
| `FILE_LOCK=NO` | **消える** | **消える**（0 bytes） | - | - |
| `FILE_LOCK=NO;WRITE_DELAY=0` | **消える** | **消える**（0 bytes） | - | - |

- H2 は開ける・読み書きできる（DB を開くのに約3秒）。ロックファイルが残っていても開き直せた
- しかし **ファイルを閉じるまで、中身が IndexedDB に保存されない**（再読込後のファイルサイズが 0 bytes）。
  `FILE_LOCK=NO` も `WRITE_DELAY=0` も、`CHECKPOINT SYNC`（中で `FileChannel.force` を呼ぶ）も効かなかった。
  CheerpJ の `/files/` は、ファイルを閉じたときに IndexedDB へ書き出す作りと思われる
- 書くたびに `SHUTDOWN` して開き直せば残るが、開き直しに毎回約3秒かかるので使えない

### 代替案: インメモリ + SQL ダンプ（`SCRIPT TO` / `RUNSCRIPT FROM`）

H2 はインメモリで動かす。書き込みのたびに `SCRIPT TO` で `/files/` に SQL ダンプを書き、JVM の起動時に `RUNSCRIPT FROM` で戻す。
ダンプは一時ファイル `dump.sql.tmp` に書いてから `dump.sql` に置き換える（書きかけで元のダンプを壊さないため。CheerpJ でも rename は動いた）。

| 項目 | 初回 | 2回目（再読込） |
| --- | --- | --- |
| jar サイズ | 21.9MB（Stage A と同じ） | |
| ランタイム / jar 読込 | 1.7s / 8.5〜9.2s | 0.1s / 3.6〜3.7s |
| 1行書いてダンプ（数行のとき） | 278ms（wall 8.5s。H2 を開く時間を含む） | 252ms |
| 3000行足してダンプ（276KB） | INSERT 4.6s + ダンプ 734ms | - |
| 1行書いてダンプ（3000行あるとき） | - | 252ms（wall 0.6s） |
| 起動時の復元（3000行・276KB） | - | 3.7s（wall 8.1〜8.6s） |
| 永続化 | **できる**。直後に再読込しても、書いた行がすべて残る（1→2→3行、3001→3002行） | |

**判断: ダンプ復元方式を採用する。** ファイルモードは閉じない限り何も保存されないため。
ダンプ方式なら、書き込みが返った時点で `/files/` に保存が済んでいる。
欠点は、書き込みのたびに全体を書き出すこと（3000行で約0.25〜0.7秒）と、起動時の復元（3000行で約4秒）。
家計簿の規模（月に数十〜百件）なら数年分でもこの程度に収まる。

## Stage C: Spring Data JPA（Hibernate 5.6）

同じ jar（39.7MB。JPA を足して +17.8MB）で、Spring Boot + MVC + H2（インメモリ）を構成を変えて起動した。
`jdbc` は JPA の自動構成を外して JdbcTemplate だけ、`jpa` は Spring Data JPA（エンティティ1つ・リポジトリ1つ）。
クラスの読み込みが時間の大部分なので、1つのページ（JVM）では1つの構成だけ起動した。
「リクエスト」は `GET /lab/categories`（JdbcTemplate または JPA リポジトリで読み書き）を DispatcherServlet に流したもの。
**各構成1回ずつの計測**で、同じ構成でも ±2秒ほどはぶれる（jdbc の2回目と3回目の比較などから）。

### JdbcTemplate と JPA

| 構成 | 回 | ランタイム | jar 読込 | Spring 初期化（`app.run` / wall） | 合計 | 最初のリクエスト | 以降 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jdbc | 初回 | 1.4s | 9.7s | 28.1s / 35.0s | 46.1s | 1.1s | 31〜41ms |
| jdbc | 2回目 | 0.1s | 3.9s | 23.8s / 28.9s | 32.9s | 0.9s | 45ms |
| jpa | 初回 | 1.5s | 9.0s | 37.1s / 43.2s | 53.7s | 2.7s | 40〜159ms |
| jpa | 2回目 | 0.2s | 7.8s | 33.5s / 37.5s | 45.5s | 2.6s | 43〜100ms |

- JPA は動く（エンティティの保存・派生クエリ `findByTypeOrderByNameAsc` とも通常の JVM と同じ結果）
- JPA にすると Spring の初期化が約 +9秒（+30〜40%）、最初のリクエストが約 +1.7秒。通常の JVM では +1.4秒（2.1s → 3.5s）
- jar の読込時間は、21.9MB（Stage A）と 39.7MB でほぼ変わらない（初回 8.7〜9.7s）。CheerpJ は Range リクエストで必要な部分だけ読むため

### 起動短縮の候補（jpa、2回目の状態で1つずつ足した）

| 候補 | Spring 初期化（`app.run`） | 素の jpa（33.5s）との差 | 最初のリクエスト | 採否 |
| --- | --- | --- | --- | --- |
| `spring.main.lazy-initialization=true` | 29.1s | **−4.4s** | 3.0s | 採用 |
| `spring.jpa.open-in-view=false` | 31.2s | **−2.3s** | 3.1s | 採用（ビューを描かない API なので不要） |
| `ddl-auto=none` + schema.sql | 30.5s | **−3.0s** | 3.1s | 採用（ダンプ復元方式でもスキーマは自分で持つ必要がある） |
| `hibernate.temp.use_jdbc_metadata_defaults=false` + 方言指定 | 32.5s | −1.0s | 3.0s | 採用（差は小さいが副作用なし） |
| `SimpleDriverDataSource`（Hikari を使わない） | 31.4s | **−2.1s** | 2.6s | 採用（1人で使うインメモリ DB なのでプールは不要） |
| Hikari のプールを1本に | 35.0s | +1.5s（ぶれの範囲） | 2.9s | 不採用（効果なし。上で Hikari 自体を外す） |
| 不要な自動構成の除外（9個） | 33.5s | ±0 | 3.0s | 不採用（Bean は 198→159 に減るが時間は変わらない） |
| **組み合わせ**（lazy + osiv + meta + simpleds + 除外） | **26.4s**（wall 33.9s） | **−7.1s** | 2.8s | |

組み合わせの合計（2回目）: ランタイム 0.1s + jar 4.1s + Spring 33.9s（wall）= **38.1s**、最初のリクエスト 2.8s。
同じ短縮をした jdbc（lazy + simpleds + 除外）は Spring 17.7s（wall 27.3s）、最初のリクエスト 2.9s。

### jar から Tomcat・WebSocket を外す

`spring-boot-starter-tomcat` を外し、`javax.servlet-api` だけを入れると **39.7MB → 35.7MB**（−4MB）。
通常の JVM でテストと JPA の起動が通ることを確認した。サーバーを立てない構成なので Tomcat は使っていない。
上のとおり jar の大きさは読込時間にほとんど効かないので、時間ではなくリポジトリに置く jar を小さくするために採用する（Stage D で確認）。

### 判断: JPA を採用する

- 依頼の目安は「合計（ランタイム + jar + Spring 初期化）が約40秒を超えたら JPA をやめる」。
  **この環境は CPU が遅く、JdbcTemplate でも初回は 46秒かかる**ので、生の数字ではなく依頼者の環境に換算して判断した。
  spring-sw-bridge の起動がこの環境で約37秒・依頼者の環境で約12秒なので、およそ 1/3 として、
  JPA（短縮あり）は **初回 約17秒・2回目 約13秒** の見込みで、40秒を大きく下回る
- JdbcTemplate との差は、短縮後で Spring 初期化が約 +6秒（この環境）。依頼者の環境なら約 +2秒の見込み
- 採用する短縮: lazy-initialization、open-in-view=false、ddl-auto=none（schema.sql）、use_jdbc_metadata_defaults=false、
  SimpleDriverDataSource、jar から Tomcat を外す

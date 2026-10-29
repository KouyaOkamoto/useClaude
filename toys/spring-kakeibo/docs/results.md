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

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

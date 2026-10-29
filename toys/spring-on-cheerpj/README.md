# Spring on CheerpJ 検証キット

ブラウザ内JVM（CheerpJ）の上で Spring Boot がどこまで動くかを、段階ごとに切り分けて調べる。
画面で「CheerpJ起動 + jar読込」→「Level 0〜3 を順に実行」。最後に「ログをコピー」で結果をそのまま貼れる。

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` / `main.js` | 検証ページ。CheerpJ を起動し、jar の static メソッドを呼ぶ |
| `probe.jar` | ビルド済みの jar（約18MB）。GitHub Pages でそのまま配信するためリポジトリに入れている |
| `src/` / `pom.xml` | jar のソース（Spring Boot 2.7 + Java 11） |

## ビルド

JDK 11 以上と Maven 3.6 以上が必要。このフォルダで実行すると `probe.jar` が作り直される。

```bash
mvn -q package
```

ソースを変えたら、`probe.jar` もあわせてコミットする。

## 手元で動かす

CheerpJ は jar を **HTTP の Range リクエスト**で少しずつ読むので、Range に対応したサーバーが必要。
Python の `http.server` は Range に対応しておらず、「CheerpJ cannot run」で止まる。GitHub Pages は対応している。

```bash
# リポジトリのルートで
npx http-server -p 8080
# http://localhost:8080/toys/spring-on-cheerpj/ を開く
```

jar のパスは既定で `/app` + このページのURLパス + `probe.jar`（CheerpJ の `/app/` はサーバーのルートを指す）。
見つからない場合は `?jar=/app/…/probe.jar` で上書きできる。

## 段階の意味（失敗した場所が原因の切り分けになる）

| Level | 確かめること | 失敗したら |
| --- | --- | --- |
| 0 | JVM(CheerpJ)上でjarのメソッドが呼べる | jarパス(`/app/…`)、Javaバージョン |
| 1 | Spring DIコンテナ、`@Configuration`のCGLIBプロキシ | 実行時クラス生成が動かない |
| 1b | `@Component` のクラスパススキャン | jar内リソース列挙(`classpath*:`)が動かない |
| 2 | Spring Boot 起動（自動構成・Jackson・ロギング） | `spring.factories`のマージ、リフレクション、起動の重さ |
| 3 | サーバー無しで DispatcherServlet に直接リクエスト | MVC初期化、ServletContext 不在まわり |

Level 3 は、Tomcat の代わりに「何もしない `WebServer`」を差し込み、
`MockHttpServletRequest` を `DispatcherServlet` に直接流す方式（ソケット不要）。
Tomcat が本来用意する ServletContext は `MockServletContext` で代用している（無いと MVC の初期化で `No ServletContext set` になる）。

## 検証結果（ヘッドレス Chromium 141 / CheerpJ 4.3 / Java 11）

すべての Level が OK。

| 項目 | 初回 | 再読込後 | 参考: 通常のJVM |
| --- | --- | --- | --- |
| CheerpJ 起動 | 1.4s | 0.1s | - |
| jar 読込 | 13.8s | 10.2s | - |
| Level 0 | 280ms | 212ms | 12ms |
| Level 1 | 3.7s | 4.0s | 248ms |
| Level 1b | 304ms | 308ms | 24ms |
| Level 2 | 9.7s | 9.8s | 726ms |
| Level 3（初回リクエスト。起動込み） | 6.0s | 6.4s | 663ms |

- Level 3 の起動後は、1リクエスト 15〜200ms 程度（POST→201、GET→200、無いID→404）
- 通常のJVMと比べて、起動まわりは 10〜15倍ほど遅い。ページを開いてからリクエストを受けられるまで 30秒前後

## 補足

- CheerpJ が Java 17 に完全対応していないため、Spring Boot 2.7 + Java 11 を使っている
- Spring Boot が起動する前は Logback の既定設定（DEBUG）で大量のログが出て重くなるので、`logback.xml` で最初から WARN にしている
- このキットは「Spring MVCがブラウザ内JVMで動くか」の確認のみ。
  Service Worker との橋渡し、DB(H2)、永続化は今後の課題

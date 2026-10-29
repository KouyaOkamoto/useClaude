# WebContainers 検証サイト

静的ホスティングだけで「ブラウザ内Node.js」がどこまで動くかを試す最小デモ。
Vite + React のプロジェクトをブラウザ内で `npm install` → `npm run dev` し、エディタ編集がHMRでプレビューに反映される。

ブラウザで開き、「起動する」を押す。

## GitHub Pages で動かすための工夫

このリポジトリはビルドせずに GitHub Pages で配信しているので、元の Vite 構成から次のように変えている。

- **依存は CDN（jsDelivr）から読む**
  - `@webcontainer/api` は importmap で ES モジュールとして読む
  - `@xterm/xterm` と `@xterm/addon-fit` は `<script>` で読み、グローバル変数として使う
- **COOP/COEP ヘッダは Service Worker で付ける**
  - WebContainers は SharedArrayBuffer を使うため、cross-origin isolation が必須
  - GitHub Pages はレスポンスヘッダを設定できないので、[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)（MIT）でレスポンスにヘッダを付け直す
  - 初回アクセス時は Service Worker の登録後に自動で1回再読み込みされる
  - Service Worker の範囲はこのフォルダ（`toys/webcontainers/`）だけで、他の玩具には影響しない

## 手元で試す

Service Worker は `localhost` でも動くので、リポジトリのルートで静的サーバーを立てれば試せる。

```bash
python3 -m http.server 8000
# http://localhost:8000/toys/webcontainers/
```

## 構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面。CDN の読み込みと Service Worker の登録 |
| `main.js` | WebContainer の boot / mount / install / dev server / jsh |
| `template.js` | ブラウザ内に展開する Vite + React プロジェクト（仮想FSの初期内容） |
| `coi-serviceworker.js` | COOP/COEP ヘッダを付ける Service Worker（v0.1.7、そのまま同梱） |

## 検証メモ欄

- [ ] Chrome で起動できるか
- [ ] Firefox / Safari での挙動
- [ ] GitHub Pages + coi-serviceworker で、プレビューの iframe まで表示されるか
- [ ] `npm install` にかかる時間
- [ ] jsh で `node -v` / `ls` / `npm i <pkg>`
- [ ] ネイティブモジュール入りパッケージ（例: `sharp`）の失敗の仕方
- [ ] 外部APIへの `fetch`（CORS）

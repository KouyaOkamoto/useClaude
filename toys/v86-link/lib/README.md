# 同梱しているライブラリ

CDN には頼らず、このフォルダから配信する。

| ファイル | 元 | バージョン | ライセンス |
| --- | --- | --- | --- |
| `v86/libv86.js`・`v86/v86.wasm` | npm パッケージ [`v86`](https://www.npmjs.com/package/v86)（`build/`） | 0.5.472 | BSD-2-Clause（`v86/LICENSE`） |
| `v86/bios/seabios.bin`・`v86/bios/vgabios.bin` | [copy/v86](https://github.com/copy/v86) の `bios/`（SeaBIOS rel-1.16.2 をビルドしたもの。手順は `v86/bios/fetch-and-build-seabios.sh`） | SeaBIOS 1.16.2 | LGPL-3.0（`v86/bios/COPYING.LESSER`）。ソースは https://www.seabios.org/ |
| `xterm/xterm.js`・`xterm/xterm.css` | npm パッケージ [`@xterm/xterm`](https://www.npmjs.com/package/@xterm/xterm) | 5.5.0 | MIT（`xterm/LICENSE`） |
| `xterm/addon-fit.js` | npm パッケージ [`@xterm/addon-fit`](https://www.npmjs.com/package/@xterm/addon-fit) | 0.10.0 | MIT（xterm.js と同じ著作権者・同じライセンス） |

**v86 を入れ替えたら、`snapstore.js` の `V86_VERSION`（いまは `0.5.472`）も同じ版にする。** 保存した起動イメージ（スナップショットの状態。IndexedDB）のキーに入っていて、
版が変わると古いものは使わずに消す（違う版の v86 の状態は、復元できないか、壊れて動くことがある）。v86 の状態の版（`STATE_VERSION`。0.5.472 では 6）が変わったときも合わせる。

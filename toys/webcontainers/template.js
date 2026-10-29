// ブラウザ内の WebContainer に mount する Vite + React プロジェクト
// (このファイル自体はホスト側のサイトの一部。files が仮想FSの初期内容)

const appJsx = [
  "import { useState } from 'react';",
  "",
  "export default function App() {",
  "  const [count, setCount] = useState(0);",
  "",
  "  return (",
  "    <main style={{ fontFamily: 'system-ui', padding: 24 }}>",
  "      <h1>Hello from WebContainers</h1>",
  "      <p>このReactアプリは、ブラウザ内のNode.jsで動くViteが配信しています。</p>",
  "      <button onClick={() => setCount(count + 1)}>count: {count}</button>",
  "      <p style={{ color: '#666' }}>左のエディタでこの文章を書き換えてみてください。</p>",
  "    </main>",
  "  );",
  "}",
  "",
].join("\n");

const mainJsx = [
  "import React from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import App from './App.jsx';",
  "",
  "createRoot(document.getElementById('root')).render(<App />);",
  "",
].join("\n");

const indexHtml = [
  "<!doctype html>",
  '<html lang="ja">',
  "  <head>",
  '    <meta charset="UTF-8" />',
  "    <title>WebContainer App</title>",
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  '    <script type="module" src="/src/main.jsx"></script>',
  "  </body>",
  "</html>",
  "",
].join("\n");

const viteConfig = [
  "import { defineConfig } from 'vite';",
  "import react from '@vitejs/plugin-react';",
  "",
  "export default defineConfig({ plugins: [react()] });",
  "",
].join("\n");

const packageJson = JSON.stringify(
  {
    name: "wc-react-app",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build" },
    dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
    devDependencies: { vite: "^5.4.0", "@vitejs/plugin-react": "^4.3.0" },
  },
  null,
  2
);

// FileSystemTree 形式
export const files = {
  "package.json": { file: { contents: packageJson } },
  "index.html": { file: { contents: indexHtml } },
  "vite.config.js": { file: { contents: viteConfig } },
  src: {
    directory: {
      "main.jsx": { file: { contents: mainJsx } },
      "App.jsx": { file: { contents: appJsx } },
    },
  },
};

// エディタで編集可能にするファイル
export const editable = ["src/App.jsx", "src/main.jsx", "index.html", "package.json"];

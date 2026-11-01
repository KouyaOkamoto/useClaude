// シナリオの文（依頼文・要件・ヒント・解説）の、ごく小さなマークアップ。DOM に依存しない（Node でテストできる）。
//
// 許すのは次だけ。HTML は解釈しない（< や & はただの文字として残る）。
//   段落       空行で区切る。段落の中の改行は、そのまま改行として扱う
//   箇条書き   行の先頭が "- " か "* "
//   コード     ``` の行ではさむ（中身はそのまま）
//   強調       **ことば**
//   コード     `ことば`（行の中）
//
// parseMarkup(text) → ブロックの配列
//   { type: 'p', lines: [インラインの配列, ...] } / { type: 'ul', items: [インラインの配列, ...] } / { type: 'code', text }
//   インライン: { t: 'text' | 'strong' | 'code', v: 文字列 }
// renderMarkup(blocks, document) は、textContent だけで DOM の要素を作る（innerHTML は使わない）

export function parseInline(line) {
  const out = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) out.push({ t: 'text', v: buf }); buf = ''; };
  while (i < line.length) {
    if (line.startsWith('**', i)) {
      const end = line.indexOf('**', i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'strong', v: line.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (line[i] === '`') {
      const end = line.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', v: line.slice(i + 1, end) }); i = end + 1; continue; }
    }
    buf += line[i++];
  }
  flush();
  return out;
}

export function parseMarkup(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = null, list = null, code = null;
  const close = () => { para = null; list = null; };
  for (const line of lines) {
    if (code) {
      if (/^```\s*$/.test(line)) { blocks.push({ type: 'code', text: code.join('\n') }); code = null; }
      else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { close(); code = []; continue; }
    const item = /^[-*] (.*)$/.exec(line);
    if (item) {
      para = null;
      if (!list) { list = { type: 'ul', items: [] }; blocks.push(list); }
      list.items.push(parseInline(item[1]));
      continue;
    }
    if (line.trim() === '') { close(); continue; }
    list = null;
    if (!para) { para = { type: 'p', lines: [] }; blocks.push(para); }
    para.lines.push(parseInline(line));
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') });   // 閉じていないコードは、最後までをコードにする
  return blocks;
}

/** ブロックを DOM の要素にする（textContent だけを使う）。doc は document（テストでは差し替えられる） */
export function renderMarkup(blocks, doc) {
  const frag = doc.createDocumentFragment();
  const inline = (parent, parts) => {
    for (const x of parts) {
      if (x.t === 'text') parent.append(doc.createTextNode(x.v));
      else {
        const e = doc.createElement(x.t === 'strong' ? 'strong' : 'code');
        e.textContent = x.v;
        parent.append(e);
      }
    }
  };
  for (const b of blocks) {
    if (b.type === 'p') {
      const p = doc.createElement('p');
      b.lines.forEach((l, i) => { if (i) p.append(doc.createElement('br')); inline(p, l); });
      frag.append(p);
    } else if (b.type === 'ul') {
      const ul = doc.createElement('ul');
      for (const it of b.items) { const li = doc.createElement('li'); inline(li, it); ul.append(li); }
      frag.append(ul);
    } else if (b.type === 'code') {
      const pre = doc.createElement('pre');
      const c = doc.createElement('code');
      c.textContent = b.text;
      pre.append(c);
      frag.append(pre);
    }
  }
  return frag;
}

/** 文字だけにする（結果の一覧などで使う） */
export const markupToText = (text) => parseMarkup(text).map((b) =>
  b.type === 'code' ? b.text : b.type === 'ul' ? b.items.map((it) => '・' + it.map((x) => x.v).join('')).join('\n') : b.lines.map((l) => l.map((x) => x.v).join('')).join('\n')).join('\n\n');

// 纯文本 / Markdown 解析：按行切段。
export function parseText(buffer, name = '') {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const paragraphs = [];
  const markdown = /\.(md|markdown)$/i.test(name);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = markdown ? line.match(/^(#{1,6})\s+(.*)$/) : null;
    paragraphs.push({
      text: h ? h[2].trim() : line,
      kind: 'paragraph',
      level: h ? h[1].length : 0,
      heading: !!h,
      isToc: false,
    });
  }
  return {
    kind: markdown ? 'markdown' : 'text',
    paragraphs,
    sections: paragraphs.filter((p) => p.heading).map((p, i) => ({index: i, level: p.level, title: p.text, path: [p.text], end: paragraphs.length - 1})),
    imageAnchors: [],
    imageHashes: [],
    comments: [],
    metadata: {},
    text: paragraphs.map((p) => p.text).join('\n'),
    coverage: {body: true, images: 0, ocr: false, fixedPages: false},
    locatorHint: '文本文件定位使用「行号/段落序号」。',
  };
}

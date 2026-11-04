// 旧版 OLE Word (.doc) 正文提取。DOC 没有可靠固定页码，统一使用段落定位。
import {createRequire} from 'node:module';
import {buildSections} from './docx.mjs';

const require = createRequire(import.meta.url);
const WordExtractor = require('word-extractor');

export async function parseDoc(buffer) {
  const doc = await new WordExtractor().extract(buffer);
  const body = String(doc.getBody() || '').replace(/\r\n?/g, '\n');
  const textboxes = String(doc.getTextboxes({includeHeadersAndFooters: false}) || '').replace(/\r\n?/g, '\n');
  const paragraphs = [];
  const add = (content, kind) => {
    for (const raw of content.split('\n')) {
      const text = raw.replace(/[\t\u00a0\u3000]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const heading = /^(?:第[一二三四五六七八九十百]+[部分章节]|\d+(?:\.\d+){0,2}[、.． ]+[^\d])/.test(text) && text.length <= 75;
      paragraphs.push({text, kind, level: heading ? 1 : 0, heading, isToc: /\.{3,}|…{2,}/.test(text)});
    }
  };
  add(body, 'paragraph');
  if (textboxes.trim() && !body.includes(textboxes.trim())) add(textboxes, 'textbox');
  if (!paragraphs.length) throw new Error('旧版 Word 未提取到正文；请提供可复制文字的 PDF 或 DOCX');
  return {
    kind: 'doc', paragraphs, sections: buildSections(paragraphs),
    imageAnchors: [], imageHashes: [], comments: [], metadata: {},
    text: paragraphs.map((p) => p.text).join('\n'),
    coverage: {body: true, images: 0, ocr: false, fixedPages: false},
    locatorHint: '旧版 DOC 可提取文字，定位使用段落序号；图片、签章和固定页码仍需人工核对。',
  };
}

// DOCX 结构化解析：段落、表格、标题层级、图片锚点、文档属性。
// 定位单位是「段落序号」，不伪造页码（DOCX 无固定分页）。
import {readZip} from './zip.mjs';
import {ocrImages} from './ocr.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function decodeXml(s) {
  return String(s)
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<w:cr\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : '';
}

/** 从段落 XML 中取纯文本，跳过已删除修订内容。 */
function paragraphText(pXml) {
  const cleaned = pXml
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
  const parts = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\t)|<w:br\/>/g;
  let m;
  while ((m = re.exec(cleaned))) {
    if (m[1] != null) parts.push(decodeXml(m[1]));
    else if (m[2]) parts.push('\t');
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function headingLevel(pXml) {
  const style = pXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
  const outline = pXml.match(/<w:outlineLvl\s+w:val="(\d+)"/);
  if (outline) return Number(outline[1]) + 1;
  if (style) {
    const name = style[1];
    const m = name.match(/^(?:Heading|heading|标题)\s*(\d)/i) || name.match(/^(\d)/);
    if (m) return Number(m[1]);
    if (/^(Title|标题)$/i.test(name)) return 0;
    if (/TOC|目录/i.test(name)) return 9;
  }
  return 0;
}

function extractDocx(bodyXml, ocrByRelationship = new Map()) {
  const paragraphs = [];
  const counters = new Map();
  const blocks = [];
  const imageAnchors = [];
  const headingStack = [];
  let tableIndex = 0;

  // 按文档顺序遍历顶层 <w:p> 与 <w:tbl>
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>/g;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(bodyXml))) {
    const chunkStart = m.index;
    if (chunkStart > lastEnd) {
      const between = bodyXml.slice(lastEnd, chunkStart);
      // 顶层图片（如悬浮图）也计入锚点
      collectImages(between, -1, paragraphs.length);
    }
    lastEnd = m.index + m[0].length;
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl')) {
      tableIndex++;
      const rows = [];
      const rowRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rm;
      while ((rm = rowRe.exec(chunk))) {
        const cells = [];
        const cellRe = /<w:tc>[\s\S]*?<\/w:tc>/g;
        let cm;
        while ((cm = cellRe.exec(rm[0]))) {
          const cellParas = [];
          const pRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
          let pm;
          while ((pm = pRe.exec(cm[0]))) {
            const t = paragraphText(pm[0]);
            if (t) cellParas.push(t);
          }
          cells.push(cellParas.join(' ').trim());
        }
        rows.push(cells);
      }
      const text = rows.map((r) => r.join(' | ')).join('\n');
      if (text.trim()) {
        paragraphs.push({text, kind: 'table', tableIndex, rowCount: rows.length, colCount: Math.max(0, ...rows.map((r) => r.length))});
        blocks.push({type: 'table', index: paragraphs.length - 1, tableIndex});
      }
      continue;
    }
    // 段落
    const pXml = chunk;
    const text = paragraphText(pXml);
    const level = headingLevel(pXml);
    const isToc = level === 9 || /\.{3,}|\u2026{2,}/.test(text);
    let imgCount = 0;
    // Count image containers once; nested a:blip / v:imagedata tags are not extra pictures.
    const drawRe = /<(?:w:drawing|w:pict)\b/g;
    while (drawRe.exec(pXml)) imgCount++;

    if (text || imgCount) {
      const paraIndex = paragraphs.length;
      paragraphs.push({text, kind: 'paragraph', level: isToc ? 0 : level, isToc, images: imgCount});
      if (imgCount) {
        imageAnchors.push({paraIndex, count: imgCount, label: `段落 ${paraIndex + 1} 图片${imgCount > 1 ? '×' + imgCount : ''}`});
        paragraphs[paraIndex].imageAnchor = true;
        const ids = [...pXml.matchAll(/<(?:a:blip|v:imagedata)\b[^>]*?r:(?:embed|id)="([^"]+)"/g)].map((x) => x[1]);
        const recognized = ids.map((id) => ocrByRelationship.get(id)).filter(Boolean);
        if (recognized.length) paragraphs[paraIndex].ocrText = recognized.join('\n');
      }
      if (level >= 1 && level <= 6 && text && !isToc && text.length <= 60) {
        while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
        headingStack.push({level, title: text, paraIndex});
        paragraphs[paraIndex].heading = true;
      }
      blocks.push({type: 'paragraph', index: paraIndex});
    }
  }
  if (lastEnd < bodyXml.length) collectImages(bodyXml.slice(lastEnd), -1, paragraphs.length);

  function collectImages(xml, paraIdx, fallbackIdx) {
    let n = 0;
    const re2 = /<(?:w:drawing|w:pict|a:blip)\b/g;
    while (re2.exec(xml)) n++;
    if (n) imageAnchors.push({paraIndex: paraIdx < 0 ? fallbackIdx : paraIdx, count: n, label: '浮动图片 ' + n + ' 处'});
  }

  return {paragraphs, blocks, imageAnchors};
}

export async function parseDocx(buffer) {
  const entries = readZip(buffer);
  const docEntry = entries.get('word/document.xml');
  if (!docEntry) throw new Error('DOCX 缺少正文部件 word/document.xml');
  const xml = docEntry.toString('utf8');

  // 富文本结构保留正文主体（去掉 sectPr 之前之外的尾部）
  const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const bodyXml = bodyMatch ? bodyMatch[1] : xml;

  const media = [...entries].filter(([name, data]) => /^word\/media\//.test(name) && data.length);
  const ocr = media.length ? await ocrImages(media) : {results: new Map(), warning: ''};
  const relationships = new Map();
  const relXml = entries.get('word/_rels/document.xml.rels')?.toString('utf8') || '';
  for (const rel of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(rel[0], 'Id');
    const target = attr(rel[0], 'Target').replace(/^\.\.\//, '');
    if (id && target) relationships.set(id, target.startsWith('word/') ? target : `word/${target}`);
  }
  const ocrByRelationship = new Map();
  for (const [id, target] of relationships) {
    const value = ocr.results.get(target);
    if (value?.text?.trim()) ocrByRelationship.set(id, value.text.trim());
  }
  const {paragraphs, blocks, imageAnchors} = extractDocx(bodyXml, ocrByRelationship);
  // Keep original paragraph numbers stable so earlier reports still locate the same source.
  for (const paragraph of paragraphs) {
    if (paragraph.ocrText) paragraph.text = `${paragraph.text}\n[图片OCR，待核对原图] ${paragraph.ocrText}`.trim();
  }

  // 文档属性
  let meta = {};
  const core = entries.get('docProps/core.xml');
  if (core) {
    const c = core.toString('utf8');
    meta = {
      creator: (c.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/) || [])[1] || '',
      lastModifiedBy: (c.match(/<cp:lastModifiedBy>([\s\S]*?)<\/cp:lastModifiedBy>/) || [])[1] || '',
      created: (c.match(/<dcterms:created[^>]*>([\s\S]*?)<\/dcterms:created>/) || [])[1] || '',
      modified: (c.match(/<dcterms:modified[^>]*>([\s\S]*?)<\/dcterms:modified>/) || [])[1] || '',
      title: decodeXml((c.match(/<dc:title>([\s\S]*?)<\/dc:title>/) || [])[1] || ''),
    };
  }
  const app = entries.get('docProps/app.xml');
  if (app) {
    const a = app.toString('utf8');
    meta.pages = Number((a.match(/<Pages>(\d+)<\/Pages>/) || [])[1] || 0) || undefined;
    meta.words = Number((a.match(/<Words>(\d+)<\/Words>/) || [])[1] || 0) || undefined;
  }

  // 图片字节哈希（用于互查图片复用）
  const imageHashes = [];
  for (const [name, data] of entries) {
    if (/^word\/media\//.test(name) && data.length) {
      const {createHash} = await import('node:crypto');
      imageHashes.push({name: name.split('/').pop(), hash: createHash('sha256').update(data).digest('hex'), size: data.length});
    }
  }

  // 批注
  const comments = [];
  const cm = entries.get('word/comments.xml');
  if (cm) {
    const c = cm.toString('utf8');
    const re2 = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
    let x;
    while ((x = re2.exec(c))) {
      const author = attr(x[1], 'w:author');
      const text = paragraphText(x[2]);
      if (text) comments.push({author, text});
    }
  }

  const sections = buildSections(paragraphs);
  const bodyText = paragraphs.map((p) => p.text).filter(Boolean).join('\n');

  return {
    kind: 'docx',
    paragraphs,
    sections,
    imageAnchors,
    imageHashes,
    comments,
    metadata: meta,
    text: bodyText,
    coverage: {body: true, images: imageHashes.length, ocr: ocr.results.size > 0, ocrImages: [...ocr.results.values()].filter((x) => x.text).length, ocrWarning: ocr.warning, fixedPages: false},
    locatorHint: 'DOCX 无固定分页，定位使用「段落序号」；请在 Word 中按段落核对。',
  };
}

/** 用标题段落切分章节树，供证据面板展示所属章节。path 只包含真正的祖先标题链。 */
export function buildSections(paragraphs) {
  const heads = [];
  paragraphs.forEach((p, i) => {
    if (p.heading && p.level <= 4) heads.push({index: i, level: p.level, title: p.text});
  });
  return heads.map((h, k) => {
    let end = paragraphs.length - 1;
    for (let j = k + 1; j < heads.length; j++) {
      if (heads[j].level <= h.level) { end = heads[j].index - 1; break; }
    }
    // 祖先链：向前找最近的、level 更小的标题，逐级回溯
    const path = [h.title];
    let curLevel = h.level;
    for (let j = k - 1; j >= 0; j--) {
      if (heads[j].level < curLevel) {
        path.unshift(heads[j].title);
        curLevel = heads[j].level;
        if (curLevel === 1) break;
      }
    }
    return {...h, end: Math.max(h.index, end), path};
  });
}

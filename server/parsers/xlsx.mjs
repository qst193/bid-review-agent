// XLSX 解析：读取共享字符串与各工作表单元格，输出为表格段落，供报价表/清单参与审核。
// 零依赖，复用 zip 读取。
import {readZip} from './zip.mjs';

function decodeXml(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function colToIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function parseXlsx(buffer) {
  const entries = readZip(buffer);
  // 共享字符串
  const shared = [];
  const sst = entries.get('xl/sharedStrings.xml');
  if (sst) {
    const xml = sst.toString('utf8');
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml))) shared.push(decodeXml(m[1]).replace(/\s+/g, ' ').trim());
  }
  // 工作表名
  const wb = entries.get('xl/workbook.xml');
  const names = [];
  if (wb) {
    const re = /<sheet[^>]*name="([^"]*)"[^>]*\/?>/g;
    let m;
    while ((m = re.exec(wb.toString('utf8')))) names.push(decodeXml(m[1]));
  }
  const paragraphs = [];
  let sheetIdx = 0;
  for (const [name, data] of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const sheetName = names[sheetIdx] || `工作表${sheetIdx + 1}`;
    sheetIdx++;
    const xml = data.toString('utf8');
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    let rowNo = 0;
    paragraphs.push({text: `【工作表】${sheetName}`, kind: 'paragraph', level: 2, heading: true, isToc: false});
    while ((rm = rowRe.exec(xml))) {
      rowNo++;
      const cells = [];
      const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) {
        const attrs = cm[1] || cm[3] || '';
        const body = cm[2] || '';
        const t = (attrs.match(/t="([^"]*)"/) || [])[1] || '';
        const ref = (attrs.match(/r="([^"]*)"/) || [])[1] || '';
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (t === 's' && v != null) val = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') val = decodeXml((body.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
        else if (v != null) val = decodeXml(v);
        val = String(val).trim();
        if (val) cells.push({col: colToIndex(ref), val});
      }
      if (!cells.length) continue;
      cells.sort((a, b) => a.col - b.col);
      // 补齐空列，保持表结构可读
      const maxCol = cells[cells.length - 1].col;
      const arr = new Array(maxCol + 1).fill('');
      for (const c of cells) arr[c.col] = c.val;
      const text = arr.join(' | ').replace(/(\s*\|\s*)+$/, '');
      if (text.trim()) paragraphs.push({text, kind: 'table', level: 0, isToc: false, rowNumber: rowNo, sheet: sheetName});
    }
  }

  const text = paragraphs.map((p) => p.text).filter(Boolean).join('\n');
  return {
    kind: 'xlsx',
    paragraphs,
    sections: paragraphs.filter((p) => p.heading).map((p, i) => ({index: i, level: 2, title: p.text, path: [p.text], end: paragraphs.length - 1})),
    imageAnchors: [],
    imageHashes: [],
    comments: [],
    metadata: {},
    text,
    coverage: {body: true, images: 0, ocr: false, fixedPages: false},
    locatorHint: 'XLSX 按「工作表 · 行」定位；表格内容以 | 分隔列。',
  };
}

// PPTX 解析：抽取每页幻灯片的文本，便于技术方案/宣讲材料参与审核。
export async function parsePptx(buffer) {
  const entries = readZip(buffer);
  const slides = [];
  for (const [name, data] of entries) {
    const m = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (m) slides.push({no: Number(m[1]), xml: data.toString('utf8')});
  }
  slides.sort((a, b) => a.no - b.no);
  const paragraphs = [];
  for (const s of slides) {
    paragraphs.push({text: `【幻灯片 ${s.no}】`, kind: 'paragraph', level: 2, heading: true, isToc: false});
    const re = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = re.exec(s.xml))) {
      const t = decodeXml(m[1]).replace(/\s+/g, ' ').trim();
      if (t) paragraphs.push({text: t, kind: 'paragraph', level: 0, isToc: false, slide: s.no});
    }
  }
  const text = paragraphs.map((p) => p.text).filter(Boolean).join('\n');
  return {
    kind: 'pptx',
    paragraphs,
    sections: paragraphs.filter((p) => p.heading).map((p, i) => ({index: i, level: 2, title: p.text, path: [p.text], end: paragraphs.length - 1})),
    imageAnchors: [],
    imageHashes: [],
    comments: [],
    metadata: {},
    text,
    coverage: {body: true, images: 0, ocr: false, fixedPages: false},
    locatorHint: 'PPTX 按「幻灯片序号」定位。',
  };
}

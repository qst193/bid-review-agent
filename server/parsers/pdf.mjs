// PDF 解析：按页提取文本（真实页码），保留每页行内容以支持证据定位。
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdf.mjs').then((m) => {
      const workerPath = fileURLToPath(new URL('../vendor/pdf.worker.mjs', import.meta.url));
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
      return m;
    });
  }
  return pdfjsPromise;
}

export async function parsePdf(buffer) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const paragraphs = []; // 每行一个段落，带真实页码
  const pages = [];
  const pageCount = Math.min(doc.numPages, 500);
  for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    // 按 y 坐标聚合为行
    const lines = new Map();
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      const key = y;
      const arr = lines.get(key) || [];
      arr.push({x: item.transform[4], str: item.str});
      lines.set(key, arr);
    }
    const sortedY = [...lines.keys()].sort((a, b) => b - a);
    const pageLines = [];
    for (const y of sortedY) {
      const items = lines.get(y).sort((a, b) => a.x - b.x).map((i) => i.str).join('');
      const text = items.replace(/\s+/g, ' ').trim();
      if (text) pageLines.push(text);
    }
    const pageText = pageLines.join('\n');
    pages.push({page: pageNo, text: pageText, lineCount: pageLines.length});
    for (const line of pageLines) {
      paragraphs.push({text: line, kind: 'paragraph', page: pageNo, level: 0, isToc: /\.{4,}/.test(line)});
    }
    page.cleanup();
  }
  await doc.destroy().catch(() => {});

  const normalizedText = pages.map((p) => p.text).join('\n');
  const imageHashes = [];
  // 扫描件判定：全部页几乎无文字
  const scanLikely = pages.length > 0 && pages.every((p) => p.text.replace(/\s/g, '').length < 20);
  try {
    imageHashes.push({name: 'pdf-image-scan', hash: createHash('sha256').update(buffer).digest('hex'), size: buffer.length, scanLikely});
  } catch {}

  const unreadable = scanLikely || normalizedText.replace(/\s/g, '').length < 40;

  return {
    kind: 'pdf',
    paragraphs,
    sections: buildPdfSections(pages),
    imageAnchors: [],
    imageHashes,
    comments: [],
    metadata: {},
    text: normalizedText,
    pages,
    pageCount: pages.length,
    coverage: {body: !scanLikely, images: 0, ocr: false, fixedPages: true},
    locatorHint: unreadable
      ? '该 PDF 未提取到可用文字，疑似扫描件。当前未接入 OCR，不参与文本审核；请在覆盖率中按「未覆盖」处理并人工核对（证书、盖章页、报价单等）。'
      : 'PDF 定位使用真实页码。',
    unreadable,
    unreadableReason: unreadable ? '疑似扫描件，无可提取文字（未接入 OCR）' : null,
  };
}

function buildPdfSections(pages) {
  // 简单按页切章，标题识别留给引擎
  return pages.map((p) => ({index: 0, level: 1, title: `第 ${p.page} 页`, page: p.page, end: 0, path: [`第 ${p.page} 页`]}));
}

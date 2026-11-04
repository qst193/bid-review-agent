// 解析入口：按扩展名/文件头分发，并统一提供「原文引用 → 定位」能力。
// 关注 P0-07：扫描件、图片、办公格式尽量纳入；确实无法解析的给出明确原因与处理建议。
import path from 'node:path';
import {parseDocx} from './docx.mjs';
import {parseDoc} from './doc.mjs';
import {parsePdf} from './pdf.mjs';
import {parseText} from './text.mjs';
import {parseXlsx, parsePptx} from './xlsx.mjs';

export async function parseFile(buffer, name) {
  const ext = path.extname(name || '').toLowerCase();
  // 以文件头为准，兼容误命名为 .docx.doc 的旧版 Word 文件。
  if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    try { return await parseDoc(buffer); } catch (e) { return unreadable('doc', `旧版 Word 解析失败：${e.message}`); }
  }
  if (ext === '.docx' || ext === '.docm') return parseDocx(buffer);
  if (ext === '.doc') {
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return parseDocx(buffer);
    return unreadable('doc', '无法识别旧版 Word 文件头；请检查文件是否损坏');
  }
  if (ext === '.pdf') return parsePdf(buffer);
  if (['.txt', '.md', '.markdown', '.csv'].includes(ext)) return parseText(buffer, name);
  if (ext === '.xlsx' || ext === '.xlsm') {
    try { return await parseXlsx(buffer); } catch (e) { return unreadable('xlsx', `XLSX 解析失败：${e.message}`); }
  }
  if (ext === '.pptx') {
    try { return await parsePptx(buffer); } catch (e) { return unreadable('pptx', `PPTX 解析失败：${e.message}`); }
  }
  if (['.xls', '.ppt'].includes(ext)) {
    return unreadable(ext.slice(1), '旧版二进制 Office 格式无法直接读取正文。请在 Word/Excel/PPT 中「另存为」DOCX/XLSX/PPTX 或导出 PDF 后重新上传，否则该文件不参与审核。');
  }
  if (['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp'].includes(ext)) {
    return unreadable('image', '图片类文件（证书扫描件、盖章页）暂未接入 OCR，正文无法读取。请上传可复制文字的 PDF 或提供文字版材料；该文件会在覆盖率中标记为「未覆盖」，需人工确认。');
  }
  if (ext === '.zip') return unreadable('zip', '压缩包未展开。请解压后逐个上传内部文件，否则包内材料不参与审核。');
  // 未知扩展：按文件头猜测
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    try { return await parseDocx(buffer); } catch {}
    try { return await parseXlsx(buffer); } catch {}
    try { return await parsePptx(buffer); } catch {}
  }
  if (buffer.slice(0, 5).toString() === '%PDF-') return parsePdf(buffer);
  const asText = parseText(buffer, name);
  if (asText.text && asText.text.replace(/\s/g, '').length > 20) return asText;
  return unreadable('unknown', '无法识别文件格式或未提取到可用文字。请转换为 PDF/DOCX 后重新上传。');
}

function unreadable(kind, hint) {
  return {
    kind,
    paragraphs: [],
    sections: [],
    imageAnchors: [],
    imageHashes: [],
    comments: [],
    metadata: {},
    text: '',
    pages: [],
    coverage: {body: false, images: 0, ocr: false, fixedPages: false},
    locatorHint: hint,
    unreadable: true,
    unreadableReason: hint,
  };
}

const normalize = (s) => String(s || '').replace(/[\s\u3000\p{P}\p{S}]/gu, '');

/**
 * 在已解析文档中定位引用文本。
 * 返回 {found, page, paraIndex, section, matched, context, mode}
 * mode: exact（完全一致）/ contains（规范化包含）/ span（跨段拼接）/ partial（仅部分相似）
 */
export function locateQuote(parsed, quote) {
  const q = normalize(quote);
  if (!q || q.length < 4) return {found: false, reason: '引用过短，无法定位'};
  const paras = parsed.paragraphs || [];

  // 1) 精确（规范化后相等）
  for (let i = 0; i < paras.length; i++) {
    if (normalize(paras[i].text) === q) return makeHit(parsed, i, 1, 'exact');
  }
  // 2) 包含
  for (let i = 0; i < paras.length; i++) {
    if (normalize(paras[i].text).includes(q)) return makeHit(parsed, i, 1, 'contains');
  }
  // 3) 跨段拼接
  const joined = paras.map((p, i) => ({i, n: normalize(p.text)}));
  const windowText = joined.map((j) => j.n).join('');
  if (windowText.includes(q)) {
    let acc = '';
    for (const j of joined) {
      const start = acc.length;
      acc += j.n;
      if (acc.includes(q)) {
        const offset = acc.indexOf(q);
        if (offset >= start) return makeHit(parsed, j.i, 1, 'span');
      }
    }
  }
  // 4) 最长公共片段（仅作为弱匹配线索）
  let best = {len: 0, idx: -1};
  for (let i = 0; i < paras.length; i++) {
    const n = normalize(paras[i].text);
    if (!n) continue;
    const l = longestCommon(n, q);
    if (l > best.len) best = {len: l, idx: i};
  }
  if (best.len >= 12 && best.idx >= 0) {
    return {...makeHit(parsed, best.idx, best.len / q.length, 'partial'), partial: true};
  }
  return {found: false, reason: '未在文件中检出该原文片段'};
}

function makeHit(parsed, idx, score, mode) {
  const para = parsed.paragraphs[idx];
  const sections = parsed.sections || [];
  let section = '';
  for (const s of sections) {
    if (s.index <= idx && idx <= (s.end ?? idx)) section = (s.path || [s.title]).join(' › ');
  }
  const context = [];
  for (let k = Math.max(0, idx - 1); k <= Math.min(parsed.paragraphs.length - 1, idx + 1); k++) {
    context.push({paraIndex: k, text: parsed.paragraphs[k].text, active: k === idx});
  }
  return {
    found: true, mode, score: Math.min(1, score),
    page: para.page || null, paraIndex: idx, paraNumber: idx + 1, section,
    quote: para.text, context,
    locatorLabel: para.page ? `第 ${para.page} 页` : (para.sheet ? `${para.sheet} 第 ${para.rowNumber} 行` : (para.slide ? `幻灯片 ${para.slide}` : `段落 ${idx + 1}`)),
  };
}

function longestCommon(a, b) {
  if (!a || !b) return 0;
  let maxLen = 0;
  const bIdx = new Map();
  for (let i = 0; i < b.length - 1; i++) {
    const key = b.slice(i, i + 2);
    if (!bIdx.has(key)) bIdx.set(key, []);
    bIdx.get(key).push(i);
  }
  for (let i = 0; i < a.length - 1; i++) {
    const positions = bIdx.get(a.slice(i, i + 2));
    if (!positions) continue;
    for (const p of positions) {
      let len = 0;
      while (i + len < a.length && p + len < b.length && a[i + len] === b[p + len]) len++;
      if (len > maxLen) maxLen = len;
    }
  }
  return maxLen;
}

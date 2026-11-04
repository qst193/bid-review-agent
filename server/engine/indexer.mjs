// 全文索引与证据检索。
// 核心目标（对应需求 P0-01/P0-02/P0-03）：
//   1) 不再只截取开头文本：对整份文件建立倒排索引，按招标要求检索相关片段；
//   2) 一个投标主体的多份文件合成一个「投标包」，在包内跨文件检索并保留来源文件；
//   3) 模型返回的引用做「精确原文 / 规范化匹配 / 部分相似」三级校验，
//      部分相似只能作为检索线索，不能支撑「已满足 / 可得分」。
import {locateQuote} from '../parsers/index.mjs';

export const norm = (s) => String(s || '').toLowerCase().replace(/[\s\u3000\p{P}\p{S}]/gu, '');

function bigrams(s) {
  const out = [];
  if (s.length < 2) {
    if (s) out.push(s);
    return out;
  }
  for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

function sectionOf(sections, idx) {
  let found = '';
  for (const s of sections || []) {
    if (s.index <= idx && idx <= (s.end ?? idx)) found = (s.path || [s.title]).join(' › ');
  }
  return found;
}

/** 为单个文件建立可检索索引。 */
export function buildIndex(doc) {
  const parsed = doc.parsed || {};
  const paras = [];
  (parsed.paragraphs || []).forEach((p, i) => {
    const text = String(p.text || '').trim();
    const n = norm(text);
    if (n.length < 2) return;
    paras.push({
      i,
      text,
      norm: n,
      page: p.page || null,
      section: sectionOf(parsed.sections, i),
      heading: !!p.heading,
      isToc: !!p.isToc,
      kind: p.kind || 'paragraph',
    });
  });

  const inv = new Map();
  for (const p of paras) {
    const seen = new Set();
    for (const bg of bigrams(p.norm)) {
      if (seen.has(bg)) continue;
      seen.add(bg);
      let arr = inv.get(bg);
      if (!arr) inv.set(bg, (arr = []));
      arr.push(p.i);
    }
  }
  return {
    docId: doc.id,
    fileName: doc.name,
    role: doc.role,
    category: doc.category || null,
    entityId: doc.entityId || null,
    entityName: doc.entityName || '',
    version: doc.version || 'V1',
    parsed,
    paras,
    inv,
    chars: paras.reduce((n, p) => n + p.text.length, 0),
    pageAware: !!parsed.pageCount,
    unreadable: !!parsed.unreadable,
  };
}

export function buildIndexes(docs) {
  return docs.filter((d) => d.parsed).map(buildIndex);
}

/** 从要求文本里提取检索查询串（保留数字、型号、★▲）。 */
export function queryFromRequirement(req) {
  const parts = [req.title || '', req.quote || '', ...(req.checkpoints || [])];
  return parts.join(' ').trim();
}

function digitsIn(s) {
  return (String(s).match(/\d+(?:\.\d+)?/g) || []).filter((x) => x.length >= 2);
}

/**
 * 在若干索引（一个投标包的全部文件）中检索与要求最相关的原文片段。
 * 返回 {hits, context, coveredFiles}
 */
export function retrieve(indexes, query, { topK = 8, maxChars = 6000 } = {}) {
  const usable = indexes.filter((x) => !x.unreadable && x.paras.length);
  if (!usable.length) return { hits: [], context: '', coveredFiles: [] };

  const qNorm = norm(query);
  if (qNorm.length < 2) return { hits: [], context: '', coveredFiles: [] };
  const qSet = new Set(bigrams(qNorm));
  const qDigits = new Set(digitsIn(query));
  const wholeQuote = qNorm.length >= 8 ? qNorm : '';

  const scored = [];
  for (const idx of usable) {
    for (const p of idx.paras) {
      let match = 0;
      let hitList = null;
      for (const bg of qSet) {
        const arr = idx.inv.get(bg);
        if (arr && arr.includes(p.i)) { match++; hitList = arr; }
      }
      if (!match) continue;
      let score = match / Math.sqrt(qSet.size);
      if (qDigits.size) {
        let dh = 0;
        for (const d of qDigits) if (p.norm.includes(d)) dh++;
        if (dh) score += 0.5 + dh * 0.15;
      }
      if (wholeQuote && p.norm.includes(wholeQuote)) score += 1.5;
      if (p.kind === 'table') score += 0.08;
      score /= Math.sqrt(Math.max(4, p.norm.length) / 60 + 1);
      scored.push({ idx, p, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const hits = [];
  for (const s of scored) {
    const near = hits.some((h) => h.fileId === s.idx.docId && Math.abs(h.paraIndex - s.p.i) <= 1);
    if (near) continue;
    hits.push({
      fileId: s.idx.docId,
      fileName: s.idx.fileName,
      role: s.idx.role,
      category: s.idx.category,
      entityName: s.idx.entityName,
      paraIndex: s.p.i,
      page: s.p.page,
      section: s.p.section,
      text: s.p.text,
      score: Number(s.score.toFixed(3)),
      doc: s.idx,
    });
    if (hits.length >= topK) break;
  }

  const byDoc = new Map();
  for (const h of hits) {
    if (!byDoc.has(h.fileId)) byDoc.set(h.fileId, {doc: h.doc, paraIndexes: new Set()});
    const g = byDoc.get(h.fileId);
    const lo = Math.max(0, h.paraIndex - 1);
    const hi = Math.min(h.doc.parsed.paragraphs.length - 1, h.paraIndex + 1);
    for (let k = lo; k <= hi; k++) {
      const pp = h.doc.parsed.paragraphs[k];
      if (pp && String(pp.text || '').trim() && !pp.isToc) g.paraIndexes.add(k);
    }
  }
  const blocks = [];
  let used = 0;
  for (const [, g] of byDoc) {
    const arr = [...g.paraIndexes].sort((a, b) => a - b);
    const lines = [];
    for (const k of arr) {
      const pp = g.doc.parsed.paragraphs[k];
      const mark = pp.page ? `[P${k + 1}|第${pp.page}页]` : `[P${k + 1}]`;
      const line = `${mark} ${pp.text}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) blocks.push(`《${g.doc.fileName}》:\n${lines.join('\n')}`);
    if (used >= maxChars) break;
  }
  return { hits, context: blocks.join('\n\n'), coveredFiles: [...new Set(hits.map((h) => h.fileName))] };
}

/**
 * 校验引用。返回 {found, matchType, quote, locator, weak}
 * matchType: exact（完全一致）/ normalized（去标点空白后一致或包含）/ fuzzy（仅部分相似）
 */
export function verifyEvidence(parsed, quote) {
  const q = String(quote || '').trim();
  if (!q || norm(q).length < 5) return { found: false, reason: '引用为空或过短' };
  const hit = locateQuote(parsed, q);
  if (!hit.found) return { found: false, reason: hit.reason || '原文未检出' };
  const matchType = hit.mode === 'exact' ? 'exact' : hit.mode === 'partial' ? 'fuzzy' : 'normalized';
  const ocrText = parsed.paragraphs?.[hit.paraIndex]?.ocrText || '';
  const fromOcr = Boolean(ocrText && (ocrText.includes(q) || norm(ocrText).includes(norm(q))));
  return {
    found: true,
    matchType: fromOcr ? 'ocr' : matchType,
    weak: fromOcr || matchType === 'fuzzy',
    quote: hit.quote,
    locator: {
      page: hit.page ?? null,
      paraIndex: hit.paraIndex,
      paraNumber: hit.paraNumber,
      section: hit.section || '',
      label: hit.locatorLabel || (hit.page ? `第 ${hit.page} 页` : `段落 ${hit.paraNumber}`),
    },
    context: hit.context,
  };
}

/** 汇总证据等级：只有 exact/normalized 能支撑「已满足 / 可得分」。
 * 兼容两种字段：grade（标准存储字段）与 matchType（verifyEvidence 原始返回）。 */
export function gradeEvidence(list) {
  const gradeOf = (e) => e.grade || e.matchType || (e.weak ? 'fuzzy' : 'none');
  // 只保留「已定位且非弱」的证据参与强证据判定；e.found 缺省视为已定位
  const strong = list.filter((e) => !e.weak && e.found !== false && ['exact', 'normalized'].includes(gradeOf(e)));
  if (strong.some((e) => gradeOf(e) === 'exact')) return 'exact';
  if (strong.length) return 'normalized';
  if (list.length) return 'fuzzy';
  return 'none';
}

// ---- 数值 / 日期等确定性字段比对（P0-03）----
const UNIT_RE = /(\d+(?:\.\d+)?)\s*(%|万元|元|万元人民币|年|个月|月|天|小时|分钟|路|个|次|台|套|人份|人|GB|TB|Gbps|Mbps|万|倍|条|项|页|张)/g;

export function extractFacts(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  const nums = [];
  UNIT_RE.lastIndex = 0;
  let m;
  while ((m = UNIT_RE.exec(s))) {
    nums.push({ value: parseFloat(m[1]), unit: m[2], raw: m[0] });
  }
  const dates = [];
  const dre = /(\d{4})\s*[-年.\/]\s*(\d{1,2})(?:\s*[-月.\/]\s*(\d{1,2}))?/g;
  while ((m = dre.exec(s))) {
    dates.push({ y: +m[1], mo: m[2] ? +m[2] : null, d: m[3] ? +m[3] : null, raw: m[0] });
  }
  return { nums, dates };
}

/**
 * 比对招标要求与投标原文中的数值/日期，返回不一致明细。
 * 只报「明确矛盾」：单位相同而数值不满足上下限约束。
 */
export function compareFacts(requirementText, evidenceText) {
  const q = String(requirementText || '');
  const e = String(evidenceText || '');
  const qF = extractFacts(q);
  const eF = extractFacts(e);
  const issues = [];

  const wantLow = /不低于|不少于|不小于|不得低于|不得少于|至少|≥|>=|以上/.test(q);
  const wantHigh = /不高于|不超过|不大于|不得高于|不得超过|至多|≤|<=|以下/.test(q);
  if ((wantLow || wantHigh) && qF.nums.length && eF.nums.length) {
    const reported = new Set();
    for (const reqNum of qF.nums) {
      const cand = eF.nums.filter((x) => sameUnit(x.unit, reqNum.unit));
      if (!cand.length) continue;
      const best = pickExtreme(cand, wantLow && !wantHigh ? 'max' : wantHigh && !wantLow ? 'min' : 'max');
      let msg = '';
      if (wantLow && !wantHigh && best.value < reqNum.value) msg = `要求不低于 ${reqNum.raw}，投标写明 ${best.raw}`;
      else if (wantHigh && !wantLow && best.value > reqNum.value) msg = `要求不高于 ${reqNum.raw}，投标写明 ${best.raw}`;
      if (msg && !reported.has(msg)) { reported.add(msg); issues.push({type: 'threshold', message: msg}); }
    }
  }
  return issues;
}

function sameUnit(a, b) {
  const map = { 万元人民币: '万元', 元: '元', 万元: '万元', 个月: '月', 月: '月' };
  return (map[a] || a) === (map[b] || b);
}
function pickExtreme(arr, mode) {
  return arr.reduce((acc, x) => (mode === 'max' ? (x.value > acc.value ? x : acc) : x.value < acc.value ? x : acc), arr[0]);
}

/** 否定表述检测：把「不满足 / 不提供 / 无法」等与要求对照。 */
export function detectNegation(text) {
  return /不满足|不能满足|无法满足|不响应|不提供|不具备|不符合|不予|拒绝|无法提供|未能提供|未提供|尚未/.test(String(text || ''));
}

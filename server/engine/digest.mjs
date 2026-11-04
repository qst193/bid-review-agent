// 文档摘要：把解析结果转成带定位标记的文本，供模型引用；并负责校验模型引用是否真实存在。
import {locateQuote} from '../parsers/index.mjs';

/** 生成带 [P序号] 定位标记的文本块（含页码）。 */
export function documentDigest(parsed, {maxChars = 14000, skipToc = true, from = 0} = {}) {
  const lines = [];
  let chars = 0;
  let idx = from;
  for (; idx < parsed.paragraphs.length; idx++) {
    const p = parsed.paragraphs[idx];
    if (skipToc && p.isToc) continue;
    const text = p.text;
    if (!text) continue;
    const mark = p.page ? `[P${idx + 1}|第${p.page}页]` : `[P${idx + 1}]`;
    const line = `${mark} ${text}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return {text: lines.join('\n'), nextIndex: idx, done: idx >= parsed.paragraphs.length};
}

/** 分块产出全文摘要，每块不超过 maxChars。 */
export function chunkedDigest(parsed, {maxChars = 12000} = {}) {
  const chunks = [];
  let from = 0;
  while (from < parsed.paragraphs.length) {
    const d = documentDigest(parsed, {maxChars, from});
    if (!d.text) break;
    chunks.push(d);
    from = d.nextIndex;
    if (d.done) break;
  }
  return chunks;
}

/**
 * 校验模型给出的引用，并补齐定位信息。
 * ref: {fileId, paraIndex?, quote, page?}
 * 返回 {ok, quote, locator:{page,paraIndex,paraNumber,section,locatorLabel}, context}
 */
export function verifyRef(parsed, ref) {
  if (!ref || !ref.quote || String(ref.quote).trim().length < 4) {
    return {ok: false, reason: '引用为空或过短'};
  }
  const quote = String(ref.quote).trim();
  // 1) 若给了段落序号，先在该段核对
  if (Number.isInteger(ref.paraIndex) && parsed.paragraphs[ref.paraIndex]) {
    const target = parsed.paragraphs[ref.paraIndex];
    const norm = (s) => String(s).replace(/[\s\u3000\p{P}\p{S}]/gu, '');
    const q = norm(quote);
    if (target.text && (norm(target.text).includes(q) || q.includes(norm(target.text).slice(0, 20)))) {
      const hit = locateQuote(parsed, quote);
      if (hit.found) return {ok: true, quote: hit.quote, locator: hit, context: hit.context, verified: 'para+quote'};
    }
  }
  // 2) 全文检索
  const hit = locateQuote(parsed, quote);
  if (hit.found) return {ok: true, quote: hit.quote, locator: hit, context: hit.context, verified: 'search'};
  return {ok: false, reason: hit.reason || '原文未检出'};
}

export function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

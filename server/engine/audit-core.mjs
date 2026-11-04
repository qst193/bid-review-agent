// 审核引擎公共层：投标包（项目+主体+版本）聚合、按要求的检索判断、证据校验落地。
// 所有检查都走同一条链路（需求第三节 5）：
//   全文建立索引 → 按要求检索候选证据 → 规则核查与模型判断 → 证据校验 → 生成问题。
import {buildIndexes, retrieve, verifyEvidence, gradeEvidence, queryFromRequirement, compareFacts, norm} from './indexer.mjs';
import {makeItem, nowStr} from './items.mjs';
import {requirementStableId} from './domain.mjs';
import {itemStableKey} from './domain.mjs';

/** 把项目文件聚合成投标包：优先按标书(bidId) 分组，回退按主体（兼容旧数据）。 */
export function buildBidPackages(project) {
  const bidDocs = project.docs.filter((d) => FILE_ROLE(d) === 'bid' && d.version === project.currentVersion && d.parsed && !d.parsed.unreadable);
  const byBid = new Map();
  for (const d of bidDocs) {
    const key = d.bidId || ('__e:' + (d.entityId || '__none__'));
    if (!byBid.has(key)) {
      const bid = (project.bids || []).find((b) => b.id === d.bidId);
      byBid.set(key, {
        bidId: d.bidId || null,
        entityId: d.entityId || null,
        entityName: bid?.entityName || d.entityName || '',
        author: bid?.author || '',
        version: d.version,
        docs: [],
      });
    }
    byBid.get(key).docs.push(d);
  }
  const packages = [...byBid.values()].map((g) => ({
    ...g,
    indexes: buildIndexes(g.docs),
    unreadableDocs: project.docs.filter((d) => FILE_ROLE(d) === 'bid' && d.version === project.currentVersion && (!d.parsed || d.parsed.unreadable)).map((d) => ({id: d.id, name: d.name, category: d.category, bidId: d.bidId})),
  }));
  return packages;
}

function FILE_ROLE(d) {
  if (d.role) return d.role;
  return ['procurement', 'supplement'].includes(d.category) ? 'procurement' : 'bid';
}

/** 采购文件索引（含补遗）。 */
export function buildProcurementIndexes(project) {
  const docs = project.docs.filter((d) => FILE_ROLE(d) === 'procurement' && d.parsed && !d.parsed.unreadable);
  return {indexes: buildIndexes(docs), docs};
}

export function procurementCoverage(project) {
  const all = project.docs.filter((d) => FILE_ROLE(d) === 'procurement');
  const parsed = all.filter((d) => d.parsed && !d.parsed.unreadable);
  const supplements = all.filter((d) => d.category === 'supplement');
  return {
    total: all.length, parsed: parsed.length,
    supplements: supplements.length,
    unreadable: all.filter((d) => !d.parsed || d.parsed.unreadable).map((d) => ({id: d.id, name: d.name})),
  };
}

/**
 * 针对一条招标要求，在一个投标包中做判断。
 * 返回 {result, resultLabel, checkStatus, confidence, evidence, gap, analysis, covered}
 * result 由模型在已检索出的候选证据上判断，随后强制用 verifyEvidence 复核引用。
 */
export async function judgeRequirement({model, pkg, req, system, userTemplate, onProgress}) {
  const query = queryFromRequirement(req);
  const retrieved = retrieve(pkg.indexes, query, {topK: 8, maxChars: 6500});
  const covered = retrieved.hits.length > 0;

  if (!covered && !pkg.indexes.length) {
    return {
      result: 'uncovered', checkStatus: 'uncovered', covered: false,
      evidence: [], gap: '该主体无可用文本（文件未解析或为扫描件）', analysis: '投标包内无可检索正文。',
    };
  }

  let obj = null;
  if (model?.configured) {
    try {
      onProgress?.(`检索判断：${req.title.slice(0, 20)}`);
      obj = await model.json({
        system,
        user: userTemplate({req, context: retrieved.context || '（未检索到相关段落）', covered}),
        maxTokens: 1600,
      });
    } catch (error) {
      throw new Error(`模型未完成「${req.title}」核查：${error.message}`);
    }
  }

  // 校验引用：只有 exact/normalized 计入强证据
  const evidence = [];
  for (const e of obj?.evidence || []) {
    // 优先在检索命中的文件里核对，缩到最小搜索范围
    const candidateDocs = retrieved.hits
      .filter((h) => !e.fileId || h.fileId === e.fileId)
      .map((h) => h.doc)
      .filter(Boolean);
    const docs = candidateDocs.length ? dedupeDocs(candidateDocs) : pkg.indexes;
    const hit = matchInDocs(docs, e.quote);
    if (hit) {
      evidence.push({
        fileId: hit.docId,
        fileName: hit.fileName,
        role: 'bid',
        quote: hit.quote,
        locator: hit.locator,
        grade: hit.matchType,
        weak: hit.weak,
      });
    }
  }
  // 模型没提供有效引用时，用检索最强命中兜底为「检索线索」（weak）
  if (!evidence.length && retrieved.hits.length) {
    const top = retrieved.hits[0];
    evidence.push({
      fileId: top.fileId, fileName: top.fileName, role: 'bid',
      quote: top.text, locator: {page: top.page, paraIndex: top.paraIndex, section: top.section, label: top.page ? `第 ${top.page} 页` : `段落 ${top.paraIndex + 1}`},
      grade: 'fuzzy', weak: true,
    });
  }

  const grade = gradeEvidence(evidence);
  let result = normalizeResult(obj?.result);
  // 证据不足则降级：不能凭部分相似给「已满足」
  if (result === 'satisfied' && grade !== 'exact' && grade !== 'normalized') result = evidence.length ? 'partial' : (covered ? 'unknown' : 'notFound');
  if (result === 'partial' && !evidence.length) result = covered ? 'unknown' : 'notFound';

  // 检索充分性（防止「检索没找到」被误判成「未检出」）
  // - adequate：有 ≥2 条命中，模型可依据上下文判断
  // - thin：命中 0–1 条，模型判断可能不充分 → 即使判 notFound 也标 retrievalThin
  const hitCount = retrieved.hits.length;
  const retrievalStatus = hitCount >= 2 ? 'adequate' : hitCount === 1 ? 'thin' : 'none';
  const retrievalThin = hitCount < 2;
  // 若结论为 notFound 但检索不足，标注为「检索不足，可能误判未检出」，仍保留 notFound 但加提示
  const maybeMissed = (result === 'notFound' || result === 'unknown') && retrievalThin;

  return {
    result,
    checkStatus: checkStatusOf(result),
    covered,
    confidence: typeof obj?.confidence === 'number' ? obj.confidence : null,
    evidence,
    gap: String(obj?.gap || obj?.missing || '').slice(0, 400),
    analysis: String(obj?.analysis || '').slice(0, 500),
    suggestedAction: String(obj?.action || '').slice(0, 400),
    suggestedText: String(obj?.suggestedText || '').slice(0, 1200),
    cannotInvent: Array.isArray(obj?.cannotInvent) ? obj.cannotInvent.slice(0, 6) : [],
    factIssues: evidence.length ? dedupeIssues(compareFacts(req.quote + ' ' + (req.checkpoints || []).join(' '), evidence.map((e) => e.quote).join(' '))) : [],
    grade,
    retrievedCount: hitCount,
    retrievalStatus,
    retrievalThin,
    maybeMissed,
  };
}

function dedupeIssues(list) {
  const seen = new Set();
  return list.filter((x) => { if (seen.has(x.message)) return false; seen.add(x.message); return true; });
}

function dedupeDocs(docs) {
  const seen = new Map();
  for (const d of docs) if (!seen.has(d.docId)) seen.set(d.docId, d);
  return [...seen.values()];
}

function matchInDocs(docs, quote) {
  for (const d of docs) {
    const v = verifyEvidence(d.parsed, quote);
    if (v.found) return {...v, docId: d.docId, fileName: d.fileName};
  }
  return null;
}

function normalizeResult(r) {
  const s = String(r || '').toLowerCase();
  if (['satisfied', 'pass', 'found', 'ok'].includes(s)) return 'satisfied';
  if (['partial', 'low', 'insufficient'].includes(s)) return 'partial';
  if (['violated', 'missing', 'fail', 'absent', 'mismatch'].includes(s)) return 'violated';
  if (['notfound', 'not_found', 'not detected'].includes(s)) return 'notFound';
  if (['uncovered'].includes(s)) return 'uncovered';
  return 'unknown';
}

function checkStatusOf(result) {
  return {
    satisfied: 'satisfied', partial: 'partial', violated: 'violated',
    notFound: 'notFound', uncovered: 'uncovered', unknown: 'unknown',
  }[result] || 'unknown';
}

export {makeItem, nowStr, itemStableKey, requirementStableId, norm};

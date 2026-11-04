// 六类检查引擎（需求第三节 5）：完整性、资格与实质响应、评分点、全书一致性、格式与交付、多主体互查。
// 统一从招标要求台账驱动；每类都走 judgeRequirement 的检索 + 模型 + 证据校验链路。
import {judgeRequirement, nowStr} from './audit-core.mjs';
import {makeItem} from './items.mjs';
import {REQ_TYPES} from './domain.mjs';
import {retrieve, norm, verifyEvidence, extractFacts} from './indexer.mjs';

// ---- 1. 完整性检查 ----
const COMPLETE_SYSTEM = `你是投标文件完整性核对助手。用户给出招标「组成材料/资格条件」要求（含原文与核查点），以及从投标包中检索到的候选原文。
判断投标包是否提供了对应材料。严格遵守：
1. result 只能是 satisfied（有可指向该材料的原文/章节）、partial（仅有标题缺实质内容）、notFound（完全未检出）、uncovered（包内无可读正文）、unknown（需看图片/扫描件）。
2. evidence.quote 必须逐字复制给定候选中连续存在的原文，禁止编造。
3. 不得虚构材料名称或页码。
4. “或”连接的材料是替代方案，找到任意一种满足条件即可，不能把未选的替代方案逐项写成缺失。分公司、自然人、许可证产品等有条件适用的材料，未确认条件成立时只能标为 unknown。
5. 目录、自查表、采购要求的原文复述、表格空白模板和“随表附上”等提示，不能证明真实证照或附件已经存在。扫描图像不可读时标为 unknown，不能判已满足或直接判缺失。
只输出 JSON。`;
const COMPLETE_USER = ({req, context}) => `要求：${req.title}
类型：组成材料/资格。原文：${req.quote}
核查点：${(req.checkpoints || []).join('；') || '无'}
所需材料：${(req.requiredMaterials || []).join('、') || '未列明'}

检索到的候选原文：
<<<
${context}
>>>

输出 JSON：{"result":"satisfied|partial|notFound|uncovered|unknown","confidence":0-1,"analysis":"一句话判断","gap":"缺少的核查点","evidence":[{"fileId":"","quote":"候选原文连续片段"}],"action":"补充什么材料"}`;

function qualificationIsMaterial(r) {
  return r.type === 'qualification' && /提供|提交|附上|证明|声明函|承诺函|证书|营业执照|资信|纳税|社保/.test(`${r.title || ''} ${r.quote || ''}`);
}

export async function runCompleteness({model, pkg, requirements, onProgress}) {
  const reqs = requirements.filter((r) => r.type === 'material' || qualificationIsMaterial(r));
  const items = [];
  for (const req of reqs) {
    const j = await judgeRequirement({model, pkg, req, system: COMPLETE_SYSTEM, userTemplate: COMPLETE_USER, onProgress});
    qualifyConditionalRequirement(j, req);
    normalizeActionableJudgment(j, req, 'material');
    guardImageOnlyEvidence(j,req,pkg);
    items.push(makeItem({
      check: 'completeness', issueType: 'material_missing', title: req.title,
      risk: riskFor(j.result, req),
      requirementId: req.stableId, requirement: reqSnapshot(req),
      entityId: pkg.entityId, entityName: pkg.entityName,
      evidence: j.evidence, gap: cleanGap([j.gap]) || defaultGap(j.result, '材料'),
      action: j.suggestedAction || (j.result === 'satisfied' ? '' : `补充「${req.title}」对应材料`),
      suggestedText: j.suggestedText, cannotInvent: j.cannotInvent?.length ? j.cannotInvent : (j.result === 'satisfied' ? [] : [`真实的${req.title}原件或扫描件`]),
      acceptance: j.result === 'satisfied' ? '' : '补齐后可定位到该材料原文/附件位置',
      checkStatus: j.checkStatus, aiFixable: false,
      extra: {confidence: j.confidence, grade: j.grade, result: j.result, analysis: j.analysis, retrievedCount: j.retrievedCount, retrievalStatus: j.retrievalStatus, retrievalThin: j.retrievalThin, maybeMissed: j.maybeMissed},
    }));
  }
  return {items, coverage: {requirements: reqs.length, entity: pkg.entityName}};
}

function guardImageOnlyEvidence(j,req,pkg){
  const source=`${req.title||''} ${req.quote||''} ${(req.requiredMaterials||[]).join(' ')}`;
  const subject=/社保|社会保障/.test(source)?/社保|社会保障/:/信用中国|信用记录/.test(source)?/信用中国|信用记录|企业信用/:/纳税|缴纳税收/.test(source)?/纳税|缴纳税收/:null;
  if(!subject)return;
  const clue=findNearbyImage(pkg,subject);
  if(!clue)return;
  const {doc,heading,i,count}=clue;
  if(j.result==='satisfied'&&!/截图|证明/.test(source))return;
  j.result=j.checkStatus='unknown';
  j.gap=`标书「${heading.slice(0,45)}」附近含图片；${doc.parsed?.coverage?.ocr ? "已提取图片文字，但仍须对照原图核实主体、日期、内容及盖章，不能直接判定缺失或合格。" : "图片文字未识别，不能判定材料缺失或合格。"}`;
  j.suggestedAction='打开标书对应原页，核对图片内容及采购要求后再确认结论';
  j.evidence=[{fileId:doc.id,fileName:doc.name,role:'bid',quote:heading,locator:{paraIndex:i,label:`段落 ${i+1}`},grade:'exact',weak:false}];
  j.grade=doc.parsed?.coverage?.ocr?'image-ocr-review':'image-unread';
}
function findNearbyImage(pkg,subject){
  for(const doc of pkg.docs||[]){
    const paras=doc.parsed?.paragraphs||[];
    for(let i=0;i<paras.length;i++){
      const heading=String(paras[i]?.text||'');
      if(!subject.test(heading)||heading.length>90)continue;
      const count=paras.slice(i,Math.min(i+4,paras.length)).reduce((n,p)=>n+(Number(p.images)||0),0);
      if(!count)continue;
      return {doc,heading,i,count};
    }
  }
  return null;
}

// ---- 2. 资格与实质响应 ----
const RESP_SYSTEM = `你是投标文件实质性响应核查助手。用户给出招标「资格条件/实质响应/否决项/★▲/技术参数」（含原文与核查点），以及投标包中检索到的候选原文。
逐条判断是否响应、证据是否充分。严格遵守：
1. result：satisfied（有明确对应且证据可支撑）、partial（有相关表述但缺关键要素如数值不满足/缺证明）、violated（明确不满足或数值矛盾）、notFound（完全未叙述）、uncovered（包内无可读正文）、unknown（需看图片/扫描件）。
2. 数值类必须逐字比对投标写出的数值与要求上下限，不得四舍五入或推测；发现矛盾必须在 gap 里写明。
3. evidence.quote 必须逐字复制给定候选原文，禁止编造数值、页码。
4. 不能替投标人补写真实数据或资质。
只输出 JSON。`;
const RESP_USER = ({req, context}) => `要求：${req.title}${req.mark ? '（' + req.mark + '）' : ''}
类型：${req.typeLabel}。原文：${req.quote}
${req.consequence ? '原文后果：' + req.consequence : ''}
核查点：${(req.checkpoints || []).join('；') || '无'}

检索到的候选原文：
<<<
${context}
>>>

输出 JSON：{"result":"satisfied|partial|violated|notFound|uncovered|unknown","confidence":0-1,"analysis":"判断依据","gap":"具体缺口（含数值/单位矛盾）","evidence":[{"fileId":"","quote":"候选原文片段"}],"action":"修改动作","suggestedText":"可参考的文字草稿（不得编造事实）","cannotInvent":["不可编造内容"]}`;

export async function runResponse({model, pkg, requirements, priceContextRequirements = requirements, onProgress}) {
  const reqs = requirements.filter((r) => ['substantive', 'param', 'commercial'].includes(r.type) ||
    (r.type === 'qualification' && !qualificationIsMaterial(r)));
  const items = [];
  for (const req of reqs) {
    const j = await judgeRequirement({model, pkg, req, system: RESP_SYSTEM, userTemplate: RESP_USER, onProgress});
    qualifyConditionalRequirement(j, req);
    normalizeActionableJudgment(j, req, 'response');
    if(/社保|社会保险|信用中国|信用记录/.test(`${req.title} ${req.quote}`))guardImageOnlyEvidence(j,req,pkg);
    const price = checkPriceCeiling(req, pkg, priceContextRequirements);
    if (price) {
      j.result = price.result;
      j.checkStatus = price.result;
      j.gap = price.result === 'satisfied' ? '' : price.gap;
      j.analysis = price.analysis;
      j.suggestedAction = price.result === 'satisfied' ? '' : '核对并修正投标报价';
      j.evidence = price.evidence;
      j.factIssues = [];
      j.grade = price.evidence.length ? 'exact' : 'none';
    }
    const factGap = j.factIssues?.length ? j.factIssues.map((x) => x.message).join('；') : '';
    // 模型 gap 已覆盖同一矛盾时不再重复追加
    const modelGap = j.gap || '';
    const extraFactGap = factGap && !modelGap.includes(factGap.split('；')[0]) ? factGap : '';
    items.push(makeItem({
      check: 'response', issueType: 'not_responded', title: (req.mark ? req.mark + ' ' : '') + req.title,
      risk: riskFor(j.result, req),
      requirementId: req.stableId, requirement: reqSnapshot(req),
      entityId: pkg.entityId, entityName: pkg.entityName,
      evidence: j.evidence, gap: cleanGap([modelGap, extraFactGap]) || defaultGap(j.result, '响应'),
      action: j.suggestedAction || (j.result === 'satisfied' ? '' : '补充响应说明与证明材料'),
      suggestedText: j.suggestedText, cannotInvent: j.cannotInvent,
      acceptance: j.result === 'satisfied' ? '' : '修改后可检索到满足该要求的原文与证明材料',
      checkStatus: j.checkStatus, aiFixable: !!j.suggestedText,
      extra: {confidence: j.confidence, grade: j.grade, result: j.result, analysis: j.analysis, retrievedCount: j.retrievedCount, retrievalStatus: j.retrievalStatus, retrievalThin: j.retrievalThin, maybeMissed: j.maybeMissed, mark: req.mark, consequence: req.consequence, isVeto: req.mark === '★' || /无效|废标|否决/.test(req.consequence || '')},
    }));
  }
  return {items, coverage: {requirements: reqs.length, entity: pkg.entityName}};
}

// 报价上限是确定性数值比较。仅在采购上限和投标报价都能明确定位时覆盖模型结论。
function checkPriceCeiling(req, pkg, requirements = []) {
  const source = `${req.title || ''} ${req.quote || ''}`;
  if (!/最高限价|预算金额|控制价/.test(source) || !/不超过|不得超过|超过|高于|上限/.test(source)) return null;
  const limitSource=[source,...requirements.filter(r=>/最高限价|预算金额/.test(r.title||'')).map(r=>r.quote||'')].join(' ');
  const ceiling = [...limitSource.matchAll(/([\d,]+(?:\.\d+)?)\s*(万元|元)/g)].map((m) => money(m)).find((v) => v > 0);
  if (!ceiling) return null;
  for (const idx of pkg.indexes || []) {
    for (const para of idx.paras || []) {
      const t = para.text || '';
      if (!/投标报价|投标总价|参选报价|参选总价|报价总额|报价金额/.test(t) || !/小写|总价|合计|报价金额|参选报价\s*[：:|]\s*[¥￥\d]/.test(t)) continue;
      const amounts = [...t.matchAll(/([\d,]+(?:\.\d+)?)\s*(万元|元)/g)];
      if (amounts.length !== 1) continue;
      const amount = money(amounts[0]);
      if (!amount) continue;
      const result = amount <= ceiling ? 'satisfied' : 'violated';
      return {result, gap: result === 'satisfied' ? '' : `投标报价 ${amounts[0][0]} 超过采购上限`,
        analysis: `投标报价 ${amounts[0][0]}；采购上限 ${ceiling} 元`,
        evidence: [{fileId: idx.docId, fileName: idx.fileName, quote: t.slice(0, 220), locator: {paraIndex: para.i, page: para.page, label: para.page ? `第 ${para.page} 页` : `段落 ${para.i+1}`}, grade: 'exact'}]};
    }
  }
  return null;
}

function money(match) { return Number(match[1].replace(/,/g, '')) * (match[2] === '万元' ? 10000 : 1); }

// ---- 3. 评分点检查（客观分程序化，主观分只给维度）----
const SCORE_SYSTEM = `你是投标评分核对助手。用户给出招标「评分项」（含分值、评分办法原文），以及投标包中检索到的候选原文。
严格遵守：
1. type：objective（有明确量化标准）、subjective（方案质量等）、price（价格分）。
2. 客观分：有可定位证据支撑时才给 evidence；客观分最终由程序计算，你只负责识别证据是否存在。
3. 主观分：只列分析维度（dimensions），不给确定分数。
4. 价格分：只在明确给出报价时识别报价数值，公式由程序核对。
5. evidence.quote 必须逐字复制候选原文。
只输出 JSON。`;
const SCORE_USER = ({req, context}) => `评分项：${req.title}${req.score != null ? '（' + req.score + '分）' : ''}
原文：${req.quote}
${req.score != null ? '该项满分：' + req.score : ''}

检索到的候选原文：
<<<
${context}
>>>

输出 JSON：{"type":"objective|subjective|price","max":数字或null,"evidencePresent":true/false,"confidence":0-1,"analysis":"依据","evidence":[{"fileId":"","quote":"候选原文"}],"dimensions":["主观分分析维度"],"priceInput":{"quote":"报价原文","amount":数字或null},"lostRisk":true/false,"advice":"补强建议"}`;

export async function runScoring({model, pkg, requirements, priceContext, onProgress}) {
  // 评标办法标题是采购方的规则说明，不是投标方必须提供的得分材料。
  const reqs = requirements.filter((r) => r.type === 'scoring' && !isScoringMethodHeader(r));
  const items = [];
  const priceFindings = [];
  for (const req of reqs) {
    const j = await judgeRequirementScoring({model, pkg, req, onProgress});
    const max = firstNum(req.score);
    let item;
    if (j.type === 'subjective') {
      item = makeItem({
        check: 'scoring', issueType: 'subjective_pending', title: req.title, risk: 'mid',
        requirementId: req.stableId, requirement: reqSnapshot(req),
        entityId: pkg.entityId, entityName: pkg.entityName, evidence: j.evidence,
        gap: '主观评分项需人工评估，系统仅提供分析维度',
        action: '人工评估并完善方案材料', acceptance: '人工给出评分区间与依据',
        checkStatus: 'unknown', extra: {scoreType: 'subjective', max, dimensions: j.dimensions, analysis: j.analysis, grade: j.grade},
      });
    } else if (j.type === 'price') {
      const amount = j.priceInput?.amount ?? null;
      const formula = priceContext?.formula || '';
      const computed = computePriceScore({amount, formula, benchmark: priceContext?.benchmark, max});
      item = makeItem({
        check: 'scoring', issueType: 'price_check', title: req.title, risk: computed.ok ? 'low' : 'high',
        requirementId: req.stableId, requirement: reqSnapshot(req),
        entityId: pkg.entityId, entityName: pkg.entityName, evidence: j.evidence,
        gap: computed.ok ? '' : (computed.missing || '价格分输入不完整'),
        action: computed.ok ? '' : '核对报价数值、评标基准价与公式方向后，再由程序计算（未经核实的公式不给确定分数）',
        checkStatus: computed.ok ? 'satisfied' : (amount == null ? 'notFound' : 'unknown'),
        extra: {scoreType: 'price', max, amount, formula, direction: computed.direction, computed, analysis: j.analysis, grade: j.grade},
      });
      if (amount != null) priceFindings.push({entity: pkg.entityName, amount, max});
    } else {
      // 客观分：有证据只代表「找到支撑材料」，不等于满足每一档计分条件（P0-04）。
      // 程序不给确定满分，只标注「有证据可核实 + 需人工核对档位」，并列出满分供参考。
      const hasEvidence = j.evidence.some((e) => !e.weak) && j.evidencePresent;
      const imageClue=!hasEvidence&&/社保|社会保险|信用记录|截图/.test(`${req.title} ${req.quote}`)
        ?findNearbyImage(pkg,/社保|社会保障|信用记录|截图/):null;
      item = makeItem({
        check: 'scoring', issueType: 'objective_evidence', title: req.title, risk: hasEvidence ? 'low' : 'mid',
        requirementId: req.stableId, requirement: reqSnapshot(req),
        entityId: pkg.entityId, entityName: pkg.entityName, evidence: imageClue?[{fileId:imageClue.doc.id,fileName:imageClue.doc.name,quote:imageClue.heading,locator:{paraIndex:imageClue.i,label:`段落 ${imageClue.i+1}`},grade:'exact'}]:j.evidence,
        gap: hasEvidence ? `找到相关证据，但需人工核对是否满足该评分项各档计分条件（满分 ${max != null ? max : '?'} 分）` : imageClue?'相关章节后含图片，尚未读取图中证书或社保内容，不能认定缺失或得分。':'缺少支撑该评分点的证明材料',
        action: hasEvidence ? '按评分标准逐档核对证据，人工确定得分' : imageClue?'人工打开对应原页核对图片证明材料':'补充对应得分证明材料',
        cannotInvent: hasEvidence ? [] : ['不可编造的证书、业绩、检测报告等'],
        // 有证据不知档位 → unknown（待人工判定）；无证据 → notFound（明显失分）
        checkStatus: hasEvidence||imageClue ? 'unknown' : 'notFound',
        extra: {scoreType: 'objective', max, score: null, scorePending: hasEvidence, analysis: j.analysis, grade: j.grade, lostRisk: !hasEvidence},
      });
    }
    items.push(item);
  }
  return {items, coverage: {scoring: reqs.length, entity: pkg.entityName}, priceFindings};
}

function isScoringMethodHeader(req) {
  const title = String(req.title || '').replace(/\s/g, '');
  return req.score == null && /^(综合评分法|评标办法|评分办法|分值构成|价格分计算方法|评分标准)(及分值构成)?$/.test(title);
}

async function judgeRequirementScoring({model, pkg, req, onProgress}) {
  const query = req.title + ' ' + req.quote;
  const retrieved = retrieve(pkg.indexes, query, {topK: 6, maxChars: 5000});
  let obj = null;
  if (model?.configured) {
    try {
      onProgress?.(`评分核对：${req.title.slice(0, 16)}`);
      obj = await model.json({system: SCORE_SYSTEM, user: SCORE_USER({req, context: retrieved.context || '（未检索到相关段落）'}), maxTokens: 1200});
    } catch (error) { throw new Error(`模型未完成评分项「${req.title}」核查：${error.message}`); }
  }
  const evidence = [];
  for (const e of obj?.evidence || []) {
    const hit = matchAny(pkg.indexes, e.quote);
    if (hit) evidence.push({fileId: hit.docId, fileName: hit.fileName, role: 'bid', quote: hit.quote, locator: hit.locator, grade: hit.matchType, weak: hit.weak});
  }
  if (!evidence.length && retrieved.hits.length) {
    const top = retrieved.hits[0];
    evidence.push({fileId: top.fileId, fileName: top.fileName, role: 'bid', quote: top.text, locator: {page: top.page, paraIndex: top.paraIndex, section: top.section, label: top.page ? `第 ${top.page} 页` : `段落 ${top.paraIndex + 1}`}, grade: 'fuzzy', weak: true});
  }
  return {
    type: ['objective', 'subjective', 'price'].includes(obj?.type) ? obj.type : 'objective',
    evidencePresent: obj?.evidencePresent !== false && evidence.some((e) => !e.weak),
    evidence,
    dimensions: Array.isArray(obj?.dimensions) ? obj.dimensions.map((x) => String(x).slice(0, 80)).slice(0, 8) : [],
    priceInput: obj?.priceInput ? {quote: String(obj.priceInput.quote || '').slice(0, 200), amount: firstNum(obj.priceInput.amount)} : null,
    analysis: String(obj?.analysis || ''),
    grade: evidence.length ? (evidence.some((e) => !e.weak) ? 'normalized' : 'fuzzy') : 'none',
  };
}

// 价格分：程序按公式计算，缺输入则不计算（需求 P0-04）
/**
 * 价格分计算（P0-04 修正版）。
 * 关键：先识别公式「方向」，再按方向计算，避免把 报价/基准价 当成 基准价/报价。
 * 返回 {ok, direction, ...}。方向无法确定或数据不全时 ok=false，只给依据与待核数据，不给确定分数。
 */
export function computePriceScore({amount, formula, benchmark, max}) {
  const f = String(formula || '');
  const base = {amount, max, benchmark: benchmark != null ? benchmark : null, formula: f};

  // 识别方向
  let direction = detectPriceDirection(f);

  // 数据完整性
  if (max == null) return {ok: false, missing: '未识别到价格分满分值', ...base, direction};
  if (amount == null) return {ok: false, missing: '未识别到投标报价', ...base, direction};
  if (direction === 'unknown') return {ok: false, missing: '未能识别价格分公式方向（是「基准价/报价」还是「报价/基准价」），请人工确认公式', ...base};
  if (benchmark == null) return {ok: false, missing: '该公式需评标基准价，尚未提供', ...base, direction};

  let raw;
  if (direction === 'benchmarkOverPrice') {
    // 低价优先：报价越低得分越高，基准价/报价 × 满分
    raw = (benchmark / amount) * max;
  } else {
    // 报价/基准价 × 满分（报价越高得分越高，少见但存在）
    raw = (amount / benchmark) * max;
  }
  const score = Math.min(max, Math.max(0, raw));
  return {ok: true, direction, amount, max, benchmark, score: round2(score), capped: raw > max, formula: f};
}

// 识别价格公式方向：
//   benchmarkOverPrice: 基准价/报价、最低评标价/报价、低价优先
//   priceOverBenchmark: 报价/基准价
//   unknown: 无法确定
function detectPriceDirection(f) {
  const s = String(f || '').replace(/\s+/g, '');
  if (!s) return 'unknown';
  // 优先判断「报价在分子」还是「基准价在分子」
  const hasBenchmark = /(评标)?基准价|最低(评标)?价|benchmark/i.test(s);
  const hasPrice = /报价|投标价|price|bid/i.test(s);
  if (!hasBenchmark || !hasPrice) {
    // 只提到「低价优先」「报价越低」也能定方向
    if (/低价优先|报价越低|最低价优先|低价者得/.test(s)) return 'benchmarkOverPrice';
    return 'unknown';
  }
  // 看谁在斜杠前（分子）
  const token = '(?:评标基准价|基准价|最低评标价|最低价|投标报价|报价|投标价|benchmark|price|bid)';
  const ratio = s.match(new RegExp('(' + token + ')\\s*[\\/÷]\\s*(' + token + ')', 'i'));
  if (ratio) {
    const num = ratio[1];
    if (/评标基准价|基准价|最低评标价|最低价|benchmark/i.test(num)) return 'benchmarkOverPrice';
    if (/投标报价|报价|投标价|price|bid/i.test(num)) return 'priceOverBenchmark';
  }
  // 兜底：出现「低价优先」类词
  if (/低价优先|报价越低|最低价优先/.test(s)) return 'benchmarkOverPrice';
  return 'unknown';
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---- 4. 全书一致性检查（确定性 + 模型）----
export async function runConsistency({model, pkg, onProgress}) {
  onProgress?.('一致性检查：抽取关键事实…');
  const items = [];
  const facts = extractKeyFacts(pkg);
  // 报价一致性
  if (facts.prices.length >= 2) {
    const vals = [...new Set(facts.prices.map((p) => p.value))];
    if (vals.length > 1) {
      items.push(makeItem({
        check: 'consistency', issueType: 'price_inconsistent', title: '报价金额在全书不一致',
        risk: 'critical', entityId: pkg.entityId, entityName: pkg.entityName,
        evidence: facts.prices.slice(0, 4).map((p) => ({fileId: p.fileId, fileName: p.fileName, quote: p.quote, locator: p.locator, grade: 'exact'})),
        gap: `检出 ${vals.length} 个不同报价：${vals.map((v) => v.toLocaleString('zh-CN')).join(' / ')} 元`,
        action: '统一最终报价，核对报价表、开标一览表、正文金额一致', acceptance: '全书报价金额唯一且与报价表一致',
        checkStatus: 'violated', extra: {analysis: '报价金额多处不一致可能影响报价有效性。'},
      }));
    }
  }
  // 有效期一致性
  if (facts.validity.length >= 2) {
    const vals = [...new Set(facts.validity.map((v) => v.value))];
    if (vals.length > 1) {
      items.push(makeItem({
        check: 'consistency', issueType: 'validity_inconsistent', title: '投标有效期表述不一致',
        risk: 'high', entityId: pkg.entityId, entityName: pkg.entityName,
        evidence: facts.validity.slice(0, 4).map((v) => ({fileId: v.fileId, fileName: v.fileName, quote: v.quote, locator: v.locator, grade: 'exact'})),
        gap: `有效期为 ${vals.join(' / ')} 天，需统一`,
        action: '统一投标有效期表述并核对承诺函', checkStatus: 'violated',
        extra: {analysis: '有效期不一致可能被认定为实质性偏离。'},
      }));
    }
  }
  // 质保期一致性
  if (facts.warranty.length >= 2) {
    const vals = [...new Set(facts.warranty.map((v) => v.value))];
    if (vals.length > 1) {
      items.push(makeItem({
        check: 'consistency', issueType: 'warranty_inconsistent', title: '质保期表述不一致',
        risk: 'mid', entityId: pkg.entityId, entityName: pkg.entityName,
        evidence: facts.warranty.slice(0, 4).map((v) => ({fileId: v.fileId, fileName: v.fileName, quote: v.quote, locator: v.locator, grade: 'exact'})),
        gap: `质保期为 ${vals.join(' / ')}，需统一`, action: '统一质保期表述', checkStatus: 'violated',
        extra: {analysis: '质保期前后不一致，需核对商务条款与正文。'},
      }));
    }
  }
  // 项目名称/主体名称跨文件一致性
  const nameIssue = checkNameConsistency(pkg);
  if (nameIssue) items.push(nameIssue);

  return {items, coverage: {entity: pkg.entityName, facts: {prices: facts.prices.length, validity: facts.validity.length, warranty: facts.warranty.length}}};
}

function extractKeyFacts(pkg) {
  const prices = [];
  const validity = [];
  const warranty = [];
  for (const idx of pkg.indexes) {
    for (const p of idx.paras) {
      const t = p.text;
      // 报价：含「元」且附近有 报价/总价/合计
      if (/报价|总价|合计|投标价|投标总价|含税|金额/.test(t)) {
        const m = t.match(/(\d[\d,]{4,})(?:\.\d+)?\s*元/);
        if (m) {
          const v = Number(m[1].replace(/,/g, ''));
          if (v > 1000) prices.push({value: v, quote: t.slice(0, 200), fileId: idx.docId, fileName: idx.fileName, locator: loc(p)});
        }
      }
      if (/投标有效期/.test(t)) {
        const m = t.match(/(\d+)\s*(?:个)?(?:日历|自然)?天/);
        if (m) validity.push({value: Number(m[1]), quote: t.slice(0, 200), fileId: idx.docId, fileName: idx.fileName, locator: loc(p)});
      }
      if (/质保|保修/.test(t)) {
        const m = t.match(/(\d+)\s*年/);
        if (m) warranty.push({value: Number(m[1]), quote: t.slice(0, 200), fileId: idx.docId, fileName: idx.fileName, locator: loc(p)});
      }
    }
  }
  return {prices, validity, warranty};
}

function checkNameConsistency(pkg) {
  if (!pkg.entityName) return null;
  const core = pkg.entityName.replace(/(有限公司|股份有限公司|有限责任公司|公司)$/g, '');
  if (core.length < 3) return null;
  // 检查投标文件里是否出现其他公司的投标主体名（不属本包）
  return null;
}

// ---- 5. 格式与交付检查 ----
export async function runFormat({model, pkg, requirements, onProgress}) {
  onProgress?.('格式与交付检查…');
  const items = [];
  const reqs = requirements.filter((r) => r.type === 'format');
  for (const req of reqs) {
    const externalDelivery = /(?:现场|纸质|密封|截止时间|截止前|递交时间|递交地点).{0,30}(?:递交|送达)|(?:递交|送达).{0,30}(?:时间|地点|截止)/.test(`${req.title} ${req.quote}`);
    const j = externalDelivery
      ? {result:'unknown',checkStatus:'unknown',evidence:[],gap:'该要求涉及文件递交动作，标书正文无法证明实际递交时间或地点；请核对交付记录。',suggestedAction:'人工核对实际递交记录和截止时间',analysis:'仅凭标书正文不能判断线下交付是否合规',grade:'none'}
      : await judgeRequirement({model, pkg, req, system: FORMAT_SYSTEM, userTemplate: FORMAT_USER, onProgress});
    items.push(makeItem({
      check: 'format', issueType: 'format_check', title: req.title, risk: riskFor(j.result, req),
      requirementId: req.stableId, requirement: reqSnapshot(req),
      entityId: pkg.entityId, entityName: pkg.entityName,
      evidence: j.evidence, gap: cleanGap([j.gap]) || defaultGap(j.result, '格式项'),
      action: j.suggestedAction || (j.result === 'satisfied' ? '' : '按招标规定格式补齐签章/目录/声明'),
      checkStatus: j.checkStatus, extra: {analysis: j.analysis, grade: j.grade, result: j.result},
    }));
  }
  // 通用格式确定性检查
  const tmpl = detectTemplateLeftover(pkg);
  if (tmpl.length) {
    items.push(makeItem({
      check: 'format', issueType: 'template_leftover', title: '正文存在模板占位符/待填标记', risk: 'mid',
      entityId: pkg.entityId, entityName: pkg.entityName,
      evidence: tmpl.slice(0, 5).map((x) => ({fileId: x.fileId, fileName: x.fileName, quote: x.quote, locator: x.locator, grade: 'exact'})),
      gap: `检出 ${tmpl.length} 处疑似占位符（如【待填】/XXXX/《项目名称》）`,
      action: '全文检索并替换所有占位符为真实信息', checkStatus: 'violated',
      extra: {analysis: '模板残留会削弱正式性与可信度，需逐一核对填写。'},
    }));
  }
  return {items, coverage: {format: reqs.length, entity: pkg.entityName}};
}

const FORMAT_SYSTEM = `你是投标文件格式核查助手。先从采购原文判断模板是明确要求原样使用、仅要求实质内容一致、允许自拟，还是未明确；不得因出现示例模板就擅自要求完全一致。逐项比对明确要求的标题、字段、表格顺序、填写方式和文件形式。只有采购文件要求原样使用，且采购与标书两侧都能读取对应版式时，才能判定行距、下划线、括号、字体、签章位置等视觉差异。当前候选主要是抽取文字；不能读取的版式、签字、印章、页眉页脚或扫描图像必须返回 unknown。发现可核实的差异时，gap 写清“采购要求：……；标书现状：……；差异：……”，并引用可逐字核验的标书原文。候选文本不能确定对应表格时也返回 unknown。不要把线下递交动作判为标书格式违规。只输出 JSON。`;
const FORMAT_USER = ({req, context}) => `采购文件要求的格式：${req.title}\n采购原文：${req.quote}\n模板使用要求：${req.template?.mode==='content'?'允许补充和修改，但不得实质违背原格式内容':req.template?.mode==='exact'?'原文要求原样使用':'原文未明确是否须原样使用'}\n模板固定正文：${(req.template?.sourceText||req.checkpoints||[]).join('；')}\n只报告有证据支持的缺段、缺字段或实质偏离；无法读取的字体、字号、下划线、括号及行距标为 unknown。\n\n标书候选原文：\n<<<\n${context}\n>>>\n\n请比较采购格式和标书实际格式；无法从文字确定的部分标为 unknown。输出 JSON：{"result":"satisfied|partial|notFound|uncovered|unknown","confidence":0-1,"analysis":"","gap":"采购要求：……；标书现状：……；差异：……","evidence":[{"fileId":"","quote":""}],"action":""}`;

function detectTemplateLeftover(pkg) {
  const hits = [];
  const re = /【[^】]{1,16}(待填|填写|待补|补充|项目名称|公司名称)[^】]*】|X{3,}|《\s*(项目名称|公司名称)\s*》/;
  for (const idx of pkg.indexes) {
    for (const p of idx.paras) {
      if (re.test(p.text) && hits.length < 20) {
        hits.push({fileId: idx.docId, fileName: idx.fileName, quote: p.text.slice(0, 200), locator: loc(p)});
      }
    }
  }
  return hits;
}

// ---- 6. 多主体互查（确定性，只出线索）----
export function runCross(pkgs, procurementIndexes = []) {
  const items = [];
  const usable = pkgs.filter((p) => p.indexes.length);
  if (usable.length < 2) {
    return {items: [], coverage: {packages: usable.length, skipped: '多份相似性需要至少两份可读标书'}};
  }
  const names = [...new Set(usable.map((p) => p.entityName).filter(Boolean))];
  // 跨主体名称残留
  for (const pkg of usable) {
    for (const other of names) {
      if (other === pkg.entityName) continue;
      const core = other.replace(/(有限公司|股份有限公司|有限责任公司|公司)$/g, '');
      if (core.length < 4) continue;
      const hits = [];
      for (const idx of pkg.indexes) {
        for (const p of idx.paras) {
          if (p.text.includes(core) && hits.length < 2) hits.push({fileId: idx.docId, fileName: idx.fileName, quote: p.text.slice(0, 200), locator: loc(p)});
        }
      }
      if (hits.length) {
        items.push(makeItem({
          check: 'cross', issueType: 'cross_name', title: '投标文本出现其他投标主体名称', risk: 'mid',
          entityId: pkg.entityId, entityName: pkg.entityName,
          evidence: hits.map((h) => ({...h, grade: 'exact'})),
          gap: `出现「${other}」名称片段`, action: '核实该名称出现原因（引用/合作/笔误）',
          checkStatus: 'unknown', extra: {clueType: 'name', analysis: '可能是引用、合作说明或笔误，需人工核实，不构成违规认定。'},
        }));
      }
    }
  }
  // 长段落相似
  const sim = similarityAcross(usable, procurementIndexes);
  items.push(...sim);
  // 文档属性仅作线索；相同模板作者字段不能单独推出关联编制。
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i], b = usable[j];
      if (a.entityId === b.entityId) continue;
      const am = a.docs.flatMap(d => [d.parsed?.metadata || {}]);
      const bm = b.docs.flatMap(d => [d.parsed?.metadata || {}]);
      const shared = [];
      for (const key of ['creator','lastModifiedBy']) {
        const av = [...new Set(am.map(m => String(m[key] || '').trim()).filter(v => v.length >= 3))];
        const bv = new Set(bm.map(m => String(m[key] || '').trim()));
        for (const value of av) if (bv.has(value)) shared.push(`${key}=${value}`);
      }
      if (!shared.length) continue;
      items.push(makeItem({check:'cross',issueType:'cross_metadata',title:'跨主体文档属性出现相同作者信息',risk:'low',entityName:`${a.entityName} ↔ ${b.entityName}`,
        gap:`相同文档属性：${shared.join('；')}`,action:'核实文件来源、模板复用及编制过程，记录独立性核查结论',checkStatus:'unknown',
        extra:{clueType:'metadata',analysis:'Office 模板或共享软件也可能产生相同属性，仅作人工核查线索。'}}));
    }
  }
  return {items, coverage: {packages: usable.length}};
}

function similarityAcross(pkgs, procurementIndexes = []) {
  const out = [];
  const procurementText = procurementIndexes.flatMap((idx) => idx.paras || []).map((p) => p.norm).filter((s) => s?.length >= 80);
  const fromProcurement = (s) => procurementText.some((source) => source.includes(s) || (s.includes(source) && source.length >= s.length * .7));
  const candidates = (idx) => {
    const long = idx.paras.filter((x) => x.norm.length >= 80);
    // PDF 常将一句话拆成多个短段；按相邻段组成检索窗口，并标记为弱定位证据。
    const windows = [];
    for (let i = 0; i < idx.paras.length; i += 3) {
      const group = idx.paras.slice(i, i + 5);
      if (group.length < 2 || (group[0].page && group.some(x => x.page && x.page !== group[0].page))) continue;
      const combined = group.map(x => x.text).join('');
      const normalized = group.map(x => x.norm).join('');
      if (normalized.length >= 80 && normalized.length <= 500) windows.push({...group[0], text: combined, norm: normalized, window: true});
    }
    return [...long, ...windows].filter(x => !isCommonTenderTemplate(x.text) && !fromProcurement(x.norm));
  };
  const prepared = pkgs.map((p) => ({
    pkg: p,
    paras: p.indexes.flatMap((idx) => candidates(idx).map((x) => ({idx, p: x, sh: shingles(x.norm)}))),
  }));
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const A = prepared[i], B = prepared[j];
      if (A.pkg.entityId === B.pkg.entityId) continue;
      let reported = 0;
      for (const a of A.paras) {
        let best = 0, hit = null;
        for (const b of B.paras) {
          const s = jaccard(a.sh, b.sh);
          if (s > best) { best = s; hit = b; }
        }
        if (best >= 0.72 && reported < 3) {
          reported++;
          out.push(makeItem({
            check: 'cross', issueType: 'cross_similar', title: '跨主体长段落高度相似', risk: 'mid',
            entityName: `${A.pkg.entityName} ↔ ${B.pkg.entityName}`,
            evidence: [
              {fileId: a.idx.docId, fileName: a.idx.fileName, quote: a.p.text.slice(0, 300), locator: loc(a.p), grade: a.p.window ? 'fuzzy' : 'exact', weak: !!a.p.window},
              {fileId: hit.idx.docId, fileName: hit.idx.fileName, quote: hit.p.text.slice(0, 300), locator: loc(hit.p), grade: hit.p.window ? 'fuzzy' : 'exact', weak: !!hit.p.window},
            ],
            gap: `相似度约 ${Math.round(best * 100)}%`, action: '核实相似是否来自共同厂商资料或合理引用',
            checkStatus: 'unknown', extra: {clueType: 'similar', similarity: best, analysis: '相似可能源于共用厂商资料或招标附件，需核实，不构成违规认定。'},
          }));
        }
      }
    }
  }
  return out;
}

function isCommonTenderTemplate(text) {
  const s = String(text || '');
  if (/政府采购法|营业执照.*组织机构代码证|年度财务状况报告.*资信证明|参加本次政府采购活动前三年内.*无重大违法记录|中小企业声明函.*监狱企业|监狱企业.*价格扣除|遴选代理服务费承诺书|招标代理服务费.*中选通知书/.test(s)) return true;
  // 法定格式的参选声明、授权和承诺会在不同投标文件中重复；不作为独立编制线索。
  return /^(?:(?:如果)?我方|本单位|本公司)/.test(s.trim())
    && /承诺|保证|声明|遴选文件|参选人|中选通知书|招标代理服务费/.test(s)
    && !/并发|识别准确率|系统架构|接口设计|部署方案|数据治理|技术路线/.test(s);
}

function shingles(s, k = 8) {
  const set = new Set();
  for (let i = 0; i + k <= s.length; i += 3) set.add(s.slice(i, i + k));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---- 工具 ----
// 清理 gap 拼接产生的空段与重复片段（规范化后比较，消除仅差空格的重复）
function cleanGap(parts) {
  const normKey = (s) => String(s).replace(/[\s\u3000]/g, '').replace(/[。；，、,;.]/g, '');
  const segs = parts.filter(Boolean).flatMap((s) => String(s).split('；')).map((x) => x.trim()).filter(Boolean);
  const keptKeys = [];
  const uniq = [];
  for (const s of segs) {
    const k = normKey(s);
    if (!k) continue;
    if (keptKeys.some((ek) => ek === k || ek.includes(k) || k.includes(ek))) continue;
    keptKeys.push(k);
    uniq.push(s);
  }
  return uniq.join('；').slice(0, 480);
}

function matchAny(indexes, quote) {
  for (const idx of indexes) {
    const v = verifyEvidence(idx.parsed, quote);
    if (v.found) return {...v, docId: idx.docId, fileName: idx.fileName};
  }
  return null;
}
function firstNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v ?? '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function riskFor(result, req) {
  const veto = req.mark === '★' || /无效|废标|否决/.test(req.consequence || '');
  if (result === 'violated') return veto ? 'critical' : 'high';
  if (result === 'notFound') return veto ? 'critical' : 'high';
  if (result === 'partial') return veto ? 'high' : 'mid';
  if (result === 'uncovered') return 'mid';
  if (result === 'unknown') return 'low';
  return 'low';
}
function qualifyConditionalRequirement(j, req) {
  if (!['notFound','partial','violated'].includes(j.result)) return;
  const quote=(req.quote||'').trim();
  const optionalPolicy=/监狱企业|残疾人福利性单位|政策性功能/.test(req.title||'') || (/中小微企业|中小企业声明函/.test(req.title||'') && /可选|如有|如为|若为|属于|价格扣除|不涉及/.test(quote));
  const conditionalEntity=/分公司|联合体/.test(req.title||'') && /如|若|如果|分公司参选|联合体成员|授权分公司|分公司进行参选/.test(quote);
  const conditionalMark=/[★▲]/.test(req.title||'') && /如.{0,25}(?:标有|存在|带有)[★▲]/.test(quote);
  if (!optionalPolicy && !conditionalEntity && !conditionalMark && !/^(?:\d+[、．.]\s*)?(?:如|若|如果|【若).{0,35}(?:属于|以非独立法人|为分公司|分公司参选|自然人|许可证管理)/.test(quote) && !/^(?:\d+[、．.]\s*)?对列入国家强制性产品目录/.test(quote)) return;
  j.result = 'unknown';
  j.checkStatus = 'unknown';
  j.gap = conditionalMark ? '该▲/★表格要求以采购文件实际存在对应标记条款为前提；须先核实具体条款清单，再判断是否漏填。' : '该要求有适用前提，现有证据不能确认是否适用；先核实投标主体或产品情况，再检查对应材料。';
  j.suggestedAction = conditionalMark ? '核对采购文件实际标记条款与响应表，存在时逐条补齐' : '先核实该条件是否适用；适用时补齐相应材料';
}
function normalizeActionableJudgment(j, req, kind) {
  // Text extraction cannot establish that a certificate image or attachment is absent.
  // A directory entry, copied requirement, or a model's "not confirmed" wording is a review task, not a proven defect.
  if (kind === 'material' && ['partial', 'notFound'].includes(j.result) &&
      /未确认|尚未确认|无法确认|不能确认|需核对.*(?:附件|扫描页|原页)/.test(j.gap || '') &&
      (j.evidence || []).every(e => e.weak || /目录|索引|文件名称\s*\||随本表格附上|须提供|需提供/.test(e.quote || ''))) {
    j.result = j.checkStatus = 'unknown';
    j.gap = '目前只定位到目录、要求复述或提示，无法从提取文字判断证照附件是否实际存在。';
    j.suggestedAction = '查看标书对应原页；确认附件确实缺失后再列为问题';
  }
  if (kind === 'response' && j.result === 'satisfied' && /报价超过预算|最高限价无效/.test(req.title||'') && !(j.evidence||[]).some(e=>/\d[\d,]*(?:\.\d+)?\s*(?:万元|元)/.test(e.quote) && /(?:参选总价|投标总价|参选报价|投标报价|总报价)\s*[：:|]?\s*[¥￥\d]/.test(e.quote))) {
    j.result = j.checkStatus = 'unknown';
    j.gap = '只检出不超限价的承诺，尚未定位实际投标总报价，无法与采购限价作数值比较。';
    j.suggestedAction = '核对开标一览表实际总报价与采购预算或最高限价，记录两个金额和所在页';
  }
  if (kind === 'material' && ['partial','notFound'].includes(j.result) && /(?:财务状况报告|资信证明).{0,100}或/.test(req.quote || '')) {
    j.gap = '采购文件允许择一提供；当前尚未确认标书中存在任一有效替代材料，需核查附件或扫描页。';
    j.suggestedAction = '核实并提供采购文件允许的其中一种有效材料，注明标书位置';
  }
  if (kind === 'material' && ['partial','notFound'].includes(j.result) && /营业执照/.test(req.quote || '') && /组织机构代码证/.test(req.quote || '')) {
    j.gap = '未确认实际主体资格证件及组织机构代码证、税务登记证复印件（或有效三证合一文件）均已附入；目录和模板提示不能证明附件存在。';
    j.suggestedAction = '核对标书附件原页；缺项时补入有效主体资格证件及相应登记证明，并核实盖章';
  }
  if (j.result === 'partial' && /无实质性缺口|不构成实质缺口/.test(j.gap || '') && (j.evidence || []).some(e => !e.weak && ['exact','normalized'].includes(e.grade))) {
    j.result = j.checkStatus = 'satisfied';
    j.gap = '';
    j.suggestedAction = '';
  }
  if (j.result === 'satisfied' && /整体(?:参选|响应)|所有条款(?:全部|完全)?响应/.test(`${req.title} ${req.quote}`)) {
    j.result = j.checkStatus = 'unknown';
    j.gap = '整体响应声明不能代替逐项核对；须检查每项采购要求的对应内容。';
    j.suggestedAction = '逐项核对响应矩阵，补足没有具体方案或证明的条款';
  }
  if (kind === 'material' && j.result === 'satisfied' && (j.evidence || []).length && (j.evidence || []).every(e => {
    const quote = norm(e.quote);
    const source = norm(req.quote);
    return (quote.length >= 20 && source.includes(quote)) || /随本表格附上|文件名称\s*\|\s*页码|索引\s*\|/.test(e.quote);
  })) {
    j.result = j.checkStatus = 'unknown';
    j.gap = '只检出要求复述、目录或空白模板，尚未定位到实际证明材料。';
    j.suggestedAction = '人工查看对应附件或扫描页，确认真实材料已附且有效';
  }
  if (j.result !== 'satisfied') {
    if (!j.gap || /^(无|无需|没有|未发现|不适用)[。\s]*$/.test(j.gap.trim())) j.gap = '现有证据不足以确认满足该采购要求，需核对标书对应内容。';
    if (!j.suggestedAction || /无需(?:修改|补充)|不需要(?:修改|补充)/.test(j.suggestedAction)) j.suggestedAction = '核对采购要求与标书对应章节；缺少内容时补充并标明位置';
  }
}
function defaultGap(result, kind) {
  return {
    satisfied: '', partial: `${kind}证据不足，缺少关键要素或证明材料`, notFound: `未检出${kind}`,
    violated: `明确不满足${kind}要求`, uncovered: '包内无可读正文，无法核查', unknown: '需人工核实',
  }[result] || '';
}
function reqSnapshot(req) {
  return {title: req.title, quote: req.quote, source: req.source, mark: req.mark, locator: req.locator, fileName: req.fileName, fileId: req.fileId, type: req.type, typeLabel: req.typeLabel, consequence: req.consequence, checkpoints: req.checkpoints};
}
function loc(p) {
  return {page: p.page || null, paraIndex: p.i, paraNumber: p.i + 1, section: p.section || '', label: p.page ? `第 ${p.page} 页` : `段落 ${p.i + 1}`};
}

export const CHECK_RUNNERS = {runCompleteness, runResponse, runScoring, runConsistency, runFormat, runCross};

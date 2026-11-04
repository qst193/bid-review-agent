// 招标要求台账（P1-01）：
// 从招标文件抽取结构化要求，形成可人工审查/拆分/合并/纠错/补充的台账，确认后锁定为审核基线。
import {chunkedDigest} from './digest.mjs';
import {verifyEvidence, norm} from './indexer.mjs';
import {REQ_TYPES, requirementStableId, stableHash} from './domain.mjs';
import {recoverCompositionRequirements} from './composition.mjs';
import {extractScoringTables,recoverPriceScoring} from './scoring-table.mjs';

const SYSTEM = `你是招标采购文件条款抽取器。用户提供采购文件带定位标记的文本（每行形如 [P12|第3页] 正文）。
任务：抽取所有影响投标的要求条款，形成结构化台账。严格遵守：
1. quote 必须逐字复制原文中连续存在的一段，不得改写、拼接或推断，长度 12–260 字。
2. paraIndex 填该行标记里的 P 数字减 1（[P12] → 11）；page 填页码（无则 null）。
3. 类型 type 只能是：qualification（资格条件）、substantive（实质响应/否决项/★▲）、material（组成材料/文件组成）、param（技术参数）、commercial（商务条件/交期/质保/报价）、scoring（评分项）、format（格式/签章/递交要求）。
4. consequence 只写原文明确写出的后果（如无效投标、扣分），原文没写就留空，禁止编造。
5. checkpoints 是这条要求可核查的具体条件（例：证书须在有效期内、须提供加盖公章复印件）。
6. requiredMaterials 是投标须提供的材料名称（证书/承诺/检测报告/方案/报价表等）。
7. 若为评分项（scoring），score 填该项满分数字（原文写明「30 分」则填 30），未写明则 null。
8. 保留 ★/▲ 原文含义，原文未说明效力就不要写。
9. 同一条有多份材料、不同名单、多人或多张不同内容截图时，在 checkpoints 中分别列出，并准确写出原文数量；“或”保持替代关系，“如有”保持触发条件。不得把示例解释为所有项目通用要求。
10. nature 区分 mandatory（响应文件必交）、scoring（仅评分）、conditional（条件适用）、manual（现场或其他阶段）、unclear（文件未明确）；只能依据本次采购原文。submissionStage 区分报名、响应文件、现场评审、成交后或未明确。
11. 模板仅在原文明确要求原样使用时标 templateMode=exact；要求实质内容一致标 content；允许自拟标 flexible；否则标 unclear。不得根据模板外观臆测字体、行距、下划线必须完全一致。
只输出 JSON 对象，不含解释或代码围栏。`;

const USER_TMPL = (text, fileName) => `采购文件名：${fileName}
请从下面文本中抽取全部要求条款。条款可能跨行，但 quote 必须取自连续的原文。

<<<采购依据文本>>>
${text}
<<<文本结束>>>

输出 JSON：
{"items":[{"title":"不超过28字","type":"qualification|substantive|material|param|commercial|scoring|format","quote":"原文连续片段","paraIndex":数字,"page":数字或null,"source":"条款号/章节","consequence":"原文写明的后果，无则空串","mark":"★/▲或无","score":数字或null,"nature":"mandatory|scoring|conditional|manual|unclear","submissionStage":"报名|响应文件|现场评审|成交后|未明确","condition":"适用条件，无则空串","quantity":"原文数量条件，无则空串","templateMode":"exact|content|flexible|unclear","checkpoints":["可核查条件"],"requiredMaterials":["须提供的材料"]}]}`;

/**
 * 从采购文件抽取要求台账。返回 {requirements, warnings, coverage}
 */
export async function extractLedger(model, procurementDocs, {onProgress, onCheckpoint, resume = {}} = {}) {
  const results = [];
  const warnings = [];
  const chunkResults = {...resume};
  const coverage = {files: procurementDocs.length, parsedFiles: 0, chunks: 0, doneChunks: 0};

  for (const doc of procurementDocs) {
    if (!doc.parsed || doc.parsed.unreadable) {
      warnings.push(`${doc.name}：正文未读取，无法抽取条款（需 OCR 或转格式）`);
      continue;
    }
    coverage.parsedFiles++;
    const chunks = chunkedDigest(doc.parsed, {maxChars: 2500});
    coverage.chunks += chunks.length;
    // 每轮最多两个请求，避免整本文件的单次长输出超时，同时保持台账顺序稳定。
    for (let start = 0; start < chunks.length; start += 2) {
      const batch = chunks.slice(start, start + 2);
      const responses = await Promise.all(batch.map(async (chunk, offset) => {
        const ci = start + offset;
        const key = `${doc.id}:${ci}:${stableHash(chunk.text)}`;
        if (Object.hasOwn(chunkResults,key)) return {ci,key,cached:chunkResults[key]};
        onProgress?.(`抽取《${doc.name}》第 ${ci + 1}/${chunks.length} 段…`);
        try { return {ci,key,obj: await model.json({system: SYSTEM, user: USER_TMPL(chunk.text, doc.name), maxTokens: 6000})}; }
        catch (error) { return {ci,key,error}; }
      }));
      for (const {ci, key, obj, cached, error} of responses) {
        if (error) {
          warnings.push(`${doc.name} 第 ${ci + 1} 段抽取失败：${error.message}`);
          continue;
        }
        coverage.doneChunks++;
        if (cached) { results.push(...cached); continue; }
        const items = Array.isArray(obj?.items) ? obj.items : [];
        const accepted = [];
        for (const it of items) {
          if (!it || !it.quote) continue;
          const v = verifyEvidence(doc.parsed, it.quote);
          if (!v.found || v.weak) {
            warnings.push(`${doc.name}：条款「${String(it.title || it.quote).slice(0, 18)}」引用未通过核验，已略去`);
            continue;
          }
          accepted.push(buildRequirement(it, v, doc));
        }
        chunkResults[key] = accepted;
        results.push(...accepted);
        await onCheckpoint?.({key,items:accepted,coverage:{...coverage},warnings:[...warnings]});
      }
    }
  }

  const deduped = dedupeRequirements(results);
  const recovered = recoverServiceRequirements(procurementDocs, deduped);
  const composition = recoverCompositionRequirements(procurementDocs,deduped);
  const scoring = await extractScoringTables(model,procurementDocs,{resume:chunkResults,onCheckpoint:async ({key,items})=>{
    chunkResults[key]=items;
    await onCheckpoint?.({key,items,coverage:{...coverage},warnings:[...warnings]});
  }});
  warnings.push(...scoring.warnings);
  const priceScoring=procurementDocs.map(recoverPriceScoring).filter(Boolean);
  if (recovered.length) warnings.push(`服务内容逐项覆盖检查补出 ${recovered.length} 条候选要求，请人工核对后确认。`);
  if(composition.length)warnings.push(`响应文件组成核对补出 ${composition.length} 条候选要求，请按采购原文核对。`);
  return {requirements: [...deduped, ...recovered, ...composition, ...scoring.requirements, ...priceScoring], warnings, coverage, chunkResults};
}

// 模型按块抽取可能漏掉连续编号的技术服务条目；仅补入待确认台账，不自动判为缺项。
export function recoverServiceRequirements(docs, existing) {
  const added=[];
  const covered=existing.map(r=>norm(r.quote));
  for(const doc of docs){
    const paragraphs=doc.parsed?.paragraphs||[];
    let inService=false;
    for(let i=0;i<paragraphs.length;i++){
      const quote=String(paragraphs[i]?.text||'').trim();
      if(/^三[、．.]\s*服务内容/.test(quote)){inService=true;continue;}
      if(inService && /^四[、．.]\s*(?:安全|质量|人员|商务)/.test(quote)){inService=false;continue;}
      if(!inService || quote.length<25 || quote.length>1500)continue;
      if(covered.some(q=>q.includes(norm(quote)) || norm(quote).includes(q) && q.length>=norm(quote).length*.75))continue;
      if(!/^(?:\d+[、．.]|（[一二三四五六]）)/.test(quote))continue;
      const verified=verifyEvidence(doc.parsed,quote);
      if(!verified.found || verified.weak)continue;
      const title=quote.replace(/^(?:\d+[、．.]|（[一二三四五六]）)\s*/,'').split(/[：:。]/)[0].slice(0,28);
      const req=buildRequirement({title,type:'param',source:'服务内容',checkpoints:[title]},verified,doc);
      req.origin='coverage';req.reviewScope='audit';req.reviewScopeReason='服务内容逐项覆盖补漏，待人工核对';
      added.push(req);covered.push(norm(quote));
    }
  }
  return added;
}

function normalizeType(t) {
  const s = String(t || '').toLowerCase();
  if (REQ_TYPES[s]) return s;
  if (/资格|资质/.test(t)) return 'qualification';
  if (/实质|否决|强制|★|▲/.test(t)) return 'substantive';
  if (/组成|材料|清单|目录/.test(t)) return 'material';
  if (/参数|技术|指标|性能/.test(t)) return 'param';
  if (/商务|交期|工期|质保|报价|付款/.test(t)) return 'commercial';
  if (/评分|得分|分值|加分/.test(t)) return 'scoring';
  if (/格式|签章|签|递交|装订|份数/.test(t)) return 'format';
  return 'substantive';
}

function buildRequirement(it, verified, doc) {
  const type = normalizeType(it.type || it.kind);
  const req = {
    stableId: requirementStableId({quote: verified.quote, title: it.title}),
    title: String(it.title || '').slice(0, 60) || verified.quote.slice(0, 24),
    type,
    typeLabel: REQ_TYPES[type]?.label || type,
    quote: verified.quote,
    source: String(it.source || '').slice(0, 60),
    mark: String(it.mark || '').slice(0, 4),
    score: numOrNull(it.score) ?? guessScore(verified.quote, type),
    consequence: String(it.consequence || '').slice(0, 200),
    nature: ['mandatory','scoring','conditional','manual','unclear'].includes(it.nature)?it.nature:'unclear',
    submissionStage:String(it.submissionStage||'未明确').slice(0,20),
    condition:String(it.condition||'').slice(0,180),quantity:String(it.quantity||'').slice(0,100),
    templateMode:['exact','content','flexible','unclear'].includes(it.templateMode)?it.templateMode:'unclear',
    checkpoints: Array.isArray(it.checkpoints) ? it.checkpoints.map((x) => String(x).slice(0, 160)).slice(0, 8) : [],
    requiredMaterials: Array.isArray(it.requiredMaterials) ? it.requiredMaterials.map((x) => String(x).slice(0, 100)).slice(0, 8) : [],
    fileId: doc.id,
    fileName: doc.name,
    locator: verified.locator,
    owner: '',
    status: 'pending',        // 待人工确认
    statusLabel: '待确认',
    locked: false,
    origin: 'ai',             // ai | manual
    verifyConclusion: '',
    manualConclusion: '',
    editedAt: null,
    createdAt: new Date().toLocaleString('zh-CN', {hour12: false}),
  };
  return req;
}

function numOrNull(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v ?? '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// 从评分项原文兜底提取该项满分（如「价格分（30 分）」「技术分 50 分」）
function guessScore(quote, type) {
  if (type !== 'scoring') return null;
  const m = String(quote || '').match(/(?:价格分|技术分|商务分|该项|满分|分值)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*分/);
  return m ? parseFloat(m[1]) : null;
}

function dedupeRequirements(items) {
  const seen = new Map();
  for (const it of items) {
    const key = norm(it.quote).slice(0, 70);
    if (!seen.has(key)) seen.set(key, it);
    else {
      // 合并核查点与材料
      const exist = seen.get(key);
      for (const c of it.checkpoints) if (!exist.checkpoints.includes(c)) exist.checkpoints.push(c);
      for (const m of it.requiredMaterials) if (!exist.requiredMaterials.includes(m)) exist.requiredMaterials.push(m);
    }
  }
  return [...seen.values()];
}

/**
 * 台账编辑：拆分/合并/纠错/补充。保持原始引文不可覆盖（需求 P1-01）。
 * 返回新的 requirements 数组（不落库，由调用方保存）。
 */
export function applyLedgerEdit(requirements, {action, payload} = {}) {
  const list = [...requirements];
  // 支持两种调用方式：{action:'confirm'} 或 {action:'edit', payload:{action:'confirm'}}
  const op = payload?.action || action;
  const idx = payload?.stableId ? list.findIndex((r) => r.stableId === payload.stableId) : -1;

  if (op === 'confirm') {
    if (idx >= 0) { list[idx] = {...list[idx], status: 'confirmed', statusLabel: '已确认', locked: true, editedAt: now()}; }
  } else if (op === 'exclude') {
    if (idx >= 0) { list[idx] = {...list[idx], status: 'excluded', statusLabel: '不纳入审核', excludeReason: String(payload.reason || '').trim().slice(0, 200), locked: true, editedAt: now()}; }
  } else if (op === 'batchConfirm' || op === 'batchExclude') {
    const ids = new Set((payload.stableIds || []).slice(0, 50));
    for (let i = 0; i < list.length; i++) {
      if (!ids.has(list[i].stableId) || list[i].status !== 'pending') continue;
      list[i] = op === 'batchConfirm'
        ? {...list[i], status:'confirmed', statusLabel:'已确认', locked:true, editedAt:now()}
        : {...list[i], status:'excluded', statusLabel:'不纳入审核', excludeReason:String(payload.reason || '').trim().slice(0,200), locked:true, editedAt:now()};
    }
  } else if (op === 'scope') {
    if (idx >= 0 && ['audit','manual','reference'].includes(payload.reviewScope)) {
      list[idx] = {...list[idx], reviewScope:payload.reviewScope, reviewScopeReason:'负责人手工调整', status:'pending', statusLabel:'待确认', locked:false, editedAt:now()};
    }
  } else if (op === 'reopen') {
    if (idx >= 0) { list[idx] = {...list[idx], status: 'pending', statusLabel: '待确认', locked: false, editedAt: now()}; }
  } else if (op === 'update') {
    if (idx >= 0) {
      const base = list[idx];
      const patch = {};
      for (const k of ['title', 'type', 'source', 'mark', 'consequence', 'owner', 'checkpoints', 'requiredMaterials']) {
        if (payload[k] !== undefined) patch[k] = payload[k];
      }
      if (patch.type) patch.typeLabel = REQ_TYPES[patch.type]?.label || patch.type;
      // 原始引文 quote 不可覆盖
      list[idx] = {...base, ...patch, editedAt: now()};
    }
  } else if (op === 'split') {
    // 把一条要求拆成两条，各自截图核查点
    if (idx >= 0) {
      const base = list[idx];
      const groups = Array.isArray(payload.groups) ? payload.groups : [];
      const made = groups.map((g, k) => ({
        ...base,
        stableId: 'R' + stableHash(norm(base.quote) + '#split' + k + '-' + norm(g.title || '')),
        title: String(g.title || base.title + '（拆分' + (k + 1) + '）').slice(0, 60),
        checkpoints: (g.checkpoints || []).map((x) => String(x).slice(0, 160)),
        requiredMaterials: (g.requiredMaterials || base.requiredMaterials || []).map((x) => String(x).slice(0, 100)),
        origin: 'manual',
        status: 'pending',
        statusLabel: '待确认',
        locked: false,
        editedAt: now(),
      }));
      if (made.length) list.splice(idx, 1, ...made);
    }
  } else if (op === 'merge') {
    const ids = Array.isArray(payload.stableIds) ? payload.stableIds : [];
    const group = list.filter((r) => ids.includes(r.stableId));
    if (group.length >= 2) {
      const first = group[0];
      const merged = {
        ...first,
        stableId: 'R' + stableHash(ids.slice().sort().join('|')),
        title: String(payload.title || first.title).slice(0, 60),
        checkpoints: [...new Set(group.flatMap((g) => g.checkpoints))].slice(0, 12),
        requiredMaterials: [...new Set(group.flatMap((g) => g.requiredMaterials))].slice(0, 12),
        quotes: group.map((g) => ({quote: g.quote, locator: g.locator, fileName: g.fileName})),
        origin: 'manual', status: 'pending', statusLabel: '待确认', locked: false, editedAt: now(),
      };
      list.splice(0, list.length, ...list.filter((r) => !ids.includes(r.stableId)));
      list.push(merged);
    }
  } else if (op === 'add') {
    const it = payload.req || {};
    const quote = String(it.quote || '').trim();
    const req = {
      stableId: 'R' + stableHash('manual-' + quote + '-' + Date.now()),
      title: String(it.title || quote.slice(0, 24) || '手工补充要求').slice(0, 60),
      type: normalizeType(it.type),
      typeLabel: REQ_TYPES[normalizeType(it.type)]?.label,
      quote,
      source: String(it.source || '人工补充').slice(0, 60),
      mark: String(it.mark || '').slice(0, 4),
      consequence: String(it.consequence || '').slice(0, 200),
      checkpoints: Array.isArray(it.checkpoints) ? it.checkpoints : [],
      requiredMaterials: Array.isArray(it.requiredMaterials) ? it.requiredMaterials : [],
      fileId: it.fileId || null,
      fileName: it.fileName || '',
      locator: it.locator || null,
      owner: String(it.owner || '').slice(0, 40),
      status: 'pending', statusLabel: '待确认', locked: false, origin: 'manual',
      verifyConclusion: '', manualConclusion: '', editedAt: now(),
      createdAt: now(),
    };
    list.push(req);
  } else if (op === 'remove') {
    return list.filter((r) => r.stableId !== payload.stableId);
  }
  return list;
}

function now() {
  return new Date().toLocaleString('zh-CN', {hour12: false});
}

/** 台账确认率（项目进度指标）。 */
export function ledgerStats(requirements) {
  const total = requirements.length;
  const confirmed = requirements.filter((r) => r.status === 'confirmed').length;
  const pending = requirements.filter((r) => r.status === 'pending').length;
  const excluded = requirements.filter((r) => r.status === 'excluded').length;
  return {total, confirmed, excluded, pending, rate: total ? Math.round(((confirmed + excluded) / total) * 100) : 0};
}

/**
 * 补遗影响分析：对比抽取前后的要求集合，输出新增/删除/修改。
 * 用于补遗文件上传后提示「哪些要求受到影响、哪些任务和章节需要跟进」。
 */
export function diffLedger(before, after) {
  const bMap = new Map(before.map((r) => [r.stableId, r]));
  const aMap = new Map(after.map((r) => [r.stableId, r]));
  const added = after.filter((r) => !bMap.has(r.stableId));
  const removed = before.filter((r) => !aMap.has(r.stableId));
  const changed = [];
  for (const r of after) {
    const old = bMap.get(r.stableId);
    if (!old) continue;
    const fields = [];
    if (old.consequence !== r.consequence) fields.push('后果');
    if (old.mark !== r.mark) fields.push('标记');
    if ((old.checkpoints || []).join('|') !== (r.checkpoints || []).join('|')) fields.push('核查点');
    if (old.type !== r.type) fields.push('类型');
    if (fields.length) changed.push({stableId: r.stableId, title: r.title, fields});
  }
  return {
    added: added.map((r) => ({stableId: r.stableId, title: r.title, type: r.typeLabel || r.type, quote: (r.quote || '').slice(0, 120)})),
    removed: removed.map((r) => ({stableId: r.stableId, title: r.title, quote: (r.quote || '').slice(0, 120)})),
    changed,
    summary: {added: added.length, removed: removed.length, changed: changed.length},
  };
}

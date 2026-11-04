// 审核任务编排（P1-02/P0-08）：
//   1) 每次审核绑定固定快照（采购文件 + 投标包版本、文件哈希、规则版本、模型配置）；
//   2) 分阶段推进六类检查，每阶段可中断续跑；
//   3) 记录每个文件/要求的处理状态，产出覆盖率，作为放行门槛。
import crypto from 'node:crypto';
import {CHECK_ORDER, CHECKS, stableHash} from './domain.mjs';
import {buildBidPackages, buildProcurementIndexes, procurementCoverage} from './audit-core.mjs';
import {runCompleteness, runResponse, runScoring, runConsistency, runFormat, runCross} from './checks.mjs';
import {summarizeItems, nowStr} from './items.mjs';
import {log, logError} from '../util/log.mjs';
import {CHECKS as CHECKS_DEF} from './domain.mjs';
import {priorityRequirements} from './priority.mjs';

export const RULES_VERSION = '2.0.0';

export function fileHash(doc) {
  return doc.hash || stableHash([doc.id, doc.name, doc.size, doc.version, doc.uploadedAt].join('|'));
}

/** 计算项目当前输入的指纹（文件哈希 + 要求集合 + 版本）。输入一变，审计结果即失效。 */
export function inputsFingerprint(project) {
  const docs = (project.docs || [])
    .filter((d) => d.version === project.currentVersion || ['procurement', 'supplement'].includes(d.category || ''))
    .map((d) => fileHash(d))
    .sort();
  const reqs = (project.focusIds?.length ? (project.requirements || []).filter(r => project.focusIds.includes(r.stableId)) : priorityRequirements(project.requirements || []))
    .map((r) => stableHash(JSON.stringify([r.stableId, r.type, r.title, r.quote, r.checkpoints, r.mark, r.consequence, r.score]))).sort();
  return stableHash([project.currentVersion, ...docs, '|', ...reqs].join('|'));
}

/** 生成审核快照（P1-02/P0-3）。记录并锁定输入指纹。 */
export function makeSnapshot(project, model) {
  const pm = model?.getPublic?.() || {};
  const procurement = project.docs.filter((d) => ['procurement', 'supplement'].includes(d.category || (d.role === 'procurement' ? 'procurement' : '')));
  const bid = project.docs.filter((d) => !['procurement', 'supplement'].includes(d.category || '') && d.role !== 'procurement');
  return {
    takenAt: nowStr(),
    version: project.currentVersion,
    inputsHash: inputsFingerprint(project),
    procurement: procurement.map((d) => ({id: d.id, name: d.name, category: d.category, hash: fileHash(d), parsed: !!d.parsed && !d.parsed.unreadable})),
    bid: bid.map((d) => ({id: d.id, name: d.name, category: d.category, entityId: d.entityId, entityName: d.entityName, hash: fileHash(d), parsed: !!d.parsed && !d.parsed.unreadable})),
    rulesVersion: RULES_VERSION,
    model: {name: pm.name || 'unknown', baseUrl: pm.baseUrl || ''},
    requirementIds: (project.focusIds?.length ? project.focusIds : priorityRequirements(project.requirements || []).map(r => r.stableId)),
  };
}

export function createAudit(project, model) {
  return {
    id: 'audit-' + Date.now().toString(36),
    status: 'pending',      // pending|running|blocked|done|error
    startedAt: nowStr(),
    finishedAt: null,
    snapshot: makeSnapshot(project, model),
    stage: 0,               // 已完成的检查序号
    stageLabel: '准备',
    message: '准备审核…',
    progress: 0,
    error: null,
    warnings: [],
    results: {},            // check -> {items, coverage}
    items: [],              // 汇总后的工作单
    coverage: null,
    summary: null,
    version: project.currentVersion,
  };
}

/**
 * 分步推进审核。每次调用只做一类检查，便于前端展示进度与续跑。
 * 返回更新后的 audit（由调用方写回项目）。
 */
export async function stepAudit({model, project, audit, onProgress}) {
  try {
    if (audit.snapshot?.inputsHash !== inputsFingerprint(project)) {
      audit.status = 'stale';
      audit.staleReason = '审核期间文件或已确认要求发生变化';
      audit.message = '审核输入已变化，请重新发起审核';
      return audit;
    }
    audit.status = 'running';
    audit.error = null;
    const requirements = project.focusIds?.length
      ? (project.requirements || []).filter(r => project.focusIds.includes(r.stableId))
      : priorityRequirements(project.requirements || []);
    if (!requirements.length) {
      audit.status = 'blocked';
      audit.message = '尚未确认招标要求台账，请先在「招标要求台账」抽取并确认要求';
      audit.error = '要求台账为空';
      return audit;
    }

    const progress = (m) => { audit.message = m; onProgress?.(m); };

    // 阶段 0：准备索引（不耗模型）
    if (audit.stage === 0) {
      progress('构建全文索引与投标包…');
      const {indexes: procIdx, docs: procDocs} = buildProcurementIndexes(project);
      const packages = buildBidPackages(project);
      if (!packages.length) {
        audit.status = 'blocked';
        audit.error = '当前版本没有可读的投标文件，请上传或修复解析';
        audit.message = audit.error;
        return audit;
      }
      audit._packages = packages.map((p) => ({entityId: p.entityId, entityName: p.entityName, docs: p.docs.map((d) => d.id)}));
      audit._procIndexCount = procIdx.length;
      audit.stage = 1;
      audit.progress = 4;
      audit.stageLabel = CHECKS.completeness.label;
      return audit;
    }

    // 重新构建索引（每次 step 独立，可从 project 恢复）
    const packages = buildBidPackages(project);

    // 阶段 1：完整性（按包）
    if (audit.stage === 1) {
      return await advanceBatch({audit, packages, requirements, types:['material','qualification'],
        key:'completeness', nextStage:2, start:4, end:20,
        run:(pkg, batch)=>runCompleteness({model,pkg,requirements:batch,onProgress:progress})});
    }

    // 阶段 2：资格与实质响应
    if (audit.stage === 2) {
      return await advanceBatch({audit, packages, requirements, types:['substantive','qualification','param','commercial'],
        key:'response', nextStage:3, start:20, end:42,
        run:(pkg,batch)=>runResponse({model,pkg,requirements:batch,priceContextRequirements:requirements,onProgress:progress})});
    }

    // 阶段 3：评分点
    if (audit.stage === 3) {
      return await advanceBatch({audit, packages, requirements, types:['scoring'],
        key:'scoring', nextStage:4, start:42, end:62,
        run:(pkg,batch)=>runScoring({model,pkg,requirements:batch,priceContext:project.priceContext,onProgress:progress}),
        transform:item=>({...item,check:'response',checkLabel:'实质性响应',extra:{...item.extra,originalCheck:'scoring'}})});
    }

    // 阶段 4：全书一致性
    if (audit.stage === 4) {
      audit.stageLabel = CHECKS.consistency.label;
      const items = [];
      for (const pkg of packages) {
        const r = await runConsistency({model, pkg, onProgress: progress});
        items.push(...r.items.map((item) => ({...item, check: 'response', checkLabel: '实质性响应', extra: {...item.extra, originalCheck: 'consistency'}})));
      }
      audit.results.consistency = {items, coverage: {entityCount: packages.length}};
      audit.stage = 5; audit.progress = 74;
      return audit;
    }

    // 阶段 5：格式与交付
    if (audit.stage === 5) {
      return await advanceBatch({audit, packages, requirements, types:['format'],
        key:'format', nextStage:6, start:74, end:84,
        run:(pkg,batch)=>runFormat({model,pkg,requirements:batch,onProgress:progress})});
    }

    // 阶段 6：多主体互查
    if (audit.stage === 6) {
      audit.stageLabel = CHECKS.cross.label;
      const r = runCross(packages, buildProcurementIndexes(project).indexes);
      audit.results.cross = {items: r.items, coverage: r.coverage};
      audit.stage = 7; audit.progress = 92;
      return audit;
    }

    // 阶段 7：汇总 + 覆盖率 + 快照收尾
    if (audit.stage === 7) {
      progress('汇总问题与覆盖率…');
      const all = CHECK_ORDER.flatMap((c) => audit.results[c]?.items || []);
      audit.items = all;
      audit.summary = summarizeItems(all);
      audit.coverage = computeCoverage({project, requirements, packages, items: all});
      audit.status = 'done';
      audit.finishedAt = nowStr();
      audit.progress = 100;
      audit.stageLabel = '完成';
      audit.message = `审核完成：共 ${all.length} 个问题项，其中致命/高风险 ${audit.summary.critical + all.filter((i) => i.risk === 'high' && i.status !== 'closed').length} 条`;
      audit.stage = 8;
      log(`审核完成：${project.name} 问题 ${all.length} 项`);
      return audit;
    }

    return audit;
  } catch (e) {
    audit.status = 'error';
    audit.error = String(e.message || e).slice(0, 400);
    logError('审核中断，可续跑', e);
    return audit;
  }
}

/**
 * 覆盖率（P0-08）：
 *   - 文件覆盖率：可读文件 / 全部文件
 *   - 要求覆盖率：有明确判断结论（非 uncovered/unknown）的要求 / 已确认要求
 * 用于放行门槛：关键文件不可解析或关键条款未核查时，不允许显示「可交标」。
 */
export async function advanceBatch({audit, packages, requirements, types, key, nextStage, start, end, run, transform=x=>x}) {
  const selected=requirements.filter(r=>types.includes(r.type));
  const size=5, perPackage=Math.max(1,Math.ceil(selected.length/size));
  const cursor=audit.batch?.stage===audit.stage ? audit.batch : {stage:audit.stage,packageIndex:0,offset:0};
  audit.results[key] ||= {items:[],coverage:{requirements:selected.length,entityCount:packages.length}};
  audit.stageLabel=CHECKS[key]?.label || key;
  if(selected.length && cursor.packageIndex<packages.length) {
    const pkg=packages[cursor.packageIndex];
    const batch=selected.slice(cursor.offset,cursor.offset+size);
    audit.message=`${audit.stageLabel}：${pkg.entityName}，${Math.min(cursor.offset+batch.length,selected.length)}/${selected.length} 项`;
    const result=await run(pkg,batch);
    audit.results[key].items.push(...result.items.map(transform));
    if(result.priceFindings?.length) audit.priceFindings=[...(audit.priceFindings||[]),...result.priceFindings];
    cursor.offset+=batch.length;
    if(cursor.offset>=selected.length){cursor.packageIndex++;cursor.offset=0;}
  } else cursor.packageIndex=packages.length;
  const completed=Math.min(packages.length*perPackage,cursor.packageIndex*perPackage+Math.ceil(cursor.offset/size));
  audit.progress=start+Math.floor((end-start)*completed/(packages.length*perPackage||1));
  audit.batch=cursor;
  audit.items=CHECK_ORDER.flatMap(c=>audit.results[c]?.items||[]);
  if(cursor.packageIndex>=packages.length){audit.stage=nextStage;audit.batch=null;audit.progress=end;}
  return audit;
}

export function computeCoverage({project, requirements, packages, items}) {
  const procCov = procurementCoverage(project);
  const bidDocs = project.docs.filter((d) => d.role !== 'procurement' && !['procurement', 'supplement'].includes(d.category || '') && d.version === project.currentVersion);
  const bidParsed = bidDocs.filter((d) => d.parsed && !d.parsed.unreadable);
  const confirmedReq = requirements;
  // 每条已确认要求在各包的判断结果里是否「已核查」
  const judged = new Set();
  for (const it of items) {
    if (it.requirementId && ['satisfied', 'partial', 'violated', 'notFound'].includes(it.checkStatus)) judged.add(it.requirementId);
  }
  const reqCovered = confirmedReq.filter((r) => judged.has(r.stableId)).length;
  return {
    files: {
      procurement: procCov,
      bid: {total: bidDocs.length, parsed: bidParsed.length, unreadable: bidDocs.filter((d) => !d.parsed || d.parsed.unreadable).map((d) => ({id: d.id, name: d.name}))},
      fileRate: (procCov.total + bidDocs.length) ? Math.round(((procCov.parsed + bidParsed.length) / (procCov.total + bidDocs.length)) * 100) : 0,
    },
    requirements: {
      confirmed: confirmedReq.length,
      total: requirements.length,
      judged: reqCovered,
      rate: confirmedReq.length ? Math.round((reqCovered / confirmedReq.length) * 100) : 0,
    },
    packages: packages.map((p) => ({entity: p.entityName, docs: p.docs.length, indexes: p.indexes.length})),
  };
}

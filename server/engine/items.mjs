// 问题工作单（整个系统的核心数据结构）与响应矩阵。
// 对应需求书第三节 6「问题工作单」与第三节 4「响应矩阵」。
import {ITEM_RISK, ITEM_STATUS, CHECKS, CHECK_STATUS, itemStableKey, requirementStableId} from './domain.mjs';

let seq = 0;

/**
 * 构造一条问题工作单。
 * 所有字段都围绕「能不能被售前直接处理」：招标依据 / 投标现状 / 具体缺口 / 修改动作 / 不能编造 / 责任人时限复核 / 状态与操作记录。
 */
export function makeItem({
  check,                    // completeness|response|scoring|consistency|format|cross
  issueType,                // 稳定问题类型（用于跨版本匹配）
  title,
  risk = 'mid',
  requirementId = null,
  requirement = null,       // {title, quote, source, mark, locator, fileId, fileName, consequence, checkpoints}
  entityId = null,
  entityName = '',
  evidence = [],            // [{fileId, fileName, role, quote, locator, grade, weak}]
  gap = '',                 // 具体缺口：哪个核查点不满足
  action = '',              // 修改动作：改哪份文件、哪个章节、补什么材料
  suggestedText = '',
  cannotInvent = [],
  acceptance = '',
  assignee = '',
  due = '',
  reviewer = '',
  checkStatus = 'unknown',  // CHECK_STATUS key
  aiFixable = false,
  extra = {},
}) {
  seq++;
  const stableRequirementId = requirementId || (requirement ? requirementStableId(requirement) : null);
  return {
    id: `i${Date.now().toString(36)}-${seq}`,
    stableKey: itemStableKey({requirementId: stableRequirementId, entityId, issueType}),
    check,
    checkLabel: CHECKS[check]?.label || check,
    issueType,
    title: String(title || '').slice(0, 100),
    risk,
    riskLabel: ITEM_RISK[risk]?.label || risk,
    requirementId: stableRequirementId,
    requirement,
    entityId,
    entityName,
    evidence: normalizeEvidence(evidence),
    gap: String(gap || '').slice(0, 500),
    action: String(action || '').slice(0, 500),
    suggestedText: String(suggestedText || '').slice(0, 1500),
    cannotInvent: Array.isArray(cannotInvent) ? cannotInvent.slice(0, 8).map((x) => String(x).slice(0, 120)) : [],
    acceptance: String(acceptance || '').slice(0, 240),
    assignee: String(assignee || '').slice(0, 40),
    due: String(due || '').slice(0, 40),
    reviewer: String(reviewer || '').slice(0, 40),
    status: 'todo',
    statusLabel: ITEM_STATUS.todo.label,
    checkStatus,
    aiFixable: !!aiFixable,
    history: [{time: nowStr(), from: null, to: 'todo', by: '系统', note: '自动生成问题'}],
    comments: [],
    extra,
    createdAt: nowStr(),
    updatedAt: nowStr(),
  };
}

function normalizeEvidence(list) {
  return (list || []).map((e) => ({
    fileId: e.fileId || null,
    fileName: e.fileName || '',
    role: e.role || 'bid',
    quote: String(e.quote || '').slice(0, 800),
    locator: e.locator || null,
    grade: e.grade || 'none',
    weak: !!e.weak,
  }));
}

export function nowStr() {
  return new Date().toLocaleString('zh-CN', {hour12: false});
}

export const isActionableItem = it => ['partial','notFound','violated','uncovered'].includes(it?.checkStatus);

/** 构建响应矩阵：以招标要求为行，投标证据 + 处理状态为列。 */
export function buildMatrix(requirements, items) {
  const byReq = new Map();
  for (const it of items) {
    if (!it.requirementId) continue;
    if (!byReq.has(it.requirementId)) byReq.set(it.requirementId, []);
    byReq.get(it.requirementId).push(it);
  }
  return requirements.map((req) => {
    const related = byReq.get(req.stableId) || [];
    // 默认「未审核」：台账确认 ≠ 审核通过。只有存在对应标书的有效结论才改变状态（P0 修复）。
    // 决策优先级：明确不满足 > 未检出 > 部分满足 > 无法确认 > 未覆盖 > 已满足
    const rank = { violated: 5, notFound: 4, partial: 3, unknown: 2, uncovered: 1, satisfied: 0 };
    let status = 'unaudited';
    let driver = null;
    for (const it of related) {
      const cs = it.checkStatus || 'unknown';
      if ((rank[cs] ?? 0) > (rank[status] ?? -1)) { status = cs; driver = it; }
    }
    // 仅当有明确的 satisfied 结论、且至少有一条非「未审核」结论时才可能显示已满足
    if (related.length === 0) status = 'unaudited';
    const evidence = [];
    for (const it of related) {
      for (const e of it.evidence || []) {
        if (!evidence.some((x) => x.fileId === e.fileId && x.quote === e.quote)) evidence.push(e);
      }
    }
    return {
      requirementId: req.stableId,
      title: req.title,
      type: req.type,
      typeLabel: req.typeLabel,
      quote: req.quote,
      locator: req.locator,
      fileName: req.fileName,
      mark: req.mark,
      consequence: req.consequence,
      checkpoints: req.checkpoints || [],
      requiredMaterials: req.requiredMaterials || [],
      owner: req.owner || '',
      status,
      statusLabel: CHECK_STATUS[status]?.label || status,
      itemIds: related.map((x) => x.id),
      openItems: related.filter((x) => isActionableItem(x) && !['closed', 'dismissed'].includes(x.status)).length,
      evidence,
      verifyConclusion: req.verifyConclusion || '',
      manualConclusion: req.manualConclusion || '',
    };
  });
}

/** 问题统计（工作台首页 & 概览）。 */
export function summarizeItems(items) {
  const open = (it) => isActionableItem(it) && !['closed', 'dismissed'].includes(it.status);
  const openItems = items.filter(open);
  const byRisk = {critical: 0, high: 0, mid: 0, low: 0};
  const byCheck = {};
  for (const it of openItems) {
    byRisk[it.risk] = (byRisk[it.risk] || 0) + 1;
    byCheck[it.check] = (byCheck[it.check] || 0) + 1;
  }
  return {
    total: items.filter(isActionableItem).length,
    open: openItems.length,
    closed: items.filter((it) => isActionableItem(it) && it.status === 'closed').length,
    dismissed: items.filter((it) => isActionableItem(it) && it.status === 'dismissed').length,
    byRisk,
    byCheck,
    critical: byRisk.critical,
    high: byRisk.high,
  };
}

// 合法流转表（P1）：防止跳步关闭。
// todo→editing；editing→reviewing/returned；reviewing→closed/returned；returned→editing；
// 任意未关闭态→dismissed；closed/dismissed 可回 todo 重开。
const ALLOWED = {
  todo: ['editing', 'dismissed'],
  confirming: ['editing', 'confirmed', 'dismissed'],
  confirmed: ['editing', 'dismissed'],
  editing: ['reviewing', 'returned', 'dismissed'],
  reviewing: ['closed', 'returned', 'editing'],
  returned: ['editing', 'dismissed'],
  closed: ['reviewing', 'todo'],
  dismissed: ['todo'],
};

export function applyItemTransition(item, toStatus, {by = '系统', note = '', force = false} = {}) {
  const from = item.status;
  if (!force && !ITEM_STATUS[toStatus]) return {ok: false, error: '未知的问题状态'};
  if (!force && toStatus === 'dismissed' && String(note).trim().length < 4) return {ok: false, error: '标记无需修改须填写至少 4 字理由'};
  if (!force && toStatus === 'reviewing' && (!item.assignee?.trim() || (!(item.proofs || []).length && !note.trim()))) {
    return {ok: false, error: '提交复核前需填写负责人，并上传补证或填写修改说明'};
  }
  if (!force && toStatus === 'closed' && (!item.reviewer?.trim() || !by.trim())) {
    return {ok: false, error: '关闭问题前需填写复核人'};
  }
  // 高风险问题关闭必须有说明或补证，且必须来自复核态（除 force）
  if (toStatus === 'closed' && !force) {
    const isHigh = ['critical', 'high'].includes(item.risk);
    const hasProofOrNote = (item.proofs || []).length > 0 || (note && note.trim().length >= 4);
    if (isHigh && from !== 'reviewing' && from !== 'closed') {
      return {ok: false, error: '高风险问题必须经「提交复核」后才能关闭，不能直接关闭'};
    }
    if (isHigh && !hasProofOrNote) {
      return {ok: false, error: '高风险问题关闭需提供新版证据或书面复核说明'};
    }
  }
  if (!force && ALLOWED[from] && !ALLOWED[from].includes(toStatus) && from !== toStatus) {
    return {ok: false, error: `不允许从「${ITEM_STATUS[from]?.label || from}」直接流转到「${ITEM_STATUS[toStatus]?.label || toStatus}」`};
  }
  item.status = toStatus;
  item.statusLabel = ITEM_STATUS[toStatus]?.label || toStatus;
  item.updatedAt = nowStr();
  item.history.push({time: nowStr(), from, to: toStatus, by, note});
  return {ok: true, item};
}

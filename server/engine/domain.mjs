// 领域常量与稳定标识工具。
// 覆盖需求书「二、当前问题」与「三、完整功能设计」里的状态词表：
// 要求类型、要求状态、核对结论、问题风险、工作单状态、文件类别、证据等级。

// ---- 招标要求类型（第三节 3. 要求台账）----
export const REQ_TYPES = {
  qualification: {key: 'qualification', label: '资格条件'},
  substantive: {key: 'substantive', label: '实质响应'},
  material: {key: 'material', label: '组成材料'},
  param: {key: 'param', label: '技术参数'},
  commercial: {key: 'commercial', label: '商务条件'},
  scoring: {key: 'scoring', label: '评分项'},
  format: {key: 'format', label: '格式要求'},
};
export const REQ_TYPE_KEYS = Object.keys(REQ_TYPES);

// ---- 招标要求处理状态（台账）----
export const REQ_STATUS = {
  pending: {key: 'pending', label: '待确认', tone: 'warn'},
  confirmed: {key: 'confirmed', label: '已确认', tone: 'brand'},
  responded: {key: 'responded', label: '已响应', tone: 'ok'},
  needEvidence: {key: 'needEvidence', label: '待补证', tone: 'danger'},
  unknown: {key: 'unknown', label: '无法确认', tone: 'neutral'},
};

// ---- 响应矩阵核对结论（第三节 4）----
// 必须区分「未检出」与「明确不满足」。
export const CHECK_STATUS = {
  unaudited: {key: 'unaudited', label: '未审核', tone: 'neutral'},
  satisfied: {key: 'satisfied', label: '已满足', tone: 'ok'},
  partial: {key: 'partial', label: '部分满足', tone: 'warn'},
  notFound: {key: 'notFound', label: '未检出', tone: 'warn'},
  violated: {key: 'violated', label: '明确不满足', tone: 'danger'},
  unknown: {key: 'unknown', label: '无法确认', tone: 'neutral'},
  uncovered: {key: 'uncovered', label: '未覆盖', tone: 'neutral'},
};

// ---- 问题风险级别（第三节 6）----
export const ITEM_RISK = {
  critical: {key: 'critical', label: '致命风险', tone: 'danger', order: 0},
  high: {key: 'high', label: '高风险', tone: 'danger', order: 1},
  mid: {key: 'mid', label: '中风险', tone: 'warn', order: 2},
  low: {key: 'low', label: '提示', tone: 'neutral', order: 3},
};

// ---- 问题工作单状态流转（第三节 6）----
export const ITEM_STATUS = {
  todo: {key: 'todo', label: '待分派', tone: 'warn'},
  editing: {key: 'editing', label: '修改中', tone: 'brand'},
  reviewing: {key: 'reviewing', label: '待复核', tone: 'brand'},
  returned: {key: 'returned', label: '退回修改', tone: 'danger'},
  closed: {key: 'closed', label: '已关闭', tone: 'ok'},
  confirming: {key: 'confirming', label: '待人工确认', tone: 'neutral'},
  confirmed: {key: 'confirmed', label: '已确认问题', tone: 'danger'},
  dismissed: {key: 'dismissed', label: '非问题', tone: 'neutral'},
};

// ---- 文件类别（第二节 2）----
export const FILE_CATEGORIES = {
  procurement: {key: 'procurement', label: '招标文件及附件', role: 'procurement'},
  supplement: {key: 'supplement', label: '澄清/答疑/补遗', role: 'procurement'},
  bid: {key: 'bid', label: '投标正文', role: 'bid'},
  qualification: {key: 'qualification', label: '资格证明', role: 'bid'},
  technical: {key: 'technical', label: '技术材料', role: 'bid'},
  commercial: {key: 'commercial', label: '商务材料', role: 'bid'},
  price: {key: 'price', label: '报价文件', role: 'bid'},
  other: {key: 'other', label: '其他附件', role: 'bid'},
};
export const FILE_CATEGORY_KEYS = Object.keys(FILE_CATEGORIES);

// ---- 证据等级（P0-03）----
export const EVIDENCE_GRADE = {
  exact: {key: 'exact', label: '精确原文', strong: true},
  normalized: {key: 'normalized', label: '规范化匹配', strong: true},
  fuzzy: {key: 'fuzzy', label: '部分相似', strong: false},
  none: {key: 'none', label: '无证据', strong: false},
};

// ---- 六类检查模块（第三节 5）----
export const CHECKS = {
  completeness: {key: 'completeness', label: '完整性检查', purpose: '要求的文件、章节、附件是否齐全'},
  response: {key: 'response', label: '资格与实质响应', purpose: '资质、有效期、参数、商务条件、★▲条款及否决项'},
  scoring: {key: 'scoring', label: '评分点检查', purpose: '客观得分证据、失分点、价格公式输入、主观待完善项'},
  consistency: {key: 'consistency', label: '全书一致性检查', purpose: '名称、型号、数量、交期、质保、报价、偏离表与正文矛盾'},
  format: {key: 'format', label: '格式与交付检查', purpose: '文件命名、签字盖章、目录、附件索引、指定格式、声明'},
  cross: {key: 'cross', label: '多主体互查', purpose: '仅呈现需核实的事实线索，不作违规认定'},
};
export const CHECK_ORDER = Object.keys(CHECKS);

/** 稳定哈希（32 位 FNV-1a），用于跨版本稳定 ID。 */
export function stableHash(input) {
  const s = String(input || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const reqNorm = (s) => String(s || '').replace(/[\s\u3000\p{P}\p{S}]/gu, '');

/** 招标要求的稳定 ID：由原文规范化后的前若干字推导，跨版本一致。 */
export function requirementStableId(req) {
  return 'R' + stableHash(reqNorm(req.quote || req.title || '').slice(0, 80));
}

/** 工作单稳定键：要求 + 主体 + 问题类型，用于复审时匹配历史问题。 */
export function itemStableKey({requirementId, entityId, issueType}) {
  return `${requirementId || 'na'}::${entityId || 'na'}::${issueType || 'general'}`;
}

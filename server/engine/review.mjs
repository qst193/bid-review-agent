// 版本复审（P0-05/P0-06）：
//   1) 复审按「同一条招标要求」重新判断新版是否满足，而不是只看旧句是否消失；
//   2) 用稳定键（要求ID + 主体 + 问题类型）匹配历史问题，输出：已解决 / 仍存在 / 风险降低 / 风险升高 / 新增 / 无法确认。
import {buildBidPackages} from './audit-core.mjs';
import {runCompleteness, runResponse, runScoring, runFormat} from './checks.mjs';
import {makeItem, nowStr} from './items.mjs';

const RISK_ORDER = {critical: 0, high: 1, mid: 2, low: 3};

/**
 * 执行复审：对目标版本重跑四类与要求相关的检查，并与历史问题逐条比对。
 */
export async function runReview({model, project, targetVersion}) {
  const requirements = project.requirements || [];
  if (!requirements.length) throw new Error('缺少招标要求台账，无法复审');

  const proj = {...project, currentVersion: targetVersion};
  const packages = buildBidPackages(proj);
  if (!packages.length) throw new Error(`版本 ${targetVersion} 没有可读的投标文件`);

  const newItems = [];
  for (const pkg of packages) {
    const [c, r, s, f] = await Promise.all([
      runCompleteness({model, pkg, requirements}),
      runResponse({model, pkg, requirements}),
      runScoring({model, pkg, requirements, priceContext: project.priceContext}),
      runFormat({model, pkg, requirements}),
    ]);
    newItems.push(...c.items, ...r.items, ...s.items, ...f.items);
  }

  // 历史问题：取上一条已完成的审核结果
  const history = project.audit?.items || [];
  const historyOpen = history.filter((h) => h.status === 'reviewing');

  // 以稳定键匹配
  const newByKey = new Map(newItems.map((it) => [it.stableKey, it]));
  const diff = [];
  const matchedKeys = new Set();

  for (const h of historyOpen) {
    const n = newByKey.get(h.stableKey);
    const oldEvidence = (h.evidence || []).filter((e) => e.quote).map((e) => ({file: e.fileName, quote: e.quote, label: e.locator?.label || ''}));
    const newEvidence = n ? (n.evidence || []).filter((e) => e.quote).map((e) => ({file: e.fileName, quote: e.quote, label: e.locator?.label || '', grade: e.grade})) : [];
    if (n) {
      matchedKeys.add(h.stableKey);
      const resolved = ['satisfied'].includes(n.checkStatus);
      if (resolved) {
        diff.push({state: 'resolved', findingId: h.id, title: h.title, check: h.check, entityName: h.entityName, oldRisk: h.risk, newRisk: n.risk, note: '新版已按同一要求提供充分证据，判定为已满足', oldEvidence, newEvidence, newStatus: n.checkStatus});
      } else if (n.checkStatus === 'unknown' || n.checkStatus === 'uncovered') {
        diff.push({state: 'unconfirmed', findingId: h.id, title: h.title, check: h.check, entityName: h.entityName, oldRisk: h.risk, newRisk: n.risk, note: '新版证据不足或文件未读取，无法确认是否解决', oldEvidence, newEvidence, newStatus: n.checkStatus});
      } else {
        const oldOrder = RISK_ORDER[h.risk] ?? 2;
        const newOrder = RISK_ORDER[n.risk] ?? 2;
        if (newOrder < oldOrder) {
          diff.push({state: 'riskDown', findingId: h.id, title: h.title, check: h.check, entityName: h.entityName, oldRisk: h.risk, newRisk: n.risk, note: '风险较上游版本降低，但仍未完全满足', oldEvidence, newEvidence, newStatus: n.checkStatus});
        } else if (newOrder > oldOrder) {
          diff.push({state: 'riskUp', findingId: h.id, title: h.title, check: h.check, entityName: h.entityName, oldRisk: h.risk, newRisk: n.risk, note: '风险较上游版本升高', oldEvidence, newEvidence, newStatus: n.checkStatus});
        } else {
          diff.push({state: 'persist', findingId: h.id, title: h.title, check: h.check, entityName: h.entityName, oldRisk: h.risk, newRisk: n.risk, note: '新版仍不满足该要求', oldEvidence, newEvidence, newStatus: n.checkStatus});
        }
      }
    } else {
      diff.push({state: 'unconfirmed', findingId: h.id, title: h.title, check: h.check, entityName: h.entityName, oldRisk: h.risk, newRisk: null, note: '新版未产生对应判断，需人工核实该要求是否已满足（文字消失不等于已解决）', oldEvidence, newEvidence: []});
    }
  }

  // 新增问题：新版产生、历史没有稳定键的
  const historicalKeys = new Set(history.map(h=>h.stableKey));
  const newOnly = newItems.filter((it) => !historicalKeys.has(it.stableKey) && !isPassive(it));

  const summary = {
    resolved: diff.filter((d) => d.state === 'resolved').length,
    persist: diff.filter((d) => d.state === 'persist').length,
    riskUp: diff.filter((d) => d.state === 'riskUp').length,
    riskDown: diff.filter((d) => d.state === 'riskDown').length,
    unconfirmed: diff.filter((d) => d.state === 'unconfirmed').length,
    added: newOnly.length,
  };

  return {
    version: targetVersion,
    at: nowStr(),
    summary,
    diff,
    newItems: newOnly.slice(0, 60).map((it) => ({id: it.id, title: it.title, check: it.check, checkLabel: it.checkLabel, risk: it.risk, entityName: it.entityName, checkStatus: it.checkStatus})),
    rerunCount: newItems.length,
  };
}

function isPassive(it) {
  return ['satisfied'].includes(it.checkStatus) && ['low'].includes(it.risk);
}

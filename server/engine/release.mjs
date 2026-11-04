// 交标前放行门禁（第三节 9）。
// 明确区分「AI 审核跑完了」和「可以提交了」。
// 只有全部硬门槛通过，且放行负责人确认后，才允许标记「可交标」。
import {nowStr, isActionableItem} from './items.mjs';
import {CHECK_STATUS} from './domain.mjs';
import {inputsFingerprint} from './orchestrator.mjs';

/**
 * 计算放行检查清单。
 * 返回 {gates, blocking, canRelease, risks}
 * 每个 gate: {key, label, ok, detail, blocking}
 */
export function computeRelease(project) {
  const audit = project.audit;
  const items = audit?.items || [];
  const coverage = audit?.coverage;
  const gates = [];

  const openItems = items.filter((it) => isActionableItem(it) && !['closed', 'dismissed'].includes(it.status));
  const criticalOpen = openItems.filter((it) => it.risk === 'critical');
  const highOpen = openItems.filter((it) => it.risk === 'high');

  // 审核必须完成且生成了问题清单，否则一律不可放行（区分「AI 跑完」和「可提交」）
  const auditDone = audit?.status === 'done' && items.length > 0;
  gates.push({
    key: 'auditDone', label: '审核已完成并生成问题清单',
    ok: auditDone, blocking: true,
    detail: auditDone ? `审核完成（${items.length} audit records)` : (audit?.status === 'stale' ? `审核已失效（${audit.staleReason || '输入已变化'}），请重新审核` : (audit ? `审核状态：${audit.status || '未开始'}` : '尚未发起审核')),
    itemIds: [],
  });
  const auditRequirements = (project.requirements || []).filter(r => project.focusIds?.includes(r.stableId));
  const unconfirmed = project.focusApprovedAt && auditRequirements.length ? [] : auditRequirements;
  gates.push({key: 'ledgerConfirmed', label: '采购重点清单已确认', ok: auditRequirements.length > 0 && unconfirmed.length === 0, blocking: true,
    detail: unconfirmed.length ? '采购重点尚未确认' : `已确认 ${auditRequirements.length} 项采购重点`, itemIds: []});
  const snapshotOk = !!audit?.snapshot?.inputsHash && audit.snapshot.inputsHash === inputsFingerprint(project);
  gates.push({key: 'inputsFresh', label: '审核输入与当前文件一致', ok: snapshotOk, blocking: true,
    detail: snapshotOk ? '文件与要求未变化' : '审核后文件或要求已变化，请重新审核', itemIds: []});

  gates.push({
    key: 'critical', label: '致命风险问题已全部关闭',
    ok: criticalOpen.length === 0, blocking: true,
    detail: criticalOpen.length ? `仍有 ${criticalOpen.length} 条致命风险未关闭` : '无未关闭的致命风险',
    itemIds: criticalOpen.map((i) => i.id),
  });
  gates.push({
    key: 'high', label: '高风险问题已关闭',
    ok: highOpen.length === 0, blocking: true,
    detail: highOpen.length ? `仍有 ${highOpen.length} 条高风险未关闭` : '无未关闭的高风险',
    itemIds: highOpen.map((i) => i.id),
  });

  const materials = items.filter((it) => it.check === 'completeness' && ['notFound', 'uncovered', 'partial'].includes(it.checkStatus) && !['closed', 'dismissed'].includes(it.status));
  gates.push({
    key: 'materials', label: '必需材料齐全',
    ok: materials.length === 0, blocking: true,
    detail: materials.length ? `${materials.length} 项必需材料缺失或证据不足` : '必需材料齐全',
    itemIds: materials.map((i) => i.id),
  });

  const procDocs = (project.docs || []).filter((d) => d.role === 'procurement' || ['procurement', 'supplement'].includes(d.category));
  const procUnreadable = procDocs.filter((d) => !d.parsedKey || d.structure?.unreadable || d.parseError);
  const procSupplements = procDocs.filter((d) => d.category === 'supplement').length;
  gates.push({
    key: 'procurement', label: '采购文件与补遗已全部纳入',
    ok: procDocs.length > 0 && procUnreadable.length === 0, blocking: true,
    detail: !procDocs.length ? '未上传采购文件' : procUnreadable.length ? `${procUnreadable.length} 份采购文件未解析：${procUnreadable.map((d) => d.name).join('、')}` : `采购文件已解析（含补遗 ${procSupplements} 份）`,
    itemIds: [],
  });

  const currentBidDocs = (project.docs || []).filter((d) => d.role !== 'procurement' && !['procurement', 'supplement'].includes(d.category) && d.version === project.currentVersion);
  const bidUnreadable = currentBidDocs.filter((d) => !d.parsedKey || d.structure?.unreadable || d.parseError);
  gates.push({
    key: 'unparsed', label: '无未解析的关键投标文件',
    ok: currentBidDocs.length > 0 && bidUnreadable.length === 0, blocking: true,
    detail: !currentBidDocs.length ? '当前版本未上传投标文件' : bidUnreadable.length ? `${bidUnreadable.length} 份投标文件未解析：${bidUnreadable.map((d) => d.name).join('、')}` : '投标文件均可读',
    itemIds: [],
  });

  const unknownItems = items.filter((it) => it.checkStatus === 'unknown' && !['closed', 'dismissed'].includes(it.status));
  const keyUnknown = unknownItems.filter((it) =>
    (it.check === 'format' && /签|章|开标一览表|报价|页码/.test(it.title)) ||
    (it.check === 'completeness' && (it.requirement?.mark === '★' || /营业执照|纳税|社保|财务|资信/.test(it.title))) ||
    (it.check === 'response' && /报价|限价|★/.test(it.title)));
  gates.push({
    key: 'manualConfirm', label: '关键待核实事项已人工确认',
    ok: keyUnknown.length === 0, blocking: true,
    detail: keyUnknown.length ? `${keyUnknown.length} 项关键事项待人工确认；另有 ${unknownItems.length-keyUnknown.length} 项普通待核实` : `${unknownItems.length} 项普通待核实，需知情复核`,
    itemIds: keyUnknown.map((i) => i.id),
  });

  const priceIssues = items.filter((it) => (it.check === 'scoring' || it.extra?.originalCheck === 'scoring') && it.extra?.scoreType === 'price' && it.checkStatus !== 'satisfied' && !['closed', 'dismissed'].includes(it.status));
  gates.push({
    key: 'price', label: '投标报价与关键参数一致',
    ok: auditDone && priceIssues.length === 0, blocking: true,
    detail: !auditDone ? '尚未完成审核，不能判断报价和参数一致' : priceIssues.length ? `${priceIssues.length} 项报价/参数问题待处理` : '报价与关键参数一致',
    itemIds: priceIssues.map((i) => i.id),
  });

  // 条款覆盖：关键条款 100% 有明确结论；一般条款达到阈值（默认 90%）
  const reqCov = computeClauseCoverage(project, items);
  gates.push({
    key: 'criticalCoverage', label: '关键条款 100% 有明确结论',
    ok: reqCov.criticalMissing.length === 0, blocking: true,
    detail: reqCov.criticalTotal
      ? `关键条款 ${reqCov.criticalJudged}/${reqCov.criticalTotal} 条有明确结论${reqCov.criticalMissing.length ? `，未覆盖：${reqCov.criticalMissing.slice(0, 3).map((r) => r.title).join('、')}${reqCov.criticalMissing.length > 3 ? ' 等 ' + reqCov.criticalMissing.length + ' 条' : ''}` : ''}`
      : '无关键条款或未识别（请确认台账）',
    itemIds: [],
  });
  const threshold = Number(project.coverageThreshold ?? 90);
  gates.push({
    key: 'coverage', label: `一般条款覆盖率达到 ${threshold}%`,
    ok: reqCov.overallRate >= threshold, blocking: true,
    detail: `一般条款覆盖 ${reqCov.overallRate}%（已核查 ${reqCov.totalJudged}/${reqCov.totalAll}），关键条款已单独要求 100%`,
    itemIds: [],
  });

  // 当前审核版本 = 当前项目版本
  const versionOk = audit?.version === project.currentVersion;
  gates.push({
    key: 'version', label: '审核对应最终文件版本',
    ok: versionOk, blocking: true,
    detail: versionOk ? `已对应版本 ${project.currentVersion}` : `审核版本 ${audit?.version || '—'} 与当前版本 ${project.currentVersion} 不一致，请重新审核`,
    itemIds: [],
  });

  const blocking = gates.filter((g) => g.blocking && !g.ok);
  const canRelease = blocking.length === 0;
  const release = project.release || null;

  return {
    gates,
    blocking: blocking.map((g) => ({key: g.key, label: g.label, detail: g.detail})),
    canRelease,
    auditComplete: audit?.status === 'done',
    release,
    checkedAt: nowStr(),
  };
}

/**
 * 条款覆盖分析：区分「关键条款」与「一般条款」。
 * 关键条款：★▲标记、否决项、资格条件、实质响应——必须 100% 有明确结论。
 * 一般条款：其余已确认要求——达到阈值即可。
 */
function computeClauseCoverage(project, items) {
  const reqs = (project.requirements || []).filter(r => project.focusIds?.includes(r.stableId));
  // 每条已确认要求的判断结论
  const judgedMap = new Map();
  for (const it of items) {
    if (!it.requirementId) continue;
    if (['satisfied', 'partial', 'violated', 'notFound'].includes(it.checkStatus)) {
      judgedMap.set(it.requirementId, true);
    } else if (!judgedMap.has(it.requirementId)) {
      judgedMap.set(it.requirementId, false);
    }
  }
  const isCritical = (r) => r.mark === '★' || r.mark === '▲' || r.type === 'qualification' || r.type === 'substantive' || /无效|废标|否决/.test(r.consequence || '');
  const critical = reqs.filter(isCritical);
  const criticalJudged = critical.filter((r) => judgedMap.get(r.stableId));
  const criticalMissing = critical.filter((r) => !judgedMap.get(r.stableId));
  const totalJudged = reqs.filter((r) => judgedMap.get(r.stableId)).length;
  return {
    criticalTotal: critical.length,
    criticalJudged: criticalJudged.length,
    criticalMissing,
    totalAll: reqs.length,
    totalJudged,
    overallRate: reqs.length ? Math.round((totalJudged / reqs.length) * 100) : 0,
  };
}

/** 未关闭风险清单（供导出）。 */
export function openRiskList(project) {
  const items = (project.audit?.items || []).filter((it) => isActionableItem(it) && !['closed', 'dismissed'].includes(it.status));
  const order = {critical: 0, high: 1, mid: 2, low: 3};
  return items
    .filter((it) => ['critical', 'high', 'mid'].includes(it.risk))
    .sort((a, b) => (order[a.risk] ?? 9) - (order[b.risk] ?? 9))
    .map((it) => ({
      id: it.id, risk: it.risk, riskLabel: it.riskLabel, title: it.title,
      check: it.check, checkLabel: it.checkLabel, entityName: it.entityName,
      gap: it.gap, action: it.action, status: it.statusLabel, assignee: it.assignee,
      requirement: it.requirement?.quote || '', evidence: it.evidence?.[0]?.quote || '',
    }));
}

export function releaseGateSummary(project) {
  const r = computeRelease(project);
  const rel = project.release;
  const revoked = !!rel?.revoked;
  return {
    canRelease: r.canRelease,
    blocking: r.blocking,
    // 已撤销的放行不再算「已确认放行」
    confirmed: !!rel?.confirmedAt && !revoked,
    confirmedAt: rel?.confirmedAt || null,
    confirmedBy: rel?.confirmedBy || null,
    version: rel?.version || null,
    revoked,
    revokedReason: rel?.revokedReason || null,
  };
}

// 项目向导：根据项目数据推导当前所处阶段与下一步主操作。
// 四阶段：1 准备文件 → 2 确认审核范围 → 3 处理问题 → 4 交标检查
// 目标：用户随时知道「当前在哪一步、下一步点什么」，每阶段只有一个主按钮。
import {isActionableItem} from './items.mjs';

export const WIZARD_STAGES = [
  {key: 'files', no: 1, title: '准备文件', desc: '上传招标文件和投标文件'},
  {key: 'scope', no: 2, title: '确认审核范围', desc: '查看并确认系统抽出的要求'},
  {key: 'issues', no: 3, title: '处理问题', desc: '分派、修改、补材料、复核'},
  {key: 'release', no: 4, title: '交标检查', desc: '查看未关闭风险与最终文件清单'},
];

export function computeWizard(project) {
  const docs = project.docs || [];
  const procDocs = docs.filter((d) => ['procurement', 'supplement'].includes(d.category) || d.role === 'procurement');
  const bidDocs = docs.filter((d) => d.category && !['procurement', 'supplement'].includes(d.category) && d.version === project.currentVersion && d.role !== 'procurement');
  const readable = (d) => !!d.parsedKey && !d.structure?.unreadable && !d.parseError;
  const reqs = project.requirements || [];
  const auditReqs = reqs.filter((r) => !r.reviewScope || r.reviewScope === 'audit');
  const confirmedReqs = auditReqs.filter((r) => r.status === 'confirmed');
  const audit = project.audit;
  const auditDone = audit?.status === 'done';
  const items = audit?.items || [];
  const openItems = items.filter((it) => isActionableItem(it) && !['closed', 'dismissed'].includes(it.status));
  const criticalHighOpen = openItems.filter((it) => ['critical', 'high'].includes(it.risk));
  const released = !!project.release?.confirmedAt && !project.release?.revoked;

  // ---- 阶段判定 ----
  // 阶段1 未完成：缺招标文件 或 缺投标文件
  const hasProc = procDocs.length > 0 && procDocs.every(readable);
  const hasBid = bidDocs.length > 0 && bidDocs.every(readable);
  const stage1Done = hasProc && hasBid;

  // 阶段2 未完成：无要求 或 有未确认要求
  const stage2Done = !!project.focusApprovedAt && (project.focusIds || []).length > 0;

  // 阶段3 未完成：未审核 或 有未关闭的中高风险/需处理问题
  const stage3Done = auditDone && criticalHighOpen.length === 0;

  // 阶段4 未完成：未放行
  const stage4Done = released;

  let current = 'files';
  if (!stage1Done) current = 'files';
  else if (!stage2Done) current = 'scope';
  else if (!stage3Done) current = 'issues';
  else current = 'release';

  // ---- 每阶段状态与主按钮 ----
  const stages = WIZARD_STAGES.map((s) => {
    let status = 'todo'; // done | current | todo
    let mainAction = null;
    let next = '';
    if (s.key === 'files') {
      status = stage1Done ? 'done' : current === 'files' ? 'current' : 'todo';
      next = stage1Done ? `已上传并解析 ${procDocs.length} 份招标 + ${bidDocs.length} 份投标` : (procDocs.some((d) => !readable(d)) ? '招标文件无法读取，请转换为 DOCX 或可复制文字的 PDF' : bidDocs.some((d) => !readable(d)) ? '投标文件无法读取，请转换格式后重新上传' : !hasProc ? '请先上传招标文件' : '请上传投标文件');
      mainAction = stage1Done ? null : {label: '去上传文件', view: 'project', tab: 'files'};
    } else if (s.key === 'scope') {
      status = stage2Done ? 'done' : current === 'scope' ? 'current' : 'todo';
      next = stage2Done ? `已确认 ${project.focusIds.length} 项售前重点` : (auditReqs.length ? '请查看售前重点清单并确认' : '尚未抽取要求');
      mainAction = stage2Done ? {label: '重新查看重点', view: 'project', tab: 'ledger'} : {label: reqs.length ? '查看售前重点' : '去抽取要求', view: 'project', tab: 'ledger'};
    } else if (s.key === 'issues') {
      status = stage3Done ? 'done' : current === 'issues' ? 'current' : 'todo';
      next = !auditDone ? '尚未开始审核' : (openItems.length ? `${openItems.length} 个问题待处理（致命/高风险 ${criticalHighOpen.length}）` : '问题已处理完');
      mainAction = !auditDone
        ? {label: stage2Done ? '开始审核' : '先确认要求', view: 'project', tab: 'audit', action: stage2Done ? 'startAudit' : null}
        : (openItems.length ? {label: '处理问题', view: 'issues'} : null);
    } else if (s.key === 'release') {
      status = stage4Done ? 'done' : current === 'release' ? 'current' : 'todo';
      next = released ? `已于 ${project.release.confirmedAt} 放行` : (stage3Done ? '可进行交标检查' : '待问题处理完成');
      mainAction = stage3Done && !released ? {label: '交标检查', view: 'report'} : null;
    }
    return {...s, status, next, mainAction};
  });

  const currentStage = stages.find((s) => s.key === current);
  // 顶部横幅文字
  const hint = currentStage
    ? `当前：${currentStage.title}｜下一步：${currentStage.mainAction ? currentStage.mainAction.label : currentStage.next}`
    : '';

  return {
    current,
    stages,
    hint,
    progress: {
      files: {done: stage1Done, proc: procDocs.length, bid: bidDocs.length},
      scope: {done: stage2Done, total: project.focusIds?.length || 0, confirmed: stage2Done ? project.focusIds.length : 0},
      issues: {done: stage3Done, auditDone, open: openItems.length, criticalHigh: criticalHighOpen.length},
      release: {done: stage4Done, released, at: project.release?.confirmedAt || null},
    },
    canStartAudit: stage1Done && stage2Done && !auditDone,
    allDone: stage1Done && stage2Done && stage3Done && stage4Done,
  };
}

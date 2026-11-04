// 工作台（项目首页）：只显示四类信息——我的待办、高风险项目、项目进度、关键时间。
// 验收：打开系统不超过两步进入自己负责的问题。
import {$, esc, state, api, toast, modal, confirmDialog, riskTone, riskLabel} from '../lib.js';
import {loadProject, refreshProjects, refreshWorkbench, navigate as go} from '../nav.js';

export function renderWorkbench() {
  const wb = state.workbench || {todo: [], highRisk: [], projects: [], deadlines: [], stats: {}};
  const s = wb.stats || {};
  return `
  <div class="page-head">
    <div class="grow">
      <h1>工作台</h1>
      <div class="sub">今天先看：我的待办、高风险项目、项目进度、关键时间。点击任意问题直达处理页。</div>
    </div>
    <button class="btn primary" id="createProject">＋ 接标建项</button>
  </div>

  <div class="metrics">
    <div class="metric" data-go="project"><div class="label">进行中项目</div><div class="num">${s.active ?? 0}<span class="unit">个</span></div><div class="hint">未归档且未完成审核</div></div>
    <div class="metric"><div class="label">我的待办</div><div class="num">${s.todoCount ?? 0}<span class="unit">条</span></div><div class="hint">已分派给我的问题</div></div>
    <div class="metric"><div class="label">高风险项目</div><div class="num" style="color:var(--danger)">${s.highRiskCount ?? 0}<span class="unit">条</span></div><div class="hint">可能影响投标有效性</div></div>
    <div class="metric" data-go="issues"><div class="label">全部项目</div><div class="num">${s.projects ?? 0}<span class="unit">个</span></div><div class="hint">点击进入问题清单</div></div>
  </div>

  <div class="section-title"><h2>各投标书</h2><div class="line"></div><span class="small muted">按项目、主体和编写人定位问题</span></div>
  <div class="card"><table class="tbl"><thead><tr><th>项目 / 版本</th><th>投标主体</th><th>编写人</th><th>文件</th><th>未关闭问题</th><th>审核状态</th><th></th></tr></thead>
    <tbody>${(wb.bids || []).length ? wb.bids.map((b) => `<tr><td>${esc(b.projectName)} · ${esc(b.version)}</td><td><b>${esc(b.entityName)}</b></td><td>${esc(b.writer || '未分配')}</td><td>${b.docs} 份</td><td><span class="tag ${b.high ? 'danger' : 'neutral'}">${b.open} 条${b.high ? ` · 高风险 ${b.high}` : ''}</span></td><td>${esc(b.auditStatus === 'done' ? '已审核' : b.auditStatus === 'stale' ? '审核已失效' : '待审核')}</td><td><button class="btn sm" data-open-bid="${b.projectId}|${b.entityId}">查看问题</button></td></tr>`).join('') : '<tr><td colspan="7"><div class="empty" style="padding:24px">请先在项目中新增投标主体并分配编写人。</div></td></tr>'}</tbody>
  </table></div>

  <div class="grid-2" style="margin-top:18px">
    <div class="card pad">
      <div class="rowflex" style="justify-content:space-between;margin-bottom:10px"><h2>我的待办</h2><span class="small muted">${wb.todo.length} 条</span></div>
      ${wb.todo.length ? `<div class="stack">${wb.todo.slice(0, 12).map(todoRow).join('')}</div>` : '<div class="empty" style="padding:30px"><b>暂无分派给你的问题</b>在问题工作单中可批量分派负责人。</div>'}
    </div>
    <div class="card pad">
      <div class="rowflex" style="justify-content:space-between;margin-bottom:10px"><h2>高风险项目</h2><span class="small muted">致命/高风险未关闭</span></div>
      ${wb.highRisk.length ? `<div class="stack">${wb.highRisk.slice(0, 12).map(riskRow).join('')}</div>` : '<div class="empty" style="padding:30px"><b>暂无高风险未关闭项</b>审核完成后此处会显示需优先处理的问题。</div>'}
    </div>
  </div>

  <div class="grid-2" style="margin-top:14px">
    <div class="card pad">
      <div class="rowflex" style="justify-content:space-between;margin-bottom:10px"><h2>项目进度</h2><span class="small muted">要求确认率 / 问题关闭率</span></div>
      ${wb.projects.length ? `<div class="stack">${wb.projects.slice(0, 8).map(progressRow).join('')}</div>` : '<div class="empty" style="padding:30px">还没有项目。</div>'}
    </div>
    <div class="card pad">
      <div class="rowflex" style="justify-content:space-between;margin-bottom:10px"><h2>关键时间</h2><span class="small muted">答疑 / 定稿 / 交标</span></div>
      ${wb.deadlines.length ? `<div class="stack">${wb.deadlines.slice(0, 10).map(deadlineRow).join('')}</div>` : '<div class="empty" style="padding:30px"><b>尚未设置关键时间</b>在项目设置中填写答疑截止、内部定稿、交标截止。</div>'}
    </div>
  </div>

  <div class="section-title"><h2>全部项目</h2><div class="line"></div><span class="small muted">${wb.projects.length} 个</span></div>
  <div class="filters" id="projFilters">
    <span class="small muted">负责人：</span>
    <select class="in" id="fOwner" style="width:auto;min-width:110px;padding:5px 9px;font-size:12.5px">
      <option value="">全部</option>
      ${[...new Set(wb.projects.map((p) => p.owner).filter(Boolean))].map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
    </select>
    <span class="small muted" style="margin-left:8px">风险：</span>
    <select class="in" id="fRisk" style="width:auto;min-width:100px;padding:5px 9px;font-size:12.5px">
      <option value="">全部</option><option value="hasRisk">有致命/高风险</option><option value="noRisk">无高风险</option>
    </select>
    <span class="small muted" style="margin-left:8px">状态：</span>
    <select class="in" id="fStatus" style="width:auto;min-width:100px;padding:5px 9px;font-size:12.5px">
      <option value="">全部</option><option value="draft">待审核</option><option value="done">已审核</option><option value="released">已放行</option><option value="archived">已归档</option>
    </select>
    <span class="small muted" id="projFilterCount" style="margin-left:8px"></span>
  </div>
  <div class="card">
    <table class="tbl" id="projTable">
      <thead><tr><th>项目</th><th>当前阶段 / 下一步</th><th>编号 / 负责人</th><th>材料</th><th>致命/高风险</th><th>要求确认</th><th></th></tr></thead>
      <tbody>${wb.projects.length ? wb.projects.map(projRow).join('') : '<tr><td colspan="7"><div class="empty" style="padding:30px"><b>还没有项目</b>点击右上角「接标建项」创建第一个项目。</div></td></tr>'}</tbody>
    </table>
  </div>
  `;
}

function todoRow(t) {
  return `<div class="rowflex clickable" style="gap:8px;padding:7px 0;border-bottom:1px solid var(--line-2);cursor:pointer" data-open-item="${t.projectId}|${t.itemId}">
    <span class="tag ${riskTone(t.risk)}">${esc(riskLabel(t.risk))}</span>
    <span class="small grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>
    <span class="small muted nowrap">${esc(t.projectName)}</span>
    <span class="tag neutral">${esc(t.statusLabel || '')}</span>
  </div>`;
}
function riskRow(r) {
  return `<div class="rowflex clickable" style="gap:8px;padding:7px 0;border-bottom:1px solid var(--line-2);cursor:pointer" data-open-item="${r.projectId}|${r.itemId}">
    <span class="tag ${riskTone(r.risk)}">${esc(r.riskLabel || riskLabel(r.risk))}</span>
    <span class="small grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.title)}</span>
    <span class="small muted nowrap">${esc(r.projectName)}${r.entityName ? ' · ' + esc(r.entityName) : ''}</span>
  </div>`;
}
function progressRow(p) {
  const closeRate = p.summary?.total ? Math.round(((p.summary.total - p.summary.open) / p.summary.total) * 100) : 0;
  return `<div class="rowflex" style="gap:10px;padding:6px 0" data-openproj="${p.id}">
    <span class="small" style="width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">${esc(p.name)}</span>
    <div class="bar-track"><i style="width:${p.requirementRate || 0}%;background:var(--brand)"></i></div>
    <span class="small muted nowrap" title="要求确认率">${p.requirementRate || 0}%</span>
    <div class="bar-track" style="max-width:90px"><i style="width:${closeRate}%;background:var(--ok)"></i></div>
    <span class="small muted nowrap" title="问题关闭率">${closeRate}%</span>
  </div>`;
}
function deadlineRow(d) {
  return `<div class="rowflex" style="gap:8px;padding:6px 0" data-openproj="${d.projectId}">
    <span class="tag ${d.type === 'bidDeadline' ? 'danger' : d.type === 'internalDeadline' ? 'warn' : 'neutral'}">${esc(d.label)}</span>
    <span class="small grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.projectName)}</span>
    <span class="small muted nowrap">${esc(d.date)}</span>
  </div>`;
}
function projRow(p) {
  const s = p.summary || {};
  const wiz = p.wizard || {};
  return `<tr class="clickable" data-openproj="${p.id}">
    <td><b>${esc(p.name)}</b>${p.archived ? ' <span class="tag neutral">已归档</span>' : ''}${p.release?.confirmed ? ' <span class="tag ok"><span class="cdot"></span>已放行</span>' : ''}</td>
    <td>${wiz.allDone ? '<span class="tag ok"><span class="cdot"></span>全部完成</span>' : `<span class="tag brand">${esc(wiz.currentTitle || '准备文件')}</span><div class="small muted" style="margin-top:2px">${esc(wiz.mainAction?.label ? '→ ' + wiz.mainAction.label : '')}</div>`}</td>
    <td><span class="small">${esc(p.code || '—')}</span><div class="small muted">${esc(p.owner || '未指定')}</div></td>
    <td class="small">${p.docs} 份 · ${p.entities} 主体</td>
    <td>${(s.critical || 0) + (s.high || 0) ? `<span class="tag danger">${(s.critical || 0) + (s.high || 0)}</span>` : '<span class="small muted">—</span>'}</td>
    <td>${p.requirementRate || 0}%</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn sm primary" data-openproj="${p.id}">${wiz.allDone ? '查看' : '继续'}</button>
      <button class="btn sm ghost" data-delproj="${p.id}" data-name="${esc(p.name)}" title="删除">🗑</button>
    </td>
  </tr>`;
}
function auditTag(p) {
  const s = p.auditStatus;
  if (p.archived) return '<span class="tag neutral">已归档</span>';
  if (!p.docs) return '<span class="tag neutral">待上传</span>';
  if (s === 'running') return `<span class="tag brand"><span class="cdot"></span>审核中 ${p.progress || 0}%</span>`;
  if (s === 'done') return '<span class="tag ok"><span class="cdot"></span>审核完成</span>';
  if (s === 'blocked') return '<span class="tag warn">待补台账/文件</span>';
  if (s === 'error') return '<span class="tag danger">审核中断</span>';
  return '<span class="tag warn">待审核</span>';
}

export function bindWorkbench() {
  $('#createProject')?.addEventListener('click', openCreate);
  document.querySelectorAll('[data-open-bid]').forEach((el) => el.addEventListener('click', async () => {
    const [pid, eid] = el.dataset.openBid.split('|');
    try { if (state.currentId !== pid) await loadProject(pid); state.itemFilter.entity = eid; state.activeItemId = null; go('issues'); }
    catch (err) { toast(err.message, 'error'); }
  }));
  bindProjectFilters();
  document.querySelectorAll('[data-openproj]').forEach((el) => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await loadProject(el.dataset.openproj); go('project'); } catch (err) { toast(err.message, 'error'); }
  }));
  document.querySelectorAll('[data-open-item]').forEach((el) => el.addEventListener('click', async (e) => {
    e.stopPropagation();
    const [pid, iid] = el.dataset.openItem.split('|');
    try {
      if (state.currentId !== pid) await loadProject(pid);
      state.activeItemId = iid;
      go('issues', {itemId: iid});
    } catch (err) { toast(err.message, 'error'); }
  }));
  document.querySelectorAll('[data-delproj]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.delproj;
    confirmDialog('删除项目', `<p>确定删除项目「<b>${esc(b.dataset.name)}</b>」及全部文件与审核记录？<br><span style="color:var(--danger)">不可恢复。</span></p>`, async () => {
      await api(`/api/projects/${id}`, {method: 'DELETE'});
      if (state.currentId === id) { state.currentId = null; state.project = null; }
      await refreshProjects(); await refreshWorkbench();
      toast('项目已删除', 'ok'); go('workbench');
    }, '删除');
  }));
}

function bindProjectFilters() {
  const rows = [...document.querySelectorAll('#projTable tbody tr[data-openproj]')];
  if (!rows.length) return;
  const apply = () => {
    const owner = $('#fOwner')?.value || '';
    const risk = $('#fRisk')?.value || '';
    const status = $('#fStatus')?.value || '';
    let shown = 0;
    for (const tr of rows) {
      const p = (state.workbench?.projects || []).find((x) => x.id === tr.dataset.openproj);
      if (!p) continue;
      let ok = true;
      if (owner && p.owner !== owner) ok = false;
      const riskCount = (p.summary?.critical || 0) + (p.summary?.high || 0);
      if (risk === 'hasRisk' && riskCount === 0) ok = false;
      if (risk === 'noRisk' && riskCount > 0) ok = false;
      if (status === 'archived' && !p.archived) ok = false;
      if (status === 'draft' && (p.auditStatus === 'done' || p.archived)) ok = false;
      if (status === 'done' && p.auditStatus !== 'done') ok = false;
      if (status === 'released' && !p.release?.confirmed) ok = false;
      tr.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    const c = $('#projFilterCount');
    if (c) c.textContent = `显示 ${shown} / ${rows.length}`;
  };
  ['#fOwner', '#fRisk', '#fStatus'].forEach((sel) => $(sel)?.addEventListener('change', apply));
  apply();
}

function openCreate() {
  const m = modal(`
    <div class="modal-head"><h3>接标建项</h3></div>
    <div class="modal-body">
      <label class="field">项目名称 <span class="req">*</span></label>
      <input class="in" id="pjName" placeholder="例如：智能语音服务采购项目" maxlength="120">
      <div class="grid-2">
        <div><label class="field">项目编号</label><input class="in" id="pjCode" placeholder="选填" maxlength="60"></div>
        <div><label class="field">包号 / 标段</label><input class="in" id="pjPackage" placeholder="选填" maxlength="60"></div>
      </div>
      <label class="field">采购人</label><input class="in" id="pjPurchaser" placeholder="选填" maxlength="120">
      <div class="grid-2">
        <div><label class="field">负责人</label><input class="in" id="pjOwner" placeholder="选填" maxlength="40"></div>
        <div><label class="field">答疑截止</label><input class="in" id="pjQa" placeholder="如 2026-11-05" maxlength="40"></div>
      </div>
      <div class="grid-2">
        <div><label class="field">内部定稿时间</label><input class="in" id="pjInternal" placeholder="如 2026-11-10" maxlength="40"></div>
        <div><label class="field">交标截止时间</label><input class="in" id="pjBid" placeholder="如 2026-11-12" maxlength="40"></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doCreate">创建项目</button></div>
  `);
  setTimeout(() => $('#pjName')?.focus(), 50);
  const submit = async () => {
    const name = $('#pjName').value.trim();
    if (!name) return toast('请填写项目名称', 'error');
    const btn = $('#doCreate'); btn.disabled = true;
    try {
      const {project} = await api('/api/projects', {method: 'POST', body: {
        name, code: $('#pjCode').value.trim(), packageNo: $('#pjPackage').value.trim(),
        purchaser: $('#pjPurchaser').value.trim(), owner: $('#pjOwner').value.trim(),
        qaDeadline: $('#pjQa').value.trim(), internalDeadline: $('#pjInternal').value.trim(), bidDeadline: $('#pjBid').value.trim(),
      }});
      await refreshProjects(); await refreshWorkbench();
      await loadProject(project.id); m.close();
      toast('项目已创建，请上传文件', 'ok');
      go('project', {tab: 'files'});
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  $('#doCreate').addEventListener('click', submit);
  $('#pjName').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

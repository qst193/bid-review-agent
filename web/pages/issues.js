// 问题工作单（系统核心页面）：左侧问题清单，右侧三栏——招标依据｜投标证据｜处理动作。
import {esc, state, riskTone, riskLabel, checkLabel, checkStatusMeta, itemStatusLabel, itemStatusTone} from '../lib.js';

const RISK_ORDER = {critical: 0, high: 1, mid: 2, low: 3};

export function renderIssues() {
  const p = state.project;
  if (!p) return `<div class="empty" style="padding:80px"><div class="big">📋</div><b>请先选择项目</b><div style="margin-top:16px"><button class="btn primary" data-go="workbench">返回工作台</button></div></div>`;
  const all = p.audit?.items || [];
  if (!all.length) {
    return `<div class="page-head"><div class="grow"><h1>问题工作单</h1><div class="sub">${esc(p.name)}</div></div></div>
      <div class="empty" style="padding:60px"><div class="big">🔍</div><b>还没有问题清单</b>请先在「项目 · 审核进度」完成审核，或确认台账后发起审核。<div style="margin-top:14px"><button class="btn primary" data-go="project">去审核</button></div></div>`;
  }
  const f = state.itemFilter;
  const list = filteredItems(all, f);
  state.visibleItemIds = list.map((x) => x.id);
  // 选中项
  let active = all.find((x) => x.id === state.activeItemId);
  if (!active) active = list[0] || all[0];
  if (active) state.activeItemId = active.id;

  return `
  <div class="page-head">
    <div class="grow"><h1>问题工作单</h1><div class="sub">${esc(p.name)} · ${esc(p.currentVersion)} · 共 ${all.length} 个问题项，未关闭 ${all.filter((x) => !['closed', 'dismissed'].includes(x.status)).length}</div></div>
    <div class="rowflex"><button class="btn" data-go="report">报告与交标 →</button></div>
  </div>
  ${p.audit?.status === 'stale' || (p.requirements || []).some((r) => r.status !== 'confirmed') ? `<div class="notice warn" style="margin-bottom:12px">当前问题清单可能已过期；请先确认全部招标要求，并重新审核最新投标文件。</div>` : ''}

  <div class="filters">
    <span class="small muted">投标主体 / 编写人：</span>
    <select class="in" id="fEntity" style="width:auto;max-width:240px;padding:5px 9px;font-size:12.5px">
      <option value="">全部投标书</option>
      ${(p.entities || []).map((e) => `<option value="${esc(e.id)}" ${f.entity === e.id ? 'selected' : ''}>${esc(e.name)} · ${esc(e.owner || '未分配编写人')}</option>`).join('')}
    </select>
    <span class="small muted">检查类别：</span>
    <button class="chip ${!f.check ? 'active' : ''}" data-fcheck="">全部</button>
    ${['completeness', 'response', 'scoring', 'consistency', 'format', 'cross'].map((c) => {
      const n = all.filter((x) => x.check === c && !['closed', 'dismissed'].includes(x.status)).length;
      return `<button class="chip ${f.check === c ? 'active' : ''}" data-fcheck="${c}">${esc(checkLabel(c))}${n ? ' ' + n : ''}</button>`;
    }).join('')}
    <span class="small muted" style="margin-left:10px">风险：</span>
    ${['', 'critical', 'high', 'mid', 'low'].map((r) => `<button class="chip ${f.risk === r ? 'active' : ''}" data-frisk="${r}">${r ? esc(riskLabel(r)) : '全部'}</button>`).join('')}
    <span class="small muted" style="margin-left:10px">状态：</span>
    <button class="chip ${f.status === 'open' ? 'active' : ''}" data-fstatus="open">未关闭</button>
    <button class="chip ${f.status === '' ? 'active' : ''}" data-fstatus="">全部</button>
    <button class="chip ${f.status === 'closed' ? 'active' : ''}" data-fstatus="closed">已关闭</button>
  </div>

  <div class="card pad" style="margin-bottom:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <b class="small">批量操作</b>
    <span class="small muted">对当前筛选结果：</span>
    <input class="in" id="bulkAssignee" placeholder="指派负责人" style="max-width:130px">
    <input class="in" id="bulkDue" placeholder="截止 如 11-10" style="max-width:120px">
    <button class="btn sm" data-bulk="assign">批量分派</button>
    <span class="small muted">逐条提交复核需填写修改说明或上传补证</span>
    <span class="small muted" id="bulkCount">${list.length} 条</span>
  </div>

  <div class="work-grid">
    <div class="item-list" id="itemList">
      ${list.length ? list.map((it) => itemRow(it, it.id === active?.id)).join('') : '<div class="empty" style="padding:30px">当前筛选无问题</div>'}
    </div>
    <div class="detail-pane" id="detailPane">
      ${active ? detailHtml(active, p) : '<div class="empty">选择左侧问题查看详情</div>'}
    </div>
  </div>`;
}

function filteredItems(all, f) {
  let items = all.slice();
  if (f.entity) items = items.filter((x) => x.entityId === f.entity || (x.check === 'cross' && (x.extra?.entityIds || []).includes(f.entity)));
  if (f.check) items = items.filter((x) => x.check === f.check);
  if (f.risk) items = items.filter((x) => x.risk === f.risk);
  if (f.status === 'open') items = items.filter((x) => !['closed', 'dismissed'].includes(x.status));
  else if (f.status === 'closed') items = items.filter((x) => ['closed', 'dismissed'].includes(x.status));
  return items.sort((a, b) => (RISK_ORDER[a.risk] ?? 9) - (RISK_ORDER[b.risk] ?? 9));
}

function itemRow(it, active) {
  return `<div class="item-row r-${it.risk} ${active ? 'active' : ''}" data-item="${it.id}">
    <div class="m"><span class="tag ${riskTone(it.risk)}">${esc(it.riskLabel || riskLabel(it.risk))}</span><span>${esc(it.checkLabel || checkLabel(it.check))}</span>${it.entityName ? `<span>· ${esc(it.entityName)}</span>` : ''}</div>
    <div class="t">${esc(it.title)}</div>
    <div class="m"><span class="tag ${itemStatusTone(it.status)}"><span class="cdot"></span>${esc(itemStatusLabel(it.status))}</span>${it.assignee ? `<span>👤 ${esc(it.assignee)}</span>` : '<span class="muted">未分派</span>'}</div>
  </div>`;
}

function detailHtml(it, p) {
  const cs = checkStatusMeta(it.checkStatus);
  return `
  <div class="card pad" style="margin-bottom:12px">
    <div class="rowflex wrap" style="gap:8px">
      <span class="tag ${riskTone(it.risk)}">${esc(it.riskLabel || riskLabel(it.risk))}</span>
      <span class="tag ${cs.tone || 'neutral'}"><span class="cdot"></span>${esc(cs.label)}</span>
      <span class="tag neutral">${esc(it.checkLabel || checkLabel(it.check))}</span>
      ${it.entityName ? `<span class="tag brand">${esc(it.entityName)}</span>` : ''}
      <span class="tag ${itemStatusTone(it.status)}">${esc(itemStatusLabel(it.status))}</span>
    </div>
    <h2 style="margin-top:10px">${esc(it.title)}</h2>
    ${it.gap ? `<div class="small" style="color:var(--danger);margin-top:6px">具体缺口：${esc(it.gap)}</div>` : ''}
    ${it.extra?.retrievalThin ? `<div class="notice warn small" style="margin-top:8px"><span>⚠️</span><div>检索不足：本要求仅命中 ${it.extra.retrievedCount || 0} 处候选段落，模型判断可能不充分。若实际有证据，请上传补证或确认原文位置后重新核验。</div></div>` : ''}
    ${it.extra?.maybeMissed ? `<div class="small" style="color:var(--warn);margin-top:4px">提示：「未检出」可能源于检索范围有限，不等于一定缺失，请人工复核原文/附件。</div>` : ''}
  </div>

  ${it.extra?.retrievalStatus ? `<div class="small muted" style="padding:0 20px 10px">检索范围：命中 ${it.extra.retrievedCount || 0} 处候选（${it.extra.retrievalStatus === 'adequate' ? '充分' : it.extra.retrievalStatus === 'thin' ? '偏少' : '无'}）</div>` : ''}

  <div class="tri-grid">
    <div class="tri-col">
      <div class="tri-head">招标依据 <span class="sub">${it.requirement?.locator?.label || ''}</span></div>
      <div class="tri-body" id="colReq">
        ${it.requirement ? `
          <div class="quote req">${esc(it.requirement.quote || '')}</div>
          <div class="kv"><span class="k">来源</span><span>${esc(it.requirement.fileName || '')} ${esc(it.requirement.source || '')}</span></div>
          <div class="kv"><span class="k">类型</span><span>${esc(it.requirement.typeLabel || '')}</span></div>
          ${it.requirement.mark ? `<div class="kv"><span class="k">标记</span><span style="color:var(--danger)">${esc(it.requirement.mark)}</span></div>` : ''}
          ${it.requirement.consequence ? `<div class="kv"><span class="k">后果</span><span style="color:var(--danger)">${esc(it.requirement.consequence)}</span></div>` : ''}
          ${(it.requirement.checkpoints || []).length ? `<div class="kv"><span class="k">核查点</span><span>${it.requirement.checkpoints.map((c) => '· ' + esc(c)).join('<br>')}</span></div>` : ''}
        ` : '<div class="small muted">该问题未绑定具体招标条款（如一致性/互查类）。</div>'}
      </div>
    </div>

    <div class="tri-col">
      <div class="tri-head">投标证据 <span class="sub">${(it.evidence || []).length} 处</span></div>
      <div class="tri-body" id="colBid">
        ${(it.evidence || []).length ? it.evidence.map((e) => `
          <div style="margin-bottom:10px">
            <div class="quote bid ${e.weak ? 'weak' : ''}">${esc(e.quote || '')}</div>
            <div class="small muted" style="margin-top:3px">${esc(e.fileName || '')} · ${esc(e.locator?.label || '')} ${e.weak ? '<span class="tag warn" style="font-size:10px">部分相似（仅线索）</span>' : e.grade === 'exact' ? '<span class="tag ok" style="font-size:10px">精确原文</span>' : '<span class="tag neutral" style="font-size:10px">规范化匹配</span>'}</div>
            ${e.locator?.paraIndex != null ? `<button class="btn sm ghost" data-open-doc="${e.fileId}|${e.locator.paraIndex}">查看上下文</button>` : ''}
          </div>`).join('') : '<div class="small muted">未检出对应证据。</div>'}
      </div>
    </div>

    <div class="tri-col">
      <div class="tri-head">处理动作</div>
      <div class="tri-body">
        ${it.action ? `<div class="kv"><span class="k">修改动作</span><span>${esc(it.action)}</span></div>` : ''}
        ${it.acceptance ? `<div class="kv"><span class="k">验收要求</span><span>${esc(it.acceptance)}</span></div>` : ''}
        ${(it.cannotInvent || []).length ? `<div class="kv"><span class="k">不可编造</span><span style="color:var(--danger)">${esc(it.cannotInvent.join('、'))}</span></div>` : ''}
        ${it.suggestedText ? `<div class="kv"><span class="k">草稿参考</span><span style="color:var(--brand)">${esc(it.suggestedText)}</span></div>` : ''}
        <div class="kv"><span class="k">负责人</span><span>${esc(it.assignee || '未分派')}</span></div>
        <div class="kv"><span class="k">截止</span><span>${esc(it.due || '未设置')}</span></div>
        <div class="kv"><span class="k">复核人</span><span>${esc(it.reviewer || '未设置')}</span></div>
        ${(it.proofs || []).length ? `<div class="kv"><span class="k">补证</span><span>${it.proofs.map((pr) => `📎 ${esc(pr.name)}`).join('<br>')}</span></div>` : ''}
      </div>
      <div class="tri-foot">
        ${stateActions(it)}
        <div class="rowflex wrap" style="gap:6px;margin-top:6px">
          <details class="more-menu">
            <summary class="small" style="cursor:pointer;color:var(--ink-3)">更多操作</summary>
            <div class="rowflex wrap" style="gap:6px;margin-top:6px">
              <button class="btn sm ghost" data-assist="${it.id}">修改助手</button>
              <button class="btn sm ghost" data-proof-item="${it.id}">上传补证</button>
              ${it.requirementId ? `<button class="btn sm ghost" data-recheck="${it.requirementId}">重新核验</button>` : ''}
              ${!['closed', 'dismissed'].includes(it.status) ? `<button class="btn sm ghost" data-transition="${it.id}" data-to="dismissed">标记非问题</button>` : ''}
              ${it.status === 'returned' ? `<button class="btn sm ghost" data-transition="${it.id}" data-to="editing">退回后继续修改</button>` : ''}
            </div>
          </details>
        </div>
      </div>
    </div>
  </div>

  <div class="grid-2" style="margin-top:12px">
    <div class="card pad">
      <h3>分派与状态</h3>
      <div class="rowflex wrap" style="gap:8px;margin-top:10px">
        <input class="in" id="itAssignee" placeholder="负责人" value="${esc(it.assignee || '')}" style="max-width:150px">
        <input class="in" id="itDue" placeholder="截止 (如 11-10)" value="${esc(it.due || '')}" style="max-width:150px">
        <input class="in" id="itReviewer" placeholder="复核人" value="${esc(it.reviewer || '')}" style="max-width:150px">
        <button class="btn primary sm" data-save-item="${it.id}">保存</button>
      </div>
      <label class="field">添加评论</label>
      <textarea class="in" id="itComment" placeholder="记录处理说明…"></textarea>
      <div style="margin-top:8px"><button class="btn sm" data-comment-item="${it.id}">提交评论</button></div>
    </div>
    <div class="card pad">
      <h3>操作记录</h3>
      <div style="margin-top:8px;max-height:200px;overflow:auto">
        ${(it.history || []).slice().reverse().map((h) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line-2)"><span class="muted">${esc(h.time)}</span> · ${esc(h.by || '')} ${h.from ? `（${esc(itemStatusLabel(h.from))}→${esc(itemStatusLabel(h.to))}）` : ''} ${h.note ? '：' + esc(h.note) : ''}</div>`).join('') || '<div class="small muted">暂无记录</div>'}
        ${(it.comments || []).map((c) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line-2)"><span class="muted">${esc(c.time)}</span> · ${esc(c.by)}：${esc(c.text)}</div>`).join('')}
      </div>
    </div>
  </div>`;
}

export { detailHtml, filteredItems };

// 按状态只给一个主操作（状态机）
function stateActions(it) {
  const id = it.id;
  const s = it.status;
  // 已关闭 / 非问题：只提示，可重新打开
  if (s === 'closed') {
    return `<div class="rowflex" style="gap:8px;align-items:center"><span class="tag ok"><span class="cdot"></span>问题已关闭</span><button class="btn sm ghost" data-transition="${id}" data-to="reviewing">重新打开复核</button></div>`;
  }
  if (s === 'dismissed') {
    return `<div class="rowflex" style="gap:8px;align-items:center"><span class="tag neutral">已标记为非问题</span><button class="btn sm ghost" data-transition="${id}" data-to="todo">恢复为待处理</button></div>`;
  }
  // 待分派 / 待修改 → 开始修改
  if (s === 'todo' || s === 'confirming' || s === 'confirmed') {
    return `<div class="rowflex" style="gap:8px;align-items:center"><span class="small muted grow">🔧 待处理：先修改，再提交复核</span><button class="btn sm primary" data-transition="${id}" data-to="editing">开始修改 →</button></div>`;
  }
  // 修改中 → 提交复核
  if (s === 'editing') {
    return `<div class="rowflex" style="gap:8px;align-items:center"><span class="small muted grow">✏️ 修改中：完成后提交复核</span><button class="btn sm primary" data-transition="${id}" data-to="reviewing">提交复核 →</button></div>`;
  }
  // 待复核 → 确认解决 / 退回修改
  if (s === 'reviewing') {
    return `<div class="rowflex" style="gap:8px;align-items:center"><span class="small muted grow">🔍 待复核：确认是否真正解决</span><div class="rowflex" style="gap:6px"><button class="btn sm ghost" data-transition="${id}" data-to="returned">退回修改</button><button class="btn sm ok" data-transition="${id}" data-to="closed">确认解决 →</button></div></div>`;
  }
  // 退回修改 → 继续修改
  if (s === 'returned') {
    return `<div class="rowflex" style="gap:8px;align-items:center"><span class="small muted grow" style="color:var(--danger)">↩️ 已退回：需继续修改</span><button class="btn sm primary" data-transition="${id}" data-to="editing">继续修改 →</button></div>`;
  }
  return `<div class="rowflex" style="gap:8px"><button class="btn sm primary" data-transition="${id}" data-to="editing">开始修改 →</button></div>`;
}

// ============ 绑定 ============
import {$$, api, toast, modal, state as _st, esc as _esc} from '../lib.js';
import {refreshProject, navigate as go} from '../nav.js';

const docCache = new Map();

export function bindIssues() {
  const p = _st.project;
  if (!p) { document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go))); return; }
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

  // 筛选
  document.querySelectorAll('[data-fcheck]').forEach((b) => b.addEventListener('click', () => { _st.itemFilter.check = b.dataset.fcheck; go('issues'); }));
  document.querySelectorAll('[data-frisk]').forEach((b) => b.addEventListener('click', () => { _st.itemFilter.risk = b.dataset.frisk; go('issues'); }));
  document.querySelectorAll('[data-fstatus]').forEach((b) => b.addEventListener('click', () => { _st.itemFilter.status = b.dataset.fstatus; go('issues'); }));
  document.getElementById('fEntity')?.addEventListener('change', (e) => { _st.itemFilter.entity = e.target.value; _st.activeItemId = null; go('issues'); });

  // 选择问题
  document.querySelectorAll('[data-item]').forEach((el) => el.addEventListener('click', () => { _st.activeItemId = el.dataset.item; go('issues', {itemId: el.dataset.item}); }));

  // 批量操作
  document.querySelectorAll('[data-bulk]').forEach((b) => b.addEventListener('click', async () => {
    const ids = _st.visibleItemIds || [];
    if (!ids.length) return toast('当前筛选无问题', 'error');
    const assignee = document.getElementById('bulkAssignee').value.trim();
    const due = document.getElementById('bulkDue').value.trim();
    if (b.dataset.bulk === 'assign' && !assignee) return toast('请填写负责人', 'error');
    const body = {ids, by: p.owner || '负责人'};
    if (b.dataset.bulk === 'assign') { body.assignee = assignee; if (due) body.due = due; }
    else body.status = 'reviewing';
    try {
      await api(`/api/projects/${p.id}/items`, {method: 'POST', body});
      await refreshProject(); toast(`已更新 ${ids.length} 条`, 'ok'); go('issues');
    } catch (e) { toast(e.message, 'error'); }
  }));

  bindDetail(p);
}

function bindDetail(p) {
  const items = p.audit?.items || [];
  const it = items.find((x) => x.id === _st.activeItemId);
  if (!it) return;

  document.querySelectorAll('[data-transition]').forEach((b) => b.addEventListener('click', () => transitionItem(p, b.dataset.transition, b.dataset.to)));
  document.querySelectorAll('[data-save-item]').forEach((b) => b.addEventListener('click', () => saveItem(p, b.dataset.saveItem)));
  document.querySelectorAll('[data-comment-item]').forEach((b) => b.addEventListener('click', () => addComment(p, b.dataset.commentItem)));
  document.querySelectorAll('[data-assist]').forEach((b) => b.addEventListener('click', () => openAssist(p, b.dataset.assist)));
  document.querySelectorAll('[data-open-doc]').forEach((b) => b.addEventListener('click', () => { const [docId, paraIdx] = b.dataset.openDoc.split('|'); openDocContext(docId, Number(paraIdx)); }));
  document.querySelectorAll('[data-proof-item]').forEach((b) => b.addEventListener('click', () => uploadProof(p, b.dataset.proofItem)));
  document.querySelectorAll('[data-recheck]').forEach((b) => b.addEventListener('click', async () => {
    const btn = b; btn.disabled = true; btn.textContent = '核验中…';
    try {
      const r = await api(`/api/projects/${p.id}/recheck`, {method: 'POST', body: {requirementId: b.dataset.recheck}});
      await refreshProject();
      toast(`已重新核验 ${r.items.length} 项`, 'ok');
      go('issues', {itemId: _st.activeItemId});
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '修改后重新核验'; }
  }));
}

function uploadProof(p, itemId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.pdf,.docx,.xlsx,.jpg,.jpeg,.png,.zip';
  input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;
    let n = 0;
    for (const f of files) {
      try {
        const res = await fetch(`/api/projects/${p.id}/items/${itemId}/proofs`, {
          method: 'POST',
          headers: {'X-File-Name': encodeURIComponent(f.name), 'X-By': encodeURIComponent(p.owner || '负责人'), 'Content-Type': 'application/octet-stream'},
          body: f,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '上传失败');
        n++;
      } catch (e) { toast(`《${f.name}》${e.message}`, 'error'); }
    }
    await refreshProject();
    toast(`已上传 ${n} 份补证材料`, 'ok');
    go('issues', {itemId});
  });
  input.click();
}

async function transitionItem(p, id, to) {
  let body = {status: to, by: p.owner || '负责人'};
  const it = (p.audit.items || []).find((x) => x.id === id);
  if (to === 'closed' && ['critical', 'high'].includes(it?.risk)) {
    const reason = await promptText('关闭高风险问题', '高风险问题关闭需提供新版证据或人工复核说明：');
    if (reason === null) return;
    body.note = reason || '人工复核后关闭';
  }
  if (to === 'dismissed') {
    const reason = await promptText('标记非问题', '请说明为何不是问题（将留痕）：');
    if (reason === null) return;
    body.dismissReason = reason || '人工确认非问题';
    body.note = reason || '';
  }
  try {
    await api(`/api/projects/${p.id}/items/${id}`, {method: 'PATCH', body});
    await refreshProject(); toast('状态已更新', 'ok'); go('issues');
  } catch (e) { toast(e.message, 'error'); }
}

async function saveItem(p, id) {
  const body = {
    assignee: document.getElementById('itAssignee').value.trim(),
    due: document.getElementById('itDue').value.trim(),
    reviewer: document.getElementById('itReviewer').value.trim(),
    by: p.owner || '负责人',
  };
  try { await api(`/api/projects/${p.id}/items/${id}`, {method: 'PATCH', body}); await refreshProject(); toast('已保存', 'ok'); go('issues'); }
  catch (e) { toast(e.message, 'error'); }
}

async function addComment(p, id) {
  const text = document.getElementById('itComment').value.trim();
  if (!text) return toast('请输入评论', 'error');
  try { await api(`/api/projects/${p.id}/items/${id}`, {method: 'PATCH', body: {comment: text, by: p.owner || '负责人'}}); await refreshProject(); toast('已评论', 'ok'); go('issues'); }
  catch (e) { toast(e.message, 'error'); }
}

async function openAssist(p, id) {
  try {
    const {assist} = await api(`/api/projects/${p.id}/items/${id}`, {method: 'POST'});
    modal(`<div class="modal-head"><h3>修改助手</h3></div><div class="modal-body">
      ${assist.location ? `<div class="kv"><span class="k">招标依据</span><span>${esc(assist.location.file || '')} ${esc(assist.location.label || '')}</span></div><div class="quote req" style="margin:6px 0">${esc(assist.location.quote || '')}</div>` : ''}
      ${(assist.bidLocation || []).length ? `<label class="field">投标现状定位</label>${assist.bidLocation.map((b) => `<div class="quote bid" style="margin:4px 0">${esc(b.quote || '')}<div class="small muted">${esc(b.file || '')} · ${esc(b.label || '')}</div></div>`).join('')}` : ''}
      ${assist.action ? `<label class="field">修改动作</label><div class="small">${esc(assist.action)}</div>` : ''}
      ${assist.suggestedText ? `<label class="field">可参考文字草稿</label><div class="quote" style="background:#f0f6ff">${esc(assist.suggestedText)}</div>` : ''}
      ${(assist.cannotInvent || []).length ? `<label class="field">必须由人提供的真实材料</label><div class="small" style="color:var(--danger)">${esc(assist.cannotInvent.join('、'))}</div>` : ''}
      ${(assist.syncHints || []).length ? `<label class="field">需同步修改的其他要求</label><div class="small">${assist.syncHints.map((s) => '· ' + esc(s)).join('<br>')}</div>` : ''}
      ${assist.acceptance ? `<label class="field">验收</label><div class="small">${esc(assist.acceptance)}</div>` : ''}
      <div class="notice neutral small" style="margin-top:12px">${esc(assist.note || '')}</div>
    </div><div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>`, {width: 760});
  } catch (e) { toast(e.message, 'error'); }
}

function promptText(title, hint) {
  return new Promise((resolve) => {
    const m = modal(`<div class="modal-head"><h3>${esc(title)}</h3></div><div class="modal-body"><div class="small muted">${esc(hint)}</div><textarea class="in" id="ptxt" style="margin-top:10px"></textarea></div><div class="modal-foot"><button class="btn ghost" id="pcancel">取消</button><button class="btn primary" id="pok">确定</button></div>`);
    document.getElementById('pok').addEventListener('click', () => { const v = document.getElementById('ptxt').value.trim(); m.close(); resolve(v); });
    document.getElementById('pcancel').addEventListener('click', () => { m.close(); resolve(null); });
  });
}

async function openDocContext(docId, paraIdx) {
  try {
    let data = docCache.get(docId);
    if (!data) { data = await api(`/api/projects/${_st.project.id}/docs/${docId}/text`); docCache.set(docId, data); }
    const paras = data.paragraphs || [];
    const start = Math.max(0, paraIdx - 5), end = Math.min(paras.length, paraIdx + 6);
    const rows = [];
    for (let i = start; i < end; i++) {
      const pp = paras[i];
      rows.push(`<div class="ev-para ${i === paraIdx ? 'hl-bid' : ''}"><span class="pn">${pp.page ? 'p' + pp.page : i + 1}</span>${esc(pp.text || '')}</div>`);
    }
    modal(`<div class="modal-head"><h3>${esc(data.name || '原文')}</h3></div><div class="modal-body"><div class="small muted" style="margin-bottom:8px">${esc(data.locatorHint || '')}</div>${rows.join('') || '<div class="small muted">未提取到正文</div>'}</div><div class="modal-foot"><button class="btn primary" data-close>关闭</button></div>`, {width: 800});
  } catch (e) { toast(e.message, 'error'); }
}

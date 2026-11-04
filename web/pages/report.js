// 报告与交标：审核报告导出、交标前放行（检查清单 + 未关闭风险清单 + 放行确认）、版本复审。
import {esc, state, api, toast, modal, confirmDialog, uploadRaw} from '../lib.js';
import {refreshProject, refreshWorkbench, navigate as go} from '../nav.js';

export function renderReport() {
  const p = state.project;
  if (!p) return `<div class="empty" style="padding:80px"><div class="big">📄</div><b>请先选择项目</b><div style="margin-top:16px"><button class="btn primary" data-go="workbench">返回工作台</button></div></div>`;
  const a = p.audit;
  if (!a?.items) return `<div class="page-head"><div class="grow"><h1>报告与交标</h1><div class="sub">${esc(p.name)}</div></div></div><div class="empty" style="padding:60px"><div class="big">📄</div><b>尚未完成审核</b>完成审核后可导出报告并进行交标放行。<div style="margin-top:14px"><button class="btn primary" data-go="project">去审核</button></div></div>`;
  const tab = state.reportTab || 'report';
  return `
  <div class="page-head"><div class="grow"><h1>报告与交标</h1><div class="sub">${esc(p.name)} · ${esc(p.currentVersion)} · 生成于 ${esc(a.finishedAt || '')}</div></div>
    <button class="btn ghost" data-go="issues">← 返回问题工作单</button></div>

  <div class="tabs" id="reportTabs">
    <button class="tab ${tab === 'report' ? 'active' : ''}" data-rtab="report">审核报告</button>
    <button class="tab ${tab === 'release' ? 'active' : ''}" data-rtab="release">交标与放行</button>
  </div>

  ${tab === 'report' ? renderReportTab(p) : renderReleaseTab(p)}
  `;
}

// 子标签1：审核报告（导出为主，不混放行）
function renderReportTab(p) {
  return `
  <div class="grid-3">
    <div class="card pad"><div class="rowflex" style="justify-content:space-between"><h2>综合审核报告</h2></div>
      <div class="small muted" style="margin:8px 0 4px">团队审核、负责人决策、归档</div><div class="small muted" style="margin-bottom:14px">格式：Word</div>
      <a class="btn block primary" href="/api/projects/${p.id}/export?format=report" download>生成 Word 报告</a></div>
    <div class="card pad"><div class="rowflex" style="justify-content:space-between"><h2>问题清单</h2></div>
      <div class="small muted" style="margin:8px 0 4px">集中修改、按负责人处理</div><div class="small muted" style="margin-bottom:14px">格式：Excel/CSV</div>
      <a class="btn block" href="/api/projects/${p.id}/export?format=csv" download>导出问题清单</a></div>
    <div class="card pad"><div class="rowflex" style="justify-content:space-between"><h2>未关闭风险清单</h2></div>
      <div class="small muted" style="margin:8px 0 4px">交标前需知情的中高风险</div><div class="small muted" style="margin-bottom:14px">格式：CSV</div>
      <a class="btn block" href="/api/projects/${p.id}/export?format=risk-csv" download>导出风险清单</a></div>
  </div>
  <div class="notice neutral" style="margin-top:16px"><span>ℹ️</span><div>报告包含六类检查结果、覆盖范围、问题明细、证据引用与待人工核实事项。报告明确标注检索范围与「未覆盖」内容，不把「未检出」当作「全部合格」。</div></div>
  <div id="reportSummaryHost" style="margin-top:16px"></div>
  `;
}

// 子标签2：交标与放行（放行门禁 + 复审 + 复盘）
function renderReleaseTab(p) {
  return `
  <div id="releaseHost"><div class="empty" style="padding:30px">加载交标检查清单…</div></div>
  <div id="reviewHost" style="margin-top:18px"></div>
  <div id="retroHost" style="margin-top:18px"></div>
  `;
}

function retroHtml(r) {
  if (!r) return '';
  const top = r.topTypes || [];
  return `<div class="card pad">
    <div class="rowflex" style="justify-content:space-between"><h2>项目复盘</h2><span class="small muted">用于持续改善编制与审核效果</span></div>
    <div class="metrics" style="grid-template-columns:repeat(4,1fr);margin-top:14px">
      <div class="metric"><div class="label">审核轮次</div><div class="num">${r.auditRounds || 0}<span class="unit">次</span></div><div class="hint">当前版本 ${esc(r.currentVersion)}</div></div>
      <div class="metric"><div class="label">问题总数</div><div class="num">${r.totalItems || 0}<span class="unit">条</span></div><div class="hint">已关闭 ${r.closed || 0} · 非问题 ${r.dismissed || 0}</div></div>
      <div class="metric"><div class="label">复审</div><div class="num">${r.reviewSummary ? (r.reviewSummary.resolved || 0) : 0}<span class="unit">条已解决</span></div><div class="hint">${r.reviewSummary ? `仍存在 ${r.reviewSummary.persist || 0} · 新增 ${r.reviewSummary.added || 0}` : '尚未复审'}</div></div>
      <div class="metric"><div class="label">放行</div><div class="num" style="font-size:19px">${r.released ? '已放行' : '未放行'}</div><div class="hint">${esc(r.elapsed || '')}</div></div>
    </div>
    ${top.length ? `<div style="margin-top:16px"><h3>高频问题类型</h3><div class="small muted" style="margin:6px 0 8px">同类问题反复出现，通常意味着编制环节有系统性缺口，可在下次接标时提前预防。</div>
      ${top.map((t) => `<div class="bar-row" style="margin:5px 0"><span class="small" style="width:150px">${esc(t.type)}</span><div class="bar-track"><i style="width:${Math.min(100, (t.count / top[0].count) * 100)}%;background:var(--brand)"></i></div><b class="small" style="width:30px;text-align:right">${t.count}</b></div>`).join('')}
    </div>` : ''}
  </div>`;
}

export function bindReport() {
  const p = state.project;
  if (!p) { document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go))); return; }
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  document.querySelectorAll('#reportTabs .tab').forEach((t) => t.addEventListener('click', () => {
    state.reportTab = t.dataset.rtab; go('report');
  }));
  const tab = state.reportTab || 'report';
  if (tab === 'release') { loadRelease(p); loadReview(p); loadRetro(p); }
}

async function loadRetro(p) {
  const host = document.getElementById('retroHost');
  if (!host) return;
  try {
    const {retro} = await api(`/api/projects/${p.id}/retro`);
    host.innerHTML = retroHtml(retro);
  } catch (e) { host.innerHTML = ''; }
}

async function loadRelease(p) {
  const host = document.getElementById('releaseHost');
  if (!host) return;
  try {
    const {release, risks} = await api(`/api/projects/${p.id}/release`);
    host.innerHTML = releaseHtml(p, release, risks);
    bindRelease(p, release);
  } catch (e) { host.innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; }
}

function releaseHtml(p, release, risks) {
  const confirmed = p.release?.confirmedAt;
  return `<div class="card pad">
    <div class="rowflex" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div><h2>交标准备情况</h2><div class="small muted" style="margin-top:4px">明确区分「AI 审核跑完了」和「可以提交了」。全部硬门槛通过并由指定人员确认后才可放行。</div></div>
      <div class="rowflex">
        <a class="btn sm" href="/api/projects/${p.id}/export?format=release" download>导出检查清单(Word)</a>
        ${release.canRelease ? `<button class="btn primary" id="doRelease">${confirmed ? '重新确认放行' : '确认放行'}</button>` : `<button class="btn" id="forceRelease">强制放行（需说明）</button>`}
      </div>
    </div>
    ${confirmed ? `<div class="notice ok" style="margin-top:12px"><span>✅</span><div>已于 ${esc(p.release.confirmedAt)} 由 <b>${esc(p.release.confirmedBy)}</b> 确认放行（版本 ${esc(p.release.version)}）${p.release.forced ? ' · <b>强制放行</b>' : ''}${p.release.note ? '：' + esc(p.release.note) : ''}</div></div>` : ''}
    <div class="metrics" style="grid-template-columns:repeat(3,1fr);margin-top:14px">
      <div class="metric"><div class="label">硬门槛</div><div class="num" style="color:${release.canRelease ? 'var(--ok)' : 'var(--danger)'}">${release.gates.filter((g) => g.blocking && g.ok).length}/${release.gates.filter((g) => g.blocking).length}</div><div class="hint">通过/总数</div></div>
      <div class="metric"><div class="label">未关闭风险</div><div class="num" style="color:var(--warn)">${risks.length}</div><div class="hint">中高风险</div></div>
      <div class="metric"><div class="label">结论</div><div class="num" style="font-size:20px;color:${release.canRelease ? 'var(--ok)' : 'var(--danger)'}">${release.canRelease ? '可放行' : '不可放行'}</div><div class="hint">${release.auditComplete ? '审核完成' : '审核未完成'}</div></div>
    </div>
    <div style="margin-top:14px">${release.gates.map(gateRow).join('')}</div>
  </div>
  ${risks.length ? `<div class="card pad" style="margin-top:14px"><div class="rowflex" style="justify-content:space-between"><h2>未关闭风险清单</h2><span class="small muted">${risks.length} 项</span></div>
    <div class="table-wrap" style="margin-top:10px"><table class="tbl">
      <thead><tr><th>风险</th><th>问题</th><th>主体</th><th>具体缺口</th><th>负责人</th><th>状态</th></tr></thead>
      <tbody>${risks.map((r) => `<tr><td><span class="tag ${r.risk === 'critical' || r.risk === 'high' ? 'danger' : 'warn'}">${esc(r.riskLabel)}</span></td><td class="small"><b>${esc(r.title)}</b></td><td class="small">${esc(r.entityName || '—')}</td><td class="small muted">${esc((r.gap || '').slice(0, 60))}</td><td class="small">${esc(r.assignee || '未分派')}</td><td><span class="tag neutral">${esc(r.status || '')}</span></td></tr>`).join('')}</tbody>
    </table></div></div>` : ''}`;
}

function gateRow(g) {
  const ic = g.ok ? 'ok' : g.blocking ? 'no' : 'info';
  return `<div class="gate"><div class="ic ${ic}">${g.ok ? '✓' : g.blocking ? '✕' : '!'}</div><div class="txt"><b>${esc(g.label)}</b> <span class="tag ${g.ok ? 'ok' : g.blocking ? 'danger' : 'warn'}" style="font-size:10px">${g.ok ? '通过' : g.blocking ? '未通过' : '需知情'}</span><div>${esc(g.detail)}</div></div></div>`;
}

function bindRelease(p, release) {
  const confirmRelease = async (force) => {
    let body = {action: 'confirm', by: p.owner || '负责人', force};
    if (force) {
      const reason = await promptRelease('强制放行说明');
      if (reason === null) return;
      body.note = reason;
    }
    try {
      await api(`/api/projects/${p.id}/release`, {method: 'POST', body});
      await refreshProject(); await refreshWorkbench(); toast('已确认放行', 'ok'); go('report');
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('doRelease')?.addEventListener('click', () => confirmDialog('确认放行', `<p>确认版本 <b>${esc(p.currentVersion)}</b> 可交标？将记录确认人与时间。</p>`, () => confirmRelease(false), '确认放行'));
  document.getElementById('forceRelease')?.addEventListener('click', () => confirmDialog('强制放行', '<p style="color:var(--danger)">仍有硬门槛未通过。强制放行需填写说明并留痕，确定继续？</p>', () => confirmRelease(true), '强制放行'));
}

function promptRelease(hint) {
  return new Promise((resolve) => {
    const m = modal(`<div class="modal-head"><h3>${esc(hint)}</h3></div><div class="modal-body"><textarea class="in" id="prtxt" placeholder="填写放行说明/遗留风险说明"></textarea></div><div class="modal-foot"><button class="btn ghost" id="prcancel">取消</button><button class="btn primary" id="prok">确定</button></div>`);
    document.getElementById('prok').addEventListener('click', () => { const v = document.getElementById('prtxt').value.trim(); m.close(); resolve(v); });
    document.getElementById('prcancel').addEventListener('click', () => { m.close(); resolve(null); });
  });
}

// ---- 版本复审 ----
async function loadReview(p) {
  const host = document.getElementById('reviewHost');
  if (!host) return;
  const review = p.review;
  host.innerHTML = `<div class="card pad">
    <div class="rowflex" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div><h2>版本复审（V2/V3）</h2><div class="small muted" style="margin-top:4px">比较的是「要求是否满足」，不只是文字是否变化。删除旧文字不等于已解决。</div></div>
      <div class="rowflex">
        <select class="in" id="reviewVersion" style="width:auto;min-width:110px">${(p.versions || ['V1']).map((v) => `<option value="${v}">${v}</option>`).join('')}</select>
        <button class="btn" id="runReview">执行复审</button>
      </div>
    </div>
    ${review ? reviewSummary(review) : '<div class="empty" style="padding:30px"><b>尚未执行复审</b>切换到新版本并执行复审，比较新旧版本差异。</div>'}
  </div>`;
  bindReview(p);
}

function reviewSummary(review) {
  const s = review.summary || {};
  return `<div class="metrics" style="grid-template-columns:repeat(5,1fr);margin-top:14px">
    <div class="metric"><div class="label">已解决</div><div class="num" style="color:var(--ok)">${s.resolved || 0}</div></div>
    <div class="metric"><div class="label">仍存在</div><div class="num" style="color:var(--danger)">${s.persist || 0}</div></div>
    <div class="metric"><div class="label">风险升高</div><div class="num" style="color:var(--danger)">${s.riskUp || 0}</div></div>
    <div class="metric"><div class="label">新增</div><div class="num" style="color:var(--warn)">${s.added || 0}</div></div>
    <div class="metric"><div class="label">无法确认</div><div class="num" style="color:var(--ink-3)">${s.unconfirmed || 0}</div></div>
  </div>
  <div class="table-wrap" style="margin-top:14px;max-height:420px"><table class="tbl">
    <thead><tr><th>问题</th><th>结论</th><th>旧版证据 / 新版证据（并排对比）</th><th>说明</th></tr></thead>
    <tbody>${(review.diff || []).map((d) => `<tr>
      <td class="small" style="max-width:180px"><b>${esc(d.title)}</b>${d.entityName ? `<div class="small muted">${esc(d.entityName)}</div>` : ''}</td>
      <td>${stateTag(d.state)}</td>
      <td style="max-width:440px">
        <div class="grid-2" style="gap:8px">
          <div><div class="small muted">旧版</div>${(d.oldEvidence || []).length ? d.oldEvidence.slice(0, 2).map((e) => `<div class="quote" style="font-size:11.5px;padding:6px 8px;margin:3px 0">${esc((e.quote || '').slice(0, 90))}</div>`).join('') : '<div class="small muted">无证据</div>'}</div>
          <div><div class="small muted">新版</div>${(d.newEvidence || []).length ? d.newEvidence.slice(0, 2).map((e) => `<div class="quote bid" style="font-size:11.5px;padding:6px 8px;margin:3px 0">${esc((e.quote || '').slice(0, 90))}${e.grade === 'fuzzy' ? ' <span class="tag warn" style="font-size:9px">部分相似</span>' : ''}</div>`).join('') : '<div class="small muted">未检出</div>'}</div>
        </div>
      </td>
      <td class="small muted" style="max-width:180px">${esc(d.note || '')}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="small muted">无历史问题对比</td></tr>'}</tbody>
  </table></div>
  ${(review.newItems || []).length ? `<div class="section-title" style="margin:16px 0 10px"><h2>新版新增问题</h2><div class="line"></div><span class="small muted">${review.newItems.length} 条</span></div>
    <div class="table-wrap" style="max-height:240px"><table class="tbl"><thead><tr><th>问题</th><th>类别</th><th>风险</th></tr></thead><tbody>${review.newItems.slice(0, 30).map((n) => `<tr><td class="small">${esc(n.title)}</td><td class="small">${esc(n.checkLabel || n.check)}</td><td><span class="tag ${n.risk === 'critical' || n.risk === 'high' ? 'danger' : 'warn'}">${esc(n.risk)}</span></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function stateTag(s) {
  return {
    resolved: '<span class="tag ok"><span class="cdot"></span>已解决</span>',
    persist: '<span class="tag danger"><span class="cdot"></span>仍存在</span>',
    riskUp: '<span class="tag danger">风险升高</span>',
    riskDown: '<span class="tag warn">风险降低</span>',
    unconfirmed: '<span class="tag neutral">无法确认</span>',
  }[s] || '<span class="tag neutral">—</span>';
}

function bindReview(p) {
  document.getElementById('runReview')?.addEventListener('click', async () => {
    const v = document.getElementById('reviewVersion').value;
    const btn = document.getElementById('runReview'); btn.disabled = true; btn.textContent = '复审中…';
    try {
      await api(`/api/projects/${p.id}/review`, {method: 'POST', body: {version: v}});
      await refreshProject(); toast('复审完成', 'ok'); go('report');
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '执行复审'; }
  });
}

// 材料库：公司资质、证书、业绩、产品资料、人员材料及有效期。复用时需重新确认项目适用性。
import {esc, state, api, toast, modal, confirmDialog} from '../lib.js';

const CATS = {qualification: '公司资质', certificate: '证书', performance: '业绩', product: '产品资料', personnel: '人员材料', other: '其他'};

export function renderMaterials() {
  const mats = state.materials || [];
  const summary = state.materialSummary || {total: 0, valid: 0, expiring: 0, expired: 0, unknown: 0};
  return `
  <div class="page-head"><div class="grow"><h1>材料库</h1><div class="sub">公司资质、证书、业绩、产品资料、人员材料及有效期。复用到项目时需重新确认适用性，过期材料会提示。</div></div>
    <button class="btn primary" id="addMaterial">＋ 添加材料</button></div>
  <div class="metrics">
    <div class="metric"><div class="label">材料总数</div><div class="num">${summary.total}</div></div>
    <div class="metric"><div class="label">有效</div><div class="num" style="color:var(--ok)">${summary.valid}</div></div>
    <div class="metric"><div class="label">90天内到期</div><div class="num" style="color:var(--warn)">${summary.expiring}</div></div>
    <div class="metric"><div class="label">已过期</div><div class="num" style="color:var(--danger)">${summary.expired}</div></div>
  </div>
  <div class="card" style="margin-top:16px">
    <table class="tbl">
      <thead><tr><th>材料名称</th><th>类别</th><th>发证/出具</th><th>编号</th><th>有效期至</th><th>状态</th><th></th></tr></thead>
      <tbody>${mats.length ? mats.map(row).join('') : '<tr><td colspan="7"><div class="empty" style="padding:40px"><div class="big">🗂</div><b>还没有材料</b>添加公司资质、证书、业绩等可复用材料。</div></td></tr>'}</tbody>
    </table>
  </div>
  <div class="notice neutral small" style="margin-top:14px">材料库用于沉淀可复用证明材料。审核时不会自动引用过期材料；复用时请核对有效期与项目适用性。</div>`;
}

function row(m) {
  const vs = validityState(m);
  const tag = {expired: '<span class="tag danger">已过期</span>', expiring: '<span class="tag warn">即将到期</span>', valid: '<span class="tag ok">有效</span>', unknown: '<span class="tag neutral">有效期未知</span>'}[vs];
  return `<tr>
    <td><b class="small">${esc(m.name)}</b>${m.holder ? `<div class="small muted">${esc(m.holder)}</div>` : ''}</td>
    <td><span class="tag neutral">${esc(CATS[m.category] || m.category)}</span></td>
    <td class="small">${esc(m.issuer || '—')}</td>
    <td class="small">${esc(m.number || '—')}</td>
    <td class="small">${esc(m.validTo || '—')}</td>
    <td>${tag}</td>
    <td style="text-align:right;white-space:nowrap"><button class="btn sm ghost" data-del-mat="${m.id}">删除</button></td>
  </tr>`;
}

function validityState(m) {
  if (!m.validTo) return 'unknown';
  const d = parseDate(m.validTo);
  if (!d) return 'unknown';
  const days = Math.floor((d - new Date()) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 90) return 'expiring';
  return 'valid';
}
function parseDate(s) {
  const mm = String(s).match(/(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/);
  if (!mm) return null;
  return new Date(+mm[1], +mm[2] - 1, mm[3] ? +mm[3] : 1);
}

export function bindMaterials() {
  document.getElementById('addMaterial')?.addEventListener('click', openAdd);
  document.querySelectorAll('[data-del-mat]').forEach((b) => b.addEventListener('click', () => confirmDialog('删除材料', '<p>确定删除该材料？</p>', async () => {
    await api(`/api/materials/${b.dataset.delMat}`, {method: 'DELETE'});
    await reloadMaterials(); toast('已删除', 'ok');
  })));
}

function openAdd() {
  const cats = Object.entries(CATS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  const m = modal(`<div class="modal-head"><h3>添加材料</h3></div><div class="modal-body">
    <label class="field">材料名称 <span class="req">*</span></label><input class="in" id="mtName" maxlength="120">
    <div class="grid-2"><div><label class="field">类别</label><select class="in" id="mtCat">${cats}</select></div><div><label class="field">持有主体</label><input class="in" id="mtHolder" maxlength="120"></div></div>
    <div class="grid-2"><div><label class="field">发证/出具机构</label><input class="in" id="mtIssuer" maxlength="120"></div><div><label class="field">编号</label><input class="in" id="mtNumber" maxlength="80"></div></div>
    <div class="grid-2"><div><label class="field">生效日期</label><input class="in" id="mtFrom" maxlength="40"></div><div><label class="field">有效期至</label><input class="in" id="mtTo" maxlength="40" placeholder="如 2027-06-30"></div></div>
    <label class="field">备注</label><textarea class="in" id="mtNote"></textarea>
  </div><div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doMt">保存</button></div>`);
  document.getElementById('doMt').addEventListener('click', async () => {
    const body = {name: document.getElementById('mtName').value.trim(), category: document.getElementById('mtCat').value, holder: document.getElementById('mtHolder').value.trim(), issuer: document.getElementById('mtIssuer').value.trim(), number: document.getElementById('mtNumber').value.trim(), validFrom: document.getElementById('mtFrom').value.trim(), validTo: document.getElementById('mtTo').value.trim(), note: document.getElementById('mtNote').value.trim()};
    if (!body.name) return toast('请填写材料名称', 'error');
    await api('/api/materials', {method: 'POST', body});
    await reloadMaterials(); m.close(); toast('已添加', 'ok');
  });
}

async function reloadMaterials() {
  const {materials, summary} = await api('/api/materials');
  state.materials = materials; state.materialSummary = summary;
  window.__bdRender?.();
}

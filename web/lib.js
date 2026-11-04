// 前端基础工具：请求、DOM、格式化、状态、词表。
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {'Content-Type': 'application/json', ...(options.headers || {})},
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（${res.status}）`);
  return data;
}

export const state = {
  projects: [],
  currentId: null,
  project: null,
  meta: null,
  workbench: null,
  view: 'workbench',
  // 视图内状态
  itemFilter: {check: '', risk: '', status: 'open', assignee: '', entity: ''},
  activeItemId: null,
  ledgerEditId: null,
  matrixFilter: '',
  projectTab: 'files',
  reportTab: 'report',
  visibleItemIds: [],
};

export function toast(msg, type = 'info') {
  let host = $('#toast');
  if (!host) { host = document.createElement('div'); host.id = 'toast'; document.body.append(host); }
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4200);
}

export function modal(html, {width = 720} = {}) {
  let host = $('#modal-host');
  if (!host) { host = document.createElement('div'); host.id = 'modal-host'; document.body.append(host); }
  host.innerHTML = `<div class="modal-backdrop"><div class="modal" style="max-width:${width}px">${html}</div></div>`;
  host.classList.add('open');
  const close = () => { host.classList.remove('open'); host.innerHTML = ''; };
  host.querySelector('.modal-backdrop').addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-backdrop')) close(); });
  host.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return {close, host};
}

export function confirmDialog(title, body, onOk, okText = '确认') {
  const m = modal(`<div class="modal-head"><h3>${esc(title)}</h3></div><div class="modal-body">${body}</div><div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="okBtn">${esc(okText)}</button></div>`);
  $('#okBtn').addEventListener('click', async () => {
    $('#okBtn').disabled = true;
    try { await onOk(); m.close(); } catch (e) { toast(e.message, 'error'); $('#okBtn').disabled = false; }
  });
}

export const fmt = {
  size(bytes) {
    if (!bytes) return '0';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  },
  date(s) { return s || '—'; },
};

// 词表（来自 meta.vocab，带兜底）
export function vocab() {
  return state.meta?.vocab || {};
}
export function checkLabel(k) {
  return (vocab().checks || []).find((x) => x.key === k)?.label || k;
}
export function riskTone(r) {
  return {critical: 'solid-danger', high: 'danger', mid: 'warn', low: 'neutral'}[r] || 'neutral';
}
export function riskLabel(r) {
  return vocab().itemRisk?.[r]?.label || {critical: '致命风险', high: '高风险', mid: '中风险', low: '提示'}[r] || r;
}
export function checkStatusMeta(s) {
  return vocab().checkStatus?.[s] || {label: s, tone: 'neutral'};
}
export function itemStatusLabel(s) {
  return vocab().itemStatus?.[s]?.label || s;
}
export function itemStatusTone(s) {
  return vocab().itemStatus?.[s]?.tone || 'neutral';
}
export function reqTypeLabel(t) {
  return vocab().reqTypes?.[t]?.label || t;
}

export async function uploadRaw(projectId, file, {category, entityId, version}) {
  const res = await fetch(`/api/projects/${projectId}/docs/raw`, {
    method: 'POST',
    headers: {
      'X-File-Name': encodeURIComponent(file.name),
      'X-Category': encodeURIComponent(category || 'bid'),
      'X-Entity': entityId || '',
      'X-Version': encodeURIComponent(version || 'V1'),
      'Content-Type': 'application/octet-stream',
    },
    body: file,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error((data && data.error) || `上传失败（${res.status}）`);
  return data;
}

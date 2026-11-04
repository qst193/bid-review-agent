// 页面骨架与路由：五项主导航（工作台 / 项目 / 问题 / 材料库 / 报告与交标）。
import {$, esc, state, api, toast} from './lib.js';
import {navigate, loadProject, refreshWorkbench} from './nav.js';
import {renderWorkbench, bindWorkbench} from './pages/workbench.js';
import {renderProject, bindProject} from './pages/project.js';
import {renderIssues, bindIssues} from './pages/issues.js';
import {renderMaterials, bindMaterials} from './pages/materials.js';
import {renderReport, bindReport} from './pages/report.js';
import {renderSettings, bindSettings} from './pages/settings.js';

const ICONS = {
  workbench: 'M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z',
  project: 'M3 6a1 1 0 0 1 1-1h4l1.5 2H16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  issues: 'M6 3h8a1 1 0 0 1 1 1v13l-5-3-5 3V4a1 1 0 0 1 1-1z',
  materials: 'M4 5h12v12H4zM7 3v4M13 3v4M4 10h12',
  report: 'M6 3h6l4 4v10H6zM11 3v5h4M8 12h6M8 15h6',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4',
};

const NAV = [
  {group: '工作', items: [
    {key: 'workbench', label: '工作台', ico: 'workbench'},
    {key: 'project', label: '项目', ico: 'project', needProject: true},
  ]},
  {group: '审核', items: [
    {key: 'issues', label: '问题', ico: 'issues', needProject: true},
    {key: 'report', label: '报告与交标', ico: 'report', needProject: true},
  ]},
  {group: '资产', items: [
    {key: 'materials', label: '材料库', ico: 'materials'},
    {key: 'settings', label: '设置', ico: 'settings'},
  ]},
];

const CRUMB = {workbench: '工作台', project: '项目', issues: '问题工作单', materials: '材料库', report: '报告与交标', settings: '设置'};

export function go(view, opts) { navigate(view, opts); }

export function render() {
  const app = $('#app');
  const p = state.project;
  const nav = $('#nav');
  nav.innerHTML = NAV.map((grp) => {
    const items = grp.items.filter((it) => !it.needProject || p).map((it) => {
      const active = state.view === it.key ? 'active' : '';
      let badge = '';
      if (it.key === 'issues' && p?.audit?.items) {
        const open = p.audit.items.filter((x) => !['closed', 'dismissed'].includes(x.status) && ['critical', 'high'].includes(x.risk)).length;
        if (open) badge = `<span class="badge">${open}</span>`;
      }
      return `<button class="nav-item ${active}" data-go="${it.key}">
        <svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[it.ico]}"/></svg>
        <span>${it.label}</span>${badge}</button>`;
    }).join('');
    return items ? `<div class="nav-group">${grp.group}</div>${items}` : '';
  }).join('');

  $('#crumb').innerHTML = CRUMB[state.view] || '工作台';

  const pages = {
    workbench: [renderWorkbench, bindWorkbench],
    project: [renderProject, bindProject],
    issues: [renderIssues, bindIssues],
    materials: [renderMaterials, bindMaterials],
    report: [renderReport, bindReport],
    settings: [renderSettings, bindSettings],
  };
  const [renderFn, bindFn] = pages[state.view] || pages.workbench;
  try {
    app.innerHTML = renderFn();
    bindFn();
  } catch (e) {
    console.error('页面渲染失败', e);
    app.innerHTML = `<div class="notice danger" style="margin:20px"><b>页面渲染失败：</b>${e.message}<br><span class="small">${(e.stack || '').split('\n').slice(0, 3).join(' | ')}</span></div>`;
  }
  bindGlobalNav();
  updateTopbar();
}

let navBound = false;
function bindGlobalNav() {
  if (navBound) return;
  navBound = true;
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go]');
    if (el) { e.preventDefault(); go(el.dataset.go); }
  });
}

export function updateTopbar() {
  const pill = $('#modelPill');
  if (pill && state.meta) {
    const m = state.meta.model;
    if (m.configured) { pill.className = 'pill ok'; pill.innerHTML = `<span class="dot"></span>${esc(m.name)}`; pill.title = `模型：${m.baseUrl}`; }
    else { pill.className = 'pill warn'; pill.innerHTML = `<span class="dot"></span>模型未配置`; }
  }
  const pp = $('#projectPill');
  if (pp) {
    if (state.project) {
      pp.classList.remove('hidden');
      pp.innerHTML = `📁 ${esc(state.project.name)} · ${esc(state.project.currentVersion || 'V1')}`;
    } else pp.classList.add('hidden');
  }
}

export async function boot() {
  window.__bdRender = render;
  try {
    const [meta, projects, wb, mats] = await Promise.all([api('/api/meta'), api('/api/projects'), api('/api/workbench'), api('/api/materials')]);
    state.meta = meta;
    state.projects = projects.projects;
    state.workbench = wb;
    state.materials = mats.materials;
    state.materialSummary = mats.summary;
    if (projects.projects.length) {
      const saved = localStorage.getItem('bd-current');
      const target = projects.projects.find((x) => x.id === saved) || projects.projects[0];
      try { await loadProject(target.id); } catch {}
    }
  } catch (e) {
    toast('初始化失败：' + e.message, 'error');
  }
  const hash = location.hash.replace('#', '');
  const [viewPart, queryPart] = hash.split('?');
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    if (params.get('tab')) state.projectTab = params.get('tab');
    if (params.get('item')) state.activeItemId = params.get('item');
  }
  state.view = viewPart || 'workbench';
  render();
  window.addEventListener('hashchange', () => {
    const [v, query] = location.hash.slice(1).split('?');
    if (!v) return;
    const params = new URLSearchParams(query || '');
    if (params.has('tab')) state.projectTab = params.get('tab');
    if (params.has('item')) state.activeItemId = params.get('item');
    state.view = v;
    render();
  });
  // 后台刷新工作台数据
  refreshWorkbench().then(() => { if (state.view === 'workbench') render(); }).catch(() => {});
}

window.addEventListener('DOMContentLoaded', boot);

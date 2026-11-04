// 导航与项目加载。
import {state, api} from './lib.js';

export function navigate(view, opts = {}) {
  state.view = view;
  if (opts.itemId !== undefined) state.activeItemId = opts.itemId;
  if (opts.tab !== undefined) state.projectTab = opts.tab;
  let hash = `#${view}`;
  const params = new URLSearchParams();
  if (view === 'project' && state.projectTab) params.set('tab', state.projectTab);
  if (view === 'issues' && state.activeItemId) params.set('item', state.activeItemId);
  const q = params.toString();
  if (q) hash += '?' + q;
  location.hash = hash;
  if (typeof window.__bdRender === 'function') window.__bdRender();
  window.scrollTo({top: 0, behavior: 'instant'});
}

export async function loadProject(id) {
  state.currentId = id;
  state.project = (await api('/api/projects/' + id)).project;
  state.activeItemId = null;
  localStorage.setItem('bd-current', id);
}

export async function refreshProject() {
  if (!state.currentId) return;
  state.project = (await api('/api/projects/' + state.currentId)).project;
}

export async function refreshProjects() {
  state.projects = (await api('/api/projects')).projects;
}

export async function refreshWorkbench() {
  state.workbench = await api('/api/workbench');
}

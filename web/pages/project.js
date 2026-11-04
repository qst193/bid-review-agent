// 项目页渲染：文件管理 / 招标要求台账 / 响应矩阵 / 审核进度。
import {esc, state, fmt, reqTypeLabel, checkStatusMeta} from '../lib.js';

const FILE_CATS = [
  {key: 'procurement', label: '招标文件及附件', role: 'procurement'},
  {key: 'supplement', label: '澄清/答疑/补遗', role: 'procurement'},
  {key: 'qualification', label: '资格证明', role: 'bid'},
  {key: 'technical', label: '技术材料', role: 'bid'},
  {key: 'commercial', label: '商务材料', role: 'bid'},
  {key: 'price', label: '报价文件', role: 'bid'},
  {key: 'other', label: '其他附件', role: 'bid'},
];

export function renderProject() {
  const p = state.project;
  if (!p) return `<div class="empty" style="padding:80px"><div class="big">📂</div><b>请先选择或创建项目</b><div style="margin-top:16px"><button class="btn primary" data-go="workbench">返回工作台</button></div></div>`;
  const wiz = p._wizard || {stages: [], current: 'files', hint: ''};
  const cur = wiz.stages.find((s) => s.key === wiz.current) || {title: '', mainAction: null};
  // 当前阶段决定默认展开的标签
  const defaultTab = {files: 'files', scope: 'ledger', issues: 'audit', release: 'audit'}[wiz.current] || 'files';
  const tab = state.projectTab || defaultTab;

  return `
  <div class="page-head">
    <div class="grow">
      <h1>${esc(p.name)} <span class="tag ${p.currentVersion === 'V1' ? 'neutral' : 'brand'}" style="vertical-align:middle;font-size:12px">${esc(p.currentVersion)}</span></h1>
      <div class="sub">${esc(p.code || '无编号')} · 采购人 ${esc(p.purchaser || '—')} · 负责人 ${esc(p.owner || '未指定')} · 交标 ${esc(p.bidDeadline || '未设置')}</div>
    </div>
    <div class="rowflex"><button class="btn ghost" id="projSettings">项目信息</button><button class="btn ghost" id="projAdvanced">高级操作</button></div>
  </div>

  ${wizardBanner(p, wiz, cur)}

  <div class="wizard-steps" id="wizardSteps">
    ${(wiz.stages || []).map((s) => wizardStepCard(p, s)).join('')}
  </div>

  <div class="tabs" id="projTabs">
    <button class="tab ${tab === 'files' ? 'active' : ''}" data-ptab="files">文件管理</button>
    <button class="tab ${tab === 'ledger' ? 'active' : ''}" data-ptab="ledger">招标要求台账 <span class="n">${p.requirements.length}</span></button>
    <button class="tab ${tab === 'matrix' ? 'active' : ''}" data-ptab="matrix">响应矩阵</button>
    <button class="tab ${tab === 'audit' ? 'active' : ''}" data-ptab="audit">审核进度</button>
  </div>
  <div id="tabBody">${tab === 'files' ? renderFiles(p) : tab === 'ledger' ? renderLedger(p) : tab === 'matrix' ? '<div id="matrixHost"><div class="empty" style="padding:40px">加载响应矩阵…</div></div>' : renderAudit(p)}</div>`;
}

// 顶部固定横幅：当前阶段 + 下一步主按钮
function wizardBanner(p, wiz, cur) {
  const ma = cur.mainAction;
  return `<div class="wizard-banner">
    <div class="wb-left">
      <span class="wb-dot"></span>
      <div>
        <div class="wb-current">当前：第 ${cur.no || '?'} 步 · ${esc(cur.title || '')}</div>
        <div class="wb-next">下一步：${esc(ma ? ma.label : cur.next || '')}</div>
      </div>
    </div>
    <div class="rowflex">
      ${ma ? `<button class="btn primary" data-wiz-action="${ma.view}|${ma.tab || ''}|${ma.action || ''}">${esc(ma.label)} →</button>` : `<span class="tag ok"><span class="cdot"></span>本阶段已完成</span>`}
    </div>
  </div>`;
}

// 四阶段卡片
function wizardStepCard(p, s) {
  const cls = s.status === 'done' ? 'done' : s.status === 'current' ? 'current' : '';
  const icon = s.status === 'done' ? '✓' : String(s.no);
  return `<div class="wizard-step ${cls}">
    <div class="ws-head"><span class="ws-no">${icon}</span><b>${esc(s.title)}</b></div>
    <div class="ws-desc">${esc(s.desc)}</div>
    <div class="ws-next">${esc(s.next || '')}</div>
    ${s.mainAction ? `<button class="btn sm ${s.status === 'current' ? 'primary' : ''}" data-wiz-action="${s.mainAction.view}|${s.mainAction.tab || ''}|${s.mainAction.action || ''}">${esc(s.mainAction.label)}</button>` : (s.status === 'done' ? `<span class="small" style="color:var(--ok)">已完成</span>` : '')}
  </div>`;
}

function renderFiles(p) {
  const vers = [...new Set(p.docs.filter((d) => d.role === 'bid').map((d) => d.version))].sort();
  return `
  <div class="notice"><span>ℹ️</span><div>文件按类别存放，每份显示版本与解析状态。支持 DOC、DOCX、可复制文字的 PDF、TXT、MD 等格式；扫描件和图片尚未接入 OCR，会标记未覆盖，需人工核对。</div></div>
  <div class="card pad" style="margin-top:14px"><div class="rowflex wrap" style="justify-content:space-between;gap:12px">
    <div><h2>当前审核版本：${esc(p.currentVersion)}</h2><div class="small muted">历史版本 ${vers.join(' / ') || 'V1'} · 切换后当前审核失效，历史记录保留</div></div>
    <div class="rowflex"><select class="in" id="versionSel" style="width:auto;min-width:90px">${(p.versions || ['V1']).map((v) => `<option value="${v}" ${v === p.currentVersion ? 'selected' : ''}>${v}</option>`).join('')}</select><input class="in" id="newVersion" placeholder="新版本 如V2" style="width:110px" maxlength="20"><button class="btn" id="switchVersion">切换/新增</button></div>
  </div></div>
  <div class="grid-2" style="margin-top:14px">
    <div class="card pad"><div class="rowflex" style="justify-content:space-between"><h2>招标类文件</h2><span class="tag brand">${p.docs.filter((d) => d.role === 'procurement').length} 份</span></div>
      ${FILE_CATS.filter((c) => c.role === 'procurement').map((c) => catBlock(p, c, p.docs.filter((d) => d.category === c.key))).join('')}</div>
    <div class="card pad"><div class="rowflex" style="justify-content:space-between"><h2>投标主体与投标包</h2><button class="btn sm" id="addEntity">＋ 登记主体</button></div>
      <div class="small muted" style="margin:6px 0">同一主体的多份文件审核时自动合并为「投标包」跨文件检索证据。</div>
      ${p.entities.length ? p.entities.map((e) => entityBlock(p, e)).join('') : '<div class="small muted">尚无主体</div>'}</div>
  </div>
  <div class="card pad" style="margin-top:14px"><div class="rowflex" style="justify-content:space-between"><h2>其他投标文件类别</h2><span class="small muted">附属于对应主体 · 审核时合并进投标包</span></div>
    ${p.entities.length === 0 ? '<div class="notice neutral small" style="margin-top:10px">请先在上方登记投标主体，再上传资格证明/技术/商务/报价类文件。</div>' : ''}
    ${FILE_CATS.filter((c) => c.role === 'bid').map((c) => catBlock(p, c, p.docs.filter((d) => d.category === c.key))).join('')}</div>`;
}

function catBlock(p, cat, docs) {
  // 投标类文件需选择主体，上传时用下拉选择
  const needEntity = cat.role === 'bid';
  return `<div style="border:1px solid var(--line-2);border-radius:10px;padding:10px 12px;margin-top:10px">
    <div class="rowflex" style="justify-content:space-between"><div class="rowflex" style="gap:8px"><b style="font-size:13px">${cat.label}</b><span class="small muted">${docs.length} 份</span></div>
      <div class="rowflex" style="gap:6px">
        ${needEntity ? `<select class="in" id="catEnt-${cat.key}" style="width:auto;min-width:130px;padding:4px 8px;font-size:12px">${p.entities.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select>` : ''}
        <button class="btn sm ghost" data-upload="${cat.key}" data-need-entity="${needEntity ? '1' : ''}" ${needEntity && !p.entities.length ? 'disabled' : ''}>＋ 上传</button>
      </div></div>
    ${docs.length ? docs.map(docRow).join('') : '<div class="small muted" style="margin-top:6px">未上传</div>'}</div>`;
}
function entityBlock(p, e) {
  const docs = p.docs.filter((d) => d.entityId === e.id && d.role === 'bid' && d.version === p.currentVersion);
  const all = p.docs.filter((d) => d.entityId === e.id && d.role === 'bid');
  return `<div style="border:1px solid var(--line-2);border-radius:10px;padding:10px 12px;margin-top:10px">
    <div class="rowflex" style="justify-content:space-between"><div class="rowflex" style="gap:8px"><span class="tag brand">${esc(e.name)}</span>${e.owner ? `<span class="small muted">${esc(e.owner)}</span>` : ''}</div>
      <div class="rowflex" style="gap:6px"><button class="btn sm ghost" data-upload="bid" data-entity="${e.id}">＋ 上传投标正文</button><button class="btn sm ghost" data-del-entity="${e.id}">🗑</button></div></div>
    <div class="small muted" style="margin-top:6px">当前版本 ${docs.length} 份 · 全部版本 ${all.length} 份</div>
    ${docs.length ? docs.map(docRow).join('') : '<div class="small muted">当前版本尚无投标正文</div>'}</div>`;
}
function docRow(d) {
  const st = d.parseError ? '<span class="tag danger">解析失败</span>' : d.structure?.unreadable ? '<span class="tag warn">未解析</span>' : `<span class="tag ok">已解析 ${d.structure?.paragraphCount || 0} 段</span>`;
  const meta = [];
  if (d.structure?.kind) meta.push(d.structure.kind.toUpperCase());
  if (d.structure?.pageCount) meta.push(d.structure.pageCount + ' 页');
  if (d.structure?.imageAnchors) meta.push(d.structure.imageAnchors + ' 图');
  return `<div class="rowflex" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line-2)">
    <div style="min-width:0"><div class="small" style="font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name)} <span class="tag neutral" style="font-size:10px">${esc(d.version)}</span>${d.duplicateOf ? ' <span class="tag warn" style="font-size:10px">重复文件</span>' : ''}</div>
    <div class="small muted">${fmt.size(d.size)} · ${meta.join(' · ') || ''}</div>
    ${d.structure?.unreadable && d.structure?.unreadableReason ? `<div class="small" style="color:var(--warn);margin-top:2px">${esc(d.structure.unreadableReason)}</div>` : ''}
    ${d.structure?.imageAnchors ? `<div class="small" style="color:var(--warn);margin-top:2px">含 ${d.structure.imageAnchors} 处图片；当前未做 OCR，请人工核对图片中的报价、证书和签章。</div>` : ''}
    ${d.duplicateOf ? `<div class="small" style="color:var(--warn);margin-top:2px">与已上传《${esc(d.duplicateOf.name)}》内容重复</div>` : ''}</div>
    <div class="rowflex" style="gap:6px">${st}<button class="btn sm ghost" data-reparse-doc="${d.id}">重新解析</button><button class="btn sm ghost" data-del-doc="${d.id}">删除</button></div>
  </div>`;
}

function renderLedger(p) {
  const reqs = p.requirements || [];
  const confirmed = reqs.filter((r) => r.status === 'confirmed').length;
  const rate = reqs.length ? Math.round((confirmed / reqs.length) * 100) : 0;
  return `
  <div class="notice"><span>ℹ️</span><div>系统抽取要求形成台账。<b>人工可编辑分类与核查点，原始引文不可覆盖</b>，确认后锁定为审核基线。补遗到来时可重新抽取合并。</div></div>
  <div class="card pad" style="margin-top:14px"><div class="rowflex" style="justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div class="rowflex" style="gap:18px"><div><div class="small muted">总数</div><b style="font-size:20px">${reqs.length}</b></div><div><div class="small muted">已确认</div><b style="font-size:20px;color:var(--ok)">${confirmed}</b></div><div><div class="small muted">确认率</div><b style="font-size:20px">${rate}%</b></div></div>
    <div class="rowflex"><button class="btn" id="extractLedger" ${state.meta?.model?.configured ? '' : 'disabled'}>抽取/更新台账</button><button class="btn" id="addReq">＋ 手工补充</button></div>
  </div>${!state.meta?.model?.configured ? '<div class="notice warn small" style="margin-top:10px">模型未配置，无法自动抽取；可用「手工补充」。</div>' : ''}</div>
  ${ledgerDiffHtml(p)}
  ${reqs.length ? `<div class="card" style="margin-top:14px"><div class="table-wrap"><table class="tbl">
    <thead><tr><th>要求</th><th>类型</th><th>原文依据</th><th>核查点</th><th>状态</th><th></th></tr></thead>
    <tbody>${reqs.map(reqRow).join('')}</tbody></table></div></div>` : `<div class="empty" style="padding:50px"><div class="big">📋</div><b>尚未抽取招标要求</b>点击「抽取/更新台账」。</div>`}`;
}

function ledgerDiffHtml(p) {
  const d = p.ledgerDiff;
  if (!d || !d.summary) return '';
  const s = d.summary;
  if (!s.added && !s.removed && !s.changed) return '';
  return `<div class="card pad" style="margin-top:14px;border-color:#f2e1bf;background:#fffdf8">
    <div class="rowflex" style="justify-content:space-between"><h3>补遗影响分析 <span class="small muted">${esc(d.at || '')}</span></h3>
      <div class="rowflex" style="gap:8px"><span class="tag ok">新增 ${s.added}</span><span class="tag danger">删除 ${s.removed}</span><span class="tag warn">修改 ${s.changed}</span></div></div>
    <div class="small muted" style="margin-top:6px">补遗文件导致要求变化，请核对受影响的任务与投标章节。</div>
    ${(d.added || []).length ? `<div style="margin-top:10px"><b class="small">新增要求</b>${d.added.map((x) => `<div class="small" style="margin-top:3px">· ${esc(x.title)} <span class="tag neutral" style="font-size:10px">${esc(x.type || '')}</span></div>`).join('')}</div>` : ''}
    ${(d.removed || []).length ? `<div style="margin-top:10px"><b class="small">已删除要求</b>${d.removed.map((x) => `<div class="small" style="margin-top:3px">· ${esc(x.title)}</div>`).join('')}</div>` : ''}
    ${(d.changed || []).length ? `<div style="margin-top:10px"><b class="small">已修改要求</b>${d.changed.map((x) => `<div class="small" style="margin-top:3px">· ${esc(x.title)}（${esc((x.fields || []).join('、'))}）</div>`).join('')}</div>` : ''}
  </div>`;
}

function reqRow(r) {
  const c = r.status === 'confirmed';
  return `<tr><td style="max-width:250px"><b class="small">${esc(r.title)}</b>${r.mark ? ' <span class="tag danger" style="font-size:10px">' + esc(r.mark) + '</span>' : ''}${r.origin === 'manual' ? ' <span class="tag neutral" style="font-size:10px">人工</span>' : ''}${r.consequence ? `<div class="small" style="color:var(--danger);margin-top:2px">后果：${esc(r.consequence)}</div>` : ''}</td>
    <td><span class="tag neutral">${esc(r.typeLabel || reqTypeLabel(r.type))}</span></td>
    <td style="max-width:280px"><div class="small" style="color:var(--ink-2)">${esc((r.quote || '').slice(0, 100))}${(r.quote || '').length > 100 ? '…' : ''}</div><div class="small muted">${esc(r.fileName || '')} · ${esc(r.locator?.label || '')}</div></td>
    <td style="max-width:180px"><div class="small muted">${(r.checkpoints || []).slice(0, 3).map((x) => '· ' + esc(x)).join('<br>') || '—'}</div></td>
    <td>${c ? '<span class="tag ok"><span class="cdot"></span>已确认</span>' : '<span class="tag warn">待确认</span>'}</td>
    <td style="text-align:right;white-space:nowrap">${c ? `<button class="btn sm ghost" data-reopen="${r.stableId}">解锁</button>` : `<button class="btn sm ok" data-confirm="${r.stableId}">确认</button>`}<button class="btn sm ghost" data-edit-req="${r.stableId}">编辑</button><button class="btn sm ghost" data-split-req="${r.stableId}">拆分</button><button class="btn sm ghost" data-del-req="${r.stableId}">删除</button></td></tr>`;
}

function renderAudit(p) {
  const a = p.audit;
  const rel = p._release || {};
  const steps = ['准备索引', '完整性', '资格与响应', '评分点', '一致性', '格式交付', '多主体互查', '汇总'];
  const stage = a?.stage ?? 0;
  return `<div class="card pad">
    <div class="rowflex" style="justify-content:space-between;flex-wrap:wrap;gap:12px">
      <div class="grow"><h2>${a ? (a.status === 'done' ? '审核已完成' : a.status === 'running' ? '审核进行中' : a.status === 'blocked' ? '审核受阻' : a.status === 'error' ? '审核中断' : '待审核') : '尚未审核'}</h2><div class="small muted" style="margin-top:4px">${a ? esc(a.message || '') : '确认台账并上传文件后即可发起审核。'}</div></div>
      <div class="rowflex">${!a || a.status === 'blocked' ? '<button class="btn primary" id="startAudit">开始审核</button>' : ''}${a && ['running', 'pending', 'error'].includes(a.status) ? '<button class="btn primary" id="continueAudit">继续审核</button>' : ''}${a && a.status === 'done' ? '<button class="btn" id="reAudit">重新审核</button><button class="btn primary" id="toIssues2">查看问题 →</button>' : ''}</div>
    </div>
    ${a ? `<div class="progressbar" style="margin-top:14px"><i style="width:${a.progress || 0}%"></i></div>
    <div class="steps" style="margin-top:12px">${steps.map((s, i) => { const cls = a.status === 'done' ? 'done' : i < stage ? 'done' : i === stage && a.status === 'running' ? 'active' : ''; return `<div class="step ${cls}"><div class="no">0${i + 1}</div><b>${s}</b><div class="st">${a.status === 'done' ? '完成' : i < stage ? '已完成' : i === stage && a.status === 'running' ? '进行中' : '等待'}</div></div>`; }).join('')}</div>` : ''}
    ${a?.error && a.status !== 'done' ? `<div class="notice ${a.status === 'blocked' ? 'warn' : 'danger'}" style="margin-top:12px">${esc(a.error)}</div>` : ''}
    ${a?.status === 'done' ? `<div class="notice ${rel.canRelease ? 'ok' : 'warn'}" style="margin-top:14px"><span>${rel.canRelease ? '✅' : '⚠️'}</span><div>${rel.canRelease ? '全部硬门槛通过，可进入「报告与交标」放行。' : `尚有 ${(rel.blocking || []).length} 项硬门槛未通过：${(rel.blocking || []).map((b) => esc(b.label)).join('、')}`}</div></div>` : ''}
  </div>${a?.coverage ? renderCoverage(a.coverage) : ''}`;
}

function renderCoverage(cov) {
  const files = cov.files || {}, req = cov.requirements || {};
  const unread = [...(files.procurement?.unreadable || []), ...(files.bid?.unreadable || [])];
  return `<div class="grid-2" style="margin-top:14px">
    <div class="card pad"><h3>文件可读率</h3><div class="bar-row" style="margin-top:10px"><div class="bar-track"><i style="width:${files.fileRate || 0}%;background:var(--brand)"></i></div><b class="small">${files.fileRate || 0}%</b></div><div class="small muted" style="margin-top:8px">招标类 ${files.procurement?.parsed || 0}/${files.procurement?.total || 0} 可读（补遗 ${files.procurement?.supplements || 0}）· 投标 ${files.bid?.parsed || 0}/${files.bid?.total || 0} 可读</div>${unread.length ? `<div class="notice danger small" style="margin-top:10px">未解析：${unread.map((d) => esc(d.name)).join('、')}</div>` : ''}</div>
    <div class="card pad"><h3>要求覆盖率</h3><div class="bar-row" style="margin-top:10px"><div class="bar-track"><i style="width:${req.rate || 0}%;background:var(--ok)"></i></div><b class="small">${req.rate || 0}%</b></div><div class="small muted" style="margin-top:8px">已确认 ${req.confirmed || 0}/${req.total || 0} 条，其中 ${req.judged || 0} 条已有核查结论</div>${(req.rate || 0) < 90 ? '<div class="notice warn small" style="margin-top:10px">要求覆盖率不足 90%，不能放行。</div>' : ''}</div>
  </div>`;
}

export async function matrixHtmlFor(projectId) {
  const {api} = await import('../lib.js');
  const {matrix, summary} = await api(`/api/projects/${projectId}/matrix`);
  return matrixHtml(matrix, summary);
}

function matrixHtml(matrix, summary) {
  if (!matrix.length) return `<div class="empty" style="padding:40px"><b>尚无要求</b>请先在「招标要求台账」抽取并确认要求。</div>`;
  const c = summary.counts;
  return `<div class="metrics" style="grid-template-columns:repeat(4,1fr)">
    <div class="metric"><div class="label">已满足</div><div class="num" style="color:var(--ok)">${c.satisfied}</div></div>
    <div class="metric"><div class="label">部分/未检出</div><div class="num" style="color:var(--warn)">${(c.partial || 0) + (c.notFound || 0)}</div></div>
    <div class="metric"><div class="label">明确不满足</div><div class="num" style="color:var(--danger)">${c.violated}</div></div>
    <div class="metric"><div class="label">无法确认/未覆盖</div><div class="num" style="color:var(--ink-3)">${(c.unknown || 0) + (c.uncovered || 0)}</div></div>
  </div>
  <div class="notice neutral small" style="margin-top:14px">以招标要求为行、投标证据与状态为列。「未检出」与「明确不满足」严格区分。</div>
  <div class="card" style="margin-top:14px"><div class="table-wrap"><table class="tbl">
    <thead><tr><th>招标要求</th><th>类型</th><th>核对结论</th><th>投标证据</th><th>负责人</th><th>人工确认</th><th></th></tr></thead>
    <tbody>${matrix.map((row) => {
      const st = checkStatusMeta(row.status);
      const ev = row.evidence || [];
      return `<tr>
        <td style="max-width:250px"><b class="small">${esc(row.title)}</b>${row.mark ? ' <span class="tag danger" style="font-size:10px">' + esc(row.mark) + '</span>' : ''}<div class="small muted" style="margin-top:2px">${esc((row.quote || '').slice(0, 55))}${(row.quote || '').length > 55 ? '…' : ''}</div></td>
        <td><span class="tag neutral">${esc(row.typeLabel || '')}</span></td>
        <td><span class="tag ${st.tone || 'neutral'}"><span class="cdot"></span>${esc(row.statusLabel || st.label)}</span>${row.openItems ? `<div class="small muted" style="margin-top:2px">${row.openItems} 待处理</div>` : ''}</td>
        <td style="max-width:290px">${ev.length ? ev.slice(0, 2).map((e) => `<div class="small" style="color:var(--ink-2);border-left:2px solid ${e.weak ? '#d0a0a0' : '#e2b56b'};padding-left:7px;margin:3px 0">${esc((e.quote || '').slice(0, 60))}${e.weak ? ' <span class="tag warn" style="font-size:10px">部分相似</span>' : ''}</div>`).join('') : '<span class="small muted">未检出证据</span>'}</td>
        <td class="small">${esc(row.owner || '—')}</td>
        <td style="max-width:180px">${row.manualConclusion ? `<div class="small" style="color:var(--ink-2)">${esc(row.manualConclusion)}</div>` : '<span class="small muted">待人工确认</span>'}</td>
        <td style="text-align:right"><button class="btn sm ghost" data-mx-confirm="${row.requirementId}">人工结论</button></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>`;
}

export const PROJECT_FILE_CATS = FILE_CATS;

// ============ 绑定与操作 ============
import {$$, api, toast, modal, confirmDialog, uploadRaw, state as _s} from '../lib.js';
import {refreshProject, refreshWorkbench, navigate as go} from '../nav.js';

export function bindProject() {
  const p = _s.project;
  if (!p) { document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go))); return; }
  $$('#projTabs .tab').forEach((t) => t.addEventListener('click', () => { _s.projectTab = t.dataset.ptab; go('project', {tab: t.dataset.ptab}); }));
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  document.getElementById('toIssues2')?.addEventListener('click', () => go('issues'));
  document.getElementById('projSettings')?.addEventListener('click', () => openProjectSettings(p));
  document.getElementById('projAdvanced')?.addEventListener('click', () => openAdvanced(p));

  // 向导动作
  document.querySelectorAll('[data-wiz-action]').forEach((b) => b.addEventListener('click', () => {
    const [view, tab, action] = b.dataset.wizAction.split('|');
    if (action === 'startAudit') {
      const startBtn = document.getElementById('startAudit');
      if (startBtn) startBtn.click();
      else driveAudit(p, 'start');
      return;
    }
    if (view === 'project' && tab) { go('project', {tab}); }
    else if (view === 'issues') { go('issues'); }
    else if (view === 'report') { go('report'); }
    else { go(view || 'project'); }
  }));

  if (_s.projectTab === 'matrix') {
    matrixHtmlFor(p.id).then((html) => { const host = document.getElementById('matrixHost'); if (host) { host.innerHTML = html; bindMatrixActions(p); } }).catch((e) => { const host = document.getElementById('matrixHost'); if (host) host.innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; });
  }

  document.getElementById('switchVersion')?.addEventListener('click', async () => {
    const v = (document.getElementById('newVersion').value.trim() || document.getElementById('versionSel').value);
    if (!v) return toast('请选择或输入版本', 'error');
    if (v === p.currentVersion) return toast('已是当前版本', 'info');
    confirmDialog('切换版本', `<p>切换到版本 <b>${esc(v)}</b> 会清空当前审核结果，需重新审核。确定？</p>`, async () => {
      await api(`/api/projects/${p.id}/version`, {method: 'POST', body: {version: v}});
      await refreshProject(); await refreshWorkbench(); toast('已切换版本', 'ok'); go('project', {tab: 'files'});
    });
  });

  document.querySelectorAll('[data-upload]').forEach((b) => b.addEventListener('click', () => {
    const cat = b.dataset.upload;
    let entityId = b.dataset.entity || null;
    // 类别区上传：从该类别的主体下拉取值
    if (b.dataset.needEntity) entityId = document.getElementById(`catEnt-${cat}`)?.value || null;
    pickFiles(cat, entityId);
  }));
  document.querySelectorAll('[data-del-doc]').forEach((b) => b.addEventListener('click', () => confirmDialog('删除文件', '<p>确定删除该文件？</p>', async () => {
    await api(`/api/projects/${p.id}/docs/${b.dataset.delDoc}`, {method: 'DELETE'}); await refreshProject(); toast('已删除', 'ok'); go('project', {tab: 'files'});
  })));
  document.querySelectorAll('[data-reparse-doc]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = '解析中…';
    try { const r = await api(`/api/projects/${p.id}/docs/${b.dataset.reparseDoc}/reparse`, {method: 'POST'}); await refreshProject();
      toast(r.doc.structure?.unreadable ? '文件仍无法读取，请检查格式' : `已提取 ${r.doc.structure?.paragraphCount || 0} 段正文`, r.doc.structure?.unreadable ? 'error' : 'ok'); go('project', {tab: 'files'});
    } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = '重新解析'; }
  }));
  document.querySelectorAll('[data-del-entity]').forEach((b) => b.addEventListener('click', () => confirmDialog('删除主体', '<p>删除主体前请先删除其文件。</p>', async () => {
    await api(`/api/projects/${p.id}/entities/${b.dataset.delEntity}`, {method: 'DELETE'}); await refreshProject(); go('project', {tab: 'files'});
  })));
  document.getElementById('addEntity')?.addEventListener('click', () => openAddEntity(p));

  document.getElementById('extractLedger')?.addEventListener('click', async () => {
    const btn = document.getElementById('extractLedger'); btn.disabled = true; btn.textContent = '抽取中（可能数分钟）…';
    try { const r = await api(`/api/projects/${p.id}/ledger`, {method: 'POST', body: {action: 'extract'}}); await refreshProject(); toast(`已抽取 ${r.requirements.length} 条要求`, 'ok'); go('project', {tab: 'ledger'}); }
    catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '抽取/更新台账'; }
  });
  document.getElementById('addReq')?.addEventListener('click', () => openAddReq(p));
  document.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', () => ledgerAction(p, 'confirm', b.dataset.confirm)));
  document.querySelectorAll('[data-reopen]').forEach((b) => b.addEventListener('click', () => ledgerAction(p, 'reopen', b.dataset.reopen)));
  document.querySelectorAll('[data-edit-req]').forEach((b) => b.addEventListener('click', () => openEditReq(p, b.dataset.editReq)));
  document.querySelectorAll('[data-split-req]').forEach((b) => b.addEventListener('click', () => openSplitReq(p, b.dataset.splitReq)));
  document.querySelectorAll('[data-del-req]').forEach((b) => b.addEventListener('click', () => confirmDialog('删除要求', '<p>从台账移除该要求？</p>', async () => {
    await api(`/api/projects/${p.id}/ledger`, {method: 'POST', body: {action: 'edit', payload: {action: 'remove', stableId: b.dataset.delReq}}}); await refreshProject(); go('project', {tab: 'ledger'});
  })));

  document.getElementById('startAudit')?.addEventListener('click', () => driveAudit(p, 'start'));
  document.getElementById('continueAudit')?.addEventListener('click', () => driveAudit(p, 'step'));
  document.getElementById('reAudit')?.addEventListener('click', () => confirmDialog('重新审核', '<p>将重新执行六类检查并覆盖当前结果。确定？</p>', () => driveAudit(p, 'start')));
}

async function ledgerAction(p, action, stableId) {
  await api(`/api/projects/${p.id}/ledger`, {method: 'POST', body: {action: 'edit', payload: {action, stableId}}});
  await refreshProject(); toast(action === 'confirm' ? '已确认' : '已解锁', 'ok'); go('project', {tab: 'ledger'});
}

function openAddEntity(p) {
  const m = modal(`<div class="modal-head"><h3>登记投标主体</h3></div><div class="modal-body"><label class="field">公司完整名称 <span class="req">*</span></label><input class="in" id="entName" maxlength="100"><label class="field">责任人</label><input class="in" id="entOwner" maxlength="40"></div><div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doEntity">保存</button></div>`);
  setTimeout(() => document.getElementById('entName')?.focus(), 50);
  document.getElementById('doEntity').addEventListener('click', async () => {
    const name = document.getElementById('entName').value.trim(); if (!name) return toast('请填写名称', 'error');
    try { await api(`/api/projects/${p.id}/entities`, {method: 'POST', body: {name, owner: document.getElementById('entOwner').value.trim()}}); await refreshProject(); m.close(); go('project', {tab: 'files'}); }
    catch (e) { toast(e.message, 'error'); }
  });
}

function openEditReq(p, stableId) {
  const r = (p.requirements || []).find((x) => x.stableId === stableId); if (!r) return;
  const types = ['qualification', 'substantive', 'material', 'param', 'commercial', 'scoring', 'format'];
  const m = modal(`<div class="modal-head"><h3>编辑要求</h3></div><div class="modal-body">
    <label class="field">标题</label><input class="in" id="erTitle" value="${esc(r.title)}" maxlength="60">
    <label class="field">类型</label><select class="in" id="erType">${types.map((t) => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${reqTypeLabel(t)}</option>`).join('')}</select>
    <label class="field">原文引用（不可覆盖）</label><div class="quote req">${esc(r.quote)}</div>
    <label class="field">核查点（每行一个）</label><textarea class="in" id="erCp">${esc((r.checkpoints || []).join('\n'))}</textarea>
    <label class="field">负责人</label><input class="in" id="erOwner" value="${esc(r.owner || '')}" maxlength="40"></div>
    <div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doEditReq">保存</button></div>`);
  document.getElementById('doEditReq').addEventListener('click', async () => {
    const payload = {action: 'update', stableId, title: document.getElementById('erTitle').value.trim(), type: document.getElementById('erType').value, owner: document.getElementById('erOwner').value.trim(), checkpoints: document.getElementById('erCp').value.split('\n').map((x) => x.trim()).filter(Boolean)};
    await api(`/api/projects/${p.id}/ledger`, {method: 'POST', body: {action: 'edit', payload}}); await refreshProject(); m.close(); go('project', {tab: 'ledger'});
  });
}

function openAddReq(p) {
  const types = ['qualification', 'substantive', 'material', 'param', 'commercial', 'scoring', 'format'];
  const m = modal(`<div class="modal-head"><h3>手工补充要求</h3></div><div class="modal-body">
    <label class="field">标题 <span class="req">*</span></label><input class="in" id="nrTitle" maxlength="60">
    <label class="field">类型</label><select class="in" id="nrType">${types.map((t) => `<option value="${t}">${reqTypeLabel(t)}</option>`).join('')}</select>
    <label class="field">原文引用</label><textarea class="in" id="nrQuote"></textarea>
    <label class="field">核查点（每行一个）</label><textarea class="in" id="nrCp"></textarea>
    <label class="field">负责人</label><input class="in" id="nrOwner" maxlength="40"></div>
    <div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doAddReq">添加</button></div>`);
  document.getElementById('doAddReq').addEventListener('click', async () => {
    const title = document.getElementById('nrTitle').value.trim(); if (!title) return toast('请填写标题', 'error');
    const req = {title, type: document.getElementById('nrType').value, quote: document.getElementById('nrQuote').value.trim(), checkpoints: document.getElementById('nrCp').value.split('\n').map((x) => x.trim()).filter(Boolean), owner: document.getElementById('nrOwner').value.trim()};
    await api(`/api/projects/${p.id}/ledger`, {method: 'POST', body: {action: 'edit', payload: {action: 'add', req}}}); await refreshProject(); m.close(); go('project', {tab: 'ledger'});
  });
}

function pickFiles(category, entityId) {
  const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
  input.accept = '.docx,.pdf,.txt,.md,.doc,.xls,.xlsx';
  input.addEventListener('change', async () => {
    const files = [...input.files]; if (!files.length) return;
    const isProc = ['procurement', 'supplement'].includes(category);
    if (!isProc && !entityId) return toast('投标文件请选择投标主体后再上传', 'error');
    let ok = 0;
    for (const f of files) {
      try { toast(`上传并解析：${f.name}…`); await uploadRaw(_s.project.id, f, {category, entityId, version: _s.project.currentVersion}); ok++; }
      catch (e) { toast(`《${f.name}》失败：${e.message}`, 'error'); }
    }
    await refreshProject(); await refreshWorkbench(); toast(`已上传 ${ok} 个文件`, 'ok'); go('project', {tab: 'files'});
  });
  input.click();
}

async function driveAudit(p, mode) {
  if (mode === 'start') {
    try { await api(`/api/projects/${p.id}/audit/start`, {method: 'POST'}); await refreshProject(); }
    catch (e) { return toast(e.message, 'error'); }
  }
  const btn = document.getElementById('continueAudit'); if (btn) { btn.disabled = true; btn.textContent = '审核中…'; }
  try {
    for (let i = 0; i < 12; i++) {
      const {audit} = await api(`/api/projects/${p.id}/audit/step`, {method: 'POST'});
      _s.project.audit = audit;
      const bar = document.querySelector('.progressbar i'); if (bar) bar.style.width = (audit.progress || 0) + '%';
      const msg = document.querySelector('.card.pad .small.muted'); if (msg && audit.message) msg.textContent = audit.message;
      if (['done', 'blocked', 'error'].includes(audit.status)) break;
    }
    await refreshProject(); await refreshWorkbench();
    const a = _s.project.audit;
    toast(a.status === 'done' ? '审核完成' : (a.error || '审核未完成'), a.status === 'done' ? 'ok' : 'error');
    go('project', {tab: 'audit'});
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '继续审核'; } }
}

function openProjectSettings(p) {
  const m = modal(`<div class="modal-head"><h3>项目信息</h3></div><div class="modal-body">
    <label class="field">项目名称</label><input class="in" id="psName" value="${esc(p.name)}" maxlength="120">
    <div class="grid-2"><div><label class="field">编号</label><input class="in" id="psCode" value="${esc(p.code || '')}" maxlength="60"></div><div><label class="field">包号</label><input class="in" id="psPackage" value="${esc(p.packageNo || '')}" maxlength="60"></div></div>
    <label class="field">采购人</label><input class="in" id="psPurchaser" value="${esc(p.purchaser || '')}" maxlength="120">
    <div class="grid-2"><div><label class="field">负责人</label><input class="in" id="psOwner" value="${esc(p.owner || '')}" maxlength="40"></div><div><label class="field">答疑截止</label><input class="in" id="psQa" value="${esc(p.qaDeadline || '')}" maxlength="40"></div></div>
    <div class="grid-2"><div><label class="field">内部定稿</label><input class="in" id="psInternal" value="${esc(p.internalDeadline || '')}" maxlength="40"></div><div><label class="field">交标截止</label><input class="in" id="psBid" value="${esc(p.bidDeadline || '')}" maxlength="40"></div></div>
    <div class="section-title" style="margin:16px 0 8px"><h2 style="font-size:14px">价格分参数</h2><div class="line"></div></div>
    <div class="small muted" style="margin-bottom:6px">价格分由程序按公式计算；缺少评标基准价或投标报价时不计算，不虚构分数。</div>
    <label class="field">价格分公式（原文照抄）</label><input class="in" id="psFormula" value="${esc(p.priceContext?.formula || '')}" placeholder="如：价格分 = 30 × (评标基准价 / 投标报价)">
    <label class="field">评标基准价（元）</label><input class="in" id="psBenchmark" value="${esc(p.priceContext?.benchmark ?? '')}" placeholder="若未知可留空">
  </div><div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doPs">保存</button></div>`);
  document.getElementById('doPs').addEventListener('click', async () => {
    const body = {name: document.getElementById('psName').value.trim(), code: document.getElementById('psCode').value.trim(), packageNo: document.getElementById('psPackage').value.trim(), purchaser: document.getElementById('psPurchaser').value.trim(), owner: document.getElementById('psOwner').value.trim(), qaDeadline: document.getElementById('psQa').value.trim(), internalDeadline: document.getElementById('psInternal').value.trim(), bidDeadline: document.getElementById('psBid').value.trim()};
    const benchRaw = document.getElementById('psBenchmark').value.trim();
    body.priceContext = {formula: document.getElementById('psFormula').value.trim(), benchmark: benchRaw ? Number(benchRaw.replace(/,/g, '')) : null};
    await api(`/api/projects/${p.id}`, {method: 'PATCH', body}); await refreshProject(); await refreshWorkbench(); m.close(); toast('已保存', 'ok'); go('project', {tab: _s.projectTab || 'files'});
  });
}

// 拆分要求：把一条要求按核查点拆成多条，便于逐条跟踪
function openSplitReq(p, stableId) {
  const r = (p.requirements || []).find((x) => x.stableId === stableId);
  if (!r) return;
  const cps = (r.checkpoints || []).length ? r.checkpoints : [''];
  const m = modal(`<div class="modal-head"><h3>拆分要求</h3></div><div class="modal-body">
    <div class="small muted">原要求：${esc(r.title)}</div>
    <div class="quote req" style="margin:8px 0">${esc(r.quote)}</div>
    <div class="small muted">按核查点拆成子要求（每行一个，留空的行忽略）。原引文保持不变，拆分项继承原文依据。</div>
    <textarea class="in" id="spList" style="min-height:130px;margin-top:8px">${esc(cps.join('\n'))}</textarea>
  </div><div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doSplit">确认拆分</button></div>`);
  document.getElementById('doSplit').addEventListener('click', async () => {
    const lines = document.getElementById('spList').value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) return toast('至少两行才能拆分', 'error');
    const groups = lines.map((line, i) => ({title: line.slice(0, 40) || `拆分项${i + 1}`, checkpoints: [line]}));
    await api(`/api/projects/${p.id}/ledger`, {method: 'POST', body: {action: 'edit', payload: {action: 'split', stableId, groups}}});
    await refreshProject(); m.close(); toast(`已拆分为 ${groups.length} 条`, 'ok'); go('project', {tab: 'ledger'});
  });
}

// 矩阵人工确认结论
function bindMatrixActions(p) {
  document.querySelectorAll('[data-mx-confirm]').forEach((b) => b.addEventListener('click', () => {
    import('../lib.js').then(async ({api}) => {
      const {matrix} = await api(`/api/projects/${p.id}/matrix`);
      const row = matrix.find((x) => x.requirementId === b.dataset.mxConfirm);
      if (!row) return;
      const m = modal(`<div class="modal-head"><h3>人工确认结论</h3></div><div class="modal-body">
        <div class="small muted">要求</div><div style="font-weight:550;margin:4px 0 8px">${esc(row.title)}</div>
        <div class="quote req" style="margin-bottom:10px">${esc(row.quote || '')}</div>
        <div class="small muted">系统判断：<span class="tag ${checkStatusMeta(row.status).tone || 'neutral'}">${esc(row.statusLabel)}</span></div>
        <label class="field">人工确认结论</label>
        <select class="in" id="mxStatus">
          <option value="confirmed">确认满足要求</option>
          <option value="needEvidence">确认为待补证</option>
          <option value="unknown">仍无法确认</option>
        </select>
        <label class="field">说明（留痕）</label><textarea class="in" id="mxNote" placeholder="例如：已核对原件，社保记录齐全">${esc(row.manualConclusion || '')}</textarea>
        <label class="field">负责人</label><input class="in" id="mxOwner" value="${esc(row.owner || '')}" maxlength="40">
      </div><div class="modal-foot"><button class="btn ghost" data-close>取消</button><button class="btn primary" id="doMx">保存</button></div>`);
      document.getElementById('doMx').addEventListener('click', async () => {
        await api(`/api/projects/${p.id}/matrix`, {method: 'POST', body: {
          requirementId: row.requirementId,
          status: document.getElementById('mxStatus').value,
          manualConclusion: document.getElementById('mxNote').value.trim() || (document.getElementById('mxStatus').value === 'confirmed' ? '人工确认满足' : ''),
          owner: document.getElementById('mxOwner').value.trim(),
        }});
        await refreshProject(); m.close(); toast('已保存人工结论', 'ok'); go('project', {tab: 'matrix'});
      });
    });
  }));
}

// 高级操作：折叠次要功能，避免阻挡首次审核
function openAdvanced(p) {
  modal(`<div class="modal-head"><h3>高级操作</h3></div><div class="modal-body">
    <div class="small muted" style="margin-bottom:12px">以下功能在完成第一次审核前通常用不到，可在此按需使用。</div>
    <div class="stack">
      <div class="rowflex" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-2)">
        <div><b class="small">多投标主体互查</b><div class="small muted">同一项目登记多个投标主体并做雷同/关联线索比对</div></div>
        <button class="btn sm" data-adv-go="project|files">管理主体</button>
      </div>
      <div class="rowflex" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-2)">
        <div><b class="small">价格分参数</b><div class="small muted">填写评标基准价与公式，用于价格分测算</div></div>
        <button class="btn sm" data-adv="price">设置参数</button>
      </div>
      <div class="rowflex" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-2)">
        <div><b class="small">手工拆分/合并条款</b><div class="small muted">在招标要求台账中拆分或合并要求</div></div>
        <button class="btn sm" data-adv-go="project|ledger">打开台账</button>
      </div>
      <div class="rowflex" style="justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line-2)">
        <div><b class="small">响应矩阵</b><div class="small muted">按招标要求逐行查看证据与核对结论</div></div>
        <button class="btn sm" data-adv-go="project|matrix">打开矩阵</button>
      </div>
      <div class="rowflex" style="justify-content:space-between;padding:10px 0">
        <div><b class="small">材料库</b><div class="small muted">管理可复用的公司资质、证书、业绩</div></div>
        <button class="btn sm" data-adv-go="materials|">前往材料库</button>
      </div>
    </div>
  </div><div class="modal-foot"><button class="btn primary" data-close>关闭</button></div>`, {width: 600}).host.querySelectorAll('[data-adv-go]').forEach((b) => {
    b.addEventListener('click', () => { const [v, t] = b.dataset.advGo.split('|'); document.querySelector('.modal-backdrop')?.dispatchEvent(new MouseEvent('mousedown', {bubbles: true})); b.closest('.modal-backdrop')?.remove(); document.getElementById('modal-host')?.classList.remove('open'); if (v === 'project') go('project', {tab: t}); else go(v); });
  });
  document.querySelectorAll('[data-adv="price"]').forEach((b) => b.addEventListener('click', () => { document.getElementById('modal-host').classList.remove('open'); document.getElementById('modal-host').innerHTML=''; openProjectSettings(p); }));
}

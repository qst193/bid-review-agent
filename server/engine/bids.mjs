// 标书（Bid）为一等公民。层级：项目 → 标书 → 文件/版本/问题。
// 一份标书 = 一个投标主体的一份投标文件集，有独立编写人、版本线与审核结果。
// 问题必须绑定 projectId + bidId + entityId + version，供团队按「谁/哪份标书/哪版」追踪。

let seq = 0;

export function makeBid({entityId, entityName, author, currentVersion = 'V1', owner} = {}) {
  seq++;
  return {
    id: 'b' + Date.now().toString(36) + seq,
    entityId: entityId || null,
    entityName: String(entityName || '').slice(0, 120),
    author: String(author || owner || '').slice(0, 40),   // 编写人
    currentVersion: currentVersion || 'V1',
    versions: [currentVersion || 'V1'],
    createdAt: new Date().toLocaleString('zh-CN', {hour12: false}),
    archived: false,
  };
}

/** 根据标书计算其文档（该标书当前版本下、该主体的全部投标类文件）。 */
export function bidDocs(project, bid) {
  return (project.docs || []).filter((d) =>
    d.role !== 'procurement' &&
    !['procurement', 'supplement'].includes(d.category || '') &&
    d.entityId === bid.entityId &&
    (d.bidId === bid.id || !d.bidId),  // 兼容旧数据未打 bidId
  );
}

/** 标书的当前版本文件。 */
export function bidDocsCurrent(project, bid) {
  return bidDocs(project, bid).filter((d) => d.version === bid.currentVersion);
}

/**
 * 迁移：为已有项目补齐 bids[]。按现有 docs 的 entityId 分组，每个主体生成一份标书。
 * 旧数据无编写人时留空；版本取 docs 中出现过的版本。
 */
export function migrateBids(project) {
  if (Array.isArray(project.bids) && project.bids.length) {
    // 已有的标书补字段
    for (const b of project.bids) {
      if (!Array.isArray(b.versions)) b.versions = [b.currentVersion || 'V1'];
      if (b.author == null) b.author = '';
    }
    // 给缺 bidId 的 docs 回溯绑定
    for (const d of project.docs || []) {
      if (!d.bidId && d.role !== 'procurement' && !['procurement', 'supplement'].includes(d.category || '')) {
        const b = project.bids.find((x) => x.entityId === d.entityId);
        if (b) d.bidId = b.id;
      }
    }
    return project;
  }
  // 首次迁移：按主体聚合
  const bidDocsList = (project.docs || []).filter((d) => d.role !== 'procurement' && !['procurement', 'supplement'].includes(d.category || ''));
  const byEntity = new Map();
  for (const d of bidDocsList) {
    const key = d.entityId || '__none__';
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(d);
  }
  const bids = [];
  for (const [key, docs] of byEntity) {
    const entity = (project.entities || []).find((e) => e.id === key);
    const versions = [...new Set(docs.map((d) => d.version || 'V1'))].sort();
    const cur = versions.includes(project.currentVersion) ? project.currentVersion : (versions[versions.length - 1] || 'V1');
    const bid = {
      id: 'b' + Date.now().toString(36) + (bids.length + 1),
      entityId: key === '__none__' ? null : key,
      entityName: entity?.name || docs[0]?.entityName || '',
      author: entity?.owner || '',
      currentVersion: cur,
      versions,
      createdAt: project.createdAt || new Date().toLocaleString('zh-CN', {hour12: false}),
      archived: false,
    };
    bids.push(bid);
    for (const d of docs) d.bidId = bid.id;
  }
  project.bids = bids;
  return project;
}

/** 标书摘要（供工作台清单/项目页卡片）。 */
export function bidSummary(project, bid) {
  const items = (project.audit?.items || []).filter((it) => it.bidId === bid.id || (!it.bidId && it.entityId === bid.entityId));
  const open = items.filter((it) => !['closed', 'dismissed'].includes(it.status));
  const high = open.filter((it) => ['critical', 'high'].includes(it.risk));
  const reviewing = items.filter((it) => it.status === 'reviewing');
  const docs = bidDocsCurrent(project, bid);
  const unreadable = docs.filter((d) => !d.parsedOk && (d.parseError || d.structure?.unreadable));
  const closed = items.filter((it) => ['closed', 'dismissed'].includes(it.status));
  return {
    id: bid.id,
    entityName: bid.entityName,
    author: bid.author,
    currentVersion: bid.currentVersion,
    versions: bid.versions,
    docCount: docs.length,
    unreadableCount: unreadable.length,
    itemCount: items.length,
    openCount: open.length,
    highCount: open.filter((it) => it.risk === 'high').length,
    criticalCount: open.filter((it) => it.risk === 'critical').length,
    reviewingCount: reviewing.length,
    closeRate: items.length ? Math.round((closed.length / items.length) * 100) : 0,
    audited: items.length > 0,
    auditStale: project.audit?.status === 'stale',
  };
}

/** 跨标书互查：按配对（bid A ↔ bid B）分组线索。 */
export function crossPairs(project) {
  const bids = project.bids || [];
  const crossItems = (project.audit?.items || []).filter((it) => it.check === 'cross' && Array.isArray(it.extra?.conflictBids) && it.extra.conflictBids.length >= 2);
  const pairs = [];
  for (let i = 0; i < bids.length; i++) {
    for (let j = i + 1; j < bids.length; j++) {
      const a = bids[i], b = bids[j];
      const related = crossItems.filter((it) => {
        const cb = it.extra.conflictBids;
        return cb.includes(a.id) && cb.includes(b.id);
      });
      pairs.push({
        a: {id: a.id, entityName: a.entityName},
        b: {id: b.id, entityName: b.entityName},
        clues: related.map((it) => ({
          id: it.id, title: it.title, risk: it.risk,
          clueType: it.extra?.clueType, note: it.extra?.analysis || it.gap,
          evidence: (it.evidence || []).slice(0, 2).map((e) => ({file: e.fileName, quote: e.quote, label: e.locator?.label, bidEntity: e.bidEntityName})),
          status: it.status, statusLabel: it.statusLabel,
        })),
        count: related.length,
      });
    }
  }
  return pairs;
}

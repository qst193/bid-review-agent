// 项目、材料库与文件持久化。数据落在 DATA_DIR，文件按 id 存储，状态集中在一个 JSON。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const STATE_VERSION = 2;

export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    this.filesDir = path.join(this.dir, 'files');
    this.statePath = path.join(this.dir, 'state.json');
    this.lock = Promise.resolve();
    fs.mkdirSync(this.filesDir, {recursive: true});
  }

  async readState() {
    try {
      const raw = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      return migrate(raw);
    } catch (e) {
      if (e.code === 'ENOENT') return {projects: [], materials: [], version: STATE_VERSION};
      await fsp.rename(this.statePath, this.statePath + '.broken-' + Date.now()).catch(() => {});
      return {projects: [], materials: [], version: STATE_VERSION};
    }
  }

  async writeState(state) {
    await fsp.mkdir(this.dir, {recursive: true});
    const temp = this.statePath + '.tmp-' + randomUUID();
    await fsp.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fsp.rename(temp, this.statePath);
  }

  /** 串行化读改写，避免并发覆盖。 */
  async mutate(fn) {
    const run = this.lock.then(async () => {
      const state = await this.readState();
      const result = await fn(state);
      await this.writeState(state);
      return result;
    });
    this.lock = run.catch(() => {});
    return run;
  }

  filePath(id) {
    if (!/^[A-Za-z0-9_.-]{6,90}$/.test(id)) throw new Error('无效文件编号');
    return path.join(this.filesDir, id);
  }

  async saveFile(buffer, ext) {
    const id = randomUUID().replace(/-/g, '');
    const key = id + (ext || '.bin');
    await fsp.writeFile(path.join(this.filesDir, key), buffer);
    return key;
  }

  async readFile(key) {
    return fsp.readFile(path.join(this.filesDir, path.basename(key)));
  }

  async deleteFile(key) {
    if (!key) return;
    await fsp.unlink(path.join(this.filesDir, path.basename(key))).catch(() => {});
  }

  async stats() {
    let count = 0;
    let bytes = 0;
    for (const entry of await fsp.readdir(this.filesDir)) {
      const st = await fsp.stat(path.join(this.filesDir, entry));
      count++;
      bytes += st.size;
    }
    return {count, bytes};
  }
}

// 迁移旧状态：补齐新字段，保持向后兼容。
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function guessScoreFromQuote(q) {
  const m = String(q || '').match(/(?:价格分|技术分|商务分|该项|满分|分值)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*分/);
  return m ? parseFloat(m[1]) : null;
}

// 内联 bids 迁移（避免 store → engine 循环依赖）：按主体为每个项目补齐标书对象。
function migrateBidsInline(p) {
  const isBidDoc = (d) => d.role !== 'procurement' && !['procurement', 'supplement'].includes(d.category || '');
  if (Array.isArray(p.bids) && p.bids.length) {
    for (const b of p.bids) {
      if (!Array.isArray(b.versions)) b.versions = [b.currentVersion || 'V1'];
      if (b.author == null) b.author = '';
    }
    for (const d of p.docs || []) {
      if (!d.bidId && isBidDoc(d)) {
        const b = p.bids.find((x) => x.entityId === d.entityId);
        if (b) d.bidId = b.id;
      }
    }
    return;
  }
  const bidDocs = (p.docs || []).filter(isBidDoc);
  const byEntity = new Map();
  for (const d of bidDocs) {
    const key = d.entityId || '__none__';
    if (!byEntity.has(key)) byEntity.set(key, []);
    byEntity.get(key).push(d);
  }
  const bids = [];
  let idx = 0;
  for (const [key, docs] of byEntity) {
    idx++;
    const entity = (p.entities || []).find((e) => e.id === key);
    const versions = [...new Set(docs.map((d) => d.version || 'V1'))].sort();
    const cur = versions.includes(p.currentVersion) ? p.currentVersion : (versions[versions.length - 1] || 'V1');
    const bid = {
      id: 'b' + fnv((p.id || '') + '|' + (key || '') + '|' + idx),
      entityId: key === '__none__' ? null : key,
      entityName: entity?.name || docs[0]?.entityName || '',
      author: entity?.owner || '',
      currentVersion: cur,
      versions,
      createdAt: p.createdAt || new Date().toLocaleString('zh-CN', {hour12: false}),
      archived: false,
    };
    bids.push(bid);
    for (const d of docs) d.bidId = bid.id;
  }
  p.bids = bids;
}

// 去重 gap 片段：按「去空格+去标点」规范化后比较，消除仅差空格的重复
function dedupeGap(gap) {
  const normKey = (s) => String(s).replace(/[\s\u3000]/g, '').replace(/[。；，、,;.]/g, '');
  const segs = String(gap).replace(/；{2,}/g, '；').split('；').map((x) => x.trim()).filter(Boolean);
  const keptKeys = [];
  const uniq = [];
  for (const s of segs) {
    const k = normKey(s);
    if (!k) continue;
    // 完全重复 / 被已有片段包含 / 包含已有片段
    if (keptKeys.some((ek) => ek === k || ek.includes(k) || k.includes(ek))) continue;
    keptKeys.push(k);
    uniq.push(s);
  }
  return uniq.join('；').slice(0, 480);
}
function migrate(state) {
  if (!state || typeof state !== 'object') return {projects: [], materials: [], version: STATE_VERSION};
  state.version = STATE_VERSION;
  state.materials = Array.isArray(state.materials) ? state.materials : [];
  state.projects = Array.isArray(state.projects) ? state.projects : [];
  for (const p of state.projects) {
    p.currentVersion = p.currentVersion || p.version || 'V1';
    p.versions = Array.isArray(p.versions) && p.versions.length ? p.versions : [p.currentVersion];
    p.entities = p.entities || [];
    p.docs = (p.docs || []).map((d) => ({
      ...d,
      category: d.category || (d.role === 'procurement' ? 'procurement' : 'bid'),
      role: d.role || (d.category === 'procurement' || d.category === 'supplement' ? 'procurement' : 'bid'),
    }));
    p.requirements = p.requirements || [];
    // 迁移旧台账字段：旧数据用 kind，新引擎用 type/stableId/status
    p.requirements = p.requirements.map((r) => {
      // 早期已迁移过的记录：仅补齐可能缺失的 score 兜底
      if (r.stableId && r.type) {
        if (r.type === 'scoring' && r.score == null) r.score = guessScoreFromQuote(r.quote);
        return r;
      }
      const kindMap = {组成要件: 'material', 资格条件: 'qualification', 实质性要求: 'substantive', 评分要求: 'scoring', 其他要求: 'substantive'};
      const type = r.type || kindMap[r.kind] || 'substantive';
      const score = r.score != null ? r.score : (type === 'scoring' ? guessScoreFromQuote(r.quote) : null);
      return {
        ...r,
        score,
        type,
        typeLabel: r.typeLabel || ({material: '组成材料', qualification: '资格条件', substantive: '实质响应', scoring: '评分项', param: '技术参数', commercial: '商务条件', format: '格式要求'}[type] || type),
        stableId: r.stableId || 'R' + fnv((r.quote || r.title || '').replace(/[\s\u3000\p{P}\p{S}]/gu, '').slice(0, 80)),
        status: r.status || 'pending',
        statusLabel: r.statusLabel || (r.status === 'confirmed' ? '已确认' : '待确认'),
        locked: !!r.locked,
        origin: r.origin || 'ai',
        locator: r.locator || {},
      };
    });
    p.log = p.log || [];
    migrateBidsInline(p);
    if (p.audit && !p.audit.items && p.audit.modules) {
      // 旧四模块结果无法直接映射为工作单，保留但标记为历史
      p.audit.legacy = true;
    }
    p.auditHistory = p.auditHistory || [];
    // 清理旧数据中 gap 字段的重复分隔符与重复片段
    if (p.audit?.items) {
      for (const it of p.audit.items) {
        if (typeof it.gap === 'string') it.gap = dedupeGap(it.gap);
      }
    }
    if (p.review) p.review = p.review;
    p.release = p.release || null;
  }
  return state;
}

export {STATE_VERSION};

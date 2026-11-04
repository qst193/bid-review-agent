import {buildBidPackages, buildProcurementIndexes} from './audit-core.mjs';
import {runCross} from './checks.mjs';

export function entityVersion(entity) { return entity.currentVersion || 'V1'; }

// The legacy project audit and its history stay untouched. This view gives each
// writer one bid package while sharing the project's procurement requirements.
export function entityProject(project, entityId) {
  const entity=(project.entities||[]).find(e=>e.id===entityId);
  if(!entity)throw new Error('标书公司不存在');
  const version=entityVersion(entity);
  return {...project,entities:[entity],currentVersion:version,
    docs:(project.docs||[]).filter(d=>d.role==='procurement'||['procurement','supplement'].includes(d.category)||
      (d.entityId===entityId&&d.version===version))};
}

export function entityAudit(project, entityId) {
  const own=project.entityAudits?.[entityId];
  if(own)return own;
  // Existing multi-company reports remain readable after introducing per-company reviews.
  const version=entityVersion((project.entities||[]).find(e=>e.id===entityId)||{});
  const legacy=[project.audit,...(project.auditHistory||[]).slice().reverse()].find(a=>a&&a.version===version&&(a.status==='done'||a.items?.length));
  if(!legacy)return null;
  const ownItems=(legacy.items||[]).filter(i=>i.entityId===entityId);
  if(!ownItems.length)return null;
  return {...legacy,status:'done',legacy:true,items:ownItems,
    results:{},summary:null};
}

export function crossAudit(project) {
  const ids=(project.entities||[]).filter(e=>(project.docs||[]).some(d=>d.entityId===e.id&&d.version===entityVersion(e))).map(e=>e.id);
  if(ids.length<2)throw new Error('至少需要两家公司各上传一份标书包');
  const pending=ids.filter(id=>entityAudit(project,id)?.status!=='done');
  if(pending.length)throw new Error(`还有 ${pending.length} 份标书未完成独立审核`);
  const latest={...project,currentVersion:'__cross__',docs:(project.docs||[]).filter(d=>
    d.role==='procurement'||['procurement','supplement'].includes(d.category)||
    (ids.includes(d.entityId)&&d.version===entityVersion(project.entities.find(e=>e.id===d.entityId)))).map(d=>
      d.role==='procurement'||['procurement','supplement'].includes(d.category)?d:{...d,version:'__cross__'})};
  const packages=buildBidPackages(latest);
  const result=runCross(packages,buildProcurementIndexes(latest).indexes);
  return {status:'done',at:new Date().toISOString(),entityIds:ids,
    versions:Object.fromEntries(ids.map(id=>[id,entityVersion(project.entities.find(e=>e.id===id))])),
    items:result.items,coverage:result.coverage};
}

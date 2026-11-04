import assert from 'node:assert/strict';
import fs from 'node:fs';
import {entityAudit,entityProject,crossAudit} from '../server/engine/entity-workflow.mjs';

const id='p-b2hchx9o05tg';
const before=JSON.parse(fs.readFileSync(new URL('../.runtime/project3-pre-workflow-backup-20261031.json',import.meta.url)));
const live=JSON.parse(fs.readFileSync(new URL('../data/state.json',import.meta.url)));
const project=live.projects.find(p=>p.id===id),snapshot=before.projects.find(p=>p.id===id);
assert(project&&snapshot,'项目三必须存在');
assert.equal(project.audit?.items?.length,snapshot.audit?.items?.length,'项目三已有问题不得丢失');
assert.equal(project.auditHistory?.length,snapshot.auditHistory?.length,'项目三审核历史不得丢失');
assert.equal(project.audit?.status,'done');
for(const entity of project.entities){
  const scoped=entityProject(project,entity.id);
  assert(scoped.docs.filter(d=>d.role==='bid').every(d=>d.entityId===entity.id));
  assert(scoped.docs.some(d=>d.role==='procurement'));
  assert.equal(entityAudit(project,entity.id)?.items.length,63);
}
for(const doc of project.docs)if(doc.parsedKey)doc.parsed=JSON.parse(fs.readFileSync(new URL(`../data/files/${doc.parsedKey}`,import.meta.url)));
const result=crossAudit(project);
assert.equal(result.status,'done');
assert.equal(result.coverage.packages,3);
const newEntity={id:'e-new',name:'新公司',owner:'新负责人',currentVersion:'V1'};
assert.equal(entityAudit({...project,entities:[...project.entities,newEntity]},newEntity.id),null,'新增公司不能继承旧审核通过状态');
console.log('公司独立视图、项目三历史保留和三份关联性审查：通过');

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {priorityRequirements} from '../server/engine/priority.mjs';
import {findScoringTables} from '../server/engine/scoring-table.mjs';

const state=JSON.parse(fs.readFileSync('data/state.json','utf8'));
const project=state.projects.find(p=>p.name==='深航');
assert.ok(project,'深航测试项目必须存在');
const doc=project.docs.find(d=>d.category==='procurement');
const parsed=JSON.parse(fs.readFileSync(`data/files/${doc.parsedKey}`,'utf8'));
assert.equal(findScoringTables({...doc,parsed}).length,2);
const focused=priorityRequirements(project.requirements);
const rows=focused.filter(r=>r.origin==='scoring-table');
assert.equal(rows.length,15);
const business=rows.filter(r=>r.scoring.table.includes('商务'));
const technical=rows.filter(r=>r.scoring.table.includes('技术'));
assert.equal(business.length,3);
assert.equal(technical.length,12);
assert.equal(business.reduce((n,r)=>n+r.score,0),10);
assert.equal(technical.reduce((n,r)=>n+r.score,0),60);
const price=focused.find(r=>r.origin==='price-scoring');
assert.equal(price?.score,30);
assert.equal(rows.reduce((n,r)=>n+r.score,0)+price.score,100);
for(const row of rows){
  assert.ok(row.scoring.fullRule.length>0,`${row.title} 缺评分细则`);
  for(const material of row.scoring.materials)assert.ok(row.scoring.fullRule.includes(material),`${row.title} 混入其他评分项材料`);
}
assert.ok(!business[2].scoring.materials.some(x=>x.includes('验收证明')),'企业涉诉不得混入合同案例的材料');
console.log('深航评分说明：商务 3 项 10 分、技术 12 项 60 分、价格 30 分；材料逐项来源校验通过');

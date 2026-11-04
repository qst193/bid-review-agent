import assert from 'node:assert/strict';
import {priorityRequirements} from '../server/engine/priority.mjs';
import {advanceBatch} from '../server/engine/orchestrator.mjs';

const rows=Array.from({length:260},(_,i)=>({stableId:`r${i}`,type:i%2?'qualification':'material',
  title:`证明材料 ${i}`,quote:`供应商须提供证明材料 ${i}`,status:'pending'}));
const focus=priorityRequirements(rows);
assert.ok(focus.length>0 && focus.length<=100);
assert.equal(new Set(focus.map(r=>r.stableId)).size,focus.length);
const audit={stage:1,progress:4,results:{},items:[]};
const reqs=rows.slice(0,13).map(r=>({...r,type:'material'}));
let calls=0;
const run=async (_pkg,batch)=>{calls++;return {items:batch.map(r=>({id:r.stableId}))};};
const options={audit,packages:[{entityName:'A'}],requirements:reqs,types:['material'],key:'completeness',
  nextStage:2,start:4,end:20,run};
await advanceBatch(options);
assert.equal(audit.items.length,5);
assert.equal(audit.stage,1);
await advanceBatch(options);
assert.equal(audit.items.length,10);
await advanceBatch(options);
assert.equal(audit.items.length,13);
assert.equal(audit.stage,2);
assert.equal(audit.progress,20);
assert.equal(calls,3);
console.log('采购重点上限与分批落盘：通过');

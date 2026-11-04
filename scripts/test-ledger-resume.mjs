import assert from 'node:assert/strict';
import {chunkedDigest} from '../server/engine/digest.mjs';
import {extractLedger} from '../server/engine/ledger.mjs';

const parsed={paragraphs:Array.from({length:90},(_,i)=>({text:`采购条款 ${i+1}：`+'甲乙丙丁'.repeat(25),isToc:false}))};
const docs=[{id:'resume-doc',name:'采购文件.txt',parsed}];
const total=chunkedDigest(parsed,{maxChars:2500}).length;
assert.ok(total>2);
const saved={};let calls=0;
const model={json:async()=>{calls++;return {items:[]};}};
await assert.rejects(extractLedger(model,docs,{onCheckpoint:async({key,items})=>{saved[key]=items;throw Error('模拟进程中断');}}),/模拟进程中断/);
assert.equal(Object.keys(saved).length,1);
calls=0;
const completed=await extractLedger(model,docs,{resume:saved,onCheckpoint:async({key,items})=>{saved[key]=items;}});
assert.equal(completed.coverage.doneChunks,total);
assert.equal(calls,total-1,'恢复时不得重新调用已保存段落');
console.log(`断点续传：${total} 段，已保存 1 段，恢复时只调用 ${calls} 段`);

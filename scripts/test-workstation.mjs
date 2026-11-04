import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {writeZip} from '../server/parsers/zip.mjs';
import {Store} from '../server/store.mjs';
import {makeItem} from '../server/engine/items.mjs';

const root=path.resolve(import.meta.dirname,'..');
const port=4400+Math.floor(Math.random()*400);
const base=`http://127.0.0.1:${port}`;
const dataDir=path.join(root,'.runtime','integration-'+randomUUID());
const server=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:dataDir},stdio:'ignore',windowsHide:true});
const checks=[];
async function request(url,{method='GET',body,cookie,headers={}}={}){
  const init={method,headers:{...headers}};
  if(cookie)init.headers.Cookie=cookie;
  if(body!==undefined){init.body=Buffer.isBuffer(body)?body:JSON.stringify(body);if(!Buffer.isBuffer(body))init.headers['Content-Type']='application/json';}
  const response=await fetch(base+url,init);
  let data;try{data=await response.json()}catch{data=null}
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
function check(label,condition){assert.ok(condition,label);checks.push(label);console.log('  ✅ '+label)}
try{
  let ready=false;
  for(let i=0;i<80;i++){
    try{const r=await request('/api/auth/status');if(r.status===200){ready=true;break}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  check('独立服务启动',ready);
  check('未登录项目接口被拒绝',(await request('/api/projects')).status===401);
  check('首次需要设置管理员',(await request('/api/auth/status')).data.needsSetup===true);
  const setup=await request('/api/auth/setup',{method:'POST',body:{name:'测试主管',account:'admin',password:'TestAdmin-2026!'}});
  check('管理员设置成功',setup.status===200);
  const adminLogin=await request('/api/auth/login',{method:'POST',body:{account:'admin',password:'TestAdmin-2026!'}});
  const admin=adminLogin.cookie;check('管理员登录得到安全会话',!!admin&&adminLogin.status===200);
  const p1=await request('/api/projects',{method:'POST',cookie:admin,body:{name:'主管项目',mode:'single'}});
  check('管理员创建项目',p1.status===200);
  const member=await request('/api/members',{method:'POST',cookie:admin,body:{name:'张负责人',account:'owner',password:'TestOwner-2026!',role:'owner'}});
  check('添加负责人',member.status===200);
  const member2=await request('/api/members',{method:'POST',cookie:admin,body:{name:'李负责人',account:'owner2',password:'TestOwner2-2026!',role:'owner'}});
  check('添加第二名负责人',member2.status===200);
  const ownerLogin=await request('/api/auth/login',{method:'POST',body:{account:'owner',password:'TestOwner-2026!'}});
  const owner=ownerLogin.cookie;check('负责人登录',!!owner);
  check('负责人列表看不到他人项目',(await request('/api/projects',{cookie:owner})).data.projects.length===0);
  check('直接访问他人项目被后端拒绝',(await request(`/api/projects/${p1.data.project.id}`,{cookie:owner})).status===403);
  check('负责人不能修改模型配置',(await request('/api/settings',{method:'POST',cookie:owner,body:{MODEL_NAME:'x'}})).status===403);
  check('负责人不能应用全局审核规则',(await request('/api/rules/apply',{method:'POST',cookie:owner,body:{instruction:'核查证照到期日并记录采购文件对应条款和投标文件证据'}})).status===403);
  const rule=await request('/api/rules/apply',{method:'POST',cookie:admin,body:{summary:'核查证照有效期',instruction:'核查每份标书的证照有效期是否满足采购文件要求，逐字列出证照原文和截止日期。'}});
  check('管理员应用真实规则版本',rule.status===200&&rule.data.current.version==='v2');
  check('规则版本可读取',(await request('/api/rules',{cookie:owner})).data.current.version==='v2');
  check('规则版本可回滚',(await request('/api/rules/rollback',{method:'POST',cookie:admin,body:{version:'v1'}})).data.current.version==='v3');
  const p2=await request('/api/projects',{method:'POST',cookie:owner,body:{name:'负责人项目',mode:'multi'}});
  check('负责人可以创建自己的项目',p2.status===200);
  const pid=p2.data.project.id;
  const entity=await request(`/api/projects/${pid}/entities`,{method:'POST',cookie:owner,body:{name:'甲公司',owner:'张负责人'}});
  check('创建标书主体',entity.status===200);
  check('负责人能选择团队其他成员',(await request('/api/member-options',{cookie:owner})).data.members.some(u=>u.name==='李负责人'));
  const entityId=entity.data.project.entities[0].id;
  check('可以调整单份标书负责人',(await request(`/api/projects/${pid}/entities/${entityId}`,{method:'PATCH',cookie:owner,body:{owner:'李负责人'}})).status===200);
  const owner2=(await request('/api/auth/login',{method:'POST',body:{account:'owner2',password:'TestOwner2-2026!'}})).cookie;
  check('参与标书的负责人能看到所属项目',(await request('/api/projects',{cookie:owner2})).data.projects.some(p=>p.id===pid));
  const content='投标人须提供有效营业执照并加盖公章，否则投标无效。';
  const zip=writeZip([{name:'采购文件.txt',data:Buffer.from(content)}]);
  const upload=await request(`/api/projects/${pid}/docs/raw`,{method:'POST',cookie:owner,headers:{'x-file-name':encodeURIComponent('采购材料.zip'),'x-category':'procurement'},body:zip});
  check('ZIP 上传自动解包并解析',upload.status===200&&upload.data.docs?.length===1&&upload.data.docs[0].structure.paragraphCount===1);
  const second=await request(`/api/projects/${pid}/entities`,{method:'POST',cookie:owner,body:{name:'乙公司',owner:'张负责人'}});
  check('项目负责人可在共享采购文件后添加第二家公司',second.status===200&&second.data.project.entities.length===2);
  const secondId=second.data.project.entities[1].id;
  const bidHeaders=id=>({'x-file-name':encodeURIComponent('标书.txt'),'x-category':'bid','x-entity':id,'x-version':'V1'});
  const firstBid=await request(`/api/projects/${pid}/docs/raw`,{method:'POST',cookie:owner2,headers:bidHeaders(entityId),body:Buffer.from('甲公司技术响应文件内容')});
  check('公司负责人可上传自己的标书包',firstBid.status===200);
  check('公司负责人不能上传其他公司标书',(await request(`/api/projects/${pid}/docs/raw`,{method:'POST',cookie:owner2,headers:bidHeaders(secondId),body:Buffer.from('不得上传')})).status===403);
  const secondBid=await request(`/api/projects/${pid}/docs/raw`,{method:'POST',cookie:owner,headers:bidHeaders(secondId),body:Buffer.from('乙公司独立投标文件内容')});
  check('项目负责人可管理第二家公司标书',secondBid.status===200);
  const limited=await request(`/api/projects/${pid}`,{cookie:owner2});
  check('普通负责人看不到其他公司的标书文件',limited.data.project.docs.some(d=>d.id===firstBid.data.doc.id)&&!limited.data.project.docs.some(d=>d.id===secondBid.data.doc.id));
  check('普通负责人不能下载其他公司标书',(await request(`/api/projects/${pid}/docs/${secondBid.data.doc.id}/file`,{cookie:owner2})).status===403);
  const docId=upload.data.docs[0].id;
  const wrong=await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'edit',payload:{action:'add',req:{title:'伪造条款',quote:'这是一段没有出现在采购文件里的虚构要求文字。',fileId:docId}}}});
  check('伪造的手工引用被拒绝',wrong.status===422);
  const good=await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'edit',payload:{action:'add',req:{title:'营业执照',type:'qualification',quote:content,fileId:docId}}}});
  check('原文核验通过后可补充台账',good.status===200&&good.data.requirements.length===1);
  const reqId=good.data.requirements[0].stableId;
  const noReason=await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'edit',payload:{action:'exclude',stableId:reqId}}});
  check('排除要求必须写明原因',noReason.status===422);
  const excluded=await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'edit',payload:{action:'exclude',stableId:reqId,reason:'非本项目适用条件'}}});
  check('排除要求保留原因与状态',excluded.status===200&&excluded.data.requirements[0].status==='excluded'&&excluded.data.stats.excluded===1);
  await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'edit',payload:{action:'reopen',stableId:reqId}}});
  const batch=await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'edit',payload:{action:'batchConfirm',stableIds:[reqId]}}});
  check('批量确认只处理勾选的待核对要求',batch.status===200&&batch.data.requirements[0].status==='confirmed');
  const focus=await request(`/api/projects/${pid}/ledger`,{method:'POST',cookie:owner,body:{action:'approveFocus'}});
  check('售前重点一次确认且总数不超过100',focus.status===200&&focus.data.focusIds.length>0&&focus.data.focusIds.length<=100);
  const item=makeItem({check:'completeness',issueType:'missing',title:'缺少营业执照',risk:'high',checkStatus:'notFound'});
  const passItem=makeItem({check:'response',issueType:'met',title:'已满足截止时间',risk:'low',checkStatus:'satisfied'});
  await new Store(dataDir).mutate(s=>{const project=s.projects.find(x=>x.id===pid);project.audit={status:'done',version:'V1',items:[item,passItem]};});
  check('未处置问题阻止切换修订版本',(await request(`/api/projects/${pid}/version`,{method:'POST',cookie:owner,body:{version:'V2'}})).status===409);
  check('无需修改缺少理由被拒绝',(await request(`/api/projects/${pid}/items/${item.id}`,{method:'PATCH',cookie:owner,body:{status:'dismissed',by:'张负责人'}})).status===409);
  check('填写理由后允许留痕处置',(await request(`/api/projects/${pid}/items/${item.id}`,{method:'PATCH',cookie:owner,body:{status:'dismissed',by:'张负责人',note:'采购文件此项不适用'}})).status===200);
  check('全部真正问题处置后可切换版本，已满足记录不阻断',(await request(`/api/projects/${pid}/version`,{method:'POST',cookie:owner,body:{version:'V2'}})).status===200);
  const feedback=await request('/api/feedback',{method:'POST',cookie:owner,body:{type:'建议',title:'增加项目筛选',description:'按负责人和状态筛选项目'}});
  check('使用反馈持久化',feedback.status===200);
  const attachment=await request(`/api/feedback/${feedback.data.feedback.id}/attachments`,{method:'POST',cookie:owner,headers:{'x-file-name':encodeURIComponent('说明.txt')},body:Buffer.from('example')});
  check('反馈附件上传',attachment.status===200);
  check('负责人读取自己的反馈及附件',(await request('/api/feedback',{cookie:owner})).data.feedback[0].attachments.length===1);
  check('管理员可以查看全部项目',(await request('/api/projects',{cookie:admin})).data.projects.length===2);
  const wrongDelete=await request(`/api/projects/${p1.data.project.id}`,{method:'DELETE',cookie:admin,body:{confirmName:'错误名称'}});
  check('删除项目必须输入完整名称',wrongDelete.status===422);
  const deniedDelete=await request(`/api/projects/${p1.data.project.id}`,{method:'DELETE',cookie:owner,body:{confirmName:p1.data.project.name}});
  check('无权访问的成员不能删除项目',deniedDelete.status===403);
  const deleted=await request(`/api/projects/${p1.data.project.id}`,{method:'DELETE',cookie:admin,body:{confirmName:p1.data.project.name}});
  check('管理员确认名称后删除项目',deleted.status===200&&(await request(`/api/projects/${p1.data.project.id}`,{cookie:admin})).status===404);
  console.log(`\n工作台集成验收：${checks.length} 项通过。`);
} finally {
  server.kill();
}

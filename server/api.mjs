// HTTP API 路由。所有业务通过此处，返回 JSON 或文件流。
import path from 'node:path';
import {authRoute, userFromRequest, canSeeProject} from './auth.mjs';
import {parseFile} from './parsers/index.mjs';
import {readZip} from './parsers/zip.mjs';
import {extractProcurementInfo} from './engine/procurement-info.mjs';
import {withRuleOverlay} from './engine/rule-overlay.mjs';
import {verifyEvidence} from './engine/indexer.mjs';
import {extractLedger, applyLedgerEdit, ledgerStats, diffLedger} from './engine/ledger.mjs';
import {triageRequirements} from './engine/triage.mjs';
import {createAudit, stepAudit, inputsFingerprint} from './engine/orchestrator.mjs';
import {priorityRequirements} from './engine/priority.mjs';
import {entityProject, entityVersion, entityAudit, crossAudit} from './engine/entity-workflow.mjs';
import {buildMatrix, applyItemTransition, summarizeItems, nowStr, isActionableItem} from './engine/items.mjs';
import {runReview} from './engine/review.mjs';
import {computeRelease, openRiskList, releaseGateSummary} from './engine/release.mjs';
import {computeWizard} from './engine/wizard.mjs';
import {makeMaterial, materialSummary} from './engine/materials.mjs';
import {
  CHECKS, CHECK_ORDER, REQ_TYPES, REQ_STATUS, CHECK_STATUS, ITEM_RISK, ITEM_STATUS,
  FILE_CATEGORIES, FILE_CATEGORY_KEYS, EVIDENCE_GRADE, stableHash,
} from './engine/domain.mjs';
import {reportToDocx, checklistToCsv, releaseToDocx, openRiskToCsv} from './export.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
const err = (msg, status = 400) => json({error: String(msg).slice(0, 500)}, status);
const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const canManageProject = (user, project) => ['super','admin'].includes(user.role) || project.createdBy === user.id || project.owner === user.name;
const canEditEntity = (user, project, entity) => canManageProject(user, project) || entity?.owner === user.name;
const activeEntitySteps = new Set();

function readJson(req, limit = 96 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('请求体超过上限')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); if (!text) return resolve({}); try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); } });
    req.on('error', reject);
  });
}
function readBody(req, limit = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('文件超过上限')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const dl = (buf, type, filename) => new Response(buf, {headers: {'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`}});

export function createRouter({store, config, model}) {
  return async function route(req, url) {
    const p = url.pathname;
    const m = req.method;
    const q = url.searchParams;
    try {
      if (m !== 'GET' && m !== 'HEAD' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return err('跨站请求被拒绝', 403);
      const authResponse = await authRoute(req, url, store);
      if (authResponse) return authResponse;
      const authState = await store.readState();
      const user = userFromRequest(req, authState);
      if (!user) return err('请先登录', 401);
      const pidMatch = p.match(/^\/api\/projects\/([^/]+)/);
      if (pidMatch) {
        const target = authState.projects.find(x => x.id === pidMatch[1]);
        if (!target) return err('项目不存在', 404);
        if (!canSeeProject(user, target)) return err('无权访问此项目', 403);
      }
      if (['/api/settings','/api/model/test'].includes(p) && m !== 'GET' && !['super','admin'].includes(user.role)) return err('仅管理员可修改系统设置', 403);
      if (p === '/api/meta' && m === 'GET') {
        const state = await store.readState();
        return json({
          model: config.publicModel(),
          vocab: {
            checks: CHECK_ORDER.map((k) => ({key: k, label: CHECKS[k].label, purpose: CHECKS[k].purpose})),
            reqTypes: REQ_TYPES, reqStatus: REQ_STATUS, checkStatus: CHECK_STATUS,
            itemRisk: ITEM_RISK, itemStatus: ITEM_STATUS, fileCategories: FILE_CATEGORIES,
            fileCategoryKeys: FILE_CATEGORY_KEYS, evidenceGrade: EVIDENCE_GRADE,
          },
          materials: {summary: materialSummary(state.materials)},
          stats: await store.stats(),
        });
      }

      if (p === '/api/model/test' && m === 'POST') {
        if (!model.configured) return json({connected: false, error: '模型接口未配置'});
        try { const r = await model.raw({system: '只回复 OK。', user: 'Reply OK only.', maxTokens: 16}); return json({connected: true, model: config.publicModel().name, reply: r.content.slice(0, 60)}); }
        catch (e) { return json({connected: false, error: String(e.message).slice(0, 200)}); }
      }
      if (p === '/api/settings' && m === 'GET') return json({model: config.publicModel()});
      if (p === '/api/settings' && m === 'POST') {
        const body = await readJson(req);
        const patch = {};
        for (const k of ['MODEL_BASE_URL', 'MODEL_NAME', 'MODEL_API_KEY']) if (body[k]) patch[k] = String(body[k]);
        config.saveSettings(patch);
        const pm = config.publicModel();
        model.baseUrl = pm.baseUrl.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
        model.apiKey = config.model.apiKey;
        model.model = pm.name;
        return json({ok: true, model: config.publicModel()});
      }

      if (p === '/api/feedback' && m === 'GET') return json({feedback: (authState.feedback || []).filter(x => ['super','admin'].includes(user.role) || x.userId === user.id).map(x=>({...x,attachments:(x.attachments||[]).map(a=>({id:a.id,name:a.name,size:a.size,at:a.at}))}))});
      const feedbackFile = p.match(/^\/api\/feedback\/([^/]+)\/attachments(?:\/([^/]+))?$/);
      if (feedbackFile) {
        const record = (authState.feedback || []).find(x => x.id === feedbackFile[1]);
        if (!record) return err('反馈不存在',404);
        if (!['super','admin'].includes(user.role) && record.userId !== user.id) return err('无权访问反馈',403);
        if (m === 'POST' && !feedbackFile[2]) {
          const name = decodeURIComponent(req.headers['x-file-name'] || 'attachment.bin').slice(0,160);
          const buffer = await readBody(req,15*1024*1024);
          if (!buffer.length) return err('附件为空');
          if ((record.attachments || []).length >= 5) return err('每条反馈最多 5 个附件');
          const key=await store.saveFile(buffer,path.extname(name)||'.bin');
          const attachment={id:'fa-'+uid(),name,key,size:buffer.length,at:nowStr()};
          await store.mutate(s=>{const f=s.feedback.find(x=>x.id===record.id);f.attachments=f.attachments||[];f.attachments.push(attachment);});
          return json({attachment:{id:attachment.id,name:attachment.name,size:attachment.size}});
        }
        if (m === 'GET' && feedbackFile[2]) {
          const attachment=(record.attachments||[]).find(x=>x.id===feedbackFile[2]);
          if (!attachment) return err('附件不存在',404);
          return dl(await store.readFile(attachment.key),'application/octet-stream',attachment.name);
        }
      }
      if (p === '/api/feedback' && m === 'POST') {
        const body = await readJson(req, 16 * 1024);
        const title = String(body.title || '').trim(), description = String(body.description || '').trim();
        if (!title || !description) return err('请填写标题和详细描述');
        const record = {id:'f-'+uid(), userId:user.id, by:user.name, type:['问题','需求','建议'].includes(body.type) ? body.type : '建议', title:title.slice(0,120), description:description.slice(0,4000), status:'待处理', at:nowStr()};
        await store.mutate(s => {s.feedback = s.feedback || []; s.feedback.unshift(record);});
        return json({feedback:record});
      }
      if (p === '/api/rules' && m === 'GET') return json({current:authState.rules?.current || {version:'v1',instruction:'',summary:'引擎内置审核规则',at:null},history:authState.rules?.history || []});
      if (p === '/api/rules/draft' && m === 'POST') {
        if (!['super','admin'].includes(user.role)) return err('仅管理员可修改规则',403);
        if (!model.configured) return err('模型未配置，无法生成规则预览',422);
        const body=await readJson(req,16*1024);
        const request=String(body.request||'').trim().slice(0,1200);
        if (request.length<6) return err('请具体描述希望增加的审核关注点');
        const draft=await model.json({system:'你是标书审核规则编辑助手。把管理员的自然语言要求转换为追加的审核关注点。不得删减原有检查、不得降低引用核验、不得承诺自动判断图片签章。仅输出 JSON 对象：{"summary":"不超过80字的变更摘要","instruction":"给审核模型的可执行核查指令，20-800字","caution":"需要人工关注的边界"}。',user:request,maxTokens:1000});
        const instruction=String(draft.instruction||'').trim().slice(0,800);
        if (instruction.length<20) return err('模型未生成可执行规则，请重试',422);
        return json({draft:{summary:String(draft.summary||request).slice(0,80),instruction,caution:String(draft.caution||'').slice(0,200)}});
      }
      if (p === '/api/rules/apply' && m === 'POST') {
        if (!['super','admin'].includes(user.role)) return err('仅管理员可应用规则',403);
        const body=await readJson(req,16*1024);
        const instruction=String(body.instruction||'').trim().slice(0,800);
        if (instruction.length<20) return err('规则指令至少 20 字');
        let current;
        await store.mutate(s=>{s.rules=s.rules||{current:{version:'v1',instruction:'',summary:'引擎内置审核规则',at:null},history:[]};const previous=s.rules.current;s.rules.history.push(previous);current={version:`v${Number(previous.version.slice(1)||1)+1}`,instruction,summary:String(body.summary||'管理员补充审核关注点').slice(0,80),at:nowStr(),by:user.name};s.rules.current=current;});
        return json({current});
      }
      if (p === '/api/rules/rollback' && m === 'POST') {
        if (!['super','admin'].includes(user.role)) return err('仅管理员可回滚规则',403);
        const body=await readJson(req,4096),version=String(body.version||'');
        let current=null;
        await store.mutate(s=>{const target=s.rules?.history?.find(x=>x.version===version);if(!target)return;const previous=s.rules.current;s.rules.history.push(previous);current={...target,version:`v${Number(previous.version.slice(1)||1)+1}`,at:nowStr(),by:user.name,summary:`回滚至 ${version}：${target.summary}`};s.rules.current=current;});
        return current?json({current}):err('历史版本不存在',404);
      }

      if (p === '/api/workbench' && m === 'GET') return json(buildWorkbench({...authState, projects: authState.projects.filter(x => canSeeProject(user,x))}));

      if (p === '/api/projects' && m === 'GET') return json({projects: authState.projects.filter(x => canSeeProject(user,x)).map(projectSummary)});
      if (p === '/api/projects' && m === 'POST') {
        const body = await readJson(req);
        if (!body.name || !String(body.name).trim()) return err('项目名称不能为空');
        const requestedEntities = Array.isArray(body.entities) ? body.entities : [];
        if (requestedEntities.length > 10) return err('一个项目最多添加 10 份标书');
        const entities = requestedEntities.map((item, index) => ({
          id: 'e-' + uid(),
          name: String(item.name || `待命名标书${index + 1}`).trim().slice(0, 100),
          owner: String(item.owner || body.owner || user.name).trim().slice(0, 40),
        }));
        const project = {
          id: 'p-' + uid(), name: String(body.name).trim().slice(0, 120), createdBy: user.id, mode: body.mode === 'multi' ? 'multi' : 'single',
          code: String(body.code || '').slice(0, 60), purchaser: String(body.purchaser || '').slice(0, 120),
          packageNo: String(body.packageNo || '').slice(0, 60), owner: String(body.owner || user.name).slice(0, 40),
          bidDeadline: String(body.bidDeadline || '').slice(0, 40), internalDeadline: String(body.internalDeadline || '').slice(0, 40),
          qaDeadline: String(body.qaDeadline || '').slice(0, 40),
          currentVersion: 'V1', version: 'V1', versions: ['V1'],
          createdAt: nowStr(), archived: false,
          entities, docs: [], requirements: [], audit: null, auditHistory: [], review: null, release: null, priceContext: null, specialReviewScope: String(body.specialReviewScope || '').slice(0,500),
          log: [{time: nowStr(), text: '创建项目'}],
        };
        await store.mutate((s) => { s.projects.unshift(project); });
        return json({project});
      }

      const pm = p.match(/^\/api\/projects\/([^/]+)$/);
      if (pm) {
        const project = await getProject(store, pm[1]);
        if (!project) return err('项目不存在', 404);
        if (m === 'GET') return json({project: withComputed(visibleProject(project,user)), model: config.publicModel()});
        if (m === 'DELETE') {
          if (!canManageProject(user,project)) return err('仅项目负责人或管理员可删除项目',403);
          const body=await readJson(req,4096);
          if (String(body.confirmName||'') !== project.name) return err('请输入完整项目名称确认删除',422);
          await store.mutate((s) => { s.projects = s.projects.filter((x) => x.id !== pm[1]); });
          for (const d of project.docs) { await store.deleteFile(d.key); await store.deleteFile(d.parsedKey); }
          return json({ok: true});
        }
        if (m === 'PATCH') {
          const body = await readJson(req);
          await store.mutate((s) => {
            const proj = s.projects.find((x) => x.id === pm[1]);
            if (!proj) return;
            for (const k of ['name', 'code', 'purchaser', 'packageNo', 'owner', 'bidDeadline', 'internalDeadline', 'qaDeadline', 'archived', 'specialReviewScope']) if (body[k] !== undefined) proj[k] = body[k];
            if (body.priceContext !== undefined) proj.priceContext = body.priceContext;
          });
          return json({project: withComputed(await getProject(store, pm[1]))});
        }
      }

      const infoRoute=p.match(/^\/api\/projects\/([^/]+)\/procurement-info$/);
      if (infoRoute && m === 'GET') {
        const project=await getProject(store,infoRoute[1]);
        const docs=await loadParsedDocs(store,project,project.docs.filter(d=>['procurement','supplement'].includes(d.category)));
        return json({suggestions:extractProcurementInfo(docs)});
      }

      if (p.match(/^\/api\/projects\/[^/]+\/entities$/) && m === 'POST') {
        const pid = p.split('/')[3];
        if (!canManageProject(user, await getProject(store,pid))) return err('仅项目负责人可添加公司',403);
        const body = await readJson(req);
        if (!body.name?.trim()) return err('主体名称不能为空');
        await store.mutate((s) => {
          const proj = s.projects.find((x) => x.id === pid);
          if (proj) { proj.entities.push({id: 'e-' + uid(), name: String(body.name).trim().slice(0, 100), owner: String(body.owner || user.name).slice(0, 40), currentVersion:'V1', versions:['V1']});proj.mode=proj.entities.length>1?'multi':'single'; proj.log.push({time: nowStr(), text: '新增投标主体 ' + body.name}); }
        });
        return json({project: await getProject(store, pid)});
      }
      const entm = p.match(/^\/api\/projects\/([^/]+)\/entities\/([^/]+)$/);
      if (entm && m === 'PATCH') {
        if (!canManageProject(user, await getProject(store,entm[1]))) return err('仅项目负责人可调整公司分工',403);
        const body = await readJson(req,4096);
        await store.mutate(s=>{const proj=s.projects.find(x=>x.id===entm[1]);const entity=proj?.entities.find(x=>x.id===entm[2]);if(!entity)return;if(body.name!==undefined)entity.name=String(body.name).trim().slice(0,100);if(body.owner!==undefined)entity.owner=String(body.owner).trim().slice(0,40);proj.log.push({time:nowStr(),text:`调整投标主体分工：${entity.name} → ${entity.owner}`});});
        return json({project:await getProject(store,entm[1])});
      }
      if (entm && m === 'DELETE') {
        if (!canManageProject(user, await getProject(store,entm[1]))) return err('仅项目负责人可删除公司',403);
        await store.mutate((s) => { const proj = s.projects.find((x) => x.id === entm[1]); if (proj) proj.entities = proj.entities.filter((e) => e.id !== entm[2]); });
        return json({project: await getProject(store, entm[1])});
      }

      const entityFlow=p.match(/^\/api\/projects\/([^/]+)\/entities\/([^/]+)\/(audit\/(?:start|step)|version)$/);
      if(entityFlow && m==='POST'){
        const [,pid,eid,operation]=entityFlow;
        const project=await getProject(store,pid),entity=project?.entities.find(e=>e.id===eid);
        if(!entity)return err('标书公司不存在',404);
        if(!canEditEntity(user,project,entity))return err('只能审核自己负责的标书',403);
        if(operation==='version'){
          const previous=entityAudit(project,eid);
          if(previous?.status==='done'){
            const pending=(previous.items||[]).filter(i=>isActionableItem(i)&&!['reviewing','closed','dismissed'].includes(i.status));
            if(pending.length)return err(`本公司仍有 ${pending.length} 条明确问题未处置`,409);
          }
          const next=`V${Math.max(1,...(entity.versions||['V1']).map(v=>Number(v.replace(/\D/g,''))||1))+1}`;
          await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid),e=proj.entities.find(x=>x.id===eid);
            e.currentVersion=next;e.versions=[...new Set([...(e.versions||['V1']),next])];
            proj.entityAudits ||= {};proj.entityAudits[eid]=null;proj.crossReview=null;
            proj.log.push({time:nowStr(),text:`${e.name} 创建修订版 ${next}`});});
          return json({version:next,project:withComputed(await getProject(store,pid))});
        }
        const scoped=entityProject(project,eid);
        if(operation==='audit/start'){
          if(!project.focusApprovedAt||!project.focusIds?.length)return err('请先确认共享采购重点',409);
          const bidDocs=scoped.docs.filter(d=>d.entityId===eid&&d.version===scoped.currentVersion);
          if(!bidDocs.length)return err('请先上传本公司的标书文件或文件夹',409);
          if(bidDocs.some(d=>!d.parsedKey||d.structure?.unreadable||d.parseError))return err('本公司标书中有无法解析的文件',409);
          if(!scoped.docs.some(d=>d.role==='procurement'))return err('项目负责人尚未上传采购文件',409);
          await hydrateDocs(store,scoped);
          const audit=createAudit(scoped,model),teamRule=(await store.readState()).rules?.current;
          audit.snapshot.rulesVersion=teamRule?.version||audit.snapshot.rulesVersion;
          audit.snapshot.ruleInstructions=teamRule?.instruction||'';
          await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);proj.entityAudits ||= {};proj.entityAudits[eid]=audit;proj.crossReview=null;});
          return json({audit:stripInternal(audit)});
        }
        if(activeEntitySteps.has(`${pid}:${eid}`))return err('本公司审核正在运行，请等待当前批次完成',409);
        const audit=project.entityAudits?.[eid];
        if(!audit)return err('请先启动本公司审核',409);
        if(['done','blocked','stale'].includes(audit.status))return json({audit:stripInternal(audit)});
        activeEntitySteps.add(`${pid}:${eid}`);
        try{
          await hydrateDocs(store,scoped);
          const updated=await stepAudit({model:withRuleOverlay(model,audit.snapshot),project:scoped,audit});
          await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);proj.entityAudits[eid]=updated;
            if(updated.status==='done'){
              proj.entityAuditHistory ||= {};proj.entityAuditHistory[eid] ||= [];
              if(!proj.entityAuditHistory[eid].some(x=>x.id===updated.id))proj.entityAuditHistory[eid].push(updated);
            }});
          return json({audit:stripInternal(updated)});
        }finally{activeEntitySteps.delete(`${pid}:${eid}`);}
      }

      const crossRoute=p.match(/^\/api\/projects\/([^/]+)\/cross-audit$/);
      if(crossRoute&&m==='POST'){
        const pid=crossRoute[1],project=await getProject(store,pid);
        if(!canManageProject(user,project))return err('仅项目负责人可发起关联性审查',403);
        await hydrateDocs(store,project);
        let result;try{result=crossAudit(project);}catch(e){return err(e.message,409);}
        await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);proj.crossReview=result;
          proj.log.push({time:nowStr(),text:`关联性审查完成：${result.entityIds.length} 份标书`});});
        return json({crossReview:result});
      }

      if (p.match(/^\/api\/projects\/[^/]+\/docs\/raw$/) && m === 'POST') {
        const pid = p.split('/')[3];
        const project = await getProject(store, pid);
        if (!project) return err('项目不存在', 404);
        const name = decodeURIComponent(req.headers['x-file-name'] || 'upload.bin');
        const category = decodeURIComponent(req.headers['x-category'] || 'bid');
        const entityId = req.headers['x-entity'] || null;
        const version = decodeURIComponent(req.headers['x-version'] || project.currentVersion);
        const isProcurement=['procurement','supplement'].includes(category);
        if(isProcurement){if(!canManageProject(user,project))return err('只有项目负责人可更新共享采购文件',403);}
        else {const entity=project.entities.find(e=>e.id===entityId);if(!entity)return err('请先选择标书公司',422);if(!canEditEntity(user,project,entity))return err('无权上传该公司的标书',403);if(version!==entityVersion(entity))return err('上传版本与该公司当前版本不一致',409);}
        const buffer = await readBody(req);
        if (!buffer.length) return err('空文件');
        if (path.extname(name).toLowerCase() === '.zip') {
          let entries;
          try { entries = readZip(buffer,{maxEntries:100,maxTotalBytes:200*1024*1024,maxEntryBytes:64*1024*1024}); }
          catch (e) { return err(`ZIP 解包失败：${e.message}`,422); }
          const files = [...entries].filter(([entry,data]) => data.length && !entry.startsWith('__MACOSX/') && !path.basename(entry).startsWith('.'));
          if (!files.length) return err('ZIP 中没有可用文件',422);
          const docs=[];
          for (const [entry,data] of files) {
            const safeEntry=entry.replaceAll('\\','/').replace(/^\/+/, '').slice(0,140);
            docs.push(await ingestDoc(store,await getProject(store,pid),pid,{buffer:data,name:`${name} / ${safeEntry}`,category,entityId,version}));
          }
          return json({docs,project:await getProject(store,pid)});
        }
        const doc = await ingestDoc(store, project, pid, {buffer, name, category, entityId, version});
        return json({doc, project: await getProject(store, pid)});
      }

      const docm = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)$/);
      if (docm && m === 'DELETE') {
        const project = await getProject(store, docm[1]);
        const doc = project?.docs.find((d) => d.id === docm[2]);
        if(!doc)return err('文档不存在',404);
        if(doc.role==='procurement'?!canManageProject(user,project):!canEditEntity(user,project,project.entities.find(e=>e.id===doc.entityId)))return err('无权删除此文档',403);
        await store.mutate((s) => { const proj = s.projects.find((x) => x.id === docm[1]); if (proj) { proj.docs = proj.docs.filter((d) => d.id !== docm[2]); staleForDoc(proj,doc,'删除文件后输入已变化'); } });
        return json({project: await getProject(store, docm[1])});
      }

      const reparseDoc = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/reparse$/);
      if (reparseDoc && m === 'POST') {
        const project = await getProject(store, reparseDoc[1]);
        const old = project?.docs.find((d) => d.id === reparseDoc[2]);
        if (!old) return err('文档不存在', 404);
        if(old.role==='procurement'?!canManageProject(user,project):!canEditEntity(user,project,project.entities.find(e=>e.id===old.entityId)))return err('无权重新解析此文档',403);
        const parsed = await parseFile(await store.readFile(old.key), old.name);
        const parsedKey = await store.saveFile(Buffer.from(JSON.stringify(parsed)), '.parsed.json');
        await store.mutate((s) => {
          const proj = s.projects.find((x) => x.id === reparseDoc[1]);
          const doc = proj.docs.find((d) => d.id === reparseDoc[2]);
          doc.parsedKey = parsedKey;
          doc.parseError = null;
          doc.structure = {kind: parsed.kind, paragraphCount: parsed.paragraphs?.length || 0, sectionCount: parsed.sections?.length || 0,
            imageAnchors: parsed.imageAnchors?.length || 0, pageCount: parsed.pageCount || parsed.metadata?.pages || null,
            unreadable: !!parsed.unreadable, locatorHint: parsed.locatorHint, unreadableReason: parsed.unreadableReason || null};
          staleForDoc(proj,doc,`重新解析文件：${doc.name}`);
          proj.log.push({time: nowStr(), text: `重新解析文件：${doc.name}`});
        });
        if (old.parsedKey && old.parsedKey !== parsedKey) await store.deleteFile(old.parsedKey);
        return json({doc: (await getProject(store, reparseDoc[1])).docs.find((d) => d.id === reparseDoc[2])});
      }

      const viewm = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/text$/);
      if (viewm && m === 'GET') {
        const project = await getProject(store, viewm[1]);
        const doc = project?.docs.find((d) => d.id === viewm[2]);
        if (!doc) return err('文档不存在', 404);
        if(doc.role==='bid'&&!canEditEntity(user,project,project.entities.find(e=>e.id===doc.entityId)))return err('无权查看其他公司的标书',403);
        let parsed = null;
        if (doc.parsedKey) { try { parsed = JSON.parse((await store.readFile(doc.parsedKey)).toString('utf8')); } catch {} }
        return json({id: doc.id, name: doc.name, kind: doc.structure?.kind, locatorHint: doc.structure?.locatorHint, paragraphs: parsed?.paragraphs || [], sections: parsed?.sections || []});
      }

      const filem = p.match(/^\/api\/projects\/([^/]+)\/docs\/([^/]+)\/file$/);
      if (filem && m === 'GET') {
        const project = await getProject(store, filem[1]);
        const doc = project?.docs.find((d) => d.id === filem[2]);
        if (!doc) return err('文档不存在', 404);
        if(doc.role==='bid'&&!canEditEntity(user,project,project.entities.find(e=>e.id===doc.entityId)))return err('无权下载其他公司的标书',403);
        return dl(await store.readFile(doc.key), 'application/octet-stream', doc.name);
      }

      // ---- 招标要求台账 ----
      const lm = p.match(/^\/api\/projects\/([^/]+)\/ledger$/);
      if (lm) {
        const pid = lm[1];
        const project = await getProject(store, pid);
        if (!project) return err('项目不存在', 404);
        if (m === 'GET') return json({requirements: project.requirements || [], stats: ledgerStats(project.requirements || []), warnings: project.ledgerWarnings || [], extraction:project.ledgerExtraction?{coverage:project.ledgerExtraction.coverage,savedChunks:Object.keys(project.ledgerExtraction.chunkResults||{}).length,lastCheckpointAt:project.ledgerExtraction.lastCheckpointAt}:null});
        const body = await readJson(req);
        if (body.action === 'triage') {
          if (!model.configured) return err('模型未配置，无法整理采购要求',422);
          if (!(project.requirements||[]).length) return err('请先抽取采购要求',422);
          const triage=await triageRequirements(model,project.requirements);
          await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);proj.requirements=triage.requirements;proj.ledgerWarnings=[...(proj.ledgerWarnings||[]),...triage.warnings];proj.log.push({time:nowStr(),text:`整理采购要求：标书审核 ${triage.counts.audit} 条，线下核对 ${triage.counts.manual} 条，参考 ${triage.counts.reference} 条`});});
          return json({counts:triage.counts,warnings:triage.warnings,requirements:triage.requirements});
        }
        if (body.action === 'extract') {
          if (!model.configured) return err('模型未配置，无法抽取要求');
          await hydrateDocs(store, project);
          const procSources=project.docs.filter((d) => ['procurement', 'supplement'].includes(d.category));
          const procDocs = await loadParsedDocs(store, project, procSources);
          const extractionKey=stableHash(procSources.map(d=>`${d.id}:${d.hash}:${d.parsedKey}`).join('|')+':'+config.publicModel().name);
          const resume=project.ledgerExtraction?.key===extractionKey ? project.ledgerExtraction.chunkResults : {};
          await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);if(proj.ledgerExtraction?.key!==extractionKey)proj.ledgerExtraction={key:extractionKey,chunkResults:{},coverage:{files:procDocs.length,parsedFiles:0,chunks:0,doneChunks:0},warnings:[],startedAt:nowStr()};});
          const r = await extractLedger(model, procDocs, {onProgress: () => {},resume,onCheckpoint:async ({key,items,coverage,warnings})=>{
            await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);if(proj.ledgerExtraction?.key!==extractionKey)return;proj.ledgerExtraction.chunkResults[key]=items;proj.ledgerExtraction.coverage=coverage;proj.ledgerExtraction.warnings=warnings;proj.ledgerExtraction.lastCheckpointAt=nowStr();});
          }});
          if (r.coverage.parsedFiles === 0) return err('采购文件正文无法读取，未抽取到任何条款。请转换为 DOCX 或可复制文字的 PDF 后重新上传', 422);
          if (r.coverage.parsedFiles !== r.coverage.files) return json({error:'部分采购文件正文不可读，原有台账未被覆盖。请修复文件后重试。',coverage:r.coverage,warnings:r.warnings},422);
          if (r.coverage.doneChunks !== r.coverage.chunks) {
            await store.mutate(s=>{const proj=s.projects.find(x=>x.id===pid);proj.ledgerExtraction={key:extractionKey,chunkResults:r.chunkResults,coverage:r.coverage,warnings:r.warnings,lastAttemptAt:nowStr()};});
            return json({error: '采购要求抽取未完成，原有台账未被覆盖。已保存成功段落；模型恢复后重试只处理失败段落。', coverage: r.coverage, warnings: r.warnings}, 422);
          }
          const triage=await triageRequirements(model,r.requirements);
          r.requirements=triage.requirements;
          r.warnings.push(...triage.warnings);
          let ledgerDiff = null;
          await store.mutate((s) => {
            const proj = s.projects.find((x) => x.id === pid);
            const before = proj.requirements.slice();
            const existing = proj.requirements.filter((r) => ['confirmed','excluded'].includes(r.status) || r.origin === 'manual');
            const map = new Map(existing.map((r) => [r.stableId, r]));
            for (const nr of r.requirements) if (!map.has(nr.stableId)) map.set(nr.stableId, nr);
            proj.requirements = [...map.values()];
            if (JSON.stringify(before) !== JSON.stringify(proj.requirements)) markAuditStale(proj, '招标要求重新抽取后发生变化');
            // 补遗影响分析（有既存要求时才比较）
            if (before.length) {
              ledgerDiff = diffLedger(before, proj.requirements);
              proj.ledgerDiff = {...ledgerDiff, at: nowStr()};
            }
            proj.ledgerWarnings = r.warnings;
            proj.ledgerExtraction = null;
            proj.log.push({time: nowStr(), text: `抽取招标要求 ${r.requirements.length} 条`});
          });
          const proj = await getProject(store, pid);
          return json({requirements: proj.requirements, warnings: r.warnings, coverage: r.coverage, stats: ledgerStats(proj.requirements), diff: ledgerDiff});
        }
        if (body.action === 'approveFocus') {
          const focusIds = priorityRequirements(project.requirements).map(r => r.stableId);
          if (!focusIds.length) return err('没有可用于审核的采购重点，请先解析采购文件', 422);
          await store.mutate(s => {
            const proj = s.projects.find(x => x.id === pid);
            proj.focusIds = focusIds;
            proj.focusApprovedAt = nowStr();
            markAuditStale(proj, '采购重点清单重新确认');
          });
          return json({focusIds, approvedAt: (await getProject(store, pid)).focusApprovedAt});
        }
        if (body.action === 'edit') {
          const edit=body.payload || {};
          if (['exclude','batchExclude'].includes(edit.action) && String(edit.reason || '').trim().length < 4) return err('不纳入审核须填写至少 4 字原因',422);
          if (['batchConfirm','batchExclude'].includes(edit.action) && (!Array.isArray(edit.stableIds) || !edit.stableIds.length || edit.stableIds.length > 50)) return err('请勾选 1–50 条待处理要求',422);
          if (body.payload?.action === 'add') {
            const quote = String(body.payload.req?.quote || '').trim();
            const fileId = String(body.payload.req?.fileId || '');
            if (quote.length < 12 || !fileId) return err('人工补充要求须选择采购文件并填写至少 12 字逐字原文',422);
            const doc = project.docs.find(d => d.id === fileId && ['procurement','supplement'].includes(d.category));
            if (!doc) return err('采购文件不存在',422);
            const parsed = (await loadParsedDocs(store,project,[doc]))[0]?.parsed;
            const evidence = parsed ? verifyEvidence(parsed,quote) : null;
            if (!evidence?.found || evidence.weak) return err('引用未在该采购文件正文中可靠定位，请逐字核对后重试',422);
            body.payload.req.fileName = doc.name;
            body.payload.req.locator = evidence.locator;
          }
          await store.mutate((s) => {
            const proj = s.projects.find((x) => x.id === pid);
            const before = (proj.requirements || []).filter((r) => r.status === 'confirmed').map((r) => r.stableId + ':' + r.type).sort().join(',');
            proj.requirements = applyLedgerEdit(proj.requirements, body);
            const after = (proj.requirements || []).filter((r) => r.status === 'confirmed').map((r) => r.stableId + ':' + r.type).sort().join(',');
            if (before !== after) markAuditStale(proj, '已确认要求发生变化');
            proj.log.push({time: nowStr(), text: `台账编辑：${body.action}`});
          });
          const proj = await getProject(store, pid);
          return json({requirements: proj.requirements, stats: ledgerStats(proj.requirements)});
        }
        return err('未知台账操作');
      }

      // ---- 响应矩阵 ----
      const mxm = p.match(/^\/api\/projects\/([^/]+)\/matrix$/);
      if (mxm) {
        const project = await getProject(store, mxm[1]);
        if (!project) return err('项目不存在', 404);
        if (m === 'GET') {
          const matrix = buildMatrix(project.requirements || [], project.audit?.items || []);
          return json({matrix, summary: matrixSummary(matrix)});
        }
        // 人工确认结论 / 负责人 / 台账状态
        if (m === 'POST') {
          const body = await readJson(req);
          const sid = String(body.requirementId || '');
          if (!sid) return err('缺少 requirementId');
          await store.mutate((s) => {
            const proj = s.projects.find((x) => x.id === mxm[1]);
            const req = (proj.requirements || []).find((r) => r.stableId === sid);
            if (!req) return;
            if (body.manualConclusion !== undefined) req.manualConclusion = String(body.manualConclusion).slice(0, 400);
            if (body.owner !== undefined) req.owner = String(body.owner).slice(0, 40);
            if (body.verifyConclusion !== undefined) req.verifyConclusion = String(body.verifyConclusion).slice(0, 400);
            if (body.status && REQ_STATUS[body.status]) { const oldStatus = req.status; req.status = body.status; req.statusLabel = REQ_STATUS[body.status].label; if (oldStatus !== req.status) markAuditStale(proj, '要求确认状态发生变化'); }
            proj.log.push({time: nowStr(), text: `矩阵人工确认：${req.title.slice(0, 20)}`});
          });
          const proj = await getProject(store, mxm[1]);
          const matrix = buildMatrix(proj.requirements || [], proj.audit?.items || []);
          return json({matrix, summary: matrixSummary(matrix)});
        }
      }

      // ---- 审核 ----
      const am = p.match(/^\/api\/projects\/([^/]+)\/audit\/(start|step)$/);
      if (am) {
        const pid = am[1];
        const project = await getProject(store, pid);
        if (!project) return err('项目不存在', 404);
        if (am[2] === 'start') {
          if (!project.docs.some((d) => ['procurement', 'supplement'].includes(d.category))) return err('请先上传招标文件');
          if (project.docs.some((d) => ['procurement', 'supplement'].includes(d.category) && (!d.parsedKey || d.structure?.unreadable))) return err('采购文件含未解析正文，请先转换为 DOCX 或可复制文字的 PDF');
          if (!project.docs.some((d) => d.role === 'bid' && d.version === project.currentVersion)) return err(`请先上传版本 ${project.currentVersion} 的投标文件`);
          if (project.docs.some((d) => d.role === 'bid' && d.version === project.currentVersion && (!d.parsedKey || d.structure?.unreadable))) return err('当前版本含未解析投标文件，请先转换格式后重新上传');
          if (!(project.requirements || []).length) return err('请先解析采购文件');
          const focus = priorityRequirements(project.requirements).map(r => r.stableId);
          if (!project.focusApprovedAt || !project.focusIds?.length || project.focusIds.join('|') !== focus.join('|'))
            return err('请先在招标解析页阅读并确认采购重点清单');
          if (!model.configured) return err('模型未配置，无法执行审核');
          await hydrateDocs(store, project);
          const audit = createAudit(project, model);
          const teamRule=(await store.readState()).rules?.current;
          audit.snapshot.rulesVersion=teamRule?.version || audit.snapshot.rulesVersion;
          audit.snapshot.ruleInstructions=teamRule?.instruction || '';
          await store.mutate((s) => { const proj = s.projects.find((x) => x.id === pid); proj.audit = audit; });
          return json({audit: stripInternal(audit)});
        }
        const audit = project.audit;
        if (!audit) return err('尚未启动审核');
        if (['done', 'blocked', 'stale'].includes(audit.status)) return json({audit: stripInternal(audit), project: withComputed(await getProject(store, pid))});
        await hydrateDocs(store, project);
        const updated = await stepAudit({model:withRuleOverlay(model,audit.snapshot), project, audit});
        await store.mutate((s) => {
          const proj = s.projects.find((x) => x.id === pid);
          proj.audit = updated;
          if (updated.status === 'done') {
            proj.auditHistory = proj.auditHistory || [];
            // 完整保存本轮审核：问题、证据、快照、覆盖率，供 V1/V2/V3 逐条对比（P0-4）
            const snapshot = {
              id: updated.id, version: updated.version,
              startedAt: updated.startedAt, finishedAt: updated.finishedAt,
              summary: updated.summary, coverage: updated.coverage,
              snapshot: updated.snapshot, rulesVersion: updated.snapshot?.rulesVersion,
              inputsHash: updated.snapshot?.inputsHash,
              items: updated.items,
              itemCount: updated.items.length,
            };
            // 同 id 去重（续跑重复完成时覆盖）
            proj.auditHistory = proj.auditHistory.filter((h) => h.id !== updated.id);
            proj.auditHistory.push(snapshot);
          }
        });
        return json({audit: stripInternal(updated), project: withComputed(await getProject(store, pid))});
      }

      return await routeMore(req, url, {store, config, model, p, m, q, user});
    } catch (e) {
      console.error('API error:', e);
      return err(e.message || '服务器内部错误', 500);
    }
  };
}

// ===== 其余路由（问题工作单 / 复审 / 版本 / 放行 / 导出 / 材料库）=====
async function routeMore(req, url, ctx) {
  const {store, config, model, p, m, q, user} = ctx;

  // ---- 问题工作单 ----
  const itList = p.match(/^\/api\/projects\/([^/]+)\/items$/);
  const itOne = p.match(/^\/api\/projects\/([^/]+)\/items\/([^/]+)$/);
  if (itList || itOne) {
    const pid = (itList || itOne)[1];
    const project = await getProject(store, pid);
    if (!project) return err('项目不存在', 404);
    if (itList && m === 'GET') {
      let items = project.audit?.items || [];
      const fCheck = q.get('check'), fRisk = q.get('risk'), fStatus = q.get('status'), fAssignee = q.get('assignee'), fEntity = q.get('entity');
      if (fCheck) items = items.filter((it) => it.check === fCheck);
      if (fRisk) items = items.filter((it) => it.risk === fRisk);
      if (fStatus === 'open') items = items.filter((it) => isActionableItem(it) && !['closed', 'dismissed'].includes(it.status));
      else if (fStatus) items = items.filter((it) => it.status === fStatus);
      if (fAssignee) items = items.filter((it) => it.assignee === fAssignee);
      if (fEntity) items = items.filter((it) => it.entityId === fEntity);
      return json({items, summary: summarizeItems(project.audit?.items || [])});
    }
    if (itList && m === 'POST') {
      const body = await readJson(req);
      if (body.status) {
        for (const it of project.audit?.items || []) {
          if (!(body.ids || []).includes(it.id)) continue;
          const trial = {...it, assignee: body.assignee !== undefined ? String(body.assignee) : it.assignee, history: [...(it.history || [])]};
          const result = applyItemTransition(trial, body.status, {by: body.by || '负责人', note: body.note || ''});
          if (!result.ok) return err(`${it.title}：${result.error}`, 409);
        }
      }
      let transErr = null;
      await store.mutate((s) => {
        const proj = s.projects.find((x) => x.id === pid);
        for (const it of proj.audit?.items || []) {
          if ((body.ids || []).includes(it.id)) {
            if (body.assignee !== undefined) it.assignee = String(body.assignee).slice(0, 40);
            if (body.due !== undefined) it.due = String(body.due).slice(0, 40);
            if (body.status) { const result = applyItemTransition(it, body.status, {by: body.by || '负责人', note: body.note || ''}); if (!result.ok) transErr = result.error; }
            it.updatedAt = nowStr();
          }
        }
      });
      if (transErr) return err(transErr, 409);
      const proj = await getProject(store, pid);
      return json({items: proj.audit.items, summary: summarizeItems(proj.audit.items)});
    }
    if (itOne) {
      const iid = itOne[2];
      if (m === 'PATCH') {
        const body = await readJson(req);
        let transErr = null;
        await store.mutate((s) => {
          const proj = s.projects.find((x) => x.id === pid);
          const it = findCurrentItem(proj,iid);
          if (!it) return;
          if (body.assignee !== undefined) it.assignee = String(body.assignee).slice(0, 40);
          if (body.due !== undefined) it.due = String(body.due).slice(0, 40);
          if (body.reviewer !== undefined) it.reviewer = String(body.reviewer).slice(0, 40);
          if (body.status && body.status !== it.status) {
            const r = applyItemTransition(it, body.status, {by: body.by || '负责人', note: body.note || ''});
            if (!r.ok) { transErr = r.error; return; }
          }
          if (body.comment) it.comments.push({time: nowStr(), by: body.by || '负责人', text: String(body.comment).slice(0, 500)});
          if (body.dismissReason) it.extra = {...(it.extra || {}), dismissReason: String(body.dismissReason).slice(0, 300)};
          it.updatedAt = nowStr();
        });
        if (transErr) return err(transErr, 409);
        const proj = await getProject(store, pid);
        return json({item: findCurrentItem(proj,iid), summary: summarizeItems(allCurrentItems(proj))});
      }
      if (m === 'POST') {
        const project2 = await getProject(store, pid);
        const it = findCurrentItem(project2,iid);
        if (!it) return err('问题不存在', 404);
        return json({assist: buildAssist(it, project2)});
      }
    }
  }

  // ---- 问题补证上传 ----
  const proofm = p.match(/^\/api\/projects\/([^/]+)\/items\/([^/]+)\/proofs$/);
  if (proofm && m === 'POST') {
    const pid = proofm[1];
    const iid = proofm[2];
    const project = await getProject(store, pid);
    if (!project) return err('项目不存在', 404);
    const name = decodeURIComponent(req.headers['x-file-name'] || 'proof.bin');
    const buffer = await readBody(req, 64 * 1024 * 1024);
    if (!buffer.length) return err('空文件');
    const key = await store.saveFile(buffer, path.extname(name) || '.bin');
    const {createHash} = await import('node:crypto');
    const proof = {id: 'pr-' + uid(), name: String(name).slice(0, 180), key, size: buffer.length, hash: createHash('sha256').update(buffer).digest('hex').slice(0, 16), uploadedAt: nowStr(), by: decodeURIComponent(req.headers['x-by'] || '')};
    await store.mutate((s) => {
      const proj = s.projects.find((x) => x.id === pid);
      const it = (proj.audit?.items || []).find((x) => x.id === iid);
      if (!it) return;
      it.proofs = it.proofs || [];
      it.proofs.push(proof);
      it.history.push({time: nowStr(), from: it.status, to: it.status, by: proof.by || '负责人', note: `上传补证：${proof.name}`});
      it.updatedAt = nowStr();
    });
    const proj = await getProject(store, pid);
    const it = (proj.audit?.items || []).find((x) => x.id === iid);
    if (!it) return err('问题不存在', 404);
    return json({item: it});
  }

  // ---- 单条要求重新核验（修改后触发）----
  const recheckm = p.match(/^\/api\/projects\/([^/]+)\/recheck$/);
  if (recheckm && m === 'POST') {
    const pid = recheckm[1];
    const project = await getProject(store, pid);
    if (!project) return err('项目不存在', 404);
    const body = await readJson(req);
    const sid = String(body.requirementId || '');
    if (!sid) return err('缺少 requirementId');
    const reqRow2 = (project.requirements || []).find((r) => r.stableId === sid);
    if (!reqRow2) return err('要求不存在', 404);
    if (!model.configured) return err('模型未配置，无法重新核验');
    await hydrateDocs(store, project);
    const {buildBidPackages} = await import('./engine/audit-core.mjs');
    const {runResponse, runCompleteness, runFormat} = await import('./engine/checks.mjs');
    const packages = buildBidPackages(project);
    const updates = [];
    for (const pkg of packages) {
      const runner = reqRow2.type === 'material' || reqRow2.type === 'qualification' ? runCompleteness : reqRow2.type === 'format' ? runFormat : runResponse;
      const r = await runner({model, pkg, requirements: [reqRow2], priceContextRequirements: project.requirements});
      updates.push(...(r.items || []));
    }
    await store.mutate((s) => {
      const proj = s.projects.find((x) => x.id === pid);
      const items = proj.audit?.items || [];
      for (const nu of updates) {
        const idx = items.findIndex((old) => old.stableKey === nu.stableKey);
        if (idx >= 0) {
          const old = items[idx];
          // 保留人工处理状态与分派信息，只更新结论与证据
          items[idx] = {...nu, id: old.id, status: old.status, statusLabel: old.statusLabel, assignee: old.assignee, due: old.due, reviewer: old.reviewer, history: [...(old.history || []), {time: nowStr(), from: old.status, to: old.status, by: '系统', note: `重新核验：${CHECK_STATUS[old.checkStatus]?.label || old.checkStatus} → ${CHECK_STATUS[nu.checkStatus]?.label || nu.checkStatus}`}], comments: old.comments || [], proofs: old.proofs || []};
        } else {
          items.push(nu);
        }
      }
      if (proj.audit) proj.audit.items = items;
      proj.log.push({time: nowStr(), text: `重新核验要求：${reqRow2.title.slice(0, 20)}`});
    });
    const proj = await getProject(store, pid);
    return json({items: (proj.audit?.items || []).filter((x) => x.requirementId === sid), summary: summarizeItems(proj.audit?.items || [])});
  }

  // ---- 复审 ----
  const rm = p.match(/^\/api\/projects\/([^/]+)\/review$/);
  if (rm && m === 'POST') {
    const pid = rm[1];
    const project = await getProject(store, pid);
    if (!project) return err('项目不存在', 404);
    const body = await readJson(req);
    const targetVersion = body.version || project.currentVersion;
    if (!model.configured) return err('模型未配置，无法复审');
    await hydrateDocs(store, project);
    const review = await runReview({model, project, targetVersion});
    await store.mutate((s) => {
      const proj = s.projects.find((x) => x.id === pid);
      proj.review = review;
      proj.log.push({time: nowStr(), text: `复审 ${targetVersion}：已解决 ${review.summary.resolved}，新增 ${review.summary.added}`});
    });
    return json({review, project: withComputed(await getProject(store, pid))});
  }

  // ---- 版本切换 ----
  const vm = p.match(/^\/api\/projects\/([^/]+)\/version$/);
  if (vm && m === 'POST') {
    const pid = vm[1];
    const body = await readJson(req);
    const v = String(body.version || '').trim();
    if (!v) return err('版本号不能为空');
    const current = await getProject(store,pid);
    if (!current) return err('项目不存在',404);
    if (v !== current.currentVersion && current.audit?.status === 'done') {
      const pending=(current.audit.items||[]).filter(it=>isActionableItem(it) && !['reviewing','closed','dismissed'].includes(it.status));
      if (pending.length) return err(`仍有 ${pending.length} 条问题未处置，不能提交修订版`,409);
    }
    await store.mutate((s) => {
      const proj = s.projects.find((x) => x.id === pid);
      if (!proj) return;
      if (v !== proj.currentVersion) markAuditStale(proj, `切换到版本 ${v}`);
      proj.currentVersion = v;
      proj.versions = [...new Set([...(proj.versions || []), v])];
      proj.log.push({time: nowStr(), text: `切换当前版本至 ${v}`});
    });
    return json({project: withComputed(await getProject(store, pid))});
  }

  // ---- 交标放行 ----
  const relm = p.match(/^\/api\/projects\/([^/]+)\/release$/);
  if (relm) {
    const pid = relm[1];
    const project = await getProject(store, pid);
    if (!project) return err('项目不存在', 404);
    if (m === 'GET') return json({release: computeRelease(project), risks: openRiskList(project)});
    if (m === 'POST') {
      const body = await readJson(req);
      const release = computeRelease(project);
      if (body.action === 'confirm') {
        if (!release.canRelease && !body.force) return err(`仍有 ${release.blocking.length} 项硬门槛未通过：${release.blocking.map((b) => b.label).join('、')}`);
        await store.mutate((s) => {
          const proj = s.projects.find((x) => x.id === pid);
          proj.release = {confirmedAt: nowStr(), confirmedBy: String(body.by || project.owner || '负责人').slice(0, 40), version: project.currentVersion, forced: !!body.force && !release.canRelease, note: String(body.note || '').slice(0, 300), snapshot: release.gates};
          proj.log.push({time: nowStr(), text: `交标放行确认（版本 ${project.currentVersion}）`});
        });
        return json({release: computeRelease(await getProject(store, pid))});
      }
      return err('未知放行操作');
    }
  }

  // ---- 项目复盘（历史统计与问题分布）----
  const rtm = p.match(/^\/api\/projects\/([^/]+)\/retro$/);
  if (rtm && m === 'GET') {
    const project = await getProject(store, rtm[1]);
    if (!project) return err('项目不存在', 404);
    return json({retro: buildRetro(project)});
  }

  // ---- 导出 ----
  const exm = p.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (exm && m === 'GET') {
    const project = await getProject(store, exm[1]);
    if (!project) return err('项目不存在', 404);
    const entityId=q.get('entity');
    if(entityId){
      const entity=project.entities.find(e=>e.id===entityId);
      if(!entity)return err('标书公司不存在',404);
      if(!canEditEntity(user,project,entity))return err('无权导出该公司报告',403);
      const audit=entityAudit(project,entityId);
      if(audit?.status!=='done')return err('本公司审核未完成',409);
      const scoped={...entityProject(project,entityId),audit};
      if(!audit.legacy&&audit.snapshot?.inputsHash!==inputsFingerprint(scoped))return err('本公司审核输入已变化，请重新审核',409);
      return dl(reportToDocx(scoped),'application/vnd.openxmlformats-officedocument.wordprocessingml.document',`${project.name}-${entity.name}-审核报告.docx`);
    }
    if (project.audit?.status !== 'done' || project.audit?.snapshot?.inputsHash !== inputsFingerprint(project)) return err('当前审核未完成或已失效，请确认台账并重新审核后导出');
    const format = q.get('format') || 'report';
    if (format === 'csv') return dl(Buffer.from(checklistToCsv(project), 'utf8'), 'text/csv; charset=utf-8', project.name + '-问题清单.csv');
    if (format === 'risk-csv') return dl(Buffer.from(openRiskToCsv(project, openRiskList(project)), 'utf8'), 'text/csv; charset=utf-8', project.name + '-未关闭风险清单.csv');
    if (format === 'release') {
      const rel = computeRelease(project);
      return dl(releaseToDocx(project, {...rel, risks: openRiskList(project)}), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', project.name + '-交标前检查清单.docx');
    }
    return dl(reportToDocx(project), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', project.name + '-审核报告.docx');
  }

  // ---- 材料库 ----
  if (p === '/api/materials' && m === 'GET') {
    const state = await store.readState();
    return json({materials: state.materials, summary: materialSummary(state.materials)});
  }
  if (p === '/api/materials' && m === 'POST') {
    const body = await readJson(req);
    const mat = makeMaterial(body);
    if (!mat.name) return err('材料名称不能为空');
    await store.mutate((s) => { s.materials.unshift(mat); });
    return json({material: mat});
  }
  const matm = p.match(/^\/api\/materials\/([^/]+)$/);
  if (matm) {
    if (m === 'PATCH') {
      const body = await readJson(req);
      await store.mutate((s) => { const mat = s.materials.find((x) => x.id === matm[1]); if (mat) Object.assign(mat, body, {updatedAt: nowStr()}); });
      return json({material: (await store.readState()).materials.find((x) => x.id === matm[1])});
    }
    if (m === 'DELETE') {
      await store.mutate((s) => { s.materials = s.materials.filter((x) => x.id !== matm[1]); });
      return json({ok: true});
    }
  }

  return err('接口不存在', 404);
}

// ===== 辅助函数 =====
async function getProject(store, id) {
  return (await store.readState()).projects.find((x) => x.id === id) || null;
}

// 输入变更（文件/要求/版本/关键设置）后，把已完成的审核标为失效，并撤销放行。
// 保证「可交标」始终对应最新文件（P0-5）。
function markAuditStale(proj, reason) {
  if (proj.audit && ['done', 'running', 'pending', 'error'].includes(proj.audit.status)) {
    if (proj.audit.status === 'done') {
      proj.audit.status = 'stale';
      proj.audit.staleReason = reason;
      proj.audit.staledAt = nowStr();
      proj.log.push({time: nowStr(), text: `审核失效：${reason}`});
    } else {
      // 未完成的审核直接作废，避免与新输入混用
      proj.audit.status = 'stale';
      proj.audit.staleReason = '审核进行中输入发生变化，已作废';
      proj.audit.staledAt = nowStr();
    }
  }
  if (proj.release && proj.release.confirmedAt) {
    proj.release = {...proj.release, revoked: true, revokedAt: nowStr(), revokedReason: reason};
    proj.log.push({time: nowStr(), text: `放行已撤销：${reason}`});
  }
}
function allCurrentItems(proj){return [...(proj.audit?.items||[]),...Object.values(proj.entityAudits||{}).flatMap(a=>a?.items||[])];}
function findCurrentItem(proj,id){return allCurrentItems(proj).find(i=>i.id===id);}
function staleForDoc(proj,doc,reason){
  if(doc.role==='procurement'){markAuditStale(proj,reason);for(const audit of Object.values(proj.entityAudits||{}))if(audit)audit.status='stale';}
  else {const audit=proj.entityAudits?.[doc.entityId];if(audit)audit.status='stale';}
  proj.crossReview=null;
}
// 把 parsedKey 指向的解析结果水合为 doc.parsed（审核/复审/台账都需要）
async function hydrateDocs(store, project) {
  for (const d of project.docs) {
    if (d.parsed) continue;
    if (d.parsedKey) {
      try { d.parsed = JSON.parse((await store.readFile(d.parsedKey)).toString('utf8')); }
      catch { d.parsed = null; }
    }
  }
  return project;
}
function withComputed(project) {
  if (!project) return project;
  const focus = priorityRequirements(project.requirements || []);
  const ids = focus.map(r => r.stableId);
  return {...project, _entityAudits:Object.fromEntries((project.entities||[]).map(e=>[e.id,entityAudit(project,e.id)])), _focus: {items: focus, approved: !!project.focusApprovedAt &&
    project.focusIds?.join('|') === ids.join('|'), totalCandidates: (project.requirements || []).length},
    _release: releaseGateSummary(project), _wizard: computeWizard(project)};
}
function visibleProject(project,user){
  if(canManageProject(user,project))return project;
  const owned=new Set((project.entities||[]).filter(e=>e.owner===user.name).map(e=>e.id));
  const filterAudit=a=>a?{...stripInternal(a),results:{},items:(a.items||[]).filter(i=>owned.has(i.entityId))}:a;
  return {...project,
    docs:(project.docs||[]).filter(d=>d.role==='procurement'||owned.has(d.entityId)),
    audit:filterAudit(project.audit),auditHistory:(project.auditHistory||[]).map(filterAudit),
    entityAudits:Object.fromEntries(Object.entries(project.entityAudits||{}).filter(([id])=>owned.has(id))),
    entityAuditHistory:Object.fromEntries(Object.entries(project.entityAuditHistory||{}).filter(([id])=>owned.has(id))),
    crossReview:null};
}
function stripInternal(audit) {
  if (!audit) return audit;
  const {_packages, _procIndexCount, ...rest} = audit;
  return rest;
}
function projectSummary(project) {
  const entityItems=(project.entities||[]).flatMap(e=>entityAudit(project,e.id)?.items||[]);
  const items = entityItems.length ? entityItems : project.audit?.items || [];
  const s = summarizeItems(items);
  const reqs = project.requirements || [];
  const wiz = computeWizard(project);
  return {
    id: project.id, name: project.name, code: project.code, owner: project.owner, mode: project.mode || (project.entities.length > 1 ? 'multi' : 'single'),
    purchaser: project.purchaser, bidDeadline: project.bidDeadline, internalDeadline: project.internalDeadline,
    createdAt: project.createdAt, currentVersion: project.currentVersion, archived: project.archived,
    docs: project.docs.length, entities: project.entities.length,
    auditStatus: (project.entities||[]).length&&project.entities.every(e=>entityAudit(project,e.id)?.status==='done')?'done':project.audit?.status || 'draft', progress: project.audit?.progress || 0,
    summary: s,
    requirementRate: reqs.some(r=>!r.reviewScope||r.reviewScope==='audit') ? Math.round((reqs.filter(r=>(!r.reviewScope||r.reviewScope==='audit')&&r.status!=='pending').length / reqs.filter(r=>!r.reviewScope||r.reviewScope==='audit').length) * 100) : 0,
    release: project.release ? {confirmed: !!project.release.confirmedAt && !project.release.revoked, at: project.release.confirmedAt} : null,
    wizard: {current: wiz.current, hint: wiz.hint, currentTitle: wiz.stages.find((x) => x.key === wiz.current)?.title || '', mainAction: wiz.stages.find((x) => x.key === wiz.current)?.mainAction || null, allDone: wiz.allDone},
  };
}
function buildWorkbench(state) {
  const projects = state.projects.map(projectSummary);
  const bids = [];
  const todo = [];
  const highRisk = [];
  for (const proj of state.projects) {
    for (const entity of proj.entities || []) {
      const docs = (proj.docs || []).filter((d) => d.entityId === entity.id && d.version === entityVersion(entity));
      const audit=entityAudit(proj,entity.id), issues = (audit?.items||[]).filter((it) => isActionableItem(it) && !['closed', 'dismissed'].includes(it.status));
      bids.push({projectId: proj.id, projectName: proj.name, version: entityVersion(entity), entityId: entity.id, entityName: entity.name, writer: entity.owner || '', docs: docs.length,
        open: issues.length, high: issues.filter((it) => ['critical', 'high'].includes(it.risk)).length, auditStatus: audit?.status || 'draft'});
    }
    for (const it of proj.audit?.items || []) {
      if (!isActionableItem(it) || ['closed', 'dismissed'].includes(it.status)) continue;
      if (['critical', 'high'].includes(it.risk)) highRisk.push({projectId: proj.id, projectName: proj.name, itemId: it.id, title: it.title, risk: it.risk, riskLabel: it.riskLabel, check: it.check, entityName: it.entityName, assignee: it.assignee, due: it.due});
      if (it.assignee) todo.push({projectId: proj.id, projectName: proj.name, itemId: it.id, title: it.title, risk: it.risk, status: it.status, statusLabel: it.statusLabel, assignee: it.assignee, due: it.due});
    }
  }
  const deadlines = [];
  for (const proj of state.projects) {
    for (const [type, label] of [['qaDeadline', '答疑截止'], ['internalDeadline', '内部定稿'], ['bidDeadline', '交标截止']]) {
      if (proj[type]) deadlines.push({projectId: proj.id, projectName: proj.name, type, label, date: proj[type]});
    }
  }
  return {
    todo: todo.slice(0, 40), highRisk: highRisk.slice(0, 40), projects, bids,
    deadlines: deadlines.slice(0, 30),
    stats: {projects: projects.length, active: projects.filter((p) => !p.archived && p.auditStatus !== 'done').length, highRiskCount: highRisk.length, todoCount: todo.length},
  };
}
function matrixSummary(matrix) {
  const counts = {unaudited: 0, satisfied: 0, partial: 0, notFound: 0, violated: 0, unknown: 0, uncovered: 0};
  let evidenceRows = 0;
  for (const row of matrix) { counts[row.status] = (counts[row.status] || 0) + 1; if ((row.evidence || []).length) evidenceRows++; }
  return {total: matrix.length, counts, evidenceRows};
}
function buildAssist(item, project) {
  const sync = (project.requirements || []).filter((r) => r.type === item.requirement?.type && r.stableId !== item.requirementId).slice(0, 3).map((r) => r.title);
  return {
    location: item.requirement ? {file: item.requirement.fileName, label: item.requirement.locator?.label, quote: item.requirement.quote} : null,
    bidLocation: (item.evidence || []).map((e) => ({file: e.fileName, label: e.locator?.label, quote: e.quote})),
    action: item.action, suggestedText: item.suggestedText, cannotInvent: item.cannotInvent, acceptance: item.acceptance,
    syncHints: sync, requirementCheckpoints: item.requirement?.checkpoints || [],
    note: '事实类材料（资质、业绩、报价、签章、承诺期限）只能由人提供真实材料，助手只列待补项，不自动编造。',
  };
}

// 项目复盘：审核轮次、问题分布、处理效率、堵点分析
function buildRetro(project) {
  const items = (project.audit?.items || []).filter(isActionableItem);
  const open = (it) => !['closed', 'dismissed'].includes(it.status);
  const byCheck = {};
  for (const it of items) byCheck[it.check] = (byCheck[it.check] || 0) + 1;
  const closed = items.filter((it) => it.status === 'closed').length;
  const dismissed = items.filter((it) => it.status === 'dismissed').length;
  // 高频问题类型（复盘用：同类问题反复出现说明编制环节有系统性问题）
  const byIssueType = {};
  for (const it of items) byIssueType[it.issueType] = (byIssueType[it.issueType] || 0) + 1;
  const topTypes = Object.entries(byIssueType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([type, n]) => ({type, count: n}));
  return {
    auditRounds: (project.auditHistory || []).length,
    currentVersion: project.currentVersion,
    totalItems: items.length,
    closed, dismissed,
    open: items.filter(open).length,
    byCheck,
    topTypes,
    reviewRounds: project.review ? 1 : 0,
    reviewSummary: project.review?.summary || null,
    released: !!project.release?.confirmedAt,
    elapsed: project.createdAt && project.release?.confirmedAt ? `${project.createdAt} → ${project.release.confirmedAt}` : null,
  };
}
async function loadParsedDocs(store, project, docs) {
  const out = [];
  for (const d of docs) {
    let parsed = null;
    if (d.parsedKey) { try { parsed = JSON.parse((await store.readFile(d.parsedKey)).toString('utf8')); } catch {} }
    out.push({id: d.id, name: d.name, role: d.role, category: d.category, entityId: d.entityId, entityName: d.entityName, version: d.version, parsed});
  }
  return out;
}
async function ingestDoc(store, project, pid, {buffer, name, category, entityId, version}) {
  const ext = path.extname(name || '') || '.bin';
  const key = await store.saveFile(buffer, ext);
  let parsed = null;
  let parseError = null;
  try { parsed = await parseFile(buffer, name); } catch (e) { parseError = String(e.message).slice(0, 200); }
  const isProc = ['procurement', 'supplement'].includes(category);
  const role = isProc ? 'procurement' : 'bid';
  // 文件哈希 + 重复提醒（同名同大小同哈希已在项目中）
  const {createHash} = await import('node:crypto');
  const hash = createHash('sha256').update(buffer).digest('hex');
  const dup = project.docs.find((d) => d.hash === hash || (d.name === name && d.size === buffer.length && d.version === (version || project.currentVersion)));
  const doc = {
    id: 'd-' + uid(), key, name: String(name).slice(0, 180), role, category,
    entityId: role === 'bid' ? (entityId || null) : null,
    entityName: role === 'bid' ? (project.entities.find((e) => e.id === entityId)?.name || '') : '',
    size: buffer.length, uploadedAt: nowStr(), hash,
    duplicateOf: dup ? {id: dup.id, name: dup.name} : null,
    version: String(version || project.currentVersion).slice(0, 20),
    parseError,
    structure: parsed ? {
      kind: parsed.kind, paragraphCount: parsed.paragraphs?.length || 0, sectionCount: parsed.sections?.length || 0,
      imageAnchors: parsed.imageAnchors?.length || 0, pageCount: parsed.pageCount || parsed.metadata?.pages || null,
      unreadable: !!parsed.unreadable, locatorHint: parsed.locatorHint, unreadableReason: parsed.unreadableReason || null,
    } : null,
    parsedKey: null,
  };
  if (parsed) {
    const parsedBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
    doc.parsedKey = await store.saveFile(parsedBuf, '.parsed.json');
  }
  await store.mutate((s) => {
    const proj = s.projects.find((x) => x.id === pid);
    if (proj) {
      proj.docs.push(doc);
      proj.log.push({time: nowStr(), text: `上传 ${isProc ? '招标/补遗' : '投标'}文件：${doc.name}（${doc.version}）`});
      staleForDoc(proj,doc,'上传新文件后输入已变化');
    }
  });
  return doc;
}

// 对已核验原文的采购条款做范围初筛。初筛仅用于缩小人工核对清单，
// 不改写原文、不得自动确认；无法判定时保留在标书审核范围内。
const SYSTEM = `你是售前标书审核范围整理员。逐条判断采购文件片段应该放在哪个清单：
audit：需要核查投标文件正文、资质材料、报价、技术方案、签章、评分响应的要求；有条件适用的材料也放 audit。
manual：递交、报名、开标参会、邮寄、现场操作等需核对线下记录，不能仅凭投标文件正文判断的事项。
reference：采购人/评委/代理机构的说明、评分计算公式和排序过程、纯定义、合同签订后的履约/付款/争议条款，且没有要求投标阶段提供承诺或方案。
不确定时选 audit。不得把资格门槛、否决条款、★▲条款、明确要求投标人提供的材料归为 reference。
只返回 JSON：{"items":[{"id":数字,"scope":"audit|manual|reference","reason":"不超过24字"}]}。必须逐个返回全部 id。`;

export async function triageRequirements(model, requirements, {onProgress}={}) {
  const result = requirements.map(r=>({...r,reviewScope:'audit',reviewScopeReason:'保守纳入标书审核'}));
  const warnings=[];
  for(let start=0;start<result.length;start+=35){
    const batch=result.slice(start,start+35);
    const source=batch.map((r,j)=>({id:start+j,type:r.type,title:r.title,quote:String(r.quote||'').slice(0,170),mark:r.mark||'',consequence:r.consequence||''}));
    onProgress?.(`整理采购要求 ${Math.min(start+35,result.length)}/${result.length}`);
    try{
      const response=await model.json({system:SYSTEM,user:JSON.stringify(source),maxTokens:4800,parse:o=>{
        if(!Array.isArray(o?.items))throw new Error('缺少分类列表');
        return o;
      }});
      const decisions=new Map(response.items.map(x=>[Number(x.id),x]));
      for(let j=0;j<batch.length;j++){
        const r=result[start+j],d=decisions.get(start+j);
        if(!d || !['audit','manual','reference'].includes(d.scope))continue;
        // 高风险和明确交标材料保守保留，避免初筛隐去必须响应的事项。
        const mustAudit=r.origin==='coverage'||r.origin==='composition'||r.origin==='template'||r.origin==='scoring-table'||r.composition?.mandatory||r.mark==='★'||r.mark==='▲'||/无效参选|无效投标|废标|否决/.test(r.consequence||'')||/须(?:提供|提交|附上)|必须(?:提供|提交)|应(?:提供|提交)/.test(r.quote||'');
        r.reviewScope=mustAudit?'audit':d.scope;
        r.reviewScopeReason=mustAudit&&d.scope!=='audit'?'明确材料或否决要求，保守纳入':String(d.reason||'AI 初筛').slice(0,60);
      }
    }catch(error){warnings.push(`第 ${start+1}–${Math.min(start+35,result.length)} 条初筛失败：${error.message}；已保守纳入审核`);}
  }
  const scoped=normalizeReviewScope(result);
  return {requirements:scoped,warnings,counts:scoped.reduce((acc,r)=>(acc[r.reviewScope]++,acc),{audit:0,manual:0,reference:0})};
}

// 采购方评审程序及线下行为规则不应被判成“标书缺少承诺”。
export function normalizeReviewScope(requirements) {
  return requirements.map(r=>{
    const title=String(r.title||'');
    const quote=String(r.quote||'');
    if(/评标委员会.{0,35}(?:否决所有|表决|审查|决定)|(?:得票超过半数|记名方式表决|简单多数原则表决)|(?:参选人|供应商)不足三家.{0,20}(?:废标|终止)|不满足审查表要求无效/.test(`${title} ${quote}`))return {...r,reviewScope:'reference',reviewScopeReason:'采购方评审程序，非标书应附材料'};
    if(/多方案参选处理|禁止影响评标|遴选文件保密|报价明显偏低须提供书面说明/.test(title))return {...r,reviewScope:'manual',reviewScopeReason:'行为或触发条件需人工核对'};
    if(/信用记录要求/.test(title)&&/以采购代理机构|评审当天/.test(quote))return {...r,reviewScope:'manual',reviewScopeReason:'评审当天由采购方查询，条件证明另核'};
    return r;
  });
}

// A bounded presales reading guide. The original ledger remains available for traceability.
// Selection is deterministic so the guide and the audit always use the same requirements.
const LIMITS = {qualification: 10, material: 10, substantive: 15, param: 12,
  commercial: 5, scoring: 6, format: 5};

export function priorityRequirements(requirements, limit = 100) {
  const scoredFiles=new Set((requirements||[]).filter(r=>r.origin==='scoring-table').map(r=>r.fileId));
  const candidates = (requirements || []).filter(r => r.status !== 'excluded' &&
    (!r.reviewScope || r.reviewScope === 'audit'||r.origin==='price-scoring') &&
    (r.type!=='scoring'||['scoring-table','price-scoring'].includes(r.origin)||!scoredFiles.has(r.fileId)) &&
    !/评标委员会|评审委员会|质疑函|开标大会|报名登记|采购代理机构|价格修正|评分统计|评审价计算公式|合同尾款|不参加参选告知|资格审查通过标准|不具备资格要求无效|参选人不足三家|影响采购公正行为废标|异常低价审查启动情形|无需缴纳参选保证金|联合体价格扣除|信封须标明截止时间前不得启封|缺漏项价格视为已包含|报价漏项处理|★条款响应要求|▲条款响应要求|满足遴选文件中标注/.test(r.title || ''));
  const score = r => {
    const text = `${r.title || ''} ${r.quote || ''} ${r.consequence || ''}`;
    let n = {qualification:30,material:35,substantive:20,param:50,commercial:10,scoring:25,format:20}[r.type] || 0;
    if (/[★▲]/.test(text)) n += 120;
    if (/无效参选|无效投标|废标|否决|资格审查/.test(text)) n += 100;
    if (/必须提供|须提供|必须提交|须提交|应附|证明材料|声明函|承诺函/.test(text)) n += 65;
    if (/最高限价|预算|报价|截止|有效期|保证金/.test(text)) n += 55;
    if (/评分|得分|技术方案|服务方案|业绩|人员/.test(text)) n += 35;
    if (r.origin === 'manual' || r.origin === 'coverage') n += 50;
    if (/评标委员会|采购代理机构|评审当天|合同签订后|报名|开标大会|邮寄|递交时间/.test(text)) n -= 150;
    if (/如为|若为|如有|可选|属于.*(?:时|的)|残疾人福利性单位|监狱企业/.test(text)) n -= 60;
    if (/准确率|时限|数据安全|接待|分类|转接|录音|服务方案|技术方案/.test(text)) n += 35;
    return n;
  };
  const seen = new Set();
  const buckets = Object.keys(LIMITS).map(type => {
    const rows = candidates.filter(r => r.type === type && score(r) >= 25).sort((a,b) => score(b)-score(a));
    return rows.filter(r => {
      const key = String(r.title || '').replace(/[（(].*?[）)]/g,'').replace(/要求|证明|材料|响应/g,'').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, LIMITS[type]);
  });
  const cap=Math.min(100,Math.max(1,limit));
  const composition=candidates.filter(r=>r.composition).sort((a,b)=>{
    return a.composition.number.localeCompare(b.composition.number,'zh-CN',{numeric:true});
  });
  const chosen=[],ids=new Set();
  const templates=candidates.filter(r=>r.template).sort((a,b)=>Number(a.template.number)-Number(b.template.number));
  const scoringRows=candidates.filter(r=>['scoring-table','price-scoring'].includes(r.origin)).sort((a,b)=>a.origin==='price-scoring'?1:b.origin==='price-scoring'?-1:a.scoring.table.localeCompare(b.scoring.table)||Number(a.scoring.number)-Number(b.scoring.number));
  for(const r of [...composition,...templates,...scoringRows,...buckets.flat()]){
    if(chosen.length>=cap)break;
    if(ids.has(r.stableId))continue;
    ids.add(r.stableId);chosen.push(r);
  }
  return chosen;
}

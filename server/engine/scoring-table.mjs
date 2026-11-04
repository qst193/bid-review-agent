import {requirementStableId,stableHash} from './domain.mjs';
import {norm} from './indexer.mjs';

const SYSTEM=`你是采购文件评分表逐项提取员。只依据给出的带 P 编号原文。识别每个顶层评分项，返回序号、名称、满分、评分规则原文片段、应提交材料原文片段和评分项所在段落 P 编号。不要把“优秀得5分”当成唯一规则；保留一般档、零分条件、数量上限和材料限制。每个原文片段须是某一行中连续出现的文字，不得改写。仅输出 JSON。`;

export function findScoringTables(doc){
  const p=doc.parsed?.paragraphs||[],tables=[];
  for(let i=0;i<p.length;i++){
    const title=String(p[i]?.text||'').trim();
    if(!/^(?:附表|附件|表)\s*[\d-]*\s*[《〈]?[^\n]{0,35}(?:商务|技术|价格)[^\n]{0,18}评分标准/.test(title))continue;
    let end=i+1;
    while(end<Math.min(p.length,i+350)&&!/^合计\s*\d*\s*分?$/.test(String(p[end]?.text||'').trim()))end++;
    if(end>=Math.min(p.length,i+350))continue;
    if(end-i<10)continue;
    tables.push({title,start:i,end});i=end;
  }
  return tables;
}

export function recoverPriceScoring(doc){
  const p=doc.parsed?.paragraphs||[];
  const heading=p.findIndex(x=>/^\d+(?:\.\d+)?\s*价格评分方法/.test(String(x.text||'').trim()));
  if(heading<0)return null;
  const formula=p.findIndex((x,i)=>i>heading&&i<heading+100&&/价格得分\s*=/.test(String(x.text||'')));
  const weights=p.findIndex((x,i)=>i>formula&&i<formula+70&&/商务标分值.*技术标分值.*价格标分值/.test(String(x.text||'')));
  if(formula<0||weights<0)return null;
  const amounts=String(p[weights+1]?.text||'').match(/(\d+)\s*分/g)?.map(x=>Number(x.match(/\d+/)[0]))||[];
  if(amounts.length!==3||amounts.some(x=>x<0||x>100))return null;
  const fullRule=p.slice(heading,Math.min(weights+3,p.length)).map(x=>String(x.text||'').trim()).filter(t=>t&&!/^\d+\s*\/\s*\d+\s*\d*$/.test(t));
  const materials=fullRule.filter(t=>/响应报价一览表|分项报价表/.test(t)).slice(0,4);
  const score=amounts[2],quote=String(p[formula].text||'');
  return {stableId:requirementStableId({quote:`${quote}:${score}`,title:'价格评分方法'}),title:'价格评分方法',type:'scoring',typeLabel:'评分说明',quote,
    source:'价格评分方法及分值汇总表',consequence:'',mark:'',score,checkpoints:materials,requiredMaterials:materials,fileId:doc.id,fileName:doc.name,
    locator:{paraIndex:formula,page:p[formula].page||null,label:p[formula].page?`第 ${p[formula].page} 页`:`段落 ${formula+1}`},
    owner:'',status:'pending',statusLabel:'待确认',locked:false,origin:'price-scoring',reviewScope:'reference',
    scoring:{table:'价格评分方法',number:'价格',maxScore:score,criteria:[],materials,fullRule},createdAt:new Date().toLocaleString('zh-CN',{hour12:false})};
}

export async function extractScoringTables(model,docs,{resume={},onCheckpoint}={}){
  const requirements=[],warnings=[],chunkResults={...resume};
  for(const doc of docs){
    for(const table of findScoringTables(doc)){
      const lines=doc.parsed.paragraphs.slice(table.start,table.end+1).map((p,j)=>`[P${table.start+j}] ${String(p.text||'').trim()}`).filter(x=>x.length>8);
      const key=`score:${doc.id}:${table.start}:${stableHash(lines.join('\n'))}`;
      if(Object.hasOwn(chunkResults,key)){constrainScoringRows(chunkResults[key],doc.parsed,table);requirements.push(...chunkResults[key]);continue;}
      let response;
      try{response=await model.json({system:SYSTEM,user:`评分表：${table.title}\n${lines.join('\n')}\n输出：{"items":[{"number":"1","title":"评分项名称","score":5,"anchor":100,"criteriaQuotes":["逐字原文"],"materialQuotes":["逐字原文"]}]}`,maxTokens:7800});}
      catch(error){warnings.push(`${doc.name} ${table.title} 评分表抽取失败：${error.message}`);continue;}
      const source=doc.parsed.paragraphs.slice(table.start,table.end+1);
      const rows=[];
      for(const item of Array.isArray(response?.items)?response.items:[]){
        const anchor=Number(item.anchor),score=Number(item.score);
        if(!Number.isInteger(anchor)||anchor<table.start||anchor>table.end||!Number.isFinite(score)||score<0||score>100)continue;
        const title=String(item.title||'').trim().slice(0,70);
        if(!title)continue;
        const section=source.map(p=>String(p.text||''));
        const exact=q=>section.find(line=>norm(line).includes(norm(q))&&norm(q).length>=4);
        const criteria=(item.criteriaQuotes||[]).map(q=>exact(String(q||''))).filter(Boolean).slice(0,12);
        const materials=(item.materialQuotes||[]).map(q=>exact(String(q||''))).filter(Boolean).slice(0,10);
        if(!criteria.length)continue;
        const nearby=doc.parsed.paragraphs.slice(Math.max(table.start,anchor-2),Math.min(table.end+1,anchor+4)).map(p=>String(p.text||'')).join(' ');
        if(!new RegExp(`(?:^|\\D)${score}(?:\\D|$)`).test(nearby)&&!criteria.some(q=>new RegExp(`${score}\\s*分`).test(q)))continue;
        const anchorText=String(doc.parsed.paragraphs[anchor].text||'');
        const quote=criteria[0];
        rows.push({stableId:requirementStableId({quote:`${table.title}:${item.number}:${title}`,title}),title,type:'scoring',typeLabel:'评分说明',quote,
          source:`${table.title} 第${item.number}项`,consequence:'',mark:'',score,checkpoints:[...criteria,...materials],requiredMaterials:materials,
          fileId:doc.id,fileName:doc.name,locator:{paraIndex:anchor,page:doc.parsed.paragraphs[anchor].page||null,label:doc.parsed.paragraphs[anchor].page?`第 ${doc.parsed.paragraphs[anchor].page} 页`:`段落 ${anchor+1}`},
          owner:'',status:'pending',statusLabel:'待确认',locked:false,origin:'scoring-table',reviewScope:'audit',
          scoring:{table:table.title,number:String(item.number),maxScore:score,criteria,materials,anchorText},createdAt:new Date().toLocaleString('zh-CN',{hour12:false})});
      }
      // The PDF text order interleaves table columns. Keep only quotations inside
      // this row; the model can otherwise borrow a neighbouring row's material.
      constrainScoringRows(rows,doc.parsed,table);
      if(!rows.length){warnings.push(`${doc.name} ${table.title} 未能得到经原文校验的评分项`);continue;}
      chunkResults[key]=rows;requirements.push(...rows);
      await onCheckpoint?.({key,items:rows});
    }
  }
  return {requirements,warnings,chunkResults};
}

export function constrainScoringRows(rows,parsed,table){
      const starts=rows.map((r,index)=>{
        const lower=index?rows[index-1].locator.paraIndex+1:table.start;
        const anchor=r.locator.paraIndex,needle=norm(r.scoring.criteria[0]);
        const hits=[];
        for(let k=lower;k<=Math.min(table.end,anchor+3);k++)if(norm(parsed.paragraphs[k].text).includes(needle))hits.push(k);
        return hits.filter(k=>k<=anchor).at(-1)??hits[0]??lower;
      });
      rows.forEach((r,index)=>{
        const raw=parsed.paragraphs.slice(starts[index],starts[index+1]??table.end+1).map(p=>String(p.text||'').trim())
          .filter(t=>t&&!/^\d+\s*\/\s*\d+\s*\d*$/.test(t)&&!/^\d{1,2}$/.test(t));
        const part=raw.map(norm);
        const within=q=>part.some(text=>text.includes(norm(q)));
        r.scoring.criteria=r.scoring.criteria.filter(within);
        r.scoring.materials=r.scoring.materials.filter(within);
        r.scoring.fullRule=raw;
        const materialStart=raw.findIndex(t=>/^(?:资料|材料|证明材料)提交要求|^证明材料[：:]/.test(t));
        if(materialStart>=0)r.scoring.materials=raw.slice(materialStart).filter(t=>!/^(?:评标委员会|评委会)/.test(t)).slice(0,30);
        r.checkpoints=[...r.scoring.criteria,...r.scoring.materials];
        r.requiredMaterials=r.scoring.materials;
      });
}

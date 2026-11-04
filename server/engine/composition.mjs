import {verifyEvidence,norm} from './indexer.mjs';
import {requirementStableId} from './domain.mjs';

// Read numbered response-file composition sections from this procurement file.
// The numbering and mandatory range come from its text, never from a project template.
export function recoverCompositionRequirements(docs,existing=[]){
  const output=[];
  const seenContent=new Set();
  for(const doc of docs){
    const contentKey=doc.hash||`${doc.name}:${(doc.parsed?.paragraphs||[]).length}`;
    if(seenContent.has(contentKey))continue;
    seenContent.add(contentKey);
    const paragraphs=doc.parsed?.paragraphs||[];
    const numberedFormat=recoverNumberedFormatSections(doc,existing);
    // Where the procurement file has an explicit numbered response-format
    // chapter, that chapter defines the composition. Earlier 3.x supplier
    // instructions are rules, not extra chapters to be submitted.
    if(!numberedFormat.length)for(let start=0;start<paragraphs.length;start++){
      const heading=String(paragraphs[start]?.text||'').trim();
      if(!/^(?:第[一二三四五六七八九十]+[章节][、.．\s]*)?(?:\d+[.、．]\s*)?.{0,12}(?:响应|投标|参选)文件的?组成\s*$/.test(heading))continue;
      const number=heading.match(/^(\d+)[.、．]/)?.[1];
      const rows=[];
      for(let i=start+1;i<Math.min(paragraphs.length,start+100);i++){
        const quote=String(paragraphs[i]?.text||'').trim();
        if(number&&new RegExp(`^${Number(number)+1}[.、．](?!\\d)`).test(quote))break;
        const m=quote.match(/^(\d+(?:\.\d+){1,3})\s*(.+)$/);
        if(m&&(!number||m[1].startsWith(number+'.')))rows.push({number:m[1],quote,index:i,title:m[2].replace(/[；;。]+$/,'').slice(0,60)});
        if(/^注[：:]/.test(quote)&&rows.length)rows.push({note:quote});
      }
      if(rows.length<3)continue;
      const note=rows.find(r=>r.note)?.note||'';
      const mandatoryRange=note.match(/必须提交[^。；]{0,100}?[“"']?(\d+)\.(\d+)\s*[-—至到~～]\s*(?:\1\.)?(\d+)/);
      const must=number&&mandatoryRange&&mandatoryRange[1]===number?{start:Number(mandatoryRange[2]),end:Number(mandatoryRange[3])}:null;
      for(const row of rows.filter(r=>r.number)){
        if(rows.some(other=>other.number?.startsWith(row.number+'.')))continue;
        const verified=verifyEvidence(doc.parsed,row.quote);
        if(!verified.found||verified.weak)continue;
        const major=Number(row.number.split('.')[1]);
        const mandatory=!!must&&major>=must.start&&major<=must.end;
        const conditional=/如有|如需|若有|视具体|如适用|仅当|如果/.test(row.quote);
        const old=existing.find(r=>r.fileId===doc.id&&(r.source===row.number||norm(r.quote)===norm(row.quote)));
        if(old){old.composition={number:row.number,mandatory,conditional,note};old.reviewScope='audit';continue;}
        output.push({stableId:requirementStableId({quote:verified.quote,title:row.title}),title:row.title,type:'material',typeLabel:'组成材料',quote:verified.quote,
          source:row.number,consequence:mandatory?note:'',mark:'',score:null,checkpoints:[],requiredMaterials:[],fileId:doc.id,fileName:doc.name,
          locator:verified.locator,owner:'',status:'pending',statusLabel:'待确认',locked:false,origin:'composition',reviewScope:'audit',
          composition:{number:row.number,mandatory,conditional,note},createdAt:new Date().toLocaleString('zh-CN',{hour12:false})});
      }
      start+=rows.length;
    }
    output.push(...numberedFormat);
    output.push(...recoverTemplateRequirements(doc,existing));
  }
  return output;
}

// Numbered annexes are a separate checklist from the response-file contents.
// A supplied sample does not by itself make its visual typography mandatory.
function recoverTemplateRequirements(doc,existing){
  const paragraphs=doc.parsed?.paragraphs||[];
  const chapter=paragraphs.findIndex(p=>/^第[一二三四五六七八九十\d]+章\s*(?:响应|投标|谈判).*文件.*格式$/.test(String(p.text||'').trim()));
  if(chapter<0)return [];
  const preface=paragraphs.slice(chapter,Math.min(chapter+8,paragraphs.length)).map(p=>String(p.text||'')).join('');
  const mode=/可根据自身情况进行补充和修改|不得造成.*实质性.*违背/.test(preface)?'content':/必须.*原样|不得修改.*格式/.test(preface)?'exact':'unclear';
  const headings=[];
  for(let i=chapter+1;i<paragraphs.length;i++){
    const line=String(paragraphs[i]?.text||'').trim();
    const match=line.match(/^(格式|附件|附表)\s*(\d{1,2})\s*[：:]\s*(.{2,70})$/);
    if(match)headings.push({index:i,kind:match[1],number:match[2],title:match[3],quote:line});
  }
  if(headings.length<2)return [];
  return headings.map((h,n)=>{
    const end=headings[n+1]?.index??paragraphs.length;
    const fixed=paragraphs.slice(h.index+1,Math.min(end,h.index+32)).map(p=>String(p.text||'').trim())
      .filter(t=>t.length>=14&&t.length<=350&&!/^(?:响应单位|供应商|法定代表人|日期|项目名称|项目编号)[：:]/.test(t)).slice(0,5);
    const old=existing.find(r=>r.fileId===doc.id&&(r.locator?.paraIndex===h.index||norm(r.quote)===norm(h.quote)));
    const template={number:h.number,kind:h.kind,mode,startIndex:h.index,endIndex:end,sourceText:fixed};
    if(old){old.template=template;old.reviewScope='audit';return null;}
    return {stableId:requirementStableId({quote:h.quote,title:h.title}),title:`${h.kind}${h.number}：${h.title}`,type:'format',typeLabel:'格式交付',quote:h.quote,
      source:`响应文件格式 ${h.kind}${h.number}`,consequence:'',mark:'',score:null,checkpoints:fixed,requiredMaterials:[],fileId:doc.id,fileName:doc.name,
      locator:{paraIndex:h.index,page:paragraphs[h.index]?.page||null,label:paragraphs[h.index]?.page?`第 ${paragraphs[h.index].page} 页`:`段落 ${h.index+1}`},
      owner:'',status:'pending',statusLabel:'待确认',locked:false,origin:'template',reviewScope:'audit',template,createdAt:new Date().toLocaleString('zh-CN',{hour12:false})};
  }).filter(Boolean);
}

function recoverNumberedFormatSections(doc,existing){
  const paragraphs=doc.parsed?.paragraphs||[],output=[];
  for(let i=0;i<paragraphs.length;i++){
    const heading=String(paragraphs[i]?.text||'').trim();
    if(!/^(?:第[一二三四五六七八九十]+章\s*)?(?:谈判|磋商|投标|响应)文件格式$/.test(heading)&&!/^(?:谈判|磋商|投标)响应文件$/.test(heading))continue;
    const recent=paragraphs.slice(Math.max(0,i-25),i).map(p=>String(p.text||'')).join('');
    const nearbyFormat=/响应文件格式|投标文件格式/.test(recent)||/文件格式/.test(heading);
    if(!nearbyFormat)continue;
    let expected=1;
    const rows=[];
    for(let j=i+1;j<Math.min(paragraphs.length,i+850);j++){
      const line=String(paragraphs[j]?.text||'').trim();
      const match=line.match(/^(\d{1,2})[、.．]\s*(.{2,90})$/);
      if(!match||Number(match[1])!==expected)continue;
      const title=match[2].trim();
      if(/[。；;]/.test(title)||/^我方|^如为|^上述|^后附/.test(title))continue;
      rows.push({number:String(expected),title,quote:line,index:j});expected++;
      if(expected>60)break;
    }
    if(rows.length<5)continue;
    for(let n=0;n<rows.length;n++){
      const row=rows[n],next=rows[n+1]?.index||Math.min(paragraphs.length,row.index+80);
      const section=paragraphs.slice(row.index+1,next).map(p=>String(p.text||'')).join(' ').slice(0,1600);
      const reference=/仅供参考|参考格式|示例/.test(row.title);
      const earlier=paragraphs.slice(Math.max(0,i-15),i).map(p=>String(p.text||'')).join('');
      const afterAward=/成交后[^。]{0,220}/.exec(earlier)?.[0]||'';
      const awardStage=afterAward&&norm(afterAward).includes(norm(row.title.replace(/供应商|符合性|社会准则/g,'').slice(0,8)));
      const mandatory=!reference&&!awardStage&&/资料提交要求|必须提供本表|须提供|必须提交/.test(section);
      const conditional=reference||!!awardStage||/如有授权|仅当|如适用/.test(section.slice(0,300));
      const composition={number:row.number,mandatory,conditional,note:reference?'采购格式注明仅供参考':awardStage?'采购文件注明成交后提交':'采购文件响应格式章节',formatSection:true,startIndex:row.index,endIndex:next};
      const old=existing.find(r=>r.fileId===doc.id&&(r.locator?.paraIndex===row.index||norm(r.quote).startsWith(norm(row.quote))));
      if(old){old.composition=composition;old.reviewScope='audit';continue;}
      const para=paragraphs[row.index];
      output.push({stableId:requirementStableId({quote:row.quote,title:row.title}),title:row.title,type:'material',typeLabel:'组成材料',quote:row.quote,
        source:`响应文件格式第${row.number}项`,consequence:'',mark:'',score:null,checkpoints:[],requiredMaterials:[],fileId:doc.id,fileName:doc.name,
        locator:{paraIndex:row.index,page:para.page||null,label:para.page?`第 ${para.page} 页`:`段落 ${row.index+1}`},owner:'',status:'pending',statusLabel:'待确认',locked:false,
        origin:'composition',reviewScope:'audit',composition,createdAt:new Date().toLocaleString('zh-CN',{hour12:false})});
    }
    break;
  }
  return output;
}

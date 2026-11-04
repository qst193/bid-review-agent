// 从采购正文提取带来源的项目信息建议；由负责人校对后写入项目。
const patterns = {
  name: /(?:采购)?项目名称\s*[：:]\s*([^，。；\n]{3,100})/,
  code: /(?:项目编号|采购编号|招标编号)\s*[：:]\s*([A-Za-z0-9_\-/]{4,60})/,
  purchaser: /(?:采购人|招标人|采购单位|遴选人)\s*[：:]\s*([^，。；\n]{2,80})/,
  bidDeadline: /(?:投标截止时间|提交投标文件截止时间|递交投标文件截止时间|投标截止)\s*[：:]?\s*(\d{4}[年\-/.]\d{1,2}[月\-/.]\d{1,2}日?(?:\s*(?:上午|下午)?\s*\d{1,2}[时:]\d{0,2}分?)?)/,
};
const nextLabel = /(?:项目编号|采购编号|招标编号|采购人|招标人|采购单位|投标截止|预算金额|采购预算)/;

export function extractProcurementInfo(docs) {
  const suggestions = {};
  for (const doc of docs) {
    for (const [index, paragraph] of (doc.parsed?.paragraphs || []).entries()) {
      const text = String(paragraph.text || '').trim();
      if (!text || text.length > 500) continue;
      for (const [field, re] of Object.entries(patterns)) {
        if (suggestions[field]) continue;
        const match = text.match(re);
        if (!match) continue;
        const value = field === 'name' || field === 'purchaser' ? match[1].split(nextLabel)[0].trim() : match[1].trim();
        if (value.length < 2) continue;
        if (field === 'purchaser' && /^(?:指|是指|系指|依法|本项目|填写|单位名称|（)/.test(value)) continue;
        suggestions[field] = {value, fileId:doc.id, fileName:doc.name, locator:paragraph.page ? `第 ${paragraph.page} 页` : `段落 ${index+1}`, quote:text.slice(0,240)};
      }
    }
  }
  return suggestions;
}

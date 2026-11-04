// 报告导出：综合审核报告(Word)、问题清单(CSV)、交标前检查清单(Word)、未关闭风险清单(CSV)。
// 零依赖，用自带 zip 生成 OOXML。
import {writeZip} from './parsers/zip.mjs';
import {ITEM_RISK, ITEM_STATUS, CHECK_STATUS, CHECKS} from './engine/domain.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

function runXml(text, {bold = false, color = null, size = 22} = {}) {
  const props = [];
  if (bold) props.push('<w:b/>');
  if (color) props.push(`<w:color w:val="${color}"/>`);
  props.push(`<w:sz w:val="${size}"/>`);
  return `<w:r><w:rPr>${props.join('')}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, opts = {}) {
  const align = opts.align ? `<w:jc w:val="${opts.align}"/>` : '';
  const spacing = opts.after != null ? `<w:spacing w:after="${opts.after}"/>` : '';
  const ind = opts.indent ? '<w:ind w:left="360"/>' : '';
  return `<w:p><w:pPr>${align}${spacing}${ind}</w:pPr>${runXml(text, opts)}</w:p>`;
}

function heading(text, level = 1) {
  const sizes = {0: 36, 1: 30, 2: 25, 3: 23};
  return para(text, {bold: true, size: sizes[level] ?? 23, after: 120})
    .replace('<w:pPr>', '<w:pPr><w:spacing w:before="200" w:after="120"/>');
}

function tableXml(headers, rows) {
  const colW = Math.floor(9000 / Math.max(1, headers.length));
  const grid = `<w:tblGrid>${headers.map(() => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`;
  const headerRow = `<w:tr>${headers.map((h) => cell(h, {bold: true, shade: 'EDF2FA'})).join('')}</w:tr>`;
  const bodyRows = rows.map((r) => `<w:tr>${r.map((c) => cell(c)).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:color="CCCCCC"/><w:insideV w:val="single" w:sz="4" w:color="CCCCCC"/></w:tblBorders></w:tblPr>${grid}${headerRow}${bodyRows}</w:tbl>`;
}

function cell(text, {bold = false, shade = null} = {}) {
  const shd = shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : '';
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shd}</w:tcPr><w:p><w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">${esc(String(text ?? ''))}</w:t></w:r></w:p></w:tc>`;
}

export function buildDocx(blocks, {title = '文档'} = {}) {
  const body = blocks.join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const now = new Date().toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>标盾 AI</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;
  return writeZip([
    {name: '[Content_Types].xml', data: contentTypes},
    {name: '_rels/.rels', data: rels},
    {name: 'word/document.xml', data: documentXml},
    {name: 'word/_rels/document.xml.rels', data: docRels},
    {name: 'docProps/core.xml', data: core},
  ]);
}

const riskLabel = (r) => ITEM_RISK[r]?.label || r;
const statusLabel = (s) => ITEM_STATUS[s]?.label || s;
const checkStatusLabel = (s) => CHECK_STATUS[s]?.label || s;

/** 综合审核报告。 */
export function reportToDocx(project) {
  const B = [];
  const audit = project.audit || {};
  const items = audit.items || [];
  const cov = audit.coverage || {};
  B.push(para('标盾 AI · 标书审核报告', {bold: true, size: 42, align: 'center', after: 160}));
  B.push(para(project.name, {size: 26, align: 'center', color: '555555', after: 60}));
  B.push(para(`版本 ${audit.version || project.currentVersion} · 生成 ${new Date().toLocaleString('zh-CN', {hour12: false})}`, {size: 19, align: 'center', color: '888888', after: 200}));
  B.push(para('本报告为 AI 辅助内审意见，不代替正式评审结论。未读取的内容显示为未覆盖或待人工核实；未发现问题不代表完全符合送审要求。', {size: 18, color: 'B45F06', after: 220}));

  B.push(heading('一、审核覆盖范围', 1));
  const fileRate = cov.files?.fileRate ?? 0;
  const reqRate = cov.requirements?.rate ?? 0;
  B.push(tableXml(['项目', '情况'], [
    ['文件可读率', `${fileRate}%`],
    ['采购文件', `${cov.files?.procurement?.parsed || 0}/${cov.files?.procurement?.total || 0} 份可读（含补遗 ${cov.files?.procurement?.supplements || 0} 份）`],
    ['投标文件', `${cov.files?.bid?.parsed || 0}/${cov.files?.bid?.total || 0} 份可读`],
    ['要求台账', `已确认 ${cov.requirements?.confirmed || 0} 条 / 共 ${cov.requirements?.total || 0} 条`],
    ['要求覆盖率', `${reqRate}%（已核查结论占比）`],
  ]));
  const unread = [...(cov.files?.procurement?.unreadable || []), ...(cov.files?.bid?.unreadable || [])];
  if (unread.length) {
    B.push(para(`未解析文件（需人工确认）：${unread.map((d) => d.name).join('、')}`, {size: 18, color: 'C00000', after: 120}));
  }

  B.push(heading('二、问题概览', 1));
  const open = items.filter((it) => !['closed', 'dismissed'].includes(it.status));
  const byRisk = {critical: 0, high: 0, mid: 0, low: 0};
  for (const it of open) byRisk[it.risk]++;
  B.push(tableXml(['风险级别', '数量'], [
    ['致命风险', String(byRisk.critical)],
    ['高风险', String(byRisk.high)],
    ['中风险', String(byRisk.mid)],
    ['提示', String(byRisk.low)],
    ['合计（未关闭）', String(open.length)],
  ]));

  B.push(heading('三、问题明细', 1));
  for (const ck of Object.keys(CHECKS)) {
    const list = open.filter((it) => it.check === ck);
    if (!list.length) continue;
    B.push(heading(`${CHECKS[ck].label}（${list.length}）`, 2));
    for (const it of list) {
      B.push(para(`• ${it.title}`, {bold: true, size: 21, after: 40}));
      B.push(para(`  风险：${riskLabel(it.risk)}｜状态：${statusLabel(it.status)}｜结论：${checkStatusLabel(it.checkStatus)}${it.entityName ? '｜主体：' + it.entityName : ''}`, {size: 17, color: '666666'}));
      if (it.requirement?.quote) B.push(para(`  招标要求：${it.requirement.quote}`, {size: 17, indent: true}));
      if (it.evidence?.[0]?.quote) B.push(para(`  投标证据（${it.evidence[0].locator?.label || ''}）：${it.evidence[0].quote}`, {size: 17, indent: true}));
      if (it.gap) B.push(para(`  具体缺口：${it.gap}`, {size: 17, indent: true, color: 'C00000'}));
      if (it.action) B.push(para(`  修改动作：${it.action}`, {size: 17, indent: true, color: '245CE5'}));
      if (it.cannotInvent?.length) B.push(para(`  不可编造：${it.cannotInvent.join('、')}`, {size: 17, indent: true, color: 'C00000'}));
      B.push(para('', {after: 30}));
    }
  }

  B.push(heading('四、待人工确认事项', 1));
  const manual = open.filter((it) => it.checkStatus === 'unknown' || it.checkStatus === 'uncovered');
  if (!manual.length) B.push(para('无', {size: 18}));
  else B.push(tableXml(['编号', '事项', '说明'], manual.map((it, i) => [`人工${i + 1}`, it.title, it.gap || it.action || '需人工核实'])));
  return buildDocx(B, {title: project.name + ' 审核报告'});
}

/** 问题清单 CSV。 */
export function checklistToCsv(project) {
  const items = project.audit?.items || [];
  const header = ['风险', '检查类别', '问题', '投标主体', '核对结论', '状态', '负责人', '截止', '招标要求', '投标证据', '具体缺口', '修改动作', '不可编造'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = items.map((it) => [
    riskLabel(it.risk), it.checkLabel || '', it.title, it.entityName || '',
    checkStatusLabel(it.checkStatus), statusLabel(it.status), it.assignee || '', it.due || '',
    it.requirement?.quote || '', it.evidence?.map((e) => e.quote).join(' ⏎ ') || '',
    it.gap || '', it.action || '', (it.cannotInvent || []).join('、'),
  ]);
  return '\uFEFF' + [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

/** 交标前检查清单 Word。 */
export function releaseToDocx(project, release) {
  const B = [];
  B.push(para('标盾 AI · 交标前检查清单', {bold: true, size: 40, align: 'center', after: 140}));
  B.push(para(project.name, {size: 24, align: 'center', color: '555555', after: 60}));
  B.push(para(`版本 ${project.currentVersion} · 生成 ${new Date().toLocaleString('zh-CN', {hour12: false})}`, {size: 18, align: 'center', color: '888888', after: 200}));
  B.push(para(release.canRelease ? '结论：全部硬门槛通过，可进入放行确认。' : `结论：尚有 ${release.blocking.length} 项硬门槛未通过，不可放行。`, {bold: true, size: 22, color: release.canRelease ? '2F8A5B' : 'C00000', after: 200}));
  B.push(heading('一、放行检查清单', 1));
  B.push(tableXml(['检查项', '结果', '说明'], release.gates.map((g) => [g.label, g.ok ? '通过' : (g.blocking ? '未通过' : '需知情'), g.detail])));
  const risks = release.risks || [];
  B.push(heading('二、未关闭风险清单', 1));
  if (!risks.length) B.push(para('无未关闭的中高风险问题。', {size: 18}));
  else B.push(tableXml(['风险', '问题', '主体', '具体缺口', '修改动作', '负责人'], risks.map((r) => [r.riskLabel, r.title, r.entityName || '', r.gap, r.action, r.assignee || '未分派'])));
  return buildDocx(B, {title: project.name + ' 交标前检查清单'});
}

export function openRiskToCsv(project, risks) {
  const header = ['风险', '问题', '检查类别', '投标主体', '招标要求', '投标证据', '具体缺口', '修改动作', '状态', '负责人'];
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = risks.map((r) => [r.riskLabel, r.title, r.checkLabel || '', r.entityName || '', r.requirement, r.evidence, r.gap, r.action, r.status, r.assignee || '']);
  return '\uFEFF' + [header, ...rows].map((row) => row.map(q).join(',')).join('\r\n');
}

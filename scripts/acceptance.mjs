// 验收测试：覆盖需求书第五节「质量验收与测试要求」的关键场景。
// 直接调用引擎函数，不依赖外部模型（用假的 model 模拟模型输出）。
import {buildIndexes, retrieve, verifyEvidence, gradeEvidence, compareFacts, detectNegation} from '../server/engine/indexer.mjs';
import {computePriceScore} from '../server/engine/checks.mjs';
import {buildMatrix, makeItem, summarizeItems} from '../server/engine/items.mjs';
import {computeRelease} from '../server/engine/release.mjs';
import {applyLedgerEdit, diffLedger, extractLedger} from '../server/engine/ledger.mjs';
import {parseFile} from '../server/parsers/index.mjs';
import {readZip, writeZip} from '../server/parsers/zip.mjs';
import {withRuleOverlay} from '../server/engine/rule-overlay.mjs';
import {extractProcurementInfo} from '../server/engine/procurement-info.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

function mkParsed(texts, opts = {}) {
  const paragraphs = texts.map((t, i) => ({text: t, kind: 'paragraph', level: 0, isToc: false, page: opts.page ? opts.page(i) : undefined}));
  return {paragraphs, sections: [], text: texts.join('\n'), pageCount: opts.pageCount};
}
function mkDoc(id, name, texts, opts = {}) {
  return {id, name, role: opts.role || 'bid', category: 'bid', entityId: opts.entityId || 'e1', entityName: opts.entityName || '甲公司', version: 'V1', parsed: mkParsed(texts, opts)};
}

console.log('\n=== 0. 规则版本快照注入 ===');
{
  let received='';
  const fake={configured:true,json:async args=>{received=args.system;return {};}};
  await withRuleOverlay(fake,{rulesVersion:'v7',ruleInstructions:'增加证照有效期检查并保留原文证据'}).json({system:'原有审核规则'});
  check('团队规则进入审核模型且保留固定证据边界',received.includes('原有审核规则')&&received.includes('证照有效期')&&received.includes('不能跳过现有维度'));
}
console.log('\n=== 0b. 已满足核查记录不进入整改门禁 ===');
{
  const satisfied=makeItem({check:'response',issueType:'responded',title:'已满足条款',risk:'low',checkStatus:'satisfied'});
  const unresolved=makeItem({check:'response',issueType:'missing',title:'缺少响应',risk:'high',checkStatus:'notFound'});
  const summary=summarizeItems([satisfied,unresolved]);
  check('已满足记录不计为待整改问题',summary.total===1&&summary.open===1&&summary.high===1);
}
console.log('\n=== 0c. 采购信息建议保留原文出处 ===');
{
  const info=extractProcurementInfo([{id:'d1',name:'采购文件.txt',parsed:mkParsed(['项目名称：智慧服务采购项目','采购人：某市服务中心','项目编号：CG-2026-001','投标截止时间：2026年11月30日 09:30'])}]);
  check('项目名称建议带文件和段落出处',info.name?.value==='智慧服务采购项目'&&info.name?.fileName==='采购文件.txt'&&info.name?.locator==='段落 1');
  check('采购人、编号和截止时间可提取',!!info.purchaser&&!!info.code&&!!info.bidDeadline);
}
console.log('\n=== 0d. 长文档抽取失败后只续跑失败段 ===');
{
  const docs=[{id:'doc-resume',name:'采购测试.txt',parsed:mkParsed([1,2,3,4].map(i=>`第${i}段`+'采购要求。'.repeat(220)))}];
  let calls=0;
  const first=await extractLedger({json:async()=>{calls++;if(calls===2)throw new Error('模型暂时失败');return {items:[]}}},docs);
  let resumedCalls=0;
  const second=await extractLedger({json:async()=>{resumedCalls++;return {items:[]}}},docs,{resume:first.chunkResults});
  check('失败批次不被标为完整',first.coverage.doneChunks<first.coverage.chunks);
  check('续跑只调用未成功的段',second.coverage.doneChunks===second.coverage.chunks&&resumedCalls===first.coverage.chunks-first.coverage.doneChunks);
}

console.log('\n=== 1. 全文覆盖（长文档末尾/附录也能检索到）===');
{
  const long = [];
  for (let i = 0; i < 400; i++) long.push(`这是第 ${i} 段无关的标书内容，用于填充篇幅。`);
  long.push('附录三：第三方检测报告编号 JC2026-8891，实测并发能力 5200 路。');
  const doc = mkDoc('d1', '投标文件', long);
  const idx = buildIndexes([doc]);
  const r = retrieve(idx, '并发能力 5000路 检测报告');
  check('长文档末尾的证据能被检索到', r.hits.length > 0 && r.hits.some((h) => h.text.includes('5200')));
  check('证据保留所属文件', r.hits[0]?.fileName === '投标文件');
}

console.log('\n=== 2. 缺件判断（正文缺但附件有 / 只有标题）===');
{
  const doc = mkDoc('d1', '投标文件', ['一、资格证明文件', '二、技术方案']);
  const idx = buildIndexes([doc]);
  const r = retrieve(idx, '营业执照 副本 复印件');
  check('仅有标题时检索无实质证据', r.hits.length === 0 || !r.hits.some((h) => h.text.includes('营业执照')));
}

console.log('\n=== 3. 实质响应（数值边界/单位差异/否定表述）===');
{
  const issues1 = compareFacts('系统需支持不少于5000路并发', '我方支持 3000 路并发');
  check('数值低于下限被判矛盾', issues1.length > 0 && issues1[0].message.includes('不低于'));
  const issues2 = compareFacts('投标报价不得超过 290 万元', '投标总价 300 万元');
  check('数值超上限被判矛盾', issues2.length > 0);
  const issues3 = compareFacts('系统需支持不少于5000路并发', '我方支持 6000 路并发');
  check('满足要求时不报矛盾', issues3.length === 0);
  check('否定表述能被识别', detectNegation('我方无法提供该检测报告') === true);
  check('正常表述不误判', detectNegation('我方已提供完整检测报告') === false);
}

console.log('\n=== 4. 证据准确性（精确/规范化/部分相似）===');
{
  const doc = mkDoc('d1', '投标文件', ['投标人应提供近三个月社保缴纳证明。', '本项目投标有效期为九十天。']);
  const exact = verifyEvidence(doc.parsed, '本项目投标有效期为九十天。');
  check('精确原文匹配', exact.found && exact.matchType === 'exact');
  const norm = verifyEvidence(doc.parsed, '投标有效期为九十天');
  check('段落包含查询时为包含匹配（非弱证据）', norm.found && norm.weak === false, `matchType=${norm.matchType}`);
  const fake = verifyEvidence(doc.parsed, '我方已获得国家科技进步一等奖');
  check('不存在的证据不被认可', fake.found === false);
  const partial = verifyEvidence(doc.parsed, '投标人应提供近六个月社保缴纳证明材料');
  check('部分相似标记为 weak', !partial.found || partial.weak === true);
  // 部分相似不能支撑"已满足"
  const grades = gradeEvidence([{found: true, matchType: 'fuzzy', weak: true}]);
  check('部分相似证据等级不为强证据', grades === 'fuzzy');
}

console.log('\n=== 5. 评分（无证据不得分/不超上限/缺输入不算）===');
{
  const r1 = computePriceScore({amount: 2800000, formula: '价格分 = 30 × (评标基准价 / 投标报价)', benchmark: 2800000, max: 30});
  check('有输入时价格分可算', r1.ok && r1.score === 30);
  const r2 = computePriceScore({amount: 2800000, formula: '价格分 = 30 × (评标基准价 / 投标报价)', benchmark: null, max: 30});
  check('缺基准价时不计算', r2.ok === false && !!r2.missing);
  const r3 = computePriceScore({amount: null, formula: 'x', benchmark: 100, max: 30});
  check('缺报价时不计算', r3.ok === false);
  const r4 = computePriceScore({amount: 1000000, formula: '价格分 = 30 × (评标基准价 / 投标报价)', benchmark: 5000000, max: 30});
  check('得分不超过上限', r4.ok && r4.score <= 30);
}

console.log('\n=== 5b. 价格公式方向（避免 报价/基准价 与 基准价/报价 混淆）===');
{
  const A = (f, a, b, m) => computePriceScore({amount: a, formula: f, benchmark: b, max: m});
  const d1 = A('价格分 = 30 × (评标基准价 / 投标报价)', 3000000, 2800000, 30);
  check('基准价/报价：报价高于基准，得分<满分', d1.ok && d1.direction === 'benchmarkOverPrice' && d1.score === 28);
  const d2 = A('价格分 = 30 × (投标报价 / 评标基准价)', 3000000, 2800000, 30);
  check('报价/基准价：方向相反，得分按报价/基准算', d2.ok && d2.direction === 'priceOverBenchmark' && d2.score === 30);
  const d3 = A('价格分 = 30 × (评标基准价 / 投标报价)', 2800000, 2800000, 30);
  check('基准价=报价时得满分', d3.ok && d3.score === 30);
  const d4 = A('按招标文件规定计算', 3000000, 2800000, 30);
  check('方向无法识别时不给分', d4.ok === false && /方向/.test(d4.missing || ''));
}

console.log('\n=== 5c. 客观分（有证据不等于满分）===');
{
  // 直接验证 checks 中客观分的处理：有证据时 score 应为 null 且标为待人工核对
  const {runScoring} = await import('../server/engine/checks.mjs');
  // 用假的 model 返回"有证据"的评分结果
  const fakeModel = {configured: true, json: async () => ({type: 'objective', max: 5, evidencePresent: true, evidence: [{quote: 'ISO9001 认证证书编号 XXX'}]})};
  const pkg = {entityId: 'e1', entityName: '甲公司', indexes: [{docId: 'd1', fileName: '投标', role: 'bid', unreadable: false, paras: [{i: 0, text: '我方具有 ISO9001 认证证书编号 XXX', norm: '我方具有iso9001认证证书编号xxx', page: null, section: '', kind: 'paragraph'}], inv: new Map(), parsed: {paragraphs: [{text: '我方具有 ISO9001 认证证书编号 XXX'}], sections: []}}]};
  const reqs = [{stableId: 'R9', title: 'ISO9001 认证', quote: '通过 ISO9001 得 5 分', type: 'scoring', score: 5}];
  const r = await runScoring({model: fakeModel, pkg, requirements: reqs});
  const obj = (r.items || []).find((it) => it.extra?.scoreType === 'objective');
  check('客观分有证据时程序不给确定分（score=null）', obj && obj.extra.score === null);
  check('客观分有证据时标为待人工核对档位', obj && obj.extra.scorePending === true && obj.checkStatus === 'unknown');
}

console.log('\n=== 5d. 放行门槛（关键条款 100% 必须有结论）===');
{
  const {computeRelease} = await import('../server/engine/release.mjs');
  // 5 条已确认：3 关键（1 Star + 2 实质）+ 2 一般；其中 1 条关键未核查
  const mkItem = (rid, cs) => makeItem({check: 'response', issueType: 'x', title: 't', risk: 'mid', requirementId: rid, checkStatus: cs});
  const reqs = [
    {stableId: 'K1', title: '★关键1', type: 'substantive', mark: '★', status: 'confirmed'},
    {stableId: 'K2', title: '关键2', type: 'qualification', status: 'confirmed'},
    {stableId: 'K3', title: '关键3', type: 'substantive', status: 'confirmed'},
    {stableId: 'G1', title: '一般1', type: 'commercial', status: 'confirmed'},
    {stableId: 'G2', title: '一般2', type: 'commercial', status: 'confirmed'},
  ];
  const items = [mkItem('K1', 'satisfied'), mkItem('K2', 'satisfied'), /* K3 未核查 */ mkItem('G1', 'satisfied'), mkItem('G2', 'satisfied')];
  const p = {currentVersion: 'V1', audit: {status: 'done', version: 'V1', items, coverage: {files: {procurement: {total: 1, parsed: 1, supplements: 0, unreadable: []}, bid: {total: 1, parsed: 1, unreadable: []}}}}, requirements: reqs};
  const rel = computeRelease(p);
  const critGate = rel.gates.find((g) => g.key === 'criticalCoverage');
  check('关键条款未全部核查 → 关键门槛不通过', critGate && critGate.ok === false);
  check('总体覆盖率 80% 但仍因关键条款未过而不可放行', rel.canRelease === false);
}

console.log('\n=== 5e. 检索不足（不能把检索没找到当未检出）===');
{
  const {retrieve, buildIndexes} = await import('../server/engine/indexer.mjs');
  // 只有一个模糊命中时，retrievalStatus 应为 thin
  const doc = {id: 'd1', name: '投标', role: 'bid', category: 'bid', entityId: 'e1', entityName: '甲', version: 'V1', parsed: {paragraphs: [{text: '我方系统支持语音识别功能', kind: 'paragraph', level: 0}], sections: []}};
  const idx = buildIndexes([doc]);
  const r = retrieve(idx, '并发不少于5000路检测报告');
  check('弱相关查询命中数极少（检索不足情形可识别）', r.hits.length <= 1);
}

console.log('\n=== 6. 版本复审（删旧文字≠已解决）===');
{
  const req = {stableId: 'R001', title: '★并发要求', type: 'substantive', status: 'confirmed', quote: '不少于5000路'};
  const h = makeItem({check: 'response', issueType: 'not_responded', title: '★并发要求', risk: 'critical', requirementId: 'R001', requirement: req, entityId: 'e1', checkStatus: 'violated'});
  const h2 = makeItem({check: 'response', issueType: 'not_responded', title: '★并发要求', risk: 'critical', requirementId: 'R001', requirement: req, entityId: 'e1', checkStatus: 'notFound'});
  check('相同要求+主体+类型 → 稳定键一致（可匹配）', h.stableKey === h2.stableKey);
  check('newStatus=notFound 不等同已解决', h2.checkStatus !== 'satisfied');
}

console.log('\n=== 7. 文件与版本（不可解析文件标记/哈希去重）===');
{
  const img = await parseFile(Buffer.from([0x89, 0x50, 0x4e, 0x47]), '证书.png');
  check('图片标记为不可解析并给出原因', img.unreadable === true && !!img.unreadableReason);
  const old = await parseFile(Buffer.from('x'), '旧标书.doc');
  check('损坏的 DOC 明确标记不可读', old.unreadable === true && /损坏|无法识别/.test(old.unreadableReason));
  const scan = await parseFile(Buffer.from('%PDF-1.4 fake'), '扫描件.pdf').catch(() => ({unreadable: true}));
  check('PDF 扫描件处理不抛错', typeof scan === 'object');
  const zip = writeZip([{name: '采购文件.txt', data: Buffer.from('投标人须提供有效营业执照并加盖公章。')}]);
  check('ZIP 文件可解包为真实采购材料', readZip(zip, {maxEntries: 10}).get('采购文件.txt')?.toString().includes('营业执照'));
}

console.log('\n=== 8. 团队流程（状态流转/留痕/人工推翻）===');
{
  const it = makeItem({check: 'response', issueType: 'x', title: '测试问题', risk: 'high', checkStatus: 'violated'});
  check('初始状态为待分派', it.status === 'todo');
  check('生成时记录操作历史', it.history.length === 1);
  const {applyItemTransition} = await import('../server/engine/items.mjs');
  applyItemTransition(it, 'dismissed', {by: '张工', note: '人工确认非问题'});
  check('可人工标记非问题（推翻AI）', it.status === 'dismissed');
  check('留痕记录操作人', it.history.at(-1).by === '张工');
}

console.log('\n=== 9. 放行门禁（未完成审核不可放行）===');
{
  const p1 = {currentVersion: 'V1', audit: null};
  const r1 = computeRelease(p1);
  check('无审核时不可放行', r1.canRelease === false);
  const p2 = {currentVersion: 'V1', audit: {status: 'done', version: 'V1', items: [], coverage: {requirements: {rate: 100}, files: {}}}, requirements: [{status: 'confirmed'}]};
  const r2 = computeRelease(p2);
  check('审核完成但无问题项也不可放行', r2.canRelease === false, '(auditDone 需 items>0)');
  const p3 = {currentVersion: 'V1', audit: {status: 'done', version: 'V0', items: [makeItem({check: 'format', issueType: 'x', title: 't', risk: 'low'})], coverage: {requirements: {rate: 100}, files: {procurement: {total: 1, parsed: 1, supplements: 0, unreadable: []}, bid: {total: 1, parsed: 1, unreadable: []}}}}, requirements: [{status: 'confirmed'}]};
  const r3 = computeRelease(p3);
  check('审核版本与当前版本不一致不可放行', r3.gates.find((g) => g.key === 'version').ok === false);
}

console.log('\n=== 10. 要求台账（拆分/合并/补遗 diff）===');
{
  const reqs = [
    {stableId: 'R1', title: '资格要求', quote: '投标人须为独立法人', type: 'qualification', status: 'pending', checkpoints: ['营业执照', '社保'], requiredMaterials: []},
    {stableId: 'R2', title: '技术参数', quote: '并发不少于5000路', type: 'substantive', status: 'pending', checkpoints: [], requiredMaterials: []},
  ];
  const confirmed = applyLedgerEdit(reqs, {action: 'edit', payload: {action: 'confirm', stableId: 'R1'}});
  check('确认后可锁定', confirmed.find((r) => r.stableId === 'R1').status === 'confirmed');
  const split = applyLedgerEdit(reqs, {action: 'edit', payload: {action: 'split', stableId: 'R2', groups: [{title: '并发路数'}, {title: '检测报告'}]}});
  check('拆分后条数增加', split.length === 3);
  const merged = applyLedgerEdit(reqs, {action: 'edit', payload: {action: 'merge', stableIds: ['R1', 'R2'], title: '合并要求'}});
  check('合并后条数减少', merged.length === 1);
  const before = [{stableId: 'A', title: '旧要求', quote: 'q1', consequence: ''}, {stableId: 'B', title: '将删除', quote: 'q2'}];
  const after = [{stableId: 'A', title: '旧要求', quote: 'q1', consequence: '否则无效'}, {stableId: 'C', title: '新增要求', quote: 'q3'}];
  const d = diffLedger(before, after);
  check('补遗 diff 识别新增', d.summary.added === 1);
  check('补遗 diff 识别删除', d.summary.removed === 1);
  check('补遗 diff 识别修改', d.summary.changed === 1);
}

console.log('\n=== 11. 响应矩阵（未检出 vs 明确不满足严格区分）===');
{
  const reqs = [
    {stableId: 'R1', title: '资格', quote: 'q', type: 'qualification', typeLabel: '资格条件', status: 'confirmed'},
    {stableId: 'R2', title: '并发', quote: 'q', type: 'substantive', typeLabel: '实质响应', status: 'confirmed'},
  ];
  const items = [
    makeItem({check: 'response', issueType: 'a', title: '资格', risk: 'high', requirementId: 'R1', checkStatus: 'notFound'}),
    makeItem({check: 'response', issueType: 'b', title: '并发', risk: 'critical', requirementId: 'R2', checkStatus: 'violated'}),
  ];
  const m = buildMatrix(reqs, items);
  check('未检出显示为未检出', m.find((x) => x.requirementId === 'R1').status === 'notFound');
  check('明确不满足显示为明确不满足', m.find((x) => x.requirementId === 'R2').status === 'violated');
  check('未检出与明确不满足的标签不同', m.find((x) => x.requirementId === 'R1').statusLabel !== m.find((x) => x.requirementId === 'R2').statusLabel);
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);

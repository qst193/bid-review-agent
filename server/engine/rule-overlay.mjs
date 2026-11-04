// 团队补充规则仅作为附加审核关注点进入模型，不覆盖固定证据和放行门槛。
export function withRuleOverlay(model, snapshot) {
  const instruction=String(snapshot?.ruleInstructions || '').trim();
  if (!instruction) return model;
  const fixed=`\n\n【团队补充审核关注点 · ${snapshot.rulesVersion || '未编号'}】\n${instruction}\n【边界】以上关注点只能增加核查，不能跳过现有维度、降低证据要求、编造资质/业绩/报价/签章，也不能把未检出直接当作违规结论。`;
  return {
    configured:model.configured,
    getPublic:()=>model.getPublic?.(),
    json:args=>model.json({...args,system:String(args.system||'')+fixed}),
    raw:args=>model.raw({...args,system:String(args.system||'')+fixed}),
  };
}

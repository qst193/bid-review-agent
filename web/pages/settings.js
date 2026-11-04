// 设置：模型接入、审核规则说明、系统信息。
import {esc, state, api, toast, fmt} from '../lib.js';

export function renderSettings() {
  const m = state.meta?.model || {};
  const stats = state.meta?.stats || {};
  return `
  <div class="page-head"><div class="grow"><h1>设置</h1><div class="sub">模型接入、审核规则说明与系统信息。</div></div></div>
  <div class="grid-2">
    <div class="card pad">
      <div class="rowflex" style="justify-content:space-between"><h2>模型接入</h2><span class="pill ${m.configured ? 'ok' : 'warn'}"><span class="dot"></span>${m.configured ? '已配置' : '未配置'}</span></div>
      <div class="small muted" style="margin:6px 0 4px">模型通过公司 AI 平台调用，密钥仅保存在本机服务端。</div>
      <label class="field">模型接口地址（以 /v1 结尾）</label><input class="in" id="mBase" value="${esc(m.baseUrl || '')}" placeholder="https://model.indata.cc/v1">
      <label class="field">模型名称</label><input class="in" id="mName" value="${esc(m.name || '')}" placeholder="glm-5.3-flash">
      <label class="field">API 密钥</label><input class="in" id="mKey" type="password" placeholder="sk-…（留空表示不修改）">
      <div class="rowflex" style="margin-top:16px"><button class="btn primary" id="saveModel">保存并测试</button><button class="btn" id="testModel">仅测试</button><span class="small muted" id="modelStatus"></span></div>
    </div>
    <div class="card pad">
      <h2>系统信息</h2>
      <table class="tbl" style="margin-top:10px"><tbody>
        <tr><td class="small muted">数据存储</td><td class="small">${stats.count ?? '—'} 个文件 · ${fmt.size(stats.bytes || 0)}</td></tr>
        <tr><td class="small muted">审核检查</td><td class="small">完整性 / 资格与实质响应 / 评分点 / 全书一致性 / 格式交付 / 多主体互查</td></tr>
        <tr><td class="small muted">项目数量</td><td class="small">${state.projects.length} 个</td></tr>
        <tr><td class="small muted">运行方式</td><td class="small">本地 Web 服务（127.0.0.1 仅本机）</td></tr>
      </tbody></table>
      <div class="notice neutral small" style="margin-top:14px">所有审核结论绑定真实原文证据；无法定位时标注「无法确认/未覆盖」，不编造页码或结论。</div>
    </div>
  </div>
  <div class="card pad" style="margin-top:16px">
    <h2>审核规则说明</h2>
    <div class="grid-2" style="margin-top:12px;gap:20px">
      ${rule('完整性检查', '从招标文件要求台账提取组成材料/资格条件，在投标包全文跨文件检索对应材料。', '已满足 / 部分满足 / 未检出 / 无法确认 / 未覆盖')}
      ${rule('资格与实质响应', '资格条件、否决项、★▲条款、技术参数、商务条件逐条核查；数值与日期做确定性比对。', '已满足 / 部分满足 / 明确不满足 / 未检出')}
      ${rule('评分点检查', '客观分识别证据、价格分按公式由程序计算（缺输入不计算）、主观分只给分析维度。', '客观分证据 / 价格公式输入 / 主观待评估')}
      ${rule('全书一致性', '名称、型号、数量、交期、质保、报价、偏离表与正文矛盾，优先确定性程序核查。', '不一致明细 + 需核实线索')}
      ${rule('格式与交付', '文件命名、签字盖章、目录、附件索引、指定格式、必要声明。', '符合 / 缺项 / 需人工确认')}
      ${rule('多主体互查', '不同投标主体的名称残留、图片指纹、长文相似等，只呈现需核实线索，不作违规认定。', '需核实的关联线索')}
    </div>
    <div class="notice warn" style="margin-top:16px"><span>⚠️</span><div>通用规则服从具体采购文件；★▲含义、资格条件、评分办法与格式以采购文件原文为准。缺其他投标人报价时不虚构价格分。</div></div>
  </div>`;
}

function rule(title, desc, output) {
  return `<div style="border-left:2px solid var(--brand);padding-left:14px"><b>${title}</b><div class="small muted" style="margin:6px 0">${desc}</div><div class="small" style="color:var(--ink-2)">输出：${output}</div></div>`;
}

export function bindSettings() {
  document.getElementById('testModel')?.addEventListener('click', async () => {
    const st = document.getElementById('modelStatus'); st.textContent = '测试中…';
    try { const r = await api('/api/model/test', {method: 'POST'}); st.textContent = r.connected ? `连接成功（${r.model}）` : `失败：${r.error}`; st.style.color = r.connected ? 'var(--ok)' : 'var(--danger)'; }
    catch (e) { st.textContent = e.message; st.style.color = 'var(--danger)'; }
  });
  document.getElementById('saveModel')?.addEventListener('click', async () => {
    const body = {MODEL_BASE_URL: document.getElementById('mBase').value.trim(), MODEL_NAME: document.getElementById('mName').value.trim()};
    const key = document.getElementById('mKey').value.trim(); if (key) body.MODEL_API_KEY = key;
    try {
      const r = await api('/api/settings', {method: 'POST', body});
      state.meta.model = r.model;
      const st = document.getElementById('modelStatus'); st.textContent = '已保存，测试中…';
      const t = await api('/api/model/test', {method: 'POST'});
      st.textContent = t.connected ? `已保存，连接成功（${t.model}）` : `已保存，但失败：${t.error}`;
      st.style.color = t.connected ? 'var(--ok)' : 'var(--danger)';
      toast('模型配置已更新', 'ok');
      window.__bdRender?.();
    } catch (e) { toast(e.message, 'error'); }
  });
}

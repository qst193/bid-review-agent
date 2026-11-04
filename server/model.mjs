// OpenAI 兼容模型客户端：默认流式（SSE）累积输出，避免长输出被网关 504 截断；
// 支持重试、JSON 修复、可选引用校验回调。
import {log} from './util/log.mjs';

export class ModelClient {
  constructor({baseUrl, apiKey, model, name, timeoutMs = 300000, maxRetries = 2}) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
    this.apiKey = apiKey;
    this.model = model || name;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.quotaError = null;
  }

  get configured() {
    return !!(this.apiKey && this.model && this.baseUrl && this.baseUrl !== '/chat/completions');
  }

  getPublic() {
    return {name: this.model, baseUrl: this.baseUrl.replace(/\/chat\/completions$/, ''), configured: this.configured};
  }

  async raw({system, user, maxTokens = 8000, temperature = 0}) {
    if (!this.configured) throw new Error('模型接口未配置，请在设置页或 .env 填写 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME');
    if (this.quotaError && Date.now() < this.quotaError.until) throw this.quotaError.error;
    this.quotaError = null;
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.#streamOnce({system, user, maxTokens, temperature});
      } catch (e) {
        lastErr = e;
        if (/weekly usage quota|monthly usage quota|额度用尽|quota exceeded/i.test(String(e.message))) {this.quotaError={error:e,until:Date.now()+15*60*1000};throw e;}
        const retryable = e.name === 'TimeoutError' || e.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|504|502|503|429|模型流式返回为空/i.test(String(e.message));
        if (retryable && attempt < this.maxRetries) {
          log(`模型调用重试 ${attempt + 1}/${this.maxRetries}：${String(e.message).slice(0, 80)}`);
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('模型调用失败');
  }

  async #streamOnce({system, user, maxTokens, temperature}) {
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey},
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        temperature,
        max_tokens: maxTokens,
        stream: true,
        ...(this.baseUrl.startsWith('https://api.deepseek.com/') ? {thinking: {type: 'disabled'}} : {}),
        messages: [
          {role: 'system', content: system},
          {role: 'user', content: user},
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`模型平台返回 ${res.status}：${text.slice(0, 160)}`);
    }
    // 非流式兜底（有些网关忽略 stream）
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('event-stream')) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('模型未返回文本内容');
      return {content, usage: data.usage || null, model: data.model || this.model};
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage = null;
    let model = this.model;
    const withTimeout = withIdleTimeout(reader, this.timeoutMs);
    while (true) {
      const {done, value} = await withTimeout.read();
      if (done) break;
      buffer += dec.decode(value, {stream: true});
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.model) model = obj.model;
          const delta = obj.choices?.[0]?.delta;
          if (delta?.content) content += delta.content;
          if (obj.usage) usage = obj.usage;
        } catch {}
      }
    }
    withTimeout.finish();
    if (!content) throw new Error('模型流式返回为空');
    return {content, usage, model};
  }

  /**
   * 请求模型返回 JSON 对象。parse(data) 可抛出错误触发一次"修复重试"。
   */
  async json({system, user, maxTokens = 8000, temperature = 0, parse}) {
    let prompt = user;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.raw({system, user: prompt, maxTokens, temperature});
      const obj = tryParseJson(res.content);
      if (obj) {
        if (!parse) return obj;
        try {
          return parse(obj);
        } catch (e) {
          if (attempt === 0) {
            prompt = user + `\n\n上一次输出有问题：${String(e.message).slice(0, 200)}。请只输出符合要求的 JSON 对象。`;
            continue;
          }
          throw e;
        }
      }
      if (attempt === 0) {
        prompt = user + '\n\n上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要包含解释或代码围栏。';
      }
    }
    throw new Error('模型输出无法解析为 JSON');
  }
}

// 空闲超时：只要还在不断收到数据就一直允许，避免长输出被误杀。
function withIdleTimeout(reader, idleMs) {
  let timer = null;
  let finished = false;
  const reset = () => {
    if (timer) clearTimeout(timer);
    if (!finished) timer = setTimeout(() => { try { reader.cancel(); } catch {} }, idleMs);
  };
  reset();
  return {
    async read() {
      const r = await reader.read();
      reset();
      return r;
    },
    finish() {
      finished = true;
      if (timer) clearTimeout(timer);
    },
  };
}

function tryParseJson(text) {
  let s = String(text || '').trim().replace(/^\uFEFF/, '');
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {}
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

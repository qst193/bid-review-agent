import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
try { process.loadEnvFile(path.join(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let settings = {};
try { settings = JSON.parse((await import('node:fs')).readFileSync(path.join(root, 'settings.json'), 'utf8')); } catch {}
const base = settings.MODEL_BASE_URL || process.env.MODEL_BASE_URL;
const key = settings.MODEL_API_KEY || process.env.MODEL_API_KEY;
const name = settings.MODEL_NAME || process.env.MODEL_NAME;
if (!base || !key || !name) { console.error('请先配置 MODEL_BASE_URL、MODEL_API_KEY、MODEL_NAME（.env 或设置页）。'); process.exit(1); }
const url = base.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions';
try {
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key},
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({model: name, stream: true, max_tokens: 30, messages: [{role: 'user', content: 'Reply only OK.'}]}),
  });
  if (!r.ok) { console.error('模型连接失败，HTTP ' + r.status); process.exit(1); }
  const text = await r.text();
  console.log('模型连接成功：' + name + ' @ ' + base);
} catch (e) {
  console.error('连接失败：' + (e.cause?.code || e.name) + '。请核对网络、DNS、VPN 与接口配置。');
  process.exit(1);
}

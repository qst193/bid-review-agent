// 配置：优先 settings.json（可在页面修改），回落到 .env / 环境变量。
import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(root) {
  let settings = {};
  const settingsPath = path.join(root, 'settings.json');
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {}
  // 加载 .env
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const pick = (k, def = '') => settings[k] ?? process.env[k] ?? def;
  return {
    root,
    settingsPath,
    port: Number(process.env.PORT || settings.PORT || 4173),
    dataDir: path.resolve(root, pick('DATA_DIR', './data')),
    model: {
      baseUrl: pick('MODEL_BASE_URL', 'https://model.indata.cc/v1'),
      apiKey: pick('MODEL_API_KEY', ''),
      name: pick('MODEL_NAME', 'glm-5.3-flash'),
      timeoutMs: Number(settings.MODEL_TIMEOUT_MS || 180000),
    },
    publicModel: () => ({
      baseUrl: settings.MODEL_BASE_URL ?? process.env.MODEL_BASE_URL ?? 'https://model.indata.cc/v1',
      name: settings.MODEL_NAME ?? process.env.MODEL_NAME ?? 'glm-5.3-flash',
      configured: !!((settings.MODEL_API_KEY ?? process.env.MODEL_API_KEY) && (settings.MODEL_BASE_URL ?? process.env.MODEL_BASE_URL) && (settings.MODEL_NAME ?? process.env.MODEL_NAME)),
    }),
    saveSettings(patch) {
      settings = {...settings, ...patch};
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      return settings;
    },
  };
}

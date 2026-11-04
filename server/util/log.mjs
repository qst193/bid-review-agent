// 统一日志（写入终端，便于用户排查）。
const ts = () => new Date().toLocaleTimeString('zh-CN', {hour12: false});
export function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}
export function logError(msg, err) {
  console.error(`[${ts()}] ✗ ${msg}${err ? '：' + (err.message || err) : ''}`);
}

// 材料库（第三节 10）：公司资质、证书、业绩、产品资料、人员材料及有效期。
// 复用时需要重新确认项目适用性（避免过期/不匹配材料直接套用）。
import {stableHash} from './domain.mjs';

let seq = 0;

export function makeMaterial({category, name, issuer, number, validFrom, validTo, holder, tags, note, fileName, fileKey, fileSize} = {}) {
  seq++;
  return {
    id: 'm' + Date.now().toString(36) + seq,
    category: String(category || 'other').slice(0, 40),
    name: String(name || '').slice(0, 120),
    issuer: String(issuer || '').slice(0, 120),
    number: String(number || '').slice(0, 80),
    validFrom: String(validFrom || '').slice(0, 40),
    validTo: String(validTo || '').slice(0, 40),
    holder: String(holder || '').slice(0, 120),
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    note: String(note || '').slice(0, 300),
    fileName: String(fileName || '').slice(0, 160),
    fileKey: fileKey || null,
    fileSize: fileSize || 0,
    createdAt: new Date().toLocaleString('zh-CN', {hour12: false}),
    updatedAt: null,
  };
}

/** 有效期状态：expired / expiring(90天内) / valid / unknown。 */
export function validityState(m, now = new Date()) {
  if (!m.validTo) return 'unknown';
  const to = parseDate(m.validTo);
  if (!to) return 'unknown';
  const days = Math.floor((to - now) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 90) return 'expiring';
  return 'valid';
}

function parseDate(s) {
  const m = String(s).match(/(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
}

export function materialSummary(list) {
  const counts = {total: list.length, valid: 0, expiring: 0, expired: 0, unknown: 0};
  for (const m of list) counts[validityState(m)]++;
  return counts;
}

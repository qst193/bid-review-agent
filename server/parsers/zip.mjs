// 零依赖 ZIP 读写（DOCX/XLSX 容器所需）。只用 Node 内置 zlib。
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function findEOCD(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 读取 zip 内全部条目：返回 Map<路径, Buffer>（仅支持 store/deflate，DOCX 标准做法）。 */
export function readZip(buf, {maxEntries = 10000, maxTotalBytes = 512 * 1024 * 1024, maxEntryBytes = 256 * 1024 * 1024} = {}) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP/DOCX 文件（未找到目录区）');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    // ZIP64：在 EOCD 之前找 0x06064b50
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06064b50) {
        count = Number(buf.readBigUInt64LE(i + 32));
        cdSize = Number(buf.readBigUInt64LE(i + 40));
        cdOffset = Number(buf.readBigUInt64LE(i + 48));
        break;
      }
    }
  }
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 目录区越界，文件可能已损坏');
  const entries = new Map();
  if (count > maxEntries) throw new Error(`ZIP 文件过多（最多 ${maxEntries} 个条目）`);
  let totalBytes = 0;
  let pos = cdOffset;
  for (let i = 0; i < count && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== SIG_CEN) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (uncompSize > maxEntryBytes || totalBytes + uncompSize > maxTotalBytes) throw new Error('ZIP 解压后大小超过安全上限');
    if (localOff + 30 > buf.length) continue;
    if (buf.readUInt32LE(localOff) !== SIG_LOC) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + (compSize || uncompSize));
    try {
      const value = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, {maxOutputLength: maxEntryBytes});
      totalBytes += value.length;
      if (totalBytes > maxTotalBytes) throw new Error('ZIP 解压后大小超过安全上限');
      entries.set(name, value);
    } catch (error) {
      throw new Error(`ZIP 条目「${name}」解压失败：${error.message}`);
    }
  }
  return entries;
}

/** 生成 zip。files: [{name, data: Buffer|string}] */
export function writeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : file.data;
    const deflated = zlib.deflateRawSync(data, {level: 9});
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOC, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 名称
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, payload);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG_CEN, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_EOCD, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

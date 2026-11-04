import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./windows-ocr.ps1', import.meta.url));

export async function ocrImages(entries) {
  if (process.platform !== 'win32' || !entries.length) return {results: new Map(), warning: 'Windows OCR unavailable'};
  const dir = await mkdtemp(join(tmpdir(), 'bid-ocr-'));
  try {
    const manifest = [];
    for (const [name, data] of entries) {
      if (!/\.(png|jpe?g|bmp|gif|tiff?)$/i.test(name) || data.length > 20 * 1024 * 1024) continue;
      const path = join(dir, basename(name));
      await writeFile(path, data);
      manifest.push({name, path});
    }
    if (!manifest.length) return {results: new Map(), warning: 'No supported images'};
    const path = join(dir, 'manifest.json');
    await writeFile(path, JSON.stringify(manifest), 'utf8');
    const {stdout} = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Manifest', path], {timeout: 180000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8'});
    const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    return {results: new Map(rows.map((r) => [r.name, {text: r.text || '', error: r.error || ''}])), warning: ''};
  } catch (error) {
    return {results: new Map(), warning: `OCR failed: ${error.message}`};
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

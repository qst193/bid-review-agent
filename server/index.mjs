import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.mjs';
import {Store} from './store.mjs';
import {ModelClient} from './model.mjs';
import {createRouter} from './api.mjs';
import {log} from './util/log.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = loadConfig(root);
const store = new Store(config.dataDir);
const model = new ModelClient(config.model);
const route = createRouter({store, config, model});

const HOST = '127.0.0.1';
const PORT = config.port;

const server = http.createServer(async (req, res) => {
  const url = new URL('http://' + (req.headers.host || HOST) + req.url);

  // 只允许本机访问；拒绝跨站 Host
  const allowed = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  if (!allowed.has(req.headers.host)) {
    res.writeHead(403); res.end('Host not allowed'); return;
  }

  // CORS 预检（本机页面）
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders()); res.end(); return;
  }

  // API
  if (url.pathname.startsWith('/api/')) {
    try {
      const response = await route(req, url);
      const headers = {...corsHeaders(), ...Object.fromEntries(response.headers)};
      res.writeHead(response.status, headers);
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (e) {
      console.error('路由异常:', e);
      if (!res.headersSent) { res.writeHead(500, {'Content-Type': 'application/json;charset=utf-8'}); res.end(JSON.stringify({error: '服务器内部错误'})); }
      else res.destroy();
    }
    return;
  }

  // 静态资源（web 目录）
  serveStatic(req, res, url.pathname);
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': `http://${HOST}:${PORT}`,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'};

function serveStatic(req, res, pathname) {
  const webDir = path.join(root, 'web');
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(webDir, rel);
  if (!file.startsWith(webDir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (e, data) => {
    if (e) {
      // 单页应用回退
      fs.readFile(path.join(webDir, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
        res.end(html);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(data);
  });
}

server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 30 * 60 * 1000;
server.keepAliveTimeout = 30 * 60 * 1000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`端口 ${PORT} 被占用，请修改 .env 中的 PORT 后重启。`); process.exit(1); }
  console.error('服务启动失败:', e); process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   标盾 AI · 智能标书审核工作台           ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  ▸ 访问地址： http://${HOST}:${PORT}`);
  console.log(`  ▸ 数据目录： ${config.dataDir}`);
  const pm = config.publicModel();
  console.log(`  ▸ 模型配置： ${pm.configured ? `${pm.name} @ ${pm.baseUrl}` : '未配置（请在上传前于设置页或 .env 填写）'}`);
  console.log('  ▸ 按 Ctrl+C 停止服务');
  console.log('');
});

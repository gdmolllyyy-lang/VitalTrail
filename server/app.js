/* =========================================================
   Healthy · HTTP 服务
   - 静态资源：public/（前端）+ shared/（共享数据集）
   - REST API：/api/*
   零第三方依赖，Node >= 22.5
   启动：node --experimental-sqlite server/app.js
   ========================================================= */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const store = require('./db');
const api = require('./api');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SHARED_DIR = path.join(ROOT, 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};

function serveFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** 阻止路径穿越 */
function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  return p.startsWith(base) ? p : null;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (e) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  const done = (note) => {
    if (process.env.NODE_ENV !== 'test') {
      console.log(`${req.method} ${url.pathname} → ${res.statusCode} ${Date.now() - started}ms ${note || ''}`);
    }
  };
  res.on('finish', () => done());

  // API
  if (url.pathname.startsWith('/api')) {
    await api.handle(req, res, url);
    return;
  }

  // 静态：共享数据集
  if (url.pathname.startsWith('/shared/')) {
    const p = safeJoin(SHARED_DIR, url.pathname.slice('/shared/'.length));
    if (!p) { res.writeHead(403); res.end('Forbidden'); return; }
    return serveFile(res, p);
  }

  // 静态：前端
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = safeJoin(PUBLIC_DIR, rel);
  if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isFile()) return serveFile(res, filePath);
    // 单页应用回退
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  });
});

/* ---------------- 启动 ---------------- */
store.seed();
const dbInfo = (() => {
  const foods = store.db.prepare('SELECT COUNT(*) AS c FROM food').get().c;
  const exs = store.db.prepare('SELECT COUNT(*) AS c FROM exercise').get().c;
  return { foods, exercises: exs };
})();

server.listen(PORT, () => {
  console.log('');
  console.log('  ✅ Healthy 已启动');
  console.log('  ───────────────────────────────────────────');
  console.log(`  前端页面   http://localhost:${PORT}`);
  console.log(`  接口地址   http://localhost:${PORT}/api/health`);
  console.log(`  数据库     ${store.DB_FILE}`);
  console.log(`  参考数据   食物 ${dbInfo.foods} 条 / 动作 ${dbInfo.exercises} 条`);
  console.log('  ───────────────────────────────────────────');
  console.log('  按 Ctrl + C 停止服务');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  已停止服务，数据已保存在 data/healthy.db\n');
  server.close(() => process.exit(0));
});

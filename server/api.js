/* =========================================================
   Healthy · REST API
   所有接口返回 JSON；错误返回 { error: { code, message } }
   ========================================================= */
'use strict';

const store = require('./db');

const MAX_BODY = 12 * 1024 * 1024; // 12MB，含压缩后的饮食照片

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function fail(res, code, message) {
  send(res, code, { error: { code, message } });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大（上限 12MB），请减少照片数量'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------------- 路由 ---------------- */
async function route(req, res, url) {
  const method = req.method;
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);

  /* 健康检查 */
  if (seg[0] === 'health') {
    return send(res, 200, { ok: true, service: 'healthy', db: store.DB_FILE, time: new Date().toISOString() });
  }

  /* 启动引导：一次性把前端需要的状态取回 */
  if (seg[0] === 'bootstrap' && method === 'GET') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 90));
    const from = new Date(Date.now() - (days - 1) * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    const fromStr = from.getFullYear() + '-' + p(from.getMonth() + 1) + '-' + p(from.getDate());

    const dates = store.db.prepare('SELECT DISTINCT date FROM food_log WHERE date >= ? UNION SELECT DISTINCT date FROM exercise_log WHERE date >= ? ORDER BY date')
      .all(fromStr, fromStr).map((r) => r.date);

    const logs = {};
    dates.forEach((d) => { logs[d] = store.getDay(d); });

    return send(res, 200, {
      profile: store.getProfile(),
      logs,
      weights: store.getWeights(),
      plans: (() => {
        const m = {};
        [today()].forEach((d) => { const pl = store.getPlan(d); if (pl) m[d] = pl; });
        return m;
      })(),
      week: store.getWeek(),
      library: {
        foods: store.db.prepare('SELECT COUNT(*) AS c FROM food').get().c,
        exercises: store.db.prepare('SELECT COUNT(*) AS c FROM exercise').get().c
      },
      serverTime: new Date().toISOString()
    });
  }

  /* 身体档案 */
  if (seg[0] === 'profile') {
    if (method === 'GET') return send(res, 200, store.getProfile());
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson(req);
      const saved = store.saveProfile(body);
      return send(res, 200, saved);
    }
    return fail(res, 405, '不支持的方法');
  }

  /* 某日记录：GET / PUT（整日覆盖） / DELETE（清空） */
  if (seg[0] === 'logs') {
    const date = seg[1];
    if (!isDate(date)) return fail(res, 400, '日期格式应为 YYYY-MM-DD');
    if (method === 'GET') return send(res, 200, store.getDay(date));
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') return fail(res, 400, '请求体应为对象');
      const saved = store.putDay(date, body);
      return send(res, 200, saved);
    }
    if (method === 'DELETE') return send(res, 200, store.clearDay(date));
    return fail(res, 405, '不支持的方法');
  }

  /* 体重记录 */
  if (seg[0] === 'weights') {
    if (method === 'GET') return send(res, 200, store.getWeights());
    if (method === 'POST' || method === 'PUT') {
      const body = await readJson(req);
      if (!body.weight) return fail(res, 400, '缺少 weight');
      return send(res, 201, store.addWeight(body));
    }
    return fail(res, 405, '不支持的方法');
  }

  /* 单日食谱 */
  if (seg[0] === 'plans') {
    const date = seg[1];
    if (!isDate(date)) return fail(res, 400, '日期格式应为 YYYY-MM-DD');
    if (method === 'GET') {
      const p = store.getPlan(date);
      return p ? send(res, 200, p) : fail(res, 404, '该日暂无食谱');
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, store.putPlan(date, body));
    }
    return fail(res, 405, '不支持的方法');
  }

  /* 一周计划 */
  if (seg[0] === 'week') {
    if (method === 'GET') {
      const w = store.getWeek();
      return w ? send(res, 200, w) : fail(res, 404, '暂无一周计划');
    }
    if (method === 'PUT' || method === 'POST') {
      const body = await readJson(req);
      if (!body.days) return fail(res, 400, '缺少 days');
      return send(res, 200, store.putWeek(body));
    }
    return fail(res, 405, '不支持的方法');
  }

  /* 食物库 / 动作库（来自 SQLite） */
  if (seg[0] === 'library') {
    if (seg[1] === 'foods') {
      const q = url.searchParams.get('q') || '';
      return send(res, 200, { items: store.getFoods(q) });
    }
    if (seg[1] === 'exercises') {
      const part = url.searchParams.get('part') || '';
      const items = store.getExercises(part).map((e) => Object.assign({}, e, {
        steps: safeArr(e.steps), mistakes: safeArr(e.mistakes)
      }));
      return send(res, 200, { items });
    }
    return fail(res, 404, '未知的资源');
  }

  /* 周统计（SQL 聚合） */
  if (seg[0] === 'stats' && method === 'GET') {
    return send(res, 200, store.stats(url.searchParams.get('days')));
  }

  return fail(res, 404, '接口不存在：' + url.pathname);
}

function safeArr(s) {
  try { return JSON.parse(s || '[]'); } catch (e) { return []; }
}

/** 返回 true 表示已由 API 处理 */
async function handle(req, res, url) {
  if (!url.pathname.startsWith('/api')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return true;
  }

  try {
    await route(req, res, url);
  } catch (err) {
    const code = err.status || 500;
    if (code >= 500) console.error('[api]', err);
    if (!res.headersSent) fail(res, code, err.message || '服务器内部错误');
  }
  return true;
}

module.exports = { handle, today };

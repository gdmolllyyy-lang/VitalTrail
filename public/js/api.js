/* =========================================================
   Healthy · 前端 API 客户端
   - 在线（http/https）时与 Node 后端 + SQLite 同步
   - 离线（直接双击打开 html）或后端不可用时自动降级为 localStorage
   ========================================================= */
(function () {
  'use strict';

  const timeout = 8000;

  const API = {
    online: false,
    available: typeof location !== 'undefined' && /^https?:$/.test(location.protocol),

    async req(method, path, body) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(path, {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctl.signal
        });
        if (!res.ok) {
          let msg = 'HTTP ' + res.status;
          try {
            const j = await res.json();
            if (j && j.error && j.error.message) msg = j.error.message;
          } catch (e) { /* ignore */ }
          const err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        if (res.status === 204) return null;
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },

    async check() {
      if (!this.available) { this.online = false; return false; }
      try {
        const h = await this.req('GET', '/api/health');
        this.online = !!(h && h.ok);
      } catch (e) {
        this.online = false;
      }
      return this.online;
    },

    bootstrap(days) { return this.req('GET', '/api/bootstrap?days=' + (days || 90)); },
    putDay(date, day) { return this.req('PUT', '/api/logs/' + date, day); },
    putProfile(p) { return this.req('PUT', '/api/profile', p); },
    addWeight(w) { return this.req('POST', '/api/weights', w); },
    putPlan(date, plan) { return this.req('PUT', '/api/plans/' + date, plan); },
    putWeek(week) { return this.req('PUT', '/api/week', week); },
    searchFoods(q) { return this.req('GET', '/api/library/foods?q=' + encodeURIComponent(q)); },
    stats(days) { return this.req('GET', '/api/stats?days=' + (days || 7)); }
  };

  window.API = API;
})();

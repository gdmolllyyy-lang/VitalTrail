/* =========================================================
   Healthy · 应用逻辑
   在线（http/https）时：启动从后端 /api/bootstrap 拉取状态，
   每次改动写回后端并落库 SQLite；离线时自动降级 localStorage。
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- 工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r5 = (v) => Math.max(0, Math.round(v / 5) * 5);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const fmt = (n) => Math.round(n || 0);

  function dstr(d) {
    const x = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
  }
  function dparse(s) {
    const a = s.split('-').map(Number);
    return new Date(a[0], a[1] - 1, a[2]);
  }
  function dlabel(s) {
    const t = dstr();
    if (s === t) return '今天';
    const y = new Date(); y.setDate(y.getDate() - 1);
    if (s === dstr(y)) return '昨天';
    const d = dparse(s);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 1900);
  }

  /* ---------------- 状态 ---------------- */
  const KEY = 'healthy_v1';
  const DEFAULT_STATE = {
    profile: {
      sex: 'female', age: 26, height: 165, weight: 60, bodyfat: null,
      activity: 1.375, goal: 'keep', dietType: 'balanced', avoid: [], weeklyFreq: 3
    },
    logs: {},
    weights: [],
    plans: {},
    week: null
  };

  let S = (function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
      const o = JSON.parse(raw);
      return Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_STATE)), o, {
        profile: Object.assign({}, DEFAULT_STATE.profile, o.profile || {})
      });
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
  })();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('本地存储已满，照片请适当清理'); }
  }

  /* ---------------- 后端同步 ---------------- */
  let offlineToastShown = false;

  function updateSyncDot() {
    const el = document.getElementById('syncDot');
    if (!el) return;
    const on = !!(window.API && window.API.online);
    el.className = 'sync-dot' + (on ? ' on' : '');
    el.title = on ? '已连接后端 · 数据实时存入 SQLite' : '本地模式 · 数据仅保存在浏览器';
  }

  function markOffline() {
    if (window.API) window.API.online = false;
    updateSyncDot();
    if (!offlineToastShown) {
      offlineToastShown = true;
      toast('后端连接中断，已切换到本地保存');
    }
  }

  function push(fn) {
    if (!window.API || !window.API.online) return;
    Promise.resolve().then(fn).then(updateSyncDot).catch(markOffline);
  }

  function addWeightRecord(weight, bf) {
    const t = today();
    S.weights = (S.weights || []).filter((w) => w.date !== t);
    S.weights.push({ date: t, weight: weight, bf: bf || null });
    S.weights.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  function syncDay(date, day) { push(() => window.API.putDay(date, day)); }
  function syncProfile() { push(() => window.API.putProfile(S.profile)); }
  function syncWeight() {
    push(() => window.API.addWeight({ date: today(), weight: S.profile.weight, bf: S.profile.bodyfat }));
  }
  function syncPlan(date) { push(() => window.API.putPlan(date, S.plans[date])); }
  function syncWeek() { push(() => window.API.putWeek(S.week)); }

  const today = () => dstr();
  let curDate = today();      // 记录页当前日期
  let curMeal = 'breakfast';  // 正在添加的餐次
  let pendingFoods = [];      // 待加入记录
  let pendingPhoto = null;    // 待加入照片
  let selectedEx = null;

  /* ---------------- 常量 ---------------- */
  const MEALS = [
    { k: 'breakfast', n: '早餐', ico: '🍳', bg: '#fff4e5' },
    { k: 'lunch', n: '午餐', ico: '🍱', bg: '#e8f6ee' },
    { k: 'dinner', n: '晚餐', ico: '🍲', bg: '#f0edff' },
    { k: 'snack', n: '加餐', ico: '🥜', bg: '#fdeff2' }
  ];
  const MEAL_NAME = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
  const MEAL_SPLIT = { breakfast: 0.27, lunch: 0.33, dinner: 0.30, snack: 0.10 };
  const PROT_SPLIT = { breakfast: 0.26, lunch: 0.32, dinner: 0.30, snack: 0.12 };

  const FOOD_BY_NAME = {};
  FOODS.forEach((f) => { FOOD_BY_NAME[f.n] = f; });

  /* ---------------- 计算 ---------------- */
  function bmrOf(p) {
    const w = +p.weight || 0, h = +p.height || 0, a = +p.age || 0;
    if (p.bodyfat && +p.bodyfat > 3 && +p.bodyfat < 60) {
      const lbm = w * (1 - (+p.bodyfat) / 100);
      return 370 + 21.6 * lbm;
    }
    return 10 * w + 6.25 * h - 5 * a + (p.sex === 'male' ? 5 : -161);
  }
  function tdeeOf(p) { return bmrOf(p) * (+p.activity || 1.375); }
  function targetKcal(p) {
    const t = tdeeOf(p);
    if (p.goal === 'lose') return Math.max(p.sex === 'male' ? 1500 : 1200, Math.round(t * 0.8 / 10) * 10);
    if (p.goal === 'gain') return Math.round(t * 1.12 / 10) * 10;
    return Math.round(t / 10) * 10;
  }
  function macroTargets(p) {
    const k = targetKcal(p);
    const w = +p.weight || 60;
    let prot = w * (p.goal === 'lose' ? 1.8 : p.goal === 'gain' ? 2.0 : 1.6);
    if (p.dietType === 'highprotein') prot = w * 2.2;
    if (p.dietType === 'veg') prot = w * 1.6;
    let fat = w * (p.goal === 'lose' ? 0.8 : 0.9);
    if (p.dietType === 'lowcarb') fat = w * 1.1;
    let carb = (k - prot * 4 - fat * 9) / 4;
    const carbMin = p.dietType === 'lowcarb' ? (k * 0.25) / 4 : (k * 0.42) / 4;
    if (carb < carbMin) {
      carb = carbMin;
      fat = Math.max(w * 0.6, (k - prot * 4 - carb * 4) / 9);
      if (k - prot * 4 - carb * 4 - fat * 9 < -80) prot = Math.max(w * 1.2, (k - carb * 4 - fat * 9) / 4);
    }
    return { k, prot: Math.round(prot), fat: Math.round(fat), carb: Math.round(carb) };
  }
  function exKcal(met, min) {
    const w = +S.profile.weight || 60;
    return Math.round((met * 3.5 * w) / 200 * min);
  }
  function dayLog(date) {
    if (!S.logs[date]) S.logs[date] = { meals: { breakfast: [], lunch: [], dinner: [], snack: [] }, exercises: [] };
    const l = S.logs[date];
    if (!l.meals) l.meals = { breakfast: [], lunch: [], dinner: [], snack: [] };
    MEALS.forEach((m) => { if (!l.meals[m.k]) l.meals[m.k] = []; });
    if (!l.exercises) l.exercises = [];
    return l;
  }
  function sumItems(arr) {
    return arr.reduce((a, i) => ({ k: a.k + i.kcal, p: a.p + i.p, f: a.f + i.f, c: a.c + i.c }), { k: 0, p: 0, f: 0, c: 0 });
  }
  function dayTotals(date) {
    const l = dayLog(date);
    let r = { k: 0, p: 0, f: 0, c: 0 };
    MEALS.forEach((m) => { const s = sumItems(l.meals[m.k]); r.k += s.k; r.p += s.p; r.f += s.f; r.c += s.c; });
    return r;
  }
  function dayBurn(date) {
    return dayLog(date).exercises.reduce((a, e) => a + e.kcal, 0);
  }

  /* ---------------- 中文数字 ---------------- */
  const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
  function cn2num(s) {
    if (!s) return 1;
    if (/^\d/.test(s)) return parseFloat(s);
    if (s.length === 1) return CN_NUM[s] != null ? CN_NUM[s] : 1;
    const i = s.indexOf('十');
    if (i === 0) { const r = s[1] ? (CN_NUM[s[1]] || 0) : 0; return 10 + r; }
    if (i > 0) { const a = CN_NUM[s.slice(0, i)] || 1; const b = s[i + 1] ? (CN_NUM[s[i + 1]] || 0) : 0; return a * 10 + b; }
    return 1;
  }

  function scaleFood(food, grams) {
    const r = grams / 100;
    return {
      id: uid(),
      name: food.n,
      grams: Math.round(grams),
      kcal: Math.round(food.k * r),
      p: +(food.p * r).toFixed(1),
      f: +(food.f * r).toFixed(1),
      c: +(food.c * r).toFixed(1)
    };
  }

  /* ---------------- 文字解析 ---------------- */
  function parseFoodText(text) {
    const tokens = String(text)
      .replace(/\s+/g, ' ')
      .split(/[,，、;；+＋\/\n]| 以及 | 还有 | 和 | 跟 | 配 |\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const out = [], miss = [];
    tokens.forEach((tk) => {
      let hit = null, alias = '';
      for (let i = 0; i < FOOD_INDEX.length; i++) {
        if (tk.indexOf(FOOD_INDEX[i].key) > -1) { hit = FOOD_INDEX[i].food; alias = FOOD_INDEX[i].key; break; }
      }
      if (!hit) { if (tk.length > 1) miss.push(tk); return; }
      const gm = tk.match(/(\d+(?:\.\d+)?)\s*(g|克|ml|毫升|G|ML)/);
      let grams;
      if (gm) grams = parseFloat(gm[1]);
      else {
        const before = tk.slice(0, tk.indexOf(alias)).replace(/约|大概|估计|左右/g, '');
        const qm = before.match(/(\d+(?:\.\d+)?|[零一二两三四五六七八九十半]+)\s*(个|碗|杯|份|片|根|勺|块|条|袋|把|盒|罐|瓶|只|颗|枚|张)?/);
        let q = 1;
        if (qm && qm[1]) q = cn2num(qm[1]);
        grams = (hit.g || 100) * (q || 1);
      }
      out.push(scaleFood(hit, clamp(grams, 5, 2000)));
    });
    return { items: out, miss };
  }

  /* ---------------- 食谱生成 ---------------- */
  const TPL_P = {
    breakfast: ['鸡蛋', '希腊酸奶', '牛奶', '豆浆', '乳清蛋白粉'],
    lunch: ['鸡胸肉', '牛肉', '猪里脊', '三文鱼', '虾', '豆腐', '巴沙鱼', '草鱼'],
    dinner: ['三文鱼', '鸡胸肉', '豆腐', '虾', '牛肉', '巴沙鱼', '鸡蛋', '鸡腿肉'],
    snack: ['希腊酸奶', '牛奶', '乳清蛋白粉', '豆浆']
  };
  const TPL_C = {
    breakfast: ['燕麦片', '全麦面包', '红薯', '玉米', '馒头'],
    lunch: ['米饭', '糙米饭', '面条', '红薯', '意大利面'],
    dinner: ['米饭', '糙米饭', '红薯', '玉米', '土豆'],
    snack: ['香蕉', '苹果', '蓝莓', '草莓', '橙子']
  };
  const TPL_V = {
    lunch: ['西兰花', '菠菜', '生菜', '青椒', '香菇', '芦笋'],
    dinner: ['西兰花', '菠菜', '番茄', '黄瓜', '冬瓜', '木耳', '油麦菜']
  };
  const TPL_F = {
    lunch: ['橄榄油'], dinner: ['橄榄油'], breakfast: ['杏仁', '核桃'], snack: ['杏仁', '核桃']
  };
  const VEG_ONLY = { breakfast: ['番茄', '黄瓜'], dinner: ['番茄', '黄瓜', '生菜'] };

  function isAvoided(f, avoid) {
    return !!(f.tag && avoid && avoid.indexOf(f.tag) > -1);
  }
  function dietBlocked(f, dietType) {
    if (dietType !== 'veg') return false;
    return ['beef', 'pork', 'lamb', 'chicken', 'fish', 'shrimp'].indexOf(f.tag) > -1;
  }
  function pickList(names, avoid, dietType, used) {
    const out = names
      .map((n) => FOOD_BY_NAME[n])
      .filter((f) => f && !isAvoided(f, avoid) && !dietBlocked(f, dietType) && !(used && used[f.n]));
    if (out.length) return out;
    return [];
  }
  function pickOne(list) { return list[Math.floor(Math.random() * list.length)]; }

  function maxGrams(f) {
    if (f.cat === '乳品' || f.n === '豆浆') return 300;
    if (f.n === '鸡蛋') return 200;
    if (f.n === '乳清蛋白粉') return 60;
    if (f.n === '豆腐') return 300;
    return 320;
  }

  function buildMeal(type, kT, pT, avoid, dietType, used) {
    const items = [];
    const lowcarb = dietType === 'lowcarb';

    // 蛋白（早餐优先选固体蛋白，乳饮留给"补足"环节）
    let pl = pickList(TPL_P[type], avoid, dietType, used);
    if (type === 'breakfast') {
      const solid = pl.filter((f) => f.p >= 8);
      if (solid.length) pl = solid;
    }
    if (!pl.length) pl = FOODS.filter((f) => f.p >= 8 && !isAvoided(f, avoid) && !dietBlocked(f, dietType));
    if (!pl.length) pl = FOODS.filter((f) => f.p >= 5);
    let pf = pickOne(pl);
    if (!pf) return { items: [] };
    let pBudget = kT * (type === 'snack' ? 0.75 : 0.55);
    let pg = r5(Math.min(pT / ((pf.p || 1) / 100), pBudget / ((pf.k || 1) / 100)));
    pg = clamp(pg, 30, maxGrams(pf));
    items.push(scaleFood(pf, pg));
    if (used) used[pf.n] = 1;

    // 蛋白不足时补第二种（例如鸡蛋 + 一杯牛奶）
    const pNow = items.reduce((a, i) => a + i.p, 0);
    if (pNow < pT * 0.85) {
      const rest2 = kT - items.reduce((a, i) => a + i.kcal, 0);
      const bl = pickList(TPL_P[type], avoid, dietType, used);
      if (bl.length && rest2 > 70) {
        const bf = pickOne(bl);
        let bg = ((pT - pNow) / ((bf.p || 1) / 100));
        bg = clamp(r5(bg), 30, Math.min(maxGrams(bf), rest2 / ((bf.k || 1) / 100)));
        if (bg >= 30) { items.push(scaleFood(bf, bg)); if (used) used[bf.n] = 1; }
      }
    }

    // 蔬菜（午/晚）
    let vk = 0;
    if (TPL_V[type]) {
      const vl = pickList(TPL_V[type], avoid, dietType, null);
      if (vl.length) { const vf = pickOne(vl); const it = scaleFood(vf, 150); items.push(it); vk = it.kcal; }
    }
    // 烹调油
    let fk = 0;
    if (type === 'lunch' || type === 'dinner') {
      const of = FOOD_BY_NAME['橄榄油'];
      const it = scaleFood(of, 5); items.push(it); fk = it.kcal;
    }
    // 主食
    let rest = kT - items.reduce((a, i) => a + i.kcal, 0);
    let cl = pickList(TPL_C[type], avoid, dietType, null);
    if (cl.length) {
      const cf = pickOne(cl);
      let cg = rest / ((cf.k || 1) / 100);
      if (type === 'snack') {
        cg = clamp(r5(cg), 0, 150);
        if (cg >= 15) items.push(scaleFood(cf, cg));
      } else {
        cg = clamp(r5(cg), 25, lowcarb ? 180 : 320);
        items.push(scaleFood(cf, cg));
      }
    }
    // 坚果 / 水果点缀
    if (TPL_F[type] && (type === 'breakfast' || type === 'snack')) {
      rest = kT - items.reduce((a, i) => a + i.kcal, 0);
      if (rest > 90) {
        const fl = pickList(TPL_F[type], avoid, dietType, null);
        if (fl.length) items.push(scaleFood(pickOne(fl), type === 'snack' ? 12 : 10));
      }
    }
    // 蔬菜不足时补一份
    if (!TPL_V[type] && VEG_ONLY[type] && rest > 60) {
      const vl = pickList(VEG_ONLY[type], avoid, dietType, null);
      if (vl.length && type === 'breakfast') items.push(scaleFood(pickOne(vl), 100));
    }
    return { items };
  }

  function buildDayPlan(opts) {
    opts = opts || {};
    const p = S.profile;
    const mt = macroTargets(p);
    const kBase = opts.kcal || mt.k;
    const avoid = p.avoid || [];
    const dietType = opts.dietType || p.dietType;
    const used = {};
    const meals = {};
    let split = MEAL_SPLIT;
    if (opts.light) split = { breakfast: 0.28, lunch: 0.34, dinner: 0.30, snack: 0.08 };
    MEALS.forEach((m) => {
      meals[m.k] = buildMeal(m.k, kBase * split[m.k], mt.prot * PROT_SPLIT[m.k], avoid, dietType, used).items;
    });
    const totals = { k: 0, p: 0, f: 0, c: 0 };
    MEALS.forEach((m) => {
      const s = sumItems(meals[m.k]);
      totals.k += s.k; totals.p += s.p; totals.f += s.f; totals.c += s.c;
    });
    return { meals, totals, target: mt };
  }

  function getPlan(date) {
    if (!S.plans[date]) { S.plans[date] = buildDayPlan({ kcal: targetKcal(S.profile) }); save(); }
    return S.plans[date];
  }

  /* ---------------- 一周计划 ---------------- */
  function spreadDays(freq) {
    freq = clamp(freq, 2, 7);
    if (freq >= 7) return [0, 1, 2, 3, 4, 5, 6];
    const idx = [];
    for (let i = 0; i < freq; i++) idx.push(Math.round((i * 6) / (freq - 1)));
    return Array.from(new Set(idx)).slice(0, freq);
  }

  function buildWeek() {
    const p = S.profile;
    const freq = clamp(+p.weeklyFreq || 3, 2, 6);
    const split = SPLITS[freq] || SPLITS[3];
    const trainIdx = spreadDays(freq);
    const mt = macroTargets(p);
    const days = [];
    const start = dparse(today());
    let si = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const isTrain = trainIdx.indexOf(i) > -1;
      const tpl = isTrain ? split[si++ % split.length] : null;
      const kTarget = isTrain ? mt.k : Math.round((mt.k * 0.92) / 10) * 10;
      const plan = buildDayPlan({ kcal: kTarget, light: !isTrain });
      let moves = [], cardio = null, burn = 0;
      if (tpl) {
        moves = tpl.ids.map((id) => {
          const e = EXERCISES.find((x) => x.id === id);
          return e ? { n: e.n, sets: e.sets, met: e.met } : null;
        }).filter(Boolean);
        if (tpl.cardio) {
          const ce = EXERCISES.find((x) => x.id === tpl.cardio);
          if (ce) {
            cardio = { n: ce.n, min: tpl.cardioMin };
            burn += exKcal(ce.met, tpl.cardioMin);
          }
        }
        // 力量训练按 40 分钟、平均 MET 4 估算
        burn += Math.round((4 * 3.5 * (+p.weight || 60)) / 200 * 40);
      }
      days.push({
        date: dstr(d), week: WEEK_NAMES[(d.getDay() + 6) % 7],
        isTrain, focus: tpl ? tpl.t : '休息 / 主动恢复',
        moves, cardio, burn, plan, kTarget
      });
    }
    return { days };
  }

  function getWeek() {
    if (!S.week || S.week.start !== today()) {
      S.week = buildWeek();
      S.week.start = today();
      save();
    }
    return S.week;
  }

  /* ---------------- 渲染：今日 ---------------- */
  function renderToday() {
    const p = S.profile;
    const t = today();
    const tot = dayTotals(t);
    const burn = dayBurn(t);
    const mt = macroTargets(p);
    const target = mt.k;

    $('#topDay').textContent = (new Date().getMonth() + 1) + '月' + new Date().getDate() + '日';
    $('#topWeek').textContent = '周' + '日一二三四五六'[new Date().getDay()];

    const pct = clamp(tot.k / (target || 1), 0, 1);
    $('#ring').style.strokeDashoffset = String(314.16 * (1 - pct));
    $('#ringKcal').textContent = fmt(tot.k);
    $('#hTarget').textContent = target + ' kcal';
    $('#hLeft').textContent = (target - tot.k >= 0 ? '' : '+') + fmt(target - tot.k) + ' kcal';
    $('#hBurn').textContent = fmt(burn) + ' kcal';

    // 评估
    const need = tdeeOf(p) + burn;
    const diff = tot.k - need;
    let level = 'ok', text = '';
    if (tot.k < 60) {
      text = '今天还没有记录饮食。记下三餐后，我会帮你判断热量差是否合理 🙂';
      level = 'idle';
    } else if (tot.k < bmrOf(p) * 0.55) {
      level = 'idle';
      text = '目前记录 ' + fmt(tot.k) + ' kcal，还不到基础代谢的 55%，可能还有餐次没记。补齐后热量差评估才准。';
    } else if (diff <= -700) {
      level = 'bad';
      text = '缺口 ' + Math.abs(fmt(diff)) + ' kcal，超出合理范围。若已记完，建议再补约 ' + fmt(Math.abs(diff) - 500) + ' kcal，避免代谢下降与肌肉流失。';
    } else if (diff < -100) {
      level = 'good';
      text = '缺口 ' + Math.abs(fmt(diff)) + ' kcal' + (p.goal === 'lose' ? '，属于合理减脂区间（300-500）。' : '，如果你不想减重，可以再补一点。');
    } else if (diff <= 150) {
      level = 'ok';
      text = '摄入与消耗基本持平（' + (diff >= 0 ? '+' : '') + fmt(diff) + ' kcal），维持期很理想。';
    } else if (diff <= 500) {
      level = 'ok';
      text = '盈余 ' + fmt(diff) + ' kcal' + (p.goal === 'gain' ? '，配合力量训练有利于增肌。' : '，非增肌期建议控制在 300 以内。');
    } else {
      level = 'bad';
      text = '盈余 ' + fmt(diff) + ' kcal，偏多了，连续性盈余容易转成脂肪。';
    }
    if (tot.k > 300 && tot.p < mt.prot * 0.75) {
      text += ' 蛋白质只到了目标的 ' + Math.round((tot.p / mt.prot) * 100) + '%，优先补蛋白。';
    }
    const icon = level === 'bad' ? '⚠️' : level === 'good' ? '✅' : level === 'idle' ? '💡' : '⚖️';
    const vEl = $('#hVerdict');
    vEl.innerHTML = '<i>' + icon + '</i><span>' + esc(text) + '</span>';
    vEl.style.background = level === 'bad' ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.16)';

    $('#sBmr').innerHTML = fmt(bmrOf(p)) + '<small>kcal</small>';
    $('#sTdee').innerHTML = fmt(tdeeOf(p)) + '<small>kcal</small>';
    $('#sBal').innerHTML = tot.k >= 60 ? ((diff >= 0 ? '+' : '−') + Math.abs(fmt(diff)) + '<small>kcal</small>') : '—';
    $('#bmrHint').textContent = (p.bodyfat ? '已按 Katch-McArdle（去脂体重）计算基础代谢，' : '按 Mifflin-St Jeor 公式计算基础代谢，') +
      '活动系数 ' + p.activity + '。训练消耗单独计入，不重复计算。';

    // 宏量
    $('#macroKcal').textContent = fmt(tot.k) + ' / ' + target + ' kcal';
    fillMacro('#mP', '#mPbar', tot.p, mt.prot);
    fillMacro('#mF', '#mFbar', tot.f, mt.fat);
    fillMacro('#mC', '#mCbar', tot.c, mt.carb);

    // 餐次
    const lg = dayLog(t);
    $('#todayMeals').innerHTML = MEALS.map((m) => {
      const items = lg.meals[m.k];
      const s = sumItems(items);
      const desc = items.length ? items.map((i) => i.name).join('、') : '还没记录';
      return '<div class="meal-row">' +
        '<div class="meal-ico" style="background:' + m.bg + '">' + m.ico + '</div>' +
        '<div class="meal-main"><div class="meal-name">' + m.n + '</div><div class="meal-desc">' + esc(desc) + '</div></div>' +
        '<div class="meal-kcal">' + fmt(s.k) + ' <small>kcal</small></div>' +
        '<button class="add-mini" data-add-meal="' + m.k + '">+</button></div>';
    }).join('');

    // 运动
    const ex = lg.exercises;
    $('#todayExercise').innerHTML = ex.length
      ? ex.map((e) => '<div class="item"><div class="item-thumb ph" style="background:#eaf2ff">🏃</div><div class="item-body"><div class="item-name">' + esc(e.name) + '</div><div class="item-sub">' + e.min + ' 分钟 · ' + (e.met || 0) + ' MET</div></div><div class="item-kcal">' + e.kcal + ' <small>kcal</small></div></div>').join('')
      : '<div class="empty"><div class="e-ico">🏃‍♀️</div>今天还没有运动记录</div>';

    // 食谱
    const plan = getPlan(t);
    $('#todayPlanMini').innerHTML = MEALS.map((m) => {
      const its = plan.meals[m.k] || [];
      const s = sumItems(its);
      return '<div class="meal-row"><div class="meal-ico" style="background:' + m.bg + '">' + m.ico + '</div>' +
        '<div class="meal-main"><div class="meal-name">' + m.n + '</div><div class="meal-desc">' + esc(its.map((i) => i.name + ' ' + i.grams + 'g').join(' · ')) + '</div></div>' +
        '<div class="meal-kcal">' + fmt(s.k) + ' <small>kcal</small></div></div>';
    }).join('');
  }

  function fillMacro(txtSel, barSel, val, target) {
    const pct = target > 0 ? clamp(val / target, 0, 1) : 0;
    $(txtSel).textContent = fmt(val) + ' / ' + fmt(target) + ' g';
    $(barSel).style.width = (pct * 100).toFixed(1) + '%';
  }

  /* ---------------- 渲染：记录 ---------------- */
  function renderLog() {
    const lg = dayLog(curDate);
    $('#logDateLabel').textContent = dlabel(curDate);
    const d = dparse(curDate);
    $('#logDateSub').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + '日一二三四五六'[d.getDay()];
    const tot = dayTotals(curDate);
    $('#logKcal').textContent = fmt(tot.k) + ' kcal';
    $('#logBurn').textContent = fmt(dayBurn(curDate)) + ' kcal';

    $('#logMeals').innerHTML = MEALS.map((m) => {
      const items = lg.meals[m.k];
      const s = sumItems(items);
      let html = '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0 4px">' +
        '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px">' + m.ico + '</span>' +
        '<b style="font-size:13.5px">' + m.n + '</b><span style="font-size:11.5px;color:var(--sub)">' + fmt(s.k) + ' kcal</span></div>' +
        '<button class="btn btn-ghost btn-sm" data-add-meal="' + m.k + '" style="height:28px;padding:0 10px">+ 添加</button></div>';
      if (items.length) {
        html += items.map((i) => '<div class="item">' +
          (i.photo ? '<img class="item-thumb" src="' + i.photo + '" alt="" />' : '<div class="item-thumb ph" style="background:' + m.bg + '">' + m.ico + '</div>') +
          '<div class="item-body"><div class="item-name">' + esc(i.name) + '</div><div class="item-sub">' + i.grams + 'g · 蛋白 ' + i.p + 'g / 脂 ' + i.f + 'g / 碳 ' + i.c + 'g</div></div>' +
          '<div class="item-kcal">' + i.kcal + ' <small>kcal</small></div>' +
          '<button class="del" data-del-food="' + m.k + '|' + i.id + '">✕</button></div>').join('');
      } else {
        html += '<div style="font-size:12px;color:var(--sub);padding:2px 0 10px">暂无记录</div>';
      }
      return html + '<div style="height:1px;background:var(--line);margin:6px 0 10px"></div>';
    }).join('');

    const ex = lg.exercises;
    $('#logExercise').innerHTML = ex.length
      ? ex.map((e) => '<div class="item"><div class="item-thumb ph" style="background:#eaf2ff">🏃</div>' +
        '<div class="item-body"><div class="item-name">' + esc(e.name) + '</div><div class="item-sub">' + e.min + ' 分钟 · MET ' + (e.met || 0) + '</div></div>' +
        '<div class="item-kcal">' + e.kcal + ' <small>kcal</small></div>' +
        '<button class="del" data-del-ex="' + e.id + '">✕</button></div>').join('')
      : '<div class="empty" style="padding:14px"><div class="e-ico">🏋️</div>还没有运动记录</div>';
  }

  /* ---------------- 渲染：食谱 ---------------- */
  function renderPlan() {
    const p = S.profile;
    const mt = macroTargets(p);
    const plan = getPlan(today());
    $('#planTargetSub').textContent = '目标 ' + mt.k + ' kcal · 蛋白 ' + mt.prot + 'g';
    $('#planBody').innerHTML = MEALS.map((m) => {
      const its = plan.meals[m.k] || [];
      const s = sumItems(its);
      return '<div class="plan-meal"><div class="plan-meal-head"><b>' + m.ico + ' ' + m.n + '</b><span>' + fmt(s.k) + ' kcal · 蛋白 ' + s.p.toFixed(0) + 'g</span></div>' +
        its.map((i) => '<div class="dish"><span>' + esc(i.name) + '</span><span class="qty">' + i.grams + 'g</span><span class="kk">' + i.kcal + ' kcal</span></div>').join('') +
        '</div>';
    }).join('') +
      '<div style="border-top:1.5px solid var(--line);margin-top:8px;padding-top:10px;display:flex;justify-content:space-between;font-size:13px">' +
      '<b>合计 ' + fmt(plan.totals.k) + ' kcal</b>' +
      '<span style="color:var(--sub)">蛋白 ' + fmt(plan.totals.p) + 'g · 脂 ' + fmt(plan.totals.f) + 'g · 碳 ' + fmt(plan.totals.c) + 'g</span></div>';

    $('#planGoalChips').innerHTML = GOALS.map((g) =>
      '<button class="chip' + (S.profile.goal === g.v ? ' on' : '') + '" data-plan-goal="' + g.v + '">' + g.n + '</button>').join('');
    $('#planDietChips').innerHTML = DIET_TYPES.map((d) =>
      '<button class="chip' + (S.profile.dietType === d.v ? ' on' : '') + '" data-plan-diet="' + d.v + '">' + d.n + '</button>').join('');
    $('#planAvoidChips').innerHTML = AVOID_TAGS.map((a) =>
      '<button class="chip' + ((S.profile.avoid || []).indexOf(a.v) > -1 ? ' on-red' : '') + '" data-plan-avoid="' + a.v + '">' + a.n + '</button>').join('');
  }

  function renderWeek() {
    const w = getWeek();
    $('#weekBody').innerHTML = w.days.map((d) => {
      const mealsTxt = MEALS.map((m) => {
        const its = d.plan.meals[m.k] || [];
        return m.n + '：' + its.map((i) => i.name + i.grams + 'g').join('、');
      }).join('｜');
      return '<div class="day-card' + (d.isTrain ? '' : ' rest') + '">' +
        '<div class="day-top"><span class="day-tag' + (d.isTrain ? '' : ' rest') + '">' + d.week + '</span>' +
        '<span class="day-title">' + esc(d.focus) + '</span>' +
        '<span class="day-kcal">' + d.kTarget + ' kcal</span></div>' +
        '<div class="day-body">' +
        (d.moves.length ? '<div><i>动作</i><span>' + d.moves.map((m) => m.n + '（' + m.sets + '）').join('、') + '</span></div>' : '') +
        (d.cardio ? '<div><i>有氧</i><span>' + d.cardio.n + ' ' + d.cardio.min + ' 分钟</span></div>' : '') +
        (d.isTrain ? '<div><i>消耗</i><span>约 ' + d.burn + ' kcal</span></div>' : '<div><i>建议</i><span>散步 30 分钟 + 拉伸，保持蛋白摄入</span></div>') +
        '<div style="margin-top:4px;color:var(--sub);font-size:11.5px;line-height:1.55">' + esc(mealsTxt) + '</div>' +
        '</div></div>';
    }).join('');
  }

  /* ---------------- 渲染：动作库 ---------------- */
  let movePart = '全部', moveQuery = '';
  function renderMoves() {
    const p = S.profile;
    const parts = ['全部', '背', '胸', '腿', '臀', '肩', '手臂', '核心', '有氧', '柔韧'];
    $('#movePartChips').innerHTML = parts.map((x) =>
      '<button class="chip' + (movePart === x ? ' on' : '') + '" data-part="' + x + '">' + x + '</button>').join('');

    const reason = p.goal === 'lose'
      ? '减脂期：复合动作 + 有氧，保住肌肉'
      : p.goal === 'gain' ? '增肌期：大重量复合动作打底' : '维持期：力量与有氧均衡';
    $('#moveReason').textContent = reason;

    let list = EXERCISES.filter((e) => movePart === '全部' || e.part === movePart);
    if (moveQuery) {
      const q = moveQuery.toLowerCase();
      list = EXERCISES.filter((e) => (e.n + e.en + e.muscles + e.part).toLowerCase().indexOf(q) > -1);
    }
    // 按目标加权排序
    const weightOf = (e) => {
      let s = 0;
      if (p.goal === 'lose') { if (e.part === '有氧') s += 3; if (['squat', 'rdl', 'lat-pulldown', 'seated-row', 'pushup'].indexOf(e.id) > -1) s += 2; if (e.met >= 6) s += 1; }
      if (p.goal === 'gain') { if (['squat', 'bench-press', 'rdl', 'ohp', 'lat-pulldown', 'seated-row', 'pullup'].indexOf(e.id) > -1) s += 3; if (e.part === '有氧') s -= 1; }
      if (p.goal === 'keep') { if (['squat', 'bench-press', 'lat-pulldown', 'seated-row', 'plank', 'run-easy'].indexOf(e.id) > -1) s += 2; }
      return s;
    };
    list = list.slice().sort((a, b) => weightOf(b) - weightOf(a));

    if (!list.length) { $('#moveList').innerHTML = '<div class="empty">没有找到匹配的动作</div>'; return; }

    $('#moveList').innerHTML = list.map((e) => {
      const bgc = { 背: 'bg-back', 胸: 'bg-chest', 腿: 'bg-leg', 臀: 'bg-glute', 肩: 'bg-shoulder', 手臂: 'bg-arm', 核心: 'bg-core', 有氧: 'bg-cardio', 柔韧: 'bg-flex' }[e.part] || 'bg-core';
      return '<div class="move" data-move="' + e.id + '">' +
        '<div class="move-badge ' + bgc + '">' + e.part + '</div>' +
        '<div class="move-body"><div class="move-name">' + esc(e.n) + ' <span class="en">' + esc(e.en) + '</span></div>' +
        '<div class="move-meta">' + esc(e.muscles) + '</div>' +
        '<div class="move-kcal">' + e.sets + ' · 30 分钟约 ' + exKcal(e.met, 30) + ' kcal</div></div>' +
        '<div style="color:#c3ccd8;font-size:16px">›</div></div>';
    }).join('');
  }

  /* ---------------- 渲染：我的 ---------------- */
  function renderMe() {
    const p = S.profile;
    $('#pSex').value = p.sex;
    $('#pAge').value = p.age;
    $('#pHeight').value = p.height;
    $('#pWeight').value = p.weight;
    $('#pBodyfat').value = p.bodyfat || '';
    $('#pActivity').innerHTML = ACTIVITY_LEVELS.map((a) =>
      '<option value="' + a.v + '">' + a.n + '（' + a.v + '）</option>').join('');
    $('#pActivity').value = String(p.activity);

    $('#goalChips').innerHTML = GOALS.map((g) =>
      '<button class="chip' + (p.goal === g.v ? ' on' : '') + '" data-goal="' + g.v + '">' + g.n + '</button>').join('');
    $('#freqChips').innerHTML = [2, 3, 4, 5, 6].map((f) =>
      '<button class="chip' + (+p.weeklyFreq === f ? ' on' : '') + '" data-freq="' + f + '">' + f + ' 天</button>').join('');
    $('#dietChips').innerHTML = DIET_TYPES.map((d) =>
      '<button class="chip' + (p.dietType === d.v ? ' on' : '') + '" data-diet="' + d.v + '">' + d.n + '</button>').join('');

    const mt = macroTargets(p);
    $('#mBmr').innerHTML = fmt(bmrOf(p)) + '<small>kcal</small>';
    $('#mTdee').innerHTML = fmt(tdeeOf(p)) + '<small>kcal</small>';
    $('#mTarget').innerHTML = mt.k + '<small>kcal</small>';
    $('#macroPlan').innerHTML =
      '<div class="macro"><div class="macro-row"><b>蛋白质</b><span>' + mt.prot + ' g · ' + mt.prot * 4 + ' kcal</span></div><div class="bar p"><i style="width:' + (mt.prot * 4 / mt.k * 100) + '%"></i></div></div>' +
      '<div class="macro"><div class="macro-row"><b>脂肪</b><span>' + mt.fat + ' g · ' + mt.fat * 9 + ' kcal</span></div><div class="bar f"><i style="width:' + (mt.fat * 9 / mt.k * 100) + '%"></i></div></div>' +
      '<div class="macro"><div class="macro-row"><b>碳水</b><span>' + mt.carb + ' g · ' + mt.carb * 4 + ' kcal</span></div><div class="bar c"><i style="width:' + (mt.carb * 4 / mt.k * 100) + '%"></i></div></div>';
    $('#formulaHint').textContent = p.bodyfat
      ? '基础代谢 = 370 + 21.6 × 去脂体重（Katch-McArdle），去脂体重 = ' + (+p.weight * (1 - p.bodyfat / 100)).toFixed(1) + ' kg。'
      : '基础代谢 = 10×体重 + 6.25×身高 − 5×年龄 ' + (p.sex === 'male' ? '+ 5' : '− 161') + '（Mifflin-St Jeor）。填体脂率会更准。';

    $('#weightChart').innerHTML = weightChartSvg();

    $('#sourceList').innerHTML = SOURCES.map((s) => '<li>· ' + esc(s) + '</li>').join('');
  }

  function renderWeightHistory() {
    $('#weightHistory').innerHTML = (S.weights || []).slice(-6).reverse().map((w) =>
      '<div class="item"><div class="item-body"><div class="item-name">' + w.date + '</div><div class="item-sub">' + (w.bf ? '体脂 ' + w.bf + '%' : '—') + '</div></div>' +
      '<button class="link" data-del-weight="' + w.date + '" style="margin-right:10px;font-size:11px">删除</button>' +
      '<div class="item-kcal">' + w.weight + ' <small>kg</small></div></div>').join('') || '<div class="empty">暂无历史</div>';
  }

  function weightChartSvg() {
    const all = (S.weights || []);
    const wArr = all.slice(-14);
    const bfArr = all.filter((a) => a.bf != null && a.bf !== '').slice(-14);
    if (wArr.length < 2) {
      return '<div class="empty"><div class="e-ico">📉</div>记录 2 次以上体重即可看到趋势</div>';
    }
    const W = 300, H = 104, L = 8, R = 8, T = 12, B = 20;
    // 每条线各自归一化：体重（kg）与体脂率（%）量纲不同，分开取刻度
    const span = (vals, minGap, padRatio) => {
      let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
      if (max - min < minGap) { min -= minGap / 2; max += minGap / 2; }
      const pad = (max - min) * padRatio;
      return [min - pad, max + pad];
    };
    const [wMin, wMax] = span(wArr.map((a) => +a.weight), 1, 0.18);
    const hasBf = bfArr.length >= 2;
    const [bMin, bMax] = hasBf ? span(bfArr.map((a) => +a.bf), 0.5, 0.22) : [0, 1];
    const X = (i, n) => L + (i * (W - L - R)) / (n - 1);
    const Yw = (v) => T + (1 - (v - wMin) / (wMax - wMin)) * (H - T - B);
    const Yb = (v) => T + (1 - (v - bMin) / (bMax - bMin)) * (H - T - B);

    const wPts = wArr.map((a, i) => X(i, wArr.length) + ',' + Yw(+a.weight)).join(' ');
    const wDots = wArr.map((a, i) => '<circle cx="' + X(i, wArr.length) + '" cy="' + Yw(+a.weight) + '" r="2.4" fill="#12b886"/>').join('');
    const first = wArr[0], last = wArr[wArr.length - 1];
    const wChange = (+last.weight - +first.weight).toFixed(1);

    let svg = '<svg class="trend" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<polyline points="' + wPts + '" fill="none" stroke="#12b886" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      wDots;
    let footer = '<span>共 ' + all.length + ' 条记录</span><span>体重 ' + (wChange > 0 ? '+' : '') + wChange + ' kg</span>';
    if (hasBf) {
      const bPts = bfArr.map((a, i) => X(i, bfArr.length) + ',' + Yb(+a.bf)).join(' ');
      const bDots = bfArr.map((a, i) => '<circle cx="' + X(i, bfArr.length) + '" cy="' + Yb(+a.bf) + '" r="2.4" fill="#339af0"/>').join('');
      svg += '<polyline points="' + bPts + '" fill="none" stroke="#339af0" stroke-width="2" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round"/>' + bDots;
      const bChange = (+bfArr[bfArr.length - 1].bf - +bfArr[0].bf).toFixed(1);
      footer = '<span>共 ' + all.length + ' 条记录</span><span>体重 ' + (wChange > 0 ? '+' : '') + wChange + ' kg · 体脂 ' + (bChange > 0 ? '+' : '') + bChange + ' %</span>';
    }
    svg += '<text x="' + L + '" y="' + (H - 5) + '" font-size="9" fill="#9aa6b8">' + first.date.slice(5) + ' · ' + first.weight + 'kg</text>' +
      '<text x="' + (W - R) + '" y="' + (H - 5) + '" font-size="9" fill="#9aa6b8" text-anchor="end">' + last.date.slice(5) + ' · ' + last.weight + 'kg</text>' +
      '</svg>';

    const legend = '<div style="display:flex;gap:14px;font-size:11px;color:var(--sub);margin-bottom:4px">' +
      '<span style="display:flex;align-items:center;gap:4px"><i style="width:14px;height:2.5px;background:#12b886;border-radius:1px"></i>体重 kg</span>' +
      (hasBf
        ? '<span style="display:flex;align-items:center;gap:4px"><i style="width:14px;height:2.5px;background:#339af0;border-radius:1px"></i>体脂率 %</span>'
        : '<span>记录 2 次体脂后显示体脂曲线</span>') +
      '</div>';
    return legend + svg +
      '<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--sub);margin-top:2px">' + footer + '</div>';
  }

  /* ---------------- 弹层控制 ---------------- */
  function openSheet(id) {
    $('#mask').classList.add('on');
    $('#' + id).classList.add('on');
  }
  function closeSheets() {
    $('#mask').classList.remove('on');
    $$('.sheet').forEach((s) => s.classList.remove('on'));
  }

  /* ---------------- 添加饮食弹层 ---------------- */
  function openFoodSheet(meal) {
    curMeal = meal;
    pendingFoods = [];
    pendingPhoto = null;
    $('#foodSheetTitle').textContent = '添加' + MEAL_NAME[meal] + ' · ' + dlabel(curDate);
    $('#foodText').value = '';
    $('#photoText').value = '';
    $('#searchGrams').value = '';
    $('#foodSearch').value = '';
    $('#foodSearchList').innerHTML = '';
    $('#parseResult').innerHTML = '';
    $('#photoResult').innerHTML = '';
    $('#photoBox').innerHTML = '<label class="photo-drop" for="photoInput" style="display:block">' +
      '<div class="ph-ico">📷</div><p>拍一张 / 从相册选择</p>' +
      '<p style="font-size:11px;opacity:.75">照片会压缩后保存在本地，作为饮食留档</p></label>';
    renderPending();
    setFoodMode('text');
    openSheet('sheet-food');
  }

  function renderPending() {
    const box = $('#pendingBox');
    if (!box) return;
    if (!pendingFoods.length) { box.innerHTML = ''; return; }
    const s = sumItems(pendingFoods);
    box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 4px;font-size:12px">' +
      '<b style="color:var(--ink-2)">待加入 ' + pendingFoods.length + ' 项</b>' +
      '<span style="color:var(--brand-d);font-weight:700">' + fmt(s.k) + ' kcal</span></div>' +
      pendingFoods.map((i) => '<div class="item"><div class="item-thumb ph" style="background:var(--brand-l)">🍽️</div>' +
        '<div class="item-body"><div class="item-name">' + esc(i.name) + '</div><div class="item-sub">' + i.grams + 'g · 蛋白 ' + i.p + 'g</div></div>' +
        '<div class="item-kcal">' + i.kcal + ' <small>kcal</small></div>' +
        '<button class="del" data-pdel="' + i.id + '">✕</button></div>').join('');
  }

  function setFoodMode(mode) {
    $$('#foodMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#modeText').style.display = mode === 'text' ? '' : 'none';
    $('#modePhoto').style.display = mode === 'photo' ? '' : 'none';
    $('#modeSearch').style.display = mode === 'search' ? '' : 'none';
    if (mode === 'search') setTimeout(() => $('#foodSearch').focus(), 60);
  }

  /* ---------------- 运动弹层 ---------------- */
  function openExerciseSheet() {
    selectedEx = null;
    $('#exSearch').value = '';
    $('#exSearchList').innerHTML = '';
    $('#exMin').value = 30;
    $('#exEstimate').textContent = '选择动作后显示预计消耗';
    renderExSuggest('');
    openSheet('sheet-exercise');
  }
  function renderExSuggest(q) {
    let list = EXERCISES;
    if (q) list = EXERCISES.filter((e) => (e.n + e.en + e.part).toLowerCase().indexOf(q.toLowerCase()) > -1);
    $('#exSearchList').innerHTML = list.slice(0, 12).map((e) =>
      '<div class="sg" data-pick-ex="' + e.id + '"><span>' + esc(e.n) + '</span><em>' + e.part + ' · ' + exKcal(e.met, 30) + ' kcal/30min</em></div>').join('');
  }
  function updateExEstimate() {
    if (!selectedEx) return;
    const min = +$('#exMin').value || 0;
    const mul = +$('#exIntensity').value || 1;
    const k = exKcal(selectedEx.met * mul, min);
    $('#exEstimate').textContent = selectedEx.n + ' · ' + min + ' 分钟 · 约 ' + k + ' kcal（按 ' + (+S.profile.weight || 60) + 'kg 体重估算）';
  }

  /* ---------------- 动作详情 ---------------- */
  function openMove(id) {
    const e = EXERCISES.find((x) => x.id === id);
    if (!e) return;
    $('#mvTitle').textContent = e.n;
    $('#mvBody').innerHTML =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' +
      '<span class="tag-src">' + e.part + '</span><span class="tag-src">' + e.equip + '</span><span class="tag-src">' + e.lvl + '</span></div>' +
      '<div class="stat-grid" style="margin-bottom:14px">' +
      '<div class="stat"><em style="font-size:13px">' + e.sets.split('×')[0].trim() + '</em><span>组数</span></div>' +
      '<div class="stat"><em style="font-size:13px">' + (e.sets.split('×')[1] || '—').trim() + '</em><span>次数/时长</span></div>' +
      '<div class="stat"><em style="font-size:13px">' + exKcal(e.met, 30) + '</em><span>30min kcal</span></div></div>' +
      '<div style="font-size:12.5px;color:var(--sub);margin-bottom:4px">目标肌群</div>' +
      '<div style="font-size:13.5px;margin-bottom:14px">' + esc(e.muscles) + '</div>' +
      '<div style="font-size:13px;font-weight:700;margin-bottom:6px">动作要领</div>' +
      '<ol style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.75;color:var(--ink-2)">' +
      e.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' +
      '<div style="font-size:13px;font-weight:700;margin-bottom:6px">常见错误</div>' +
      '<ul style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.75;color:#b45309">' +
      e.miss.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul>' +
      '<div style="font-size:12.5px;color:var(--sub);margin-bottom:4px">组间休息</div>' +
      '<div style="font-size:13.5px;margin-bottom:14px">' + esc(e.rest) + '</div>' +
      '<span class="tag-src">参考：' + esc(e.src) + '</span>' +
      '<div class="btn-row" style="margin-top:16px"><button class="btn btn-primary btn-sm" data-log-move="' + e.id + '">记入今天运动</button></div>';
    openSheet('sheet-move');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    // 底部导航
    $$('#tabbar button').forEach((b) => {
      b.addEventListener('click', () => switchView(b.dataset.view));
    });
    document.addEventListener('click', (ev) => {
      const goto = ev.target.closest('[data-goto]');
      if (goto) switchView(goto.dataset.goto);
    });

    // 遮罩 / 关闭
    $('#mask').addEventListener('click', closeSheets);
    $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

    // 记录页日期切换
    $('#dayPrev').addEventListener('click', () => { shiftDate(-1); });
    $('#dayNext').addEventListener('click', () => { shiftDate(1); });

    // 添加饮食
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-add-meal]');
      if (b) { openFoodSheet(b.dataset.addMeal); return; }
      const df = ev.target.closest('[data-del-food]');
      if (df) {
        const [meal, id] = df.dataset.delFood.split('|');
        const lg = dayLog(curDate);
        lg.meals[meal] = lg.meals[meal].filter((i) => i.id !== id);
        save(); syncDay(curDate, lg); renderAll(); toast('已删除');
        return;
      }
      const de = ev.target.closest('[data-del-ex]');
      if (de) {
        const lg = dayLog(curDate);
        lg.exercises = lg.exercises.filter((e) => e.id !== de.dataset.delEx);
        save(); syncDay(curDate, lg); renderAll(); toast('已删除');
        return;
      }
      const pd = ev.target.closest('[data-pdel]');
      if (pd) {
        pendingFoods = pendingFoods.filter((i) => i.id !== pd.dataset.pdel);
        renderPending();
        return;
      }
    });

    // 饮食弹层模式
    $('#foodMode').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-mode]');
      if (b) setFoodMode(b.dataset.mode);
    });

    // 文字解析
    $('#parseTextBtn').addEventListener('click', () => {
      const txt = $('#foodText').value.trim();
      if (!txt) { toast('先写点吃了什么吧'); return; }
      const r = parseFoodText(txt);
      if (!r.items.length) {
        $('#parseResult').innerHTML = '<div class="note warn"><i>🤔</i><span>没识别出食物。试试更常见的说法，如"鸡胸肉150g、米饭一碗"，或切到「食物库」手动选。</span></div>';
        return;
      }
      pendingFoods = pendingFoods.concat(r.items);
      $('#parseResult').innerHTML = r.miss.length
        ? '<div class="note"><i>ℹ️</i><span>已识别 ' + r.items.length + ' 项，未识别：' + esc(r.miss.join('、')) + '（可切到食物库手动补）</span></div>'
        : '';
      renderPending();
      toast('已解析 ' + r.items.length + ' 项');
    });

    // 拍照
    $('#photoInput').addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      compressImage(f, 560, 0.6).then((data) => {
        pendingPhoto = data;
        $('#photoBox').innerHTML = '<div class="photo-preview"><img src="' + data + '" alt="饮食照片" />' +
          '<button class="rm" id="rmPhoto">✕</button></div>';
        $('#rmPhoto').addEventListener('click', () => {
          pendingPhoto = null;
          $('#photoBox').innerHTML = '<label class="photo-drop" for="photoInput" style="display:block">' +
            '<div class="ph-ico">📷</div><p>拍一张 / 从相册选择</p></label>';
        });
      }).catch(() => toast('图片读取失败'));
    });

    $('#parsePhotoBtn').addEventListener('click', () => {
      const txt = $('#photoText').value.trim();
      if (!txt) { toast('补充一句描述才能算热量哦'); return; }
      const r = parseFoodText(txt);
      if (!r.items.length) {
        $('#photoResult').innerHTML = '<div class="note warn"><i>🤔</i><span>没识别出食物，换个说法或切到食物库手动选。</span></div>';
        return;
      }
      pendingFoods = pendingFoods.concat(r.items);
      $('#photoResult').innerHTML = '<div class="note ok"><i>✅</i><span>已按描述计算 ' + r.items.length + ' 项，确认后照片会一起存入记录。</span></div>';
      renderPending();
      toast('已解析 ' + r.items.length + ' 项');
    });

    // 食物库搜索
    let foodSearchTimer = null;
    $('#foodSearch').addEventListener('input', (ev) => {
      const q = ev.target.value.trim();
      if (!q) { $('#foodSearchList').innerHTML = ''; return; }
      const renderList = (rows) => {
        $('#foodSearchList').innerHTML = rows.length
          ? rows.map((f) => '<div class="sg" data-pick-food="' + f.n + '"><span>' + f.n + '</span><em>' + Math.round(f.k) + ' kcal/100g</em></div>').join('')
          : '<div class="sg"><span>没有找到</span><em>试试别的关键词</em></div>';
      };
      // 先用本地数据集即时反馈
      renderList(FOODS.filter((f) => (f.n + (f.a || []).join('')).indexOf(q) > -1).slice(0, 10));
      // 在线时改由服务端 SQLite 食物库检索
      if (window.API && window.API.online) {
        clearTimeout(foodSearchTimer);
        foodSearchTimer = setTimeout(() => {
          window.API.searchFoods(q)
            .then((r) => { if (r && r.items && r.items.length) renderList(r.items.slice(0, 10)); })
            .catch(() => {});
        }, 260);
      }
    });
    $('#foodSearchList').addEventListener('click', (ev) => {
      const it = ev.target.closest('[data-pick-food]');
      if (!it) return;
      const f = FOOD_BY_NAME[it.dataset.pickFood];
      if (!f) return;
      const g = +$('#searchGrams').value || f.g || 100;
      pendingFoods.push(scaleFood(f, g));
      renderPending();
      toast('已加入 ' + f.n);
    });

    // 确认加入饮食
    $('#confirmFood').addEventListener('click', () => {
      if (!pendingFoods.length) { toast('还没有要加入的食物'); return; }
      const lg = dayLog(curDate);
      const first = pendingFoods[0];
      if (pendingPhoto && first) first.photo = pendingPhoto;
      lg.meals[curMeal] = lg.meals[curMeal].concat(pendingFoods);
      save();
      syncDay(curDate, lg);
      const k = fmt(sumItems(pendingFoods).k);
      pendingFoods = []; pendingPhoto = null;
      closeSheets();
      renderAll();
      toast('已加入 ' + MEAL_NAME[curMeal] + ' · ' + k + ' kcal');
    });

    // 运动
    $('#quickAddExercise').addEventListener('click', openExerciseSheet);
    $('#addExerciseBtn').addEventListener('click', openExerciseSheet);
    $('#exSearch').addEventListener('input', (ev) => renderExSuggest(ev.target.value.trim()));
    $('#exSearchList').addEventListener('click', (ev) => {
      const it = ev.target.closest('[data-pick-ex]');
      if (!it) return;
      selectedEx = EXERCISES.find((e) => e.id === it.dataset.pickEx);
      $('#exSearch').value = selectedEx.n;
      $('#exSearchList').innerHTML = '';
      updateExEstimate();
    });
    $('#exMin').addEventListener('input', updateExEstimate);
    $('#exIntensity').addEventListener('change', updateExEstimate);
    $('#confirmExercise').addEventListener('click', () => {
      if (!selectedEx) { toast('先选一个运动'); return; }
      const min = clamp(+$('#exMin').value || 0, 1, 600);
      const mul = +$('#exIntensity').value || 1;
      const lg = dayLog(curDate);
      lg.exercises.push({
        id: uid(), name: selectedEx.n, min,
        met: +(selectedEx.met * mul).toFixed(1),
        kcal: exKcal(selectedEx.met * mul, min)
      });
      save(); syncDay(curDate, lg); closeSheets(); renderAll();
      toast('已记录 ' + selectedEx.n + ' ' + min + ' 分钟');
    });

    // 动作库
    $('#movePartChips').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-part]');
      if (!b) return;
      movePart = b.dataset.part; moveQuery = ''; $('#moveSearch').value = '';
      renderMoves();
    });
    $('#moveSearch').addEventListener('input', (ev) => { moveQuery = ev.target.value.trim(); renderMoves(); });
    $('#moveList').addEventListener('click', (ev) => {
      const it = ev.target.closest('[data-move]');
      if (it) openMove(it.dataset.move);
    });
    $('#mvBody').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-log-move]');
      if (!b) return;
      const e = EXERCISES.find((x) => x.id === b.dataset.logMove);
      if (!e) return;
      const lg = dayLog(curDate);
      lg.exercises.push({ id: uid(), name: e.n, min: 40, met: e.met, kcal: exKcal(e.met, 40) });
      save(); syncDay(curDate, lg); closeSheets(); renderAll();
      toast('已记入今天：' + e.n + ' 40 分钟');
    });

    // 我的：保存
    $('#saveProfile').addEventListener('click', () => {
      const p = S.profile;
      p.sex = $('#pSex').value;
      p.age = clamp(+$('#pAge').value || 26, 10, 99);
      p.height = clamp(+$('#pHeight').value || 165, 120, 230);
      p.weight = clamp(+$('#pWeight').value || 60, 30, 250);
      const bf = $('#pBodyfat').value;
      p.bodyfat = bf ? clamp(+bf, 3, 60) : null;
      p.activity = +$('#pActivity').value || 1.375;
      S.plans = {}; S.week = null;
      addWeightRecord(p.weight, p.bodyfat);
      save(); syncProfile(); syncWeight(); renderAll();
      toast('已保存，代谢与食谱已更新');
    });

    document.addEventListener('click', (ev) => {
      const g = ev.target.closest('[data-goal]');
      if (g) { S.profile.goal = g.dataset.goal; S.plans = {}; S.week = null; save(); syncProfile(); renderAll(); return; }
      const f = ev.target.closest('[data-freq]');
      if (f) { S.profile.weeklyFreq = +f.dataset.freq; S.week = null; save(); syncProfile(); renderAll(); return; }
      const d = ev.target.closest('[data-diet]');
      if (d) { S.profile.dietType = d.dataset.diet; S.plans = {}; S.week = null; save(); syncProfile(); renderAll(); return; }
      const pg = ev.target.closest('[data-plan-goal]');
      if (pg) { S.profile.goal = pg.dataset.planGoal; S.plans = {}; S.week = null; save(); syncProfile(); renderAll(); return; }
      const pd = ev.target.closest('[data-plan-diet]');
      if (pd) { S.profile.dietType = pd.dataset.planDiet; S.plans = {}; S.week = null; save(); syncProfile(); renderAll(); return; }
      const pa = ev.target.closest('[data-plan-avoid]');
      if (pa) {
        const v = pa.dataset.planAvoid;
        const arr = S.profile.avoid || (S.profile.avoid = []);
        const i = arr.indexOf(v);
        if (i > -1) arr.splice(i, 1); else arr.push(v);
        S.plans = {}; S.week = null; save(); syncProfile(); renderAll(); return;
      }
    });

    // 食谱
    $('#planSeg').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-tab]');
      if (!b) return;
      $$('#planSeg button').forEach((x) => x.classList.toggle('on', x === b));
      $('#planDay').style.display = b.dataset.tab === 'day' ? '' : 'none';
      $('#planWeek').style.display = b.dataset.tab === 'week' ? '' : 'none';
      if (b.dataset.tab === 'week') renderWeek();
    });
    $('#regenPlan').addEventListener('click', () => {
      S.plans[today()] = buildDayPlan({ kcal: targetKcal(S.profile) });
      save(); syncPlan(today()); renderAll(); toast('已换一份食谱');
    });
    $('#applyPlan').addEventListener('click', () => {
      const plan = getPlan(today());
      const lg = dayLog(today());
      MEALS.forEach((m) => {
        (plan.meals[m.k] || []).forEach((i) => {
          lg.meals[m.k].push({ id: uid(), name: i.name, grams: i.grams, kcal: i.kcal, p: i.p, f: i.f, c: i.c });
        });
      });
      save(); syncDay(today(), lg); renderAll(); toast('食谱已记入今日饮食');
      switchView('today');
    });
    $('#regenWeek').addEventListener('click', () => {
      S.week = buildWeek(); S.week.start = today(); save(); syncWeek(); renderWeek(); toast('已重新规划一周');
    });

    // 体重记录
    $('#addWeightBtn').addEventListener('click', () => {
      $('#wWeight').value = S.profile.weight;
      $('#wBodyfat').value = S.profile.bodyfat || '';
      renderWeightHistory();
      openSheet('sheet-weight');
    });
    $('#weightHistory').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-del-weight]');
      if (!btn) return;
      const date = btn.dataset.delWeight;
      S.weights = (S.weights || []).filter((w) => w.date !== date);
      save();
      if (window.API && window.API.online) push(() => window.API.delWeight(date));
      renderWeightHistory();
      renderAll();
      toast('已删除 ' + date + ' 的记录');
    });
    // 清空趋势（双击确认，防止误触）
    const clearBtn = $('#clearWeightsBtn');
    clearBtn.addEventListener('click', () => {
      if (clearBtn.dataset.armed !== '1') {
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = '确认清空？';
        setTimeout(() => { clearBtn.dataset.armed = ''; clearBtn.textContent = '清空'; }, 3000);
        return;
      }
      clearBtn.dataset.armed = '';
      clearBtn.textContent = '清空';
      S.weights = [];
      save();
      if (window.API && window.API.online) push(() => window.API.clearWeights());
      renderAll();
      toast('趋势数据已清空，重新记录即可');
    });
    $('#confirmWeight').addEventListener('click', () => {
      const w = +$('#wWeight').value;
      if (!w) { toast('请输入体重'); return; }
      const bf = $('#wBodyfat').value ? +$('#wBodyfat').value : null;
      S.profile.weight = clamp(w, 30, 250);
      if (bf) S.profile.bodyfat = clamp(bf, 3, 60);
      addWeightRecord(S.profile.weight, S.profile.bodyfat);
      S.plans = {}; S.week = null;
      save(); syncProfile(); syncWeight(); closeSheets(); renderAll(); toast('已记录体重');
    });

    // 手机端阻止双击缩放（可选）
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  function shiftDate(n) {
    const d = dparse(curDate);
    d.setDate(d.getDate() + n);
    const next = dstr(d);
    if (next > today()) { toast('未来的记录可以去「食谱 → 一周计划」规划'); return; }
    curDate = next;
    renderLog();
  }

  function switchView(v) {
    $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'week' || v === 'plan') { /* noop */ }
    if (v === 'moves') renderMoves();
    if (v === 'me') renderMe();
    if (v === 'plan') { renderPlan(); if ($('#planWeek').style.display !== 'none') renderWeek(); }
    if (v === 'log') renderLog();
    const sc = $('#scroll');
    if (sc) sc.scrollTop = 0;
  }

  function renderAll() {
    renderToday();
    renderLog();
    renderPlan();
    renderMe();
    if ($('#planWeek').style.display !== 'none') renderWeek();
    if (document.querySelector('#view-moves.active')) renderMoves();
  }

  /* ---------------- 图片压缩 ---------------- */
  function compressImage(file, max, q) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', q));
        };
        img.onerror = reject;
        img.src = fr.result;
      };
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  /* ---------------- 初始化 ---------------- */
  function applyBoot(boot) {
    if (!boot) return;
    if (boot.profile) S.profile = Object.assign({}, S.profile, boot.profile);
    if (boot.logs) {
      Object.keys(boot.logs).forEach((d) => {
        const day = boot.logs[d] || {};
        const meals = { breakfast: [], lunch: [], dinner: [], snack: [] };
        MEALS.forEach((m) => { meals[m.k] = (day.meals && day.meals[m.k]) ? day.meals[m.k] : []; });
        S.logs[d] = { meals, exercises: day.exercises || [] };
      });
    }
    if (boot.weights && boot.weights.length) S.weights = boot.weights;
    if (boot.plans) S.plans = Object.assign({}, S.plans, boot.plans);
    if (boot.week && boot.week.days) S.week = boot.week;
  }

  async function init() {
    // 待加入区域
    const box = document.createElement('div');
    box.id = 'pendingBox';
    $('#sheet-food .sheet-body').appendChild(box);

    bind();

    // 连接后端并拉取已有数据（失败则保持本地模式）
    if (window.API && window.API.available) {
      try {
        if (await window.API.check()) {
          const boot = await window.API.bootstrap(90);
          applyBoot(boot);
        }
      } catch (e) {
        window.API.online = false;
      }
    }

    if (!S.weights.length) S.weights.push({ date: today(), weight: S.profile.weight, bf: S.profile.bodyfat });
    updateSyncDot();
    save();
    renderAll();
    switchView('today');

    // 首次生成的今日食谱也写入后端
    if (window.API && window.API.online) syncPlan(today());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

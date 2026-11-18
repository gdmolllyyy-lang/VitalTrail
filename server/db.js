/* =========================================================
   Healthy · 数据库层
   使用 Node.js 内置 node:sqlite（Node >= 22.5，需 --experimental-sqlite）
   首次运行自动建库建表，并从 shared/dataset.js 导入食物库 / 动作库
   ========================================================= */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'healthy.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

/* ---------------- 建表 ---------------- */
db.exec(`
CREATE TABLE IF NOT EXISTS profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  sex           TEXT    NOT NULL DEFAULT 'female',
  age           INTEGER NOT NULL DEFAULT 26,
  height        REAL    NOT NULL DEFAULT 165,
  weight        REAL    NOT NULL DEFAULT 60,
  bodyfat       REAL,
  activity      REAL    NOT NULL DEFAULT 1.375,
  goal          TEXT    NOT NULL DEFAULT 'keep',
  diet_type     TEXT    NOT NULL DEFAULT 'balanced',
  avoid         TEXT    NOT NULL DEFAULT '[]',
  weekly_freq   INTEGER NOT NULL DEFAULT 3,
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS food_log (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  meal       TEXT NOT NULL,
  name       TEXT NOT NULL,
  grams      REAL NOT NULL DEFAULT 0,
  kcal       REAL NOT NULL DEFAULT 0,
  protein    REAL NOT NULL DEFAULT 0,
  fat        REAL NOT NULL DEFAULT 0,
  carb       REAL NOT NULL DEFAULT 0,
  photo      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_food_date ON food_log(date);

CREATE TABLE IF NOT EXISTS exercise_log (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  name       TEXT NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 0,
  met        REAL NOT NULL DEFAULT 0,
  kcal       REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ex_date ON exercise_log(date);

CREATE TABLE IF NOT EXISTS weight_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  weight     REAL NOT NULL,
  bodyfat    REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_weight_date ON weight_log(date);

CREATE TABLE IF NOT EXISTS day_plan (
  date       TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS week_plan (
  start_date TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS food (
  name       TEXT PRIMARY KEY,
  alias      TEXT,
  kcal       REAL NOT NULL,
  protein    REAL NOT NULL DEFAULT 0,
  fat        REAL NOT NULL DEFAULT 0,
  carb       REAL NOT NULL DEFAULT 0,
  unit       TEXT,
  unit_grams REAL,
  category   TEXT,
  tag        TEXT
);

CREATE TABLE IF NOT EXISTS exercise (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_en    TEXT,
  part       TEXT,
  equip      TEXT,
  met        REAL,
  level      TEXT,
  sets       TEXT,
  rest       TEXT,
  muscles    TEXT,
  steps      TEXT,
  mistakes   TEXT,
  source     TEXT
);
`);

/* ---------------- 默认档案 ---------------- */
const DEFAULT_PROFILE = {
  sex: 'female', age: 26, height: 165, weight: 60, bodyfat: null,
  activity: 1.375, goal: 'keep', dietType: 'balanced', avoid: [], weeklyFreq: 3
};

function rowToProfile(r) {
  if (!r) return { ...DEFAULT_PROFILE };
  let avoid = [];
  try { avoid = JSON.parse(r.avoid || '[]'); } catch (e) { avoid = []; }
  return {
    sex: r.sex, age: r.age, height: r.height, weight: r.weight,
    bodyfat: r.bodyfat == null ? null : r.bodyfat,
    activity: r.activity, goal: r.goal, dietType: r.diet_type,
    avoid, weeklyFreq: r.weekly_freq
  };
}

function getProfile() {
  const r = db.prepare('SELECT * FROM profile WHERE id = 1').get();
  return rowToProfile(r);
}

function saveProfile(p) {
  const cur = getProfile();
  const v = Object.assign({}, cur, p || {});
  db.prepare(`
    INSERT INTO profile (id, sex, age, height, weight, bodyfat, activity, goal, diet_type, avoid, weekly_freq, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(id) DO UPDATE SET
      sex=excluded.sex, age=excluded.age, height=excluded.height, weight=excluded.weight,
      bodyfat=excluded.bodyfat, activity=excluded.activity, goal=excluded.goal,
      diet_type=excluded.diet_type, avoid=excluded.avoid, weekly_freq=excluded.weekly_freq,
      updated_at=excluded.updated_at
  `).run(
    v.sex, Math.round(v.age), v.height, v.weight,
    v.bodyfat == null || v.bodyfat === '' ? null : v.bodyfat,
    v.activity, v.goal, v.dietType, JSON.stringify(v.avoid || []), Math.round(v.weeklyFreq)
  );
  return getProfile();
}

/* ---------------- 日志 ---------------- */
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

function getDay(date) {
  const meals = { breakfast: [], lunch: [], dinner: [], snack: [] };
  const rows = db.prepare(
    'SELECT id, meal, name, grams, kcal, protein, fat, carb, photo FROM food_log WHERE date = ? ORDER BY created_at, rowid'
  ).all(date);
  rows.forEach((r) => {
    if (!meals[r.meal]) meals[r.meal] = [];
    meals[r.meal].push({
      id: r.id, name: r.name, grams: r.grams, kcal: r.kcal,
      p: r.protein, f: r.fat, c: r.carb, photo: r.photo || undefined
    });
  });
  const ex = db.prepare(
    'SELECT id, name, minutes, met, kcal FROM exercise_log WHERE date = ? ORDER BY created_at, rowid'
  ).all(date).map((r) => ({ id: r.id, name: r.name, min: r.minutes, met: r.met, kcal: r.kcal }));
  return { date, meals, exercises: ex };
}

/** 整日覆盖写入（幂等）：先清空该日，再批量插入 */
function putDay(date, day) {
  const meals = (day && day.meals) || {};
  const exercises = (day && day.exercises) || [];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM food_log WHERE date = ?').run(date);
    db.prepare('DELETE FROM exercise_log WHERE date = ?').run(date);
    const insF = db.prepare(`INSERT INTO food_log (id, date, meal, name, grams, kcal, protein, fat, carb, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    MEALS.forEach((m) => {
      (meals[m] || []).forEach((i, idx) => {
        insF.run(
          String(i.id || (date + '-' + m + '-' + idx + '-' + Math.random().toString(36).slice(2, 7))),
          date, m, String(i.name || '未命名'), Number(i.grams) || 0, Number(i.kcal) || 0,
          Number(i.p) || 0, Number(i.f) || 0, Number(i.c) || 0,
          i.photo ? String(i.photo) : null
        );
      });
    });
    const insE = db.prepare('INSERT INTO exercise_log (id, date, name, minutes, met, kcal) VALUES (?, ?, ?, ?, ?, ?)');
    exercises.forEach((e, idx) => {
      insE.run(
        String(e.id || (date + '-e-' + idx + '-' + Math.random().toString(36).slice(2, 7))),
        date, String(e.name || '运动'), Math.round(Number(e.min) || 0),
        Number(e.met) || 0, Number(e.kcal) || 0
      );
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getDay(date);
}

function clearDay(date) {
  db.prepare('DELETE FROM food_log WHERE date = ?').run(date);
  db.prepare('DELETE FROM exercise_log WHERE date = ?').run(date);
  return getDay(date);
}

/* ---------------- 体重 ---------------- */
function getWeights(limit = 120) {
  return db.prepare('SELECT date, weight, bodyfat AS bf FROM weight_log ORDER BY date DESC, id DESC LIMIT ?')
    .all(limit).reverse();
}
function addWeight(w) {
  const date = String(w.date || new Date().toISOString().slice(0, 10));
  const bf = w.bf == null || w.bf === '' ? null : Number(w.bf);
  db.prepare('DELETE FROM weight_log WHERE date = ?').run(date);
  db.prepare('INSERT INTO weight_log (date, weight, bodyfat) VALUES (?, ?, ?)')
    .run(date, Number(w.weight) || 0, bf);
  return getWeights();
}
function deleteWeight(date) {
  db.prepare('DELETE FROM weight_log WHERE date = ?').run(date);
  return getWeights();
}
function clearWeights() {
  db.prepare('DELETE FROM weight_log').run();
  return getWeights();
}

/* ---------------- 计划 ---------------- */
function getPlan(date) {
  const r = db.prepare('SELECT payload FROM day_plan WHERE date = ?').get(date);
  if (!r) return null;
  try { return JSON.parse(r.payload); } catch (e) { return null; }
}
function putPlan(date, payload) {
  db.prepare(`INSERT INTO day_plan (date, payload, updated_at) VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(date) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
    .run(date, JSON.stringify(payload));
  return getPlan(date);
}
function getWeek() {
  const r = db.prepare('SELECT start_date, payload FROM week_plan ORDER BY start_date DESC LIMIT 1').get();
  if (!r) return null;
  try { return Object.assign({ start: r.start_date }, JSON.parse(r.payload)); } catch (e) { return null; }
}
function putWeek(week) {
  const start = String(week.start || new Date().toISOString().slice(0, 10));
  db.prepare(`INSERT INTO week_plan (start_date, payload, updated_at) VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(start_date) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
    .run(start, JSON.stringify({ days: week.days || [] }));
  return getWeek();
}

/* ---------------- 食物库 / 动作库 ---------------- */
function getFoods(q) {
  if (q) {
    const like = '%' + q + '%';
    return db.prepare('SELECT * FROM food WHERE name LIKE ? OR IFNULL(alias, \'\') LIKE ? ORDER BY name LIMIT 50').all(like, like);
  }
  return db.prepare('SELECT * FROM food ORDER BY name').all();
}
function getExercises(part) {
  if (part) return db.prepare('SELECT * FROM exercise WHERE part = ? ORDER BY name').all(part);
  return db.prepare('SELECT * FROM exercise ORDER BY part, name').all();
}

/* ---------------- 启动初始化：导入数据集 ---------------- */
function seed() {
  const ds = require('../shared/dataset.js');

  db.exec('BEGIN');
  try {
    const insF = db.prepare(`INSERT INTO food (name, alias, kcal, protein, fat, carb, unit, unit_grams, category, tag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET alias=excluded.alias, kcal=excluded.kcal, protein=excluded.protein,
        fat=excluded.fat, carb=excluded.carb, unit=excluded.unit, unit_grams=excluded.unit_grams,
        category=excluded.category, tag=excluded.tag`);
    ds.FOODS.forEach((f) => {
      insF.run(f.n, JSON.stringify(f.a || []), f.k, f.p, f.f, f.c, f.u || '份', f.g || 100, f.cat || '', f.tag || null);
    });

    const insE = db.prepare(`INSERT INTO exercise (id, name, name_en, part, equip, met, level, sets, rest, muscles, steps, mistakes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, name_en=excluded.name_en, part=excluded.part,
        equip=excluded.equip, met=excluded.met, level=excluded.level, sets=excluded.sets, rest=excluded.rest,
        muscles=excluded.muscles, steps=excluded.steps, mistakes=excluded.mistakes, source=excluded.source`);
    ds.EXERCISES.forEach((e) => {
      insE.run(e.id, e.n, e.en || '', e.part, e.equip, e.met, e.lvl, e.sets, e.rest,
        e.muscles, JSON.stringify(e.steps || []), JSON.stringify(e.miss || []), e.src || '');
    });

    const hasProfile = db.prepare('SELECT COUNT(*) AS c FROM profile').get().c;
    if (!hasProfile) saveProfile(DEFAULT_PROFILE);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------------- 统计（展示 SQL 聚合） ---------------- */
function stats(days = 7) {
  const d = Math.max(1, Math.min(365, Number(days) || 7));
  const from = db.prepare("SELECT date('now','localtime', ? ) AS d").get('-' + (d - 1) + ' days').d;
  const intake = db.prepare(`
    SELECT date, ROUND(SUM(kcal)) AS kcal, ROUND(SUM(protein),1) AS protein,
           ROUND(SUM(fat),1) AS fat, ROUND(SUM(carb),1) AS carb
    FROM food_log WHERE date >= ? GROUP BY date ORDER BY date`).all(from);
  const burn = db.prepare(`
    SELECT date, ROUND(SUM(kcal)) AS kcal FROM exercise_log WHERE date >= ? GROUP BY date ORDER BY date`).all(from);
  const map = new Map();
  intake.forEach((r) => map.set(r.date, {
    date: r.date, intake: r.kcal, protein: r.protein, fat: r.fat, carb: r.carb, burn: 0
  }));
  burn.forEach((r) => {
    const cur = map.get(r.date) || { date: r.date, intake: 0, protein: 0, fat: 0, carb: 0, burn: 0 };
    cur.burn = r.kcal;
    map.set(r.date, cur);
  });
  return { from, to: db.prepare("SELECT date('now','localtime') AS d").get().d, days: [...map.values()] };
}

module.exports = {
  db, DB_FILE, MEALS, DEFAULT_PROFILE,
  getProfile, saveProfile,
  getDay, putDay, clearDay,
  getWeights, addWeight, deleteWeight, clearWeights,
  getPlan, putPlan, getWeek, putWeek,
  getFoods, getExercises,
  seed, stats
};

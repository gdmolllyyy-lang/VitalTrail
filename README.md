# Healthy · 健身饮食管家（全栈版）

一个本地运行的健身饮食管理系统：**前端（原版小程序风格界面）+ Node.js 后端 + SQLite 数据库**。
支持饮食记录（文字 / 拍照 / 食物库）、体重体脂与代谢计算、运动消耗（MET）、每日热量差评估、
个性化食谱生成、一周训练 + 饮食计划、动作库推荐。

> 后端**零第三方依赖**（使用 Node.js 内置 `http` 与 `node:sqlite`），无需 `npm install`。

---

## 一、快速启动

**方式 1（推荐，Windows）**：双击 `start.bat`
→ 自动启动服务并打开浏览器 `http://localhost:3000`

**方式 2**：命令行

```bash
# 需要 Node.js >= 22.5（内置 SQLite）
npm start          # 等价于 node --experimental-sqlite --no-warnings server/app.js
```

启动成功后控制台会输出：

```
✅ Healthy 已启动
前端页面   http://localhost:3000
接口地址   http://localhost:3000/api/health
数据库     ...\Healthy\data\healthy.db
参考数据   食物 109 条 / 动作 30 条
```

- 修改端口：`set PORT=8080` 后再启动（或改 `server/app.js` 里的默认值）。
- 重置数据：停止服务后删除 `data/healthy.db`，重启即自动重建。
- **离线也能用**：直接双击 `public/index.html` 打开（数据仅存浏览器 localStorage，顶部圆点为灰色）。

---

## 二、目录结构

```
Healthy/
├── start.bat               # Windows 一键启动
├── start.sh                # macOS / Linux 启动脚本
├── package.json            # 无第三方依赖，仅定义启动命令
├── data/                   # SQLite 数据库（首次运行自动生成）
│   └── healthy.db
├── server/                 # ★ 后端（Node.js 原生 http）
│   ├── app.js              # HTTP 服务：静态资源 + API 路由分发 + 启动横幅
│   ├── api.js              # REST API：参数校验、CORS、JSON 读写、错误处理
│   └── db.js               # 数据库层：建表、种子导入、增删改查、SQL 聚合统计
├── shared/
│   └── dataset.js          # ★ 共享数据集（浏览器/Node 双端复用）
│                           #   食物成分表 109 条、动作库 30 条、训练分化、膳食指南要点
└── public/                 # ★ 前端
    ├── index.html
    ├── css/style.css
    └── js/
        ├── api.js          # API 客户端（超时、降级、健康检查）
        └── app.js          # 应用逻辑（代谢计算、解析、食谱生成、渲染）
```

---

## 三、REST API 一览

统一前缀 `/api`，返回 JSON；错误格式 `{ "error": { "code": 500, "message": "..." } }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/bootstrap?days=90` | 启动引导：档案 + 近 N 天日志 + 体重 + 今日食谱 + 一周计划 + 库规模 |
| GET | `/api/profile` | 读取身体档案 |
| PUT | `/api/profile` | 更新档案（性别/年龄/身高/体重/体脂/活动系数/目标/饮食结构/忌口/训练频率） |
| GET | `/api/logs/:date` | 某日饮食 + 运动记录（`YYYY-MM-DD`） |
| PUT | `/api/logs/:date` | 整日覆盖写入（事务：先清空该日再插入，幂等） |
| DELETE | `/api/logs/:date` | 清空某日 |
| GET | `/api/weights` | 体重/体脂历史 |
| POST | `/api/weights` | 新增记录（同日覆盖） |
| DELETE | `/api/weights/2026-01-01` | 删除某一天的记录 |
| DELETE | `/api/weights` | 清空全部体重/体脂趋势 |
| GET / PUT | `/api/plans/:date` | 单日食谱（JSON 快照） |
| GET / PUT | `/api/week` | 一周计划（JSON 快照，按起始日存档） |
| GET | `/api/library/foods?q=鸡胸` | 食物库检索（SQLite `LIKE`，支持别名） |
| GET | `/api/library/exercises?part=背` | 动作库检索 |
| GET | `/api/stats?days=7` | 近 N 天摄入/消耗汇总（SQL `GROUP BY` 聚合） |

示例：

```bash
curl http://localhost:3000/api/health
curl "http://localhost:3000/api/library/foods?q=鸡胸"
curl -X PUT http://localhost:3000/api/logs/2026-11-14 \
     -H "Content-Type: application/json" \
     -d '{"meals":{"breakfast":[{"id":"a1","name":"鸡蛋","grams":100,"kcal":144,"p":13.3,"f":8.8,"c":2.8}],"lunch":[],"dinner":[],"snack":[]},"exercises":[]}'
```

---

## 四、数据库设计（SQLite）

| 表 | 用途 |
|---|---|
| `profile` | 身体档案（单行，`id=1`） |
| `food_log` | 饮食明细：日期、餐次、名称、克数、热量、蛋白/脂肪/碳水、照片（base64） |
| `exercise_log` | 运动明细：日期、名称、分钟、MET、消耗 |
| `weight_log` | 体重/体脂记录（同日覆盖） |
| `day_plan` | 生成的单日食谱（JSON 快照） |
| `week_plan` | 一周计划（JSON 快照） |
| `food` | 食物成分库（109 条，来自《中国食物成分表·第6版》整理值） |
| `exercise` | 动作库（30 条，含要领/常见错误，来自 ACSM / NSCA 规范） |

索引：`food_log(date)`、`exercise_log(date)`、`weight_log(date)`。
写入模式：日志采用「按日整体覆盖」事务，天然幂等，前后端无需对账。

---

## 五、前后端如何协作

1. **启动**：前端调 `GET /api/bootstrap` 拉取档案、近 90 天日志、体重、食谱、周计划，替换本地缓存。
2. **写入**：前端每次改动（加餐、删项、记运动、改档案、记体重、重排食谱/周计划）立即调用对应接口落库，
   页面左上角绿点表示「已连接后端 · 数据实时存入 SQLite」。
3. **降级**：直接以 `file://` 打开、或后端掉线时，前端自动切换 localStorage 本地模式（灰点），
   所有功能照常使用，恢复连接后重新加载即同步。
4. **食物库搜索**：在线时由服务端 `LIKE` 查询 SQLite 食物表；离线时使用本地数据集。

---

## 六、数据来源与说明

- 《中国食物成分表（第6版）》，北京大学医学出版社 —— 食物热量与三大营养素（每 100g 可食部）
- 《中国居民膳食指南(2022)》，中国营养学会 —— 推荐摄入结构
- 《中国居民膳食营养素参考摄入量(2023版)》
- Compendium of Physical Activities (Ainsworth et al., 2011) —— 运动 MET 值
- ACSM《运动测试与运动处方指南》/ NSCA《力量训练与体能训练精要》—— 动作要领与抗阻训练安排
- WHO《身体活动和久坐行为指南》(2020)

**免责声明**：所有数值为参考估算，不构成医疗或营养处方建议；如有慢性疾病、孕期或进食障碍史，请咨询注册营养师或医生。

---

## 七、常见问题

- **提示“未检测到 Node.js”**：请安装 Node.js 22.5+（内置 SQLite 需要），下载：https://nodejs.org/
- **启动报 `node:sqlite` 相关错误**：说明 Node 版本过低，升级后重试；启动命令必须带 `--experimental-sqlite`（`npm start` 已包含）。
- **端口被占用**：换端口 `set PORT=8080` 后再运行 `npm start`。
- **想多人/多设备使用**：当前为单用户设计（profile 单行）；如需多用户可在 `profile` 表加 `user_id` 并在 API 加鉴权。

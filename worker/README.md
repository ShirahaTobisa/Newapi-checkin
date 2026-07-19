# NewAPI Cloudflare Worker

`worker/` 是当前完整生产环境：**一个 Cloudflare Worker、一个 D1 数据库和 Worker Static Assets**。

Worker 同时提供前端、API、Cron 与任务执行器；D1 保存账号配置、设置、每日状态、运行记录、翻牌明细和防重复槽位。GitHub 不参与生产定时、页面托管或状态存储。

## 架构

```text
浏览器
  ├─ Static Assets：仪表盘、设置页、账号配置页
  └─ Worker API：公开状态、管理员操作
          │
          ├─ Cron：签到、答题、常规翻牌、视频检查
          ├─ 上游 NewAPI / VSLLM
          └─ STATE_DB：账号、设置、状态、日志、租约
```

生产环境只需要：

- Worker
- `STATE_DB` D1 binding
- Worker Static Assets
- `ADMIN_TOKEN` Secret
- 每分钟 Cron trigger

新部署不需要 GitHub Pages、GitHub Actions 定时任务、KV、坚果云或旧同步令牌。

## 功能、默认计划与生产覆盖

以下是代码中的新部署默认值，时间均为北京时间（Asia/Shanghai）：

| 任务 | 默认计划 | 默认行为 |
|---|---|---|
| 签到 | 每天 00:10 | 每账号执行 1 次 |
| 答题 | 每天 00:15 | 奖励成功后立即翻牌 1 次 |
| 常规翻牌 | 从 00:20 起每 120 分钟 | 每账号翻牌 1 次，先激活 50% 分享加成 |
| 视频任务 | 从 01:00 起每 120 分钟检查 | 每日最多领取 3 次；每次奖励成功后立即翻牌 1 次 |

答题或视频处于已完成、冷却、暂停、失败状态，或上游没有确认奖励可用时，不会触发奖励翻牌。Worker 会比较任务前后的 `charges_current/charges_max`，充能已满且没有新增时不会消耗已有次数；视频和答题奖励分别受每日 3 次与 1 次上限约束。上述奖励翻牌开关和计划都可在管理员设置页修改。

Cron 每分钟唤醒一次，但只有命中 D1 设置中的计划槽位才执行。确定性槽位、运行租约和账号锁用于避免重复触发与同账号并发。翻牌请求还使用 `claimed → request_sent → terminal` 状态机；进入 `request_sent` 后即使 Worker 中断，也只会记为 `uncertain`，不会再次发送翻牌。

当前生产实例 `newapi-sync.mornye.uk` 已将 D1 计划调整为：签到 `01:00`、答题 `01:10`、常规翻牌从 `01:05` 起每 `120` 分钟、视频从 `01:15` 起每 `120` 分钟检查。VSLLM 状态接口返回的 `cooldown_seconds` 和 `ad_min_interval_seconds` 均为 `7200` 秒，因此这里的间隔是 2 小时；`05` 和 `15` 只是起始错峰分钟。新部署若没有导入生产设置，仍会使用上表中的代码默认值。

生产计划保存在 D1 中，后续如通过控制台修改，应以 `GET /api/admin/settings` 和 `GET /api/dashboard` 的实时结果为准；本文中的生产值最后核验于 2026-07-19。

上游翻牌额度是原始值，启用分享加成后按 `原始额度 × 1.5` 写入收益统计。奖励翻牌只有在任务前后 `charges_current` 实际增加时才进入队列；`charges_current >= charges_max`、状态未知或每日奖励上限已用尽时，会跳过奖励翻牌，避免消耗自然恢复次数。视频奖励每日最多 3 次，答题奖励每日最多 1 次。

收益换算是固定业务规则：

```text
500000 额度 = ¥1
```

控制台中的总收益、今日收益、账号收益和单次奖品金额都使用该换算，不能通过旧配置或管理员设置改写。

## 准备工作

需要：

- Node.js 22+
- Wrangler 4+
- 已登录的 Cloudflare 账号

进入目录并安装依赖：

```powershell
cd worker
npm install
Copy-Item wrangler.jsonc.example wrangler.jsonc
```

`wrangler.jsonc` 是本机部署配置。后续所有 Wrangler 命令都显式使用：

```text
--config wrangler.jsonc
```

这样可以避免目录中遗留的 `wrangler.toml` 或其他默认配置被误选。

## 首次部署

### 1. 创建 D1

```powershell
wrangler d1 create newapi-checkin-state --config wrangler.jsonc
```

将输出中的 `database_id` 写入 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "STATE_DB",
    "database_name": "newapi-checkin-state",
    "database_id": "你的数据库 ID",
    "migrations_dir": "migrations"
  }
]
```

### 2. 应用迁移

本地开发数据库：

```powershell
wrangler d1 migrations apply STATE_DB --local --config wrangler.jsonc
```

生产数据库：

```powershell
wrangler d1 migrations apply STATE_DB --remote --config wrangler.jsonc
```

### 3. 设置管理员令牌

生成一个新的、足够长的随机值，然后通过交互提示保存：

```powershell
wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
```

`ADMIN_TOKEN` 是当前唯一需要的完整管理员令牌，用于：

- 登录管理员控制台
- 保存和更新账号配置
- 修改自动计划
- 手动执行任务
- 查询账号余额
- 触发旧 KV 到 D1 的迁移

不要把令牌写入 `wrangler.jsonc`、源码、命令参数、日志或提交记录。

### 4. 保持自动化暂停

首次上线时必须保留：

```jsonc
"vars": {
  "AUTOMATION_PAUSED": "true"
}
```

暂停只阻止 Cron 自动执行，不妨碍管理员保存配置、读取状态或进行受控手动验证。

### 5. 检查并部署

```powershell
wrangler deploy --dry-run --config wrangler.jsonc
wrangler deploy --config wrangler.jsonc
```

### 6. 保存账号并检查健康状态

打开 Worker 首页，用 `ADMIN_TOKEN` 登录，然后进入内置账号配置页。

生产账号 Cookie 只提交给同源 Worker 并写入 D1：

- 不使用“保存到本地”
- 不启用“记住云端凭据”
- 不把账号 Cookie 写入浏览器 `localStorage`
- 若曾使用旧版配置器，先清除该域名的站点数据再录入

管理员令牌只保存在当前标签页的 `sessionStorage`；关闭标签页后清除。

保存后访问：

```text
GET /health
```

至少确认：

- `ok: true`
- `storage: "D1"`
- `accounts_configured: true`
- `account_count` 与实际账号数一致
- `automation_paused: true`

再通过管理员页面手动运行一个低风险任务，确认公开仪表盘只显示脱敏账号名、状态与统计，不包含 Cookie、用户 ID 或令牌。

### 7. 解除暂停

完成本页的迁移和旧 Actions 停用检查后，将：

```jsonc
"AUTOMATION_PAUSED": "false"
```

再次部署：

```powershell
wrangler deploy --dry-run --config wrangler.jsonc
wrangler deploy --config wrangler.jsonc
```

## 从旧 KV 与 GitHub Actions 迁移

迁移期间可以临时同时绑定：

- 新 `STATE_DB` D1
- 旧 `CONFIG_KV` KV namespace

状态层兼容从旧 KV 导入缺失文档，且不会覆盖 D1 中已经存在或更新过的值。生产迁移应在管理员登录后显式调用：

```text
POST /api/admin/migrate
Authorization: Bearer <ADMIN_TOKEN>
```

### 安全迁移顺序

1. 保持 `AUTOMATION_PAUSED=true`。
2. 停用或从默认分支删除五个旧生产工作流，等待正在运行的旧任务结束。
3. 临时保留 `STATE_DB` 与 `CONFIG_KV` 两个 binding，并保持 `LEGACY_WRITES_ENABLED=false`。
4. 设置全新的 `ADMIN_TOKEN`。
5. 应用 D1 migrations，并使用 `--config wrangler.jsonc` 部署。
6. 调用管理员迁移接口；`/health` 是只读检查，不会执行迁移。
7. 核对账号数、设置、翻牌历史、每日任务状态和最近运行记录。
8. 手动验证一个任务，确认 D1 状态继续更新。
9. 从 `wrangler.jsonc` 删除整个 `kv_namespaces` / `CONFIG_KV` binding。
10. 重新部署并再次检查 `/health`。
11. 删除旧 Worker Secrets 和 GitHub Secrets。
12. 最后解除自动化暂停并观察至少一个真实计划槽位。

迁移验证完成前不要删除旧 KV namespace；验证完成后生产 Worker 不应继续绑定 KV。

### 必须停用的旧工作流

旧仓库中以下生产工作流必须停用或删除：

- `.github/workflows/checkin.yml`
- `.github/workflows/gwent.yml`
- `.github/workflows/vsllm-quiz.yml`
- `.github/workflows/vsllm-ad.yml`
- `.github/workflows/keepalive.yml`

当前源码已经删除这五个文件，只保留 `.github/workflows/validate.yml` 用于 push 和 pull request 校验。

只删除 cron、但保留 `workflow_dispatch` 仍可能造成重复手动执行，因此应停用整个旧生产工作流。不要在 Worker Cron 已启用时重新启用这些 Actions。

### 删除旧令牌

D1 迁移完成、旧 Actions 已停用且新 `ADMIN_TOKEN` 已验证后，删除不再需要的 Worker Secrets：

```powershell
wrangler secret delete SYNC_TOKEN --config wrangler.jsonc
wrangler secret delete ACTIONS_TOKEN --config wrangler.jsonc
wrangler secret delete JIANGUO_USERNAME --config wrangler.jsonc
wrangler secret delete JIANGUO_APP_PASSWORD --config wrangler.jsonc
```

随后删除 GitHub 仓库中对应的旧 Secrets，并检查旧 Actions 日志与 Artifacts。新 `/api/admin/*` 只接受 `ADMIN_TOKEN`；旧令牌仅服务于兼容接口，也不应长期保留。

## 账号数据

生产账号配置保存在 D1，示例结构：

```json
{
  "accounts": [
    {
      "name": "账号1",
      "url": "https://vsllm.com",
      "user_id": "123",
      "session": "完整 Session 值"
    }
  ]
}
```

兼容旧格式：

```json
[
  {
    "name": "账号1",
    "userId": "123",
    "cookie": "session=完整值"
  }
]
```

也可以使用 `ACCOUNTS_JSON` Secret 作为兜底来源；D1 中已有账号配置时以 D1 为准。不要同时在多个来源长期维护不同版本的账号 Cookie。

## 前端与 API

Static Assets 与 API 由同一个 Worker 提供。首页包含：

- 今日签到、答题和视频状态
- 视频完成进度与下一次可执行时间
- 全账号与单账号收益、翻牌次数、中奖数和最近奖品明细
- 可按账号、来源和北京时间日期筛选、分页的完整翻牌记录
- 管理员按账号刷新的实时额度
- 管理员设置、余额查询和手动任务入口

公开只读接口：

- `GET /health`
- `GET /api/dashboard`
- `GET /api/history/events`
- `GET /api/gwent/history`

完整翻牌记录接口支持 `page`、`page_size`、`account_key`、`source`、`from` 和 `to` 查询参数。`source` 可为 `draw`、`checkin`、`quiz` 或 `ad`，日期使用 `YYYY-MM-DD` 北京时间格式；每页最多 100 条。

管理员接口需要：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

接口：

- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `GET /api/admin/accounts`
- `PUT /api/admin/accounts`
- `POST /api/admin/run`
- `GET|POST /api/admin/balances`
- `POST /api/admin/migrate`

### 只读生产核验

以下接口只读取状态，不会触发任何任务：

- `GET /health`
- `GET /api/dashboard`
- `GET /api/history/events`
- `GET /api/admin/settings`
- `GET /api/admin/balances`

`/api/admin/balances` 的 VSLLM 结果包含 `available`、`charges_current`、`charges_max`、`cooldown_seconds` 和 `ad_min_interval_seconds`，可用于确认当前恢复间隔和剩余翻牌次数。运行记录可在控制台“翻牌记录”查看，也可通过 `/api/history/events` 分页读取。

手动任务请求体示例：

```json
{
  "action": "draw",
  "account_keys": ["all"],
  "draw_count": 1,
  "idempotency_key": "manual-20260718-001"
}
```

`action` 可为 `draw`、`checkin`、`quiz`、`ad` 或 `all`。可传指定账号 key，也可用 `["all"]`。相同幂等键重复提交会返回已有运行结果，不会再次执行同一手动任务。

## 安全与失败语义

- Cookie、Session、用户 ID 和管理令牌不会出现在公开 API。
- 账号 Cookie 只保存在 D1 或可选的 `ACCOUNTS_JSON` Secret，不保存在浏览器 `localStorage`。
- 管理令牌只保存在当前标签页 `sessionStorage`。
- 所有上游响应都有大小限制；D1 日志只保存白名单字段和脱敏消息。
- VSLLM 翻牌没有上游幂等键。请求发出后若超时或响应无法解析，记录为 `uncertain`，不会自动重试，以免重复消耗次数。
- 答题和视频奖励先进入 D1 奖励队列，再使用稳定事件编号翻牌和写历史；日志恢复不会重复累计额度。
- 默认翻牌顺序是 `share_unlock -> draw`。
- 视频领取先确认服务端计数，再执行对应奖励翻牌。
- 需要浏览器挑战或 Playwright 的第三方站点无法在纯 Worker 中等价运行；普通 Cookie 可直连的 NewAPI 站点可以使用。

## D1 状态

迁移创建带版本号的文档表，以及完整运行和翻牌事件表：

```sql
state_documents(
  state_key TEXT PRIMARY KEY,
  value_json TEXT,
  version INTEGER,
  updated_at TEXT
)

automation_runs(
  run_id TEXT PRIMARY KEY,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  source TEXT,
  total_quota INTEGER
)

automation_events(
  event_id TEXT PRIMARY KEY,
  run_id TEXT,
  account_key TEXT,
  occurred_at TEXT,
  local_date TEXT,
  task_type TEXT,
  prize_quota INTEGER
)
```

状态读改写使用版本号进行 CAS。多个 Cron、手动任务或兼容客户端同时更新时，冲突请求会重新读取并合并，避免简单后写覆盖。完整历史使用 `run_id` 和 `event_id` 主键去重，不受 Dashboard 最近记录数量限制。

## 本地验证与日志

运行测试和语法检查：

```powershell
npm test
npm run check
```

应用本地 D1 migration 后启动开发环境：

```powershell
wrangler d1 migrations apply STATE_DB --local --config wrangler.jsonc
wrangler dev --test-scheduled --config wrangler.jsonc
```

生成 binding 类型：

```powershell
wrangler types --config wrangler.jsonc
```

部署前检查：

```powershell
wrangler deploy --dry-run --config wrangler.jsonc
```

查看生产日志：

```powershell
wrangler tail --config wrangler.jsonc
```

## Legacy 兼容范围

旧接口 `/api/config`、`/api/gwent/history`、`/api/gwent/task-status`、`/api/gwent/schedule` 以及旧手动路径暂时保留用于迁移兼容。`LEGACY_WRITES_ENABLED=false` 默认封锁旧配置、历史、任务状态和调度接口的全部写入；GET 与 OPTIONS 只读请求不受影响。

Python 脚本、GitHub Actions 生产工作流、GitHub Pages 和坚果云/KV 同步不是当前生产架构。新部署不要依赖这些组件；迁移完成后只保留 Worker、D1、Static Assets、Cron 和 `ADMIN_TOKEN`。

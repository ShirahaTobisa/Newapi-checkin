# NewAPI 自动化控制台

当前生产架构是 **单 Cloudflare Worker + 单 D1 + Worker Static Assets**。

同一个 Worker 负责：

- 托管前端控制台和账号配置页
- 提供公开只读 API 与管理员 API
- 通过 Cron 执行签到、VSLLM 翻牌、答题和视频任务
- 在 D1 中保存账号配置、自动计划、每日状态、运行日志、翻牌记录和防重复槽位

GitHub 只保存源码和运行校验，不再承担生产定时、页面托管或状态存储。生产环境不需要 GitHub Pages、GitHub Actions 定时任务、KV 或坚果云。

## 功能

- 多站点、多账号 NewAPI 签到
- VSLLM 常规翻牌，翻牌前可自动激活 50% 分享加成
- 每日答题；答题奖励成功后默认立即翻牌 1 次
- 视频任务；每次视频奖励领取成功后默认立即翻牌 1 次，每日最多 3 次
- 管理员手动执行全部账号或指定账号的签到、翻牌、答题、视频任务
- 每账号今日签到、答题、视频状态与视频进度
- 全账号和单账号翻牌统计、收益趋势，以及可按账号、来源、日期分页查询的完整翻牌记录
- 固定按 **500000 额度 = ¥1** 换算展示收益
- D1 槽位租约和幂等记录，避免 Cron 或重复提交造成重复消费

## 默认计划

以下时间均为北京时间（Asia/Shanghai）：

| 任务 | 默认计划 | 奖励行为 |
|---|---|---|
| 签到 | 每天 00:10 | 不额外翻牌 |
| 答题 | 每天 00:15 | 成功领取奖励后翻牌 1 次 |
| 常规翻牌 | 从 00:20 起每 2 小时，每账号 1 次 | 先激活 50% 分享加成 |
| 视频任务 | 从 01:00 起每 2 小时检查，每天最多 3 次 | 每次成功领取奖励后翻牌 1 次 |

Cron 每分钟唤醒 Worker，真正的执行时间由 D1 中的计划和确定性槽位判断。部署后可在控制台修改计划，无需改 Cron 表达式。

任务奖励翻牌只有在上游确认充能实际增加时才会入队；充能达到 `charges_max` 且没有新增时不会消耗已有次数。视频与答题奖励分别限制为每天 3 次和 1 次。

## 快速部署

完整步骤见 [worker/README.md](worker/README.md)。最小流程如下：

```powershell
cd worker
Copy-Item wrangler.jsonc.example wrangler.jsonc
npm install
wrangler d1 create newapi-checkin-state --config wrangler.jsonc
```

将创建结果中的 `database_id` 写入 `wrangler.jsonc`，然后执行：

```powershell
wrangler d1 migrations apply STATE_DB --remote --config wrangler.jsonc
wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
wrangler deploy --dry-run --config wrangler.jsonc
wrangler deploy --config wrangler.jsonc
```

首次部署必须保持：

```jsonc
"AUTOMATION_PAUSED": "true"
```

随后：

1. 打开 Worker 首页，以 `ADMIN_TOKEN` 登录。
2. 通过 Worker 内置账号配置页把账号保存到 D1。
3. 请求 `/health`，确认使用 D1、账号已配置且自动化仍暂停。
4. 如从旧版迁移，先停用旧的五个生产 GitHub Actions，再调用 `POST /api/admin/migrate`。
5. 验证 D1 数据后删除临时 KV binding 和旧令牌。
6. 将 `AUTOMATION_PAUSED` 改为 `false`，再用显式配置文件部署。

## 安全约定

- 新部署只使用一个完整管理员令牌：`ADMIN_TOKEN`。
- 管理员令牌只保存在当前标签页的 `sessionStorage`，关闭标签页后清除。
- 账号 Cookie 只提交给同源 Worker 并保存到 D1；生产流程不得把 Cookie 写入浏览器 `localStorage`。
- 不使用旧配置器的“保存到本地”或“记住云端凭据”功能。若浏览器曾使用旧版页面，请清除该站点的本地存储。
- 公开页面和公开 API 只返回脱敏状态，不返回 Cookie、用户令牌或管理员令牌。
- 不要把 Cookie、Token、`.dev.vars` 或包含敏感值的本地 Wrangler 配置提交到仓库。

## 从旧版迁移

迁移期间可以临时同时绑定旧 `CONFIG_KV` 和新 `STATE_DB`。先停止旧任务写入，再由管理员调用 `POST /api/admin/migrate`；接口会同时把旧翻牌明细幂等回填到 D1 的完整历史表。完成账号、设置、历史与每日状态检查后：

1. 确认以下五个旧生产工作流已停用或从默认分支删除：
   - `.github/workflows/checkin.yml`
   - `.github/workflows/gwent.yml`
   - `.github/workflows/vsllm-quiz.yml`
   - `.github/workflows/vsllm-ad.yml`
   - `.github/workflows/keepalive.yml`
2. 保留 `.github/workflows/validate.yml` 用于测试；当前仓库已删除上述五个生产工作流。
3. 从 `wrangler.jsonc` 删除 `CONFIG_KV` 的 `kv_namespaces` binding，并重新部署。
4. 删除 Worker 中不再需要的 `SYNC_TOKEN`、`ACTIONS_TOKEN`、`JIANGUO_USERNAME` 和 `JIANGUO_APP_PASSWORD`。
5. 删除 GitHub 仓库中对应的旧 Secrets，并检查历史 Actions 日志和 Artifacts 是否含敏感信息。
6. 完成上述检查后再解除 `AUTOMATION_PAUSED`。

不要同时启用旧 Actions 定时任务和 Worker Cron，否则同一账号可能重复签到、答题、看视频或翻牌。

## Legacy：Python 与 GitHub Actions

仓库中的 Python 脚本、GitHub Actions 生产工作流、GitHub Pages 配置器和坚果云/KV 中继仅保留用于历史参考、兼容测试或本地调试，**不再是推荐部署方式**。

生产环境请只使用 `worker/` 中的 Worker、D1、Static Assets 和 Cron。不要重新启用旧生产工作流，也不要把 GitHub Secrets 当作当前生产账号配置源。

## 本地验证

```powershell
node --test tests/*.test.mjs worker/test/*.test.mjs
node --check worker/src/app.mjs
wrangler deploy --dry-run --config worker/wrangler.jsonc
```

更详细的部署、迁移、API 和故障语义说明见 [worker/README.md](worker/README.md)。

# Cloudflare Worker 配置中继

这个模块提供账号配置同步、脱敏翻牌历史和翻牌调度租约三组接口。答题和广告任务在 GitHub Actions 中运行，Worker 只负责配置、历史和租约，不直接保存额外的 Cookie Secret。浏览器对 `GET /api/config` 和 `PUT /api/config` 的请求会写入 Cloudflare KV；未绑定 KV 时回退到固定的坚果云 WebDAV 文件：

`https://dav.jianguoyun.com/dav/newapi-config.json`

线上推荐使用 Cloudflare KV 保存配置，避免 Cloudflare 出口访问坚果云 WebDAV 时出现 520。未绑定 `CONFIG_KV` 时仍兼容坚果云 WebDAV。它不是通用代理，浏览器不能通过 URL、查询参数或请求体指定上游地址。

## 安全边界

- 配置 `GET` 接受 `SYNC_TOKEN` 或 `ACTIONS_TOKEN`，配置 `PUT` 只接受 `SYNC_TOKEN`。
- `GET /api/gwent/history` 公开返回脱敏汇总；`POST /api/gwent/history` 只接受 `ACTIONS_TOKEN`，并拒绝 Cookie、Session、Token、密码等敏感字段。
- `POST /api/gwent/schedule` 只接受 `ACTIONS_TOKEN`，以 KV 保存两小时槽位令牌和 15 分钟短期租约；租约请求失败时 Actions 会安全跳过本轮。
- 历史运行的 `source` 可为 `gwent`、`quiz` 或 `ad`；旧记录没有该字段时按 `gwent` 兼容处理。
- `ALLOWED_ORIGINS` 是逗号或换行分隔的精确白名单，不支持通配符、子域推断或前缀匹配。
- 本地 `file://` 页面通常发送 `Origin: null`。只有在白名单中明确加入字面值 `null` 才会放行。
- 无 `Origin` 的非浏览器请求仍可使用，但同样必须通过 Bearer 鉴权。
- 请求体和上游响应体上限均为 256 KiB。
- 所有响应都包含 `Cache-Control: no-store`；错误统一返回 JSON。
- 首次尚未保存配置时，上游 `GET` 的 404 会保留为 404，并返回 `config_not_found` JSON 错误。
- 上游重定向不会被跟随，避免认证信息离开固定主机。

## 部署

需要 Node.js 和 Wrangler。Worker 本身没有第三方运行时依赖。

### 仅使用浏览器

1. 在 Cloudflare 控制台进入 **Workers & Pages**，创建一个 Worker。
2. 使用在线编辑器，以模块 Worker 的形式粘贴 `src/index.mjs` 的内容并部署。
3. 绑定名为 `CONFIG_KV` 的 KV 命名空间，并添加普通变量 `ALLOWED_ORIGINS`。
4. 以 **Secret** 类型添加 `SYNC_TOKEN` 和 `ACTIONS_TOKEN`，然后重新部署。`ACTIONS_TOKEN` 供 GitHub Actions 上报历史和申请翻牌调度租约使用，建议与 `SYNC_TOKEN` 使用不同的随机值。仅在不使用 KV、回退坚果云 WebDAV 时才需要 `JIANGUO_USERNAME`、`JIANGUO_APP_PASSWORD` 和 `JIANGUO_CONFIG_PATH`。

### Wrangler

```bash
cd worker
cp wrangler.toml.example wrangler.toml
```

编辑 `wrangler.toml` 中的 `ALLOWED_ORIGINS`。生产环境建议只填写实际页面地址，例如：

```toml
ALLOWED_ORIGINS = "https://your-name.github.io"
```

如果确实要从直接打开的本地 HTML 文件访问，再显式加入 `null`：

```toml
ALLOWED_ORIGINS = "https://your-name.github.io, null"
```

按使用方式写入 secret：

```bash
npx wrangler secret put JIANGUO_USERNAME
npx wrangler secret put JIANGUO_APP_PASSWORD
npx wrangler secret put SYNC_TOKEN
npx wrangler secret put ACTIONS_TOKEN
npx wrangler deploy
```

`JIANGUO_APP_PASSWORD` 必须使用坚果云为 WebDAV 创建的应用密码，不要使用账户登录密码。`SYNC_TOKEN` 建议使用密码管理器生成至少 32 字节的随机值。

## 浏览器调用

```js
const workerUrl = "https://newapi-checkin-config-relay.example.workers.dev/api/config";
const syncToken = "你的 SYNC_TOKEN";

const getResponse = await fetch(workerUrl, {
  headers: { Authorization: `Bearer ${syncToken}` },
  cache: "no-store",
});
if (!getResponse.ok) throw new Error(await getResponse.text());
const config = await getResponse.json();

const putResponse = await fetch(workerUrl, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${syncToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(config),
});
if (!putResponse.ok) throw new Error(await putResponse.text());
```

Bearer token 放在浏览器页面里意味着页面使用者可以读取它。因此应把页面本身限制在可信环境，不要把带真实 token 的静态文件提交到公开仓库。

## 翻牌历史接口

仪表盘直接读取公开的脱敏历史，不需要把任何令牌放进前端：

```js
const response = await fetch(
  "https://your-worker.example/api/gwent/history",
  { cache: "no-store" },
);
const history = await response.json();
```

历史只保留全量累计汇总、最近 500 条事件、最近 120 次运行和最近 90 天趋势。GitHub Actions 使用 `ACTIONS_TOKEN` 上报，每个 `run_id` 只累计一次。

## 翻牌调度租约

GitHub Actions 每两小时整点触发一次，并按运行时所属的 UTC 两小时窗口生成稳定槽位令牌，例如 `scheduled:20260718T04`。申请槽位时传入 `min_interval_seconds: 0`，让 Worker 按令牌防重，不再用“上次完成时间 + 两小时”推算下一轮：

```json
POST /api/gwent/schedule
Authorization: Bearer <ACTIONS_TOKEN>
Content-Type: application/json

{"action":"claim","lease_token":"scheduled:20260718T04","min_interval_seconds":0}
```

只有返回 `due: true` 的运行才会翻牌；任务结束后使用同一个 `lease_token` 发送 `{"action":"complete"}`。同一槽位的行为如下：

- 15 分钟租约仍有效时，同 token 重试返回 `reused: true`，不同 token 返回 `reason: "lease_active"`。
- 租约已经过期或任务已经完成时，同 token 重试返回 `due: false` 和 `reason: "duplicate_slot"`，不会重复消耗翻牌次数。
- 下一个两小时槽位使用新 token，因此即使上一轮在整点后几分钟才完成，也能按时申请，不受运行时长漂移影响。

KV 状态仍保持 `schema_version: 1`，并新增可选的 `last_claimed_token`。旧状态没有该字段时，会从现有租约或 `last_completed_token` 安全推导，无需手工迁移。

旧客户端仍可省略 `min_interval_seconds`，或传入不小于 `7200` 的正数，继续使用基于最近申请/完成时间的间隔模式；默认间隔为 7200 秒。手动运行应使用唯一 token 并设置 `force: true`，以绕过旧式时间间隔，但仍保留活动租约和相同 token 防重：

```json
{"action":"claim","lease_token":"manual:<GITHUB_RUN_ID>:<GITHUB_RUN_ATTEMPT>","force":true}
```

## 测试

测试使用 Node.js 内置的 `node:test` 和注入式 mock fetch，无需安装依赖：

```bash
node --test test/*.test.mjs
```

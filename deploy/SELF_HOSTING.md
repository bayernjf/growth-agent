# growth-agent 自托管安装指南（BYOK）

本指南面向在单机 VPS / 家庭服务器上运行 growth-agent 的 owner。技术背景见
`bayjf/docs/tier0/Tier0-增长Agent技术方案.md` §7（部署形态）与 §8（凭据边界）。

## 1. 合规基线（不可配置关闭）

部署前先确认这些硬约束——它们没有任何 env 开关：

- 所有内容发布决策必须经 **zeus D2 人审（slaHours=24h）**，不存在自动放行。
- bot **只开 PR / 建草稿，永不自动合并**；上线最后一步永远是人工。
- 每日硬上限 **1 篇新内容 + 1 个修复**。
- GSC 授权严格只读（`webmasters.readonly`），refresh token 加密落盘。
- PR 打开前必须过意图 / 查重 / 价值三闸。

## 2. 前置条件

- Docker Engine 24+ 与 docker compose v2；单机 2C4G 可跑。
- 本机可访问 `zeus` 源码目录（compose 从 `../zeus` 构建决策内核镜像）。
- `growth-os` / `loom` 为按需内核：没有发布镜像时不影响基础栈（见第 6 节）。
- 出站网络可达：Google Search Console、SERP 供应商（如 DataForSEO）、
  api.github.com；仅在你启用对应 online 模式时需要。

## 3. 首次启动

```bash
cp .env.example .env
# 编辑 .env：至少设置 POSTGRES_PASSWORD、ZEUS_INTERNAL_TOKEN
```

### 3.1 生成 zeus roster 签名密钥

zeus 内核无签名密钥拒绝启动。生成一次并持久化到 zeus 数据卷：

```bash
docker run --rm -v growth-agent_zeusdata:/data node:22-slim \
  sh -c "apt-get update -qq && apt-get install -y -qq openssl >/dev/null && \
         openssl genpkey -algorithm ed25519 -outform PEM -out /data/rsk.key"
```

（或按 zeus `docs/deployment.md` 用其内置脚本生成。）然后在 `.env` 中设置
`ZEUS_RSK_KEY_ID=local-rsk`。

### 3.2 启动

```bash
docker compose up -d --build
curl -s http://127.0.0.1:8790/healthz | jq
```

`/healthz` 返回 `status: ready` 且包含 `startup`（数据库方言、凭据 presence、
zeus 探活、启动对账结果）。任何 online 模式缺凭据、或 zeus 不可达，orchestrator
会在启动阶段 fail-closed 退出（`docker compose logs orchestrator` 看缺失清单）。

### 3.3 批次调度与草稿收件箱

orchestrator 进程只提供 healthz 和两个入站 webhook；真正跑批的是 `batch` 服务
（`deploy/batch-scheduler.sh`，镜像内无 cron，沿用 `db-backup` 的 sleep-loop）。
每个 tick 依次执行 `daily` → `production` → `verify`，三步都幂等，空 tick 是 no-op：

```bash
docker compose logs -f batch
# 手动触发一次（不依赖调度）
docker compose exec batch node --experimental-sqlite dist/cli/batch.js production --site bayjf.com
```

#### 连跑可见性（health）

每个 `batch` 命令都会向运行台账追加一行（默认 `$GA_REPORT_DIR/run-ledger.jsonl`，
可用 `GA_RUN_LEDGER` 指定绝对路径）。台账是本地 JSONL：一次运行一条，记录时间、
命令、站点、状态（ok / skipped / failed）与耗时。

`daily` 之后调度器自动跑 `health`：检查最近 30 个**完整日**（不含今天）每天是否
至少有一次成功运行。任一天缺失时输出 `health: GAP — ...` 并以 1 退出，断档当天早上
就出现在日志里，而不是等一个月后的复盘：

```bash
docker compose logs batch | grep 'health:'
# 手动检查（可改窗口长度）
docker compose exec batch node --experimental-sqlite dist/cli/batch.js health --days 7
```

把 `health` 的非零退出接到现有告警通道（日志采集即可），30 天连跑才有证明。
台账只依赖本地磁盘，不写数据库、不增加外部调用。

`report` / `packet` **不在循环里**：它们会生成带版本号的新文件而不是覆盖，放进
小时循环会把 reports 卷刷满。请单独排期调用。

审批通过（zeus → `drafting`）的任务需要一份草稿才能真正开 PR。默认草稿来源是
操作者收件箱 `GA_DRAFT_INBOX_DIR`（compose 里为 `/data/drafts`）：

```jsonc
// /data/drafts/gt_20261027_fix_1.json
{
  "slug": "guides/legacy-guide",          // write: 建议路径；fix: 现有页面路径
  "title": "Legacy guide (refreshed)",
  "changeSummary": "Refresh deteriorated page",
  "paragraphs": ["...", "...", "..."]      // 至少 3 段（value gate 下限）
}
```

文件缺失或结构不合法时，任务留在 `drafting` 等下一个 tick，**既不伪造正文，也不消耗
任务唯一一次 `qa_revision` 返工**——所以第一次部署可以只放一份草稿、逐个任务推进。
`GA_DRAFT_MODE=loom` 时该文件只提供 `finalId`（loom 线下发证）与 slug/title，
正文由 loom 产出；`GA_LOOM_MODE` 不是 `online` 时启动直接失败，避免 mock 正文进 PR。

## 4. BYOK 凭据（全部 env 注入，仅存 .env / 服务端）

| 凭据 | 变量 | 说明 |
|---|---|---|
| GSC OAuth 客户端 | `GA_GSC_MODE=online`、`GA_GSC_CLIENT_ID`、`GA_GSC_CLIENT_SECRET` | installed-app 流程，scope 仅 `webmasters.readonly`；refresh token 用 AES-256-GCM 密封后写入 `gsc_tokens` 卷 |
| 主密钥 | `GA_GROWTH_MASTER_KEY` | 必须解码为 32 字节：64 位 hex 或 32 字节 base64；加密 GSC token，与密文分卷存放，**丢失即无法解密 token**，需重新授权 |
| SERP | `GA_SERP_MODE=online`、`GA_SERP_DATAFORSEO_LOGIN`、`GA_SERP_DATAFORSEO_PASSWORD` | 记在你自己的供应商账户计费 |
| GitHub PAT | `GA_GITHUB_MODE=online`、`GA_GITHUB_TOKEN` | 最小 repo contents + pull-requests 写权限；bot 只开 PR 不合并。目标 owner/repo/baseBranch 在 `config/sites/*.json` 按站点配置，无全局默认 |
| zeus 鉴权 | `GA_ZEUS_URL`、`GA_ZEUS_TOKEN`（= `ZEUS_INTERNAL_TOKEN`）、`GA_ZEUS_WEBHOOK_SECRET`（≥16 字符） | webhook secret 在 zeus 侧 list 永不回显 |
| GitHub webhook | `GA_GITHUB_WEBHOOK_SECRET`（≥16 字符） | 仓库 Webhook settings 配同一值；回调 `POST /webhooks/github`，Content-Type application/json |
| 成本估算 | `GA_COST_RATES` | JSON `{"provider": micros/unit}`，格式错误启动即失败；留空则成本记 0 |

全部连接器默认 `off`（离线 fixture），不配置任何凭据也能把整条链路跑起来；
**online 缺凭据一律 fail-closed，不会静默回退到离线数据。**

注意离线模式的边界：fixture 回放**忽略请求输入**（GSC 不论要 page 还是 query 维度都
返回同一批 query 维行；SERP 对任何 query 都返回同一份结果，自有域名恒在第 1 位），
因此 `daily` 在离线模式下产出 0 个候选。离线模式验证的是管道与状态机，不是候选
质量；要看真实候选必须配置 GSC + SERP 凭据。这一条是已知缺口，见 `handoff.md`。

### GSC OAuth 授权流程

`GA_GSC_MODE=online` 后按连接器 loopback 流程（src/connector/gsc/oauth.ts）
在本机完成一次授权，密封 token 写入 `gsc_tokens` 卷。轮换/撤销后需重新授权；
日志只打掩码，不回显 token 全文。

## 5. 存储与备份

- 默认 **SQLite**：业务库在 `agent_data` 卷 `/data/growth-agent.db`；周报写入
  `reports` 卷（`weekly-<周>-v<n>.md`，只追加不覆盖，不发邮件）。
- 切换 Postgres：`.env` 设 `GA_DB_DRIVER=postgres`。本仓零依赖原则未把 `pg`
  写入 package.json；postgres 驱动在缺 `pg` 时 fail-closed。需要 PG 部署时，
  自行构建一个包含 `pg` 的派生镜像（`FROM growth-agent:local` 后 `npm i pg`），
  或在外部使用 SQLite 备份。迁移在容器启动时自动执行（幂等）。
- Postgres 备份：`db-backup` 服务每日 `pg_dump`（gzip）到 `backups` 卷，默认
  保留 7 天（宿主 `.env` 中 `BACKUP_RETENTION_DAYS` / `BACKUP_INTERVAL_SECONDS` 可调）。
- **GSC token 卷单独备份**：`gsc_tokens` 是密文，备份时同时确认
  `GA_GROWTH_MASTER_KEY` 已在凭据管理器中另存；只有密文没有主密钥无法恢复。
- SQLite 模式：对 `agent_data` 卷做每日文件快照（停写窗口或使用 LVM/CoW）。

## 6. 可选内核服务（peers profile）

growth-os 信号引擎与 loom 内容生产不包含在基础镜像中，且本仓不得修改内核：

```bash
# 自行构建 growth-os 镜像并导出为 tar 或打上标签
export GROWTH_OS_IMAGE=growth-os:local
docker compose --profile peers up -d
```

未设置镜像时该服务不启动；离线 / dogfood 阶段不需要它。

## 7. 升级流程

```bash
git pull && docker compose build orchestrator
docker compose up -d orchestrator
# 容器启动时自动跑 migrate:up（sqlite/postgres 配对迁移，幂等）
# /healthz 变 ready 即完成；v1 接受分钟级停机，不做零停机
```

迁移只增不改；不要手工修改已应用的迁移文件。

## 8. 排障速查

| 现象 | 处理 |
|---|---|
| orchestrator 启动退出，提示 missing credentials | 按报错清单补齐对应 `GA_*` 变量，或把该连接器改回 `off` |
| zeus 启动退出，提示 roster key | 重新执行第 3.1 节生成密钥并挂载到 `zeusdata` |
| `/healthz` 为 `degraded` | 查看 `startup.reconcile`：有 reconciled 说明漏推送已被对账修复；drifted>0 说明本地状态与 zeus 审计冲突，需人工介入 |
| GSC 401 | OAuth 已撤销，重新走授权流程 |
| SERP 402 | 供应商账户欠费，充值后自动恢复 |
| channel 段出现失败 | 查 `channel_failures` 与周报 "Channel health"；4xx 业务错不重试，429/5xx 有界退避 3 次 |

## 9. 不做的事

- 不向 SaaS 仪表盘发送任何数据；外部调用只发生在你配置的 BYOK 上游。
- 不自动合并 PR、不自动发布、不提供每日 1+1 以上的产量档位。
- 不把任何密钥写入镜像层、日志、周报或 git 历史。

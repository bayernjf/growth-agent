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
每个 tick 依次执行 `daily` → `production` → `verify` → `health`，前三个批次步骤都
幂等，空 tick 是 no-op：

```bash
docker compose logs -f batch
# 手动触发一次（不依赖调度）
docker compose exec batch node --experimental-sqlite dist/cli/batch.js production --site bayjf.com
```

`report` / `packet` **不在循环里**：它们会生成带版本号的新文件而不是覆盖，放进
小时循环会把 reports 卷刷满。请单独排期调用。

#### 连续运行可见性（run ledger / health）

每次 `batch <command>` 调用都会向 `GA_REPORT_DIR` 下的 `run-ledger.jsonl` 追加
一行：命令、站点、状态（`ok` / `skipped` / `failed`）、耗时、结果摘要，失败时还
有原因。它是普通文件，随 `reports` 卷持久化，不写数据库，也不改变任何业务默认值。

```bash
# 最近 7 天实际跑了什么（含今天，用来核对真实节奏）
docker compose exec batch node --experimental-sqlite dist/cli/batch.js history --days 7
# 最近 30 个完整日必须每天有成功记录；有缺口时退出码为 1
docker compose exec batch node --experimental-sqlite dist/cli/batch.js health --days 30 --site bayjf.com
```

调度器每个 tick 在 `daily` → `production` → `verify` 之后跑一次 `health`；失败只
打印到 stderr，不终止循环。`batch` 服务同时用同一个检查作为 compose healthcheck
（覆盖镜像自带的 `:8790` 检查——这个容器里没有服务监听该端口）。所以某天漏跑会在
当天的 tick 上以 `health: GAP — ...` 出现在 `docker compose logs batch`，并让
`docker compose ps` 显示 `unhealthy`，不需要等三十天后再翻周报。

- 今天不算缺口：只有完整日（UTC）进入检查窗口，给当天重试留出时间。
- 检查对象是 `daily`：`production` / `verify` 只处理 `daily` 建出的任务，不能让它们
  掩盖一个缺失的上午批次；其它命令仍会进 `history`，只是不参与覆盖判定。
- 账本第一条记录之前的日期不要求覆盖，新部署不会一上来就报 30 天缺口。
- `skipped`（同一天已跑过）不是缺口；`failed` 若当天后续重试成功则不算缺口，
  但仍会在 `health` 输出里列出失败次数与最近一次原因。
- 历史回放用 `--day` 重跑指定日期，例如
  `docker compose exec batch node --experimental-sqlite dist/cli/batch.js daily --site bayjf.com --day 2026-11-05`；
  `history` 只读取账本本身，不会重放外部副作用。

#### 外发告警（可选，webhook）

`health` 的退出码和 compose 的 `unhealthy` 只在本机可见；没人盯日志时，断档仍可能
一整天无人知道。配置 webhook 后，同一处判断会额外 POST 一条消息：

| 变量 | 默认 | 作用 |
|---|---|---|
| `GA_ALERT_WEBHOOK_URL` | 空（关闭） | 目标地址；留空时模块完全惰性，行为与之前一致 |
| `GA_ALERT_WEBHOOK_FORMAT` | `generic` | `generic` 发 `{text,...}`（Slack 可直接用）；`feishu` 发文本卡片 |
| `GA_ALERT_WEBHOOK_TOKEN` | 空 | 可选 Bearer；不写日志 |
| `GA_ALERT_COOLDOWN_MINUTES` | `360` | 同一个告警键在该窗口内只发一次 |

覆盖三种情况：命令运行失败（`run_failed`）、覆盖缺口（`coverage_gap`）、账本为空
（`coverage_empty`）。三条硬约束：

- **不改变退出码**：告警是附加投递。`health` 有缺口仍 exit 1，失败命令仍 exit 1。
- **去重 + 退避**：键为 `run_failed:<site>:<command>:<day>` 或 `<kind>:<checkedTo>`，
  6 小时内同一键只发一次；发送失败按 1s/2s 退避重试，共 3 次。
- **告警失败不拖垮主流程**：webhook 不可达只在 stderr 打一行，不替换原始错误。

去重状态写在 `GA_REPORT_DIR/alert-state.json`（与台账同卷），删掉该文件即可重置窗口。

#### 草稿来源（inbox / loom）

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
  dump 失败时容器以非零码退出，由 `restart: unless-stopped` 重启：
  `docker compose ps` 会显示 Restarting，日志出现 `[pg-backup] backup failed`。
  **不再 `|| true` 静默吞失败。**
- **存储位置限制**：`backups` 卷与 `pgdata` 卷在同一台主机上。**主机或磁盘损坏时
  备份与数据库同时丢失**，这不是异地容灾；跨机副本尚未实现。
- **恢复已演练（2026-11-08）**：本机没有历史 dump（没有运行中的 growth-agent
  compose 栈或卷，也没有 `*.sql.gz`），因此用 `db-backup` 同款命令现场生成 dump，
  再恢复到一个独立的临时库。**这证明的是"同款命令产出的 dump 可恢复"，不是
  "恢复了一份历史备份"。**

  ```bash
  # 临时实例（独立容器与端口，不动生产栈）
  docker run -d --name drill-growth-agent-pg \
    -e POSTGRES_USER=drill -e POSTGRES_PASSWORD=drill \
    -e POSTGRES_DB=growth_agent_src -p 127.0.0.1:55432:5432 \
    pgvector/pgvector:pg16

  # 建 schema：按文件名顺序应用 db/migrations/postgres/*.sql
  docker exec -i drill-growth-agent-pg \
    psql -v ON_ERROR_STOP=1 -U drill -d growth_agent_src < db/migrations/postgres/001_growth_tasks.sql
  # ... 002 至 009 同样执行

  # 写入代表行后，用 sidecar 同款命令生成 dump
  docker exec drill-growth-agent-pg sh -c \
    'PGPASSWORD=drill pg_dump --no-owner --clean --if-exists -U drill -h 127.0.0.1 growth_agent_src' \
    | gzip > /tmp/drill-growth-agent/growth_agent_src-<stamp>.sql.gz

  # 恢复到第二个库
  docker exec drill-growth-agent-pg psql -U drill -d postgres \
    -c 'CREATE DATABASE growth_agent_restored'
  gzip -dc /tmp/drill-growth-agent/growth_agent_src-<stamp>.sql.gz \
    | docker exec -i drill-growth-agent-pg \
      psql -v ON_ERROR_STOP=1 -U drill -d growth_agent_restored
  ```

  实际输出（2026-11-08）：

  ```text
  DUMP=/tmp/drill-growth-agent/growth_agent_src-20261108T135958Z.sql.gz 2345 bytes
  GZIP_OK
  RESTORE_EXIT=0

  --- source ---            --- restored ---
  api_calls=1               api_calls=1
  channel_failures=1        channel_failures=1
  github_webhook_deliveries=1  github_webhook_deliveries=1
  growth_tasks=1            growth_tasks=1
  gsc_daily_snapshot=1      gsc_daily_snapshot=1
  sentiment_daily_snapshot=1  sentiment_daily_snapshot=1
  zeus_webhook_deliveries=1 zeus_webhook_deliveries=1
  zeus_webhook_nonces=1     zeus_webhook_nonces=1
  COUNTS_MATCH
  ```

  8 张表逐表行数与源库一致。未用健康端点做校验：本仓零依赖原则不包含 `pg`，
  postgres 模式缺 `pg` 会 fail-closed，无法在演练中启动应用；因此以逐表行数作为
  "恢复可用"的证据。恢复后启动应用并观察 `/healthz` 仍是上线动作，需在带 `pg`
  的派生镜像上执行。

  生产恢复命令（先恢复到临时库验证，不要直接覆盖）：

  ```bash
  # 从 backups 卷取 dump（db-backup 容器挂了该卷），恢复到临时库验证
  docker compose exec -T postgres createdb -U growth growth_agent_restore_check
  docker compose exec -T db-backup sh -c 'gzip -dc /backups/growth_agent-<stamp>.sql.gz' \
    | docker compose exec -T postgres psql -U growth -d growth_agent_restore_check
  # 比对逐表行数后再切换到该库
  ```

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
# 升级前留档当前镜像，作为代码回滚锚点
docker tag growth-agent:local "growth-agent:$(date -u +%Y%m%d-%H%M)"

git pull && docker compose build orchestrator
docker compose up -d orchestrator
# 容器启动时自动跑 migrate:up（sqlite/postgres 配对迁移，幂等）
# /healthz 变 ready 即完成；v1 接受分钟级停机，不做零停机
```

回滚到上一版镜像：

```bash
GA_IMAGE_TAG=20261108-1200 docker compose up -d orchestrator
```

本仓没有镜像 registry，`GA_IMAGE_TAG` 指向的镜像只在本机 Dockerd 中；
**换机或清理 `docker images` 后该 tag 不存在，回滚路径即失效**。要跨机回滚，
需先 `docker save growth-agent:<tag> | gzip > growth-agent-<tag>.tar.gz` 并异地保存，
或推送到 registry。这不是与 registry 等价的方案。

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
| `docker compose ps` 中 batch 为 `unhealthy`，或日志出现 `health: GAP` | 读 `reports` 卷的 `run-ledger.jsonl`；按提示的缺失日期补跑 `batch daily --day <日期>`，下一个 tick 的 `health` 会恢复 |

## 9. 不做的事

- 不向 SaaS 仪表盘发送任何数据；外部调用只发生在你配置的 BYOK 上游。
- 不自动合并 PR、不自动发布、不提供每日 1+1 以上的产量档位。
- 不把任何密钥写入镜像层、日志、周报或 git 历史。

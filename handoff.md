# Handoff

## 待办登记（标准）

> 本段是本产品唯一活跃待办入口；详细背景见下方原有章节。完成一项改 `[x]`，并在“最近变更 / Recently shipped”留证据。
> 最近同步：2026-11-19

<!-- tier0:todos v1 -->
| id | title | status | priority | owner | next | evidence | updated |
|---|---|---|---|---|---|---|---|
| GA-01 | 真实 SERP / GSC 凭据 | blocked | p1 | owner | DataForSEO Basic Auth + GSC OAuth | - | 2026-11-19 |
| GA-02 | 成稿模型切 `doubao-seed-1-6` | blocked | p1 | owner | SSO 重登后登记并切换，提升营销文案质量 | - | 2026-11-19 |
| GA-03 | 生产全自动发证 `final_id` | open | p2 | self | 打通上游 operator 自动发证 | - | 2026-11-19 |
<!-- /tier0:todos -->

### 已完成（历史）

- [x] **真实 GitHub PR 闭环** — 状态：已完成（2026-11-22）；证据：`scripts/smoke/github-pr-e2e.mjs` 在 `bayernjf/git-e2e-test` 真实建 PR #19，幂等复用与状态查询通过，收尾自动关 PR/删分支；报告 `data/e2e/github-pr-2026-11-22T14-32-39-930Z.json`。
- [x] **零凭据本地日跑产候选** — 状态：已完成（2026-11-22）；GSC fixture 按输入维度回放，`GA_GSC_OFFLINE_ROLLING=1` 时按昨日 UTC 锚点滚动；本机 `daily` 当日产出 1 write + 1 fix。

> **2026-11-22 补登：真实 GitHub PR 闭环 + 零凭据滚动回放（Tier 0 本地 MVP 收口）。**
>
> - **真实 GitHub PR**：新增 `scripts/smoke/github-pr-e2e.mjs`，用真实 `GitHubPublisher` 跑 daily → zeus 审批 → production sweep → 建 PR；目标仓固定为 `bayernjf/git-e2e-test`（非该仓需 `GA_E2E_ALLOW_ANY_REPO=1`），默认验证后关 PR 并删任务分支。实跑 PR #19：创建成功、head branch 与 task 匹配、PR body 带 task id、重复 `openChange` 返回同一 PR、`getChangeStatus=open`，全部断言通过。报告落在 `data/e2e/`（gitignored）。
> - **零凭据本地日跑**：`OfflineGscProvider` 本来已按 site/date/dimensions 过滤，但 fixture 固定日期在 2026-09/10，当前日历跑 daily 会 0 候选。新增显式 `GA_GSC_OFFLINE_ROLLING=1`：把该站最新记录锚到昨日 UTC，其他行等距平移，recent/prior 窗口保持原有落差；默认关闭，严格日期回放与既有测试不变。本机 2026-11-22 `daily` 实跑输出 `gt_20261122_write_1` + `gt_20261122_fix_2`，deferred 2 write / 0 fix。
> - **边界**：rolling 是合成回放，不是实时 GSC；真实 GSC/DataForSEO 仍需凭据，保留为 post-MVP 项，不计入本地 MVP 阻塞。真实 GitHub smoke 只验证 publisher/状态写回，不代表内容质量或 merge 后验证已完成。
> - **门禁**：`npm run check:all` 全绿（48 文件 / 468 tests，新增 2 个 replay 用例）。

> **2026-11-13 补登：growth-agent 已加 loom 自动发证，闭合 final_id 契约缺口。**
>
> - **变更**：`LoomClient` 新增 `issueFinal()`（`POST /api/fcw/assemble`），409 `DuplicateIssuance`（同 pws+pwc+platform+slot+country 已发证）幂等复用已有 final_id 而非报错。draft 层的 inbox envelope 新增可选发证材料 `productSpaceId/platform/slotId/goal/country/pwsId`：无 `finalId` 时 `LoomDraftProvider` 自动调 `issueFinal` 发证，再走 `/api/content/generate`。
> - **边界不变**：growth-agent 仍不建模 loom 的发布资产拓扑，四个必填字段原样来自 envelope，不在本地推导；有 `finalId` 时行为与旧版完全一致。
> - **验证**：`npm run typecheck && npm run lint && npm test`（467 用例全绿）+ `npm run build` 通过；新增 9 个用例覆盖 wire body、可选 country/pws、409 复用、guards-failed 不复用、draft 自动发证与材料不全。
> - **commit**：`5bb9c7e`（connector 端口）、`f6aee1c`（draft 编排）、`ba503a8`（测试）。
> - **仍未做（等 SSO）**：SSO 重登后登记 doubao-seed-1-6 接入点，把成稿模型从 ark-code-latest 切过去提升营销文案质量。

> **2026-11-13 补登：loom 模式（ARTICLE-GEN）已通过 ark-code-latest 跑通 HTTP 端到端。**
>
> - **结论**：growth-agent 的 loom 模式（`GA_DRAFT_MODE=loom` → `POST /api/content/generate`）已在 loom 侧真实验证闭环——staff 令牌（operations）认证通过，`/api/content/generate` 返回 **201 + status=review**，真实产出种草文，`SCENE_ARTICLE_GEN="ARTICLE-GEN"` 经 `gateway.invoke` 解析到 **ark-code-latest**。
> - **前提**：loom 已接 model-hub（创建 loom 项目 + 分配 ark-code-latest + token，见 loom/handoff.md），`ARTICLE-GEN` 与 `CONTENT-BASE` 两场景 text 模态均命中 ark-code-latest。
> - **剩余缺口（未解决）**：growth-agent 自身**不发 final_id**——`src/connector/loom/http.ts::submitTopicDraft` 靠上游传 `input.finalId`，为空即报错。final_id 需 operator 线下经 loom `POST /api/fcw/assemble` 发证（要 product_space/platform/slot/七 Guard 前置）。本次验证为绕过该缺口，对 loom 测试环境 E2E 遗留 final 的冻结快照直接写库恢复后复用；**生产上这条链路的全自动发证仍未打通**。

> **2026-11-06 补登：dev → main 已于 2026-11-05 经 PR #10 合并（合并前 CI 全绿）；实测 origin/main 与 origin/dev 内容完全一致（git diff 为空）。**

State of growth-agent as of 2026-10-28.

> 一句话：**W11 把「装配完成但没人调用」的循环接成了真正可运行的东西**——批次有了
> 触发器（CLI + compose 调度）、任务有了持久化上下文、生产批次有了草稿来源和真实证据，
> GSC 的 online 传输也从占位实现换成了真代码。真实 GitHub PR 已在专用测试仓跑通；
> 真实凭据仍是 post-MVP 项，零凭据本地日跑已由 `GA_GSC_OFFLINE_ROLLING=1` 补齐。


## 2026-11-11 batch unhealthy：幂等误判更正（只读实测）

**结论先行：`already_ran_today` 是正确的幂等，2026-11-10 也没有漏跑采集。**
`batch-1` 的 `unhealthy` 是**账本覆盖缺口**，不是业务缺口；此前把它读成「那天没跑／
幂等挡错了」是误判。本轮为纯只读核查：未跑采集、未写数据库、未改账本、未改代码。

### 实测证据

- 容器：`growth-agent-batch-1`，Created `2026-11-10T13:39:57Z`，
  `State.Health.Status=unhealthy`，`FailingStreak=26`（2026-11-11T13:05Z 测），
  保留的 5 次检查全部 `exit=1`，间隔 30m，与 `docker-compose.yml:122-127`
  （`interval: 30m`、`retries: 2`）一致。
- `health` 实跑（`docker exec … node --experimental-sqlite dist/cli/batch.js
  health --site "$BATCH_SITE"`，exit **1**）：
  `health: GAP — 1/1 complete days missing (2026-11-10) in 2026-11-10..2026-11-10; last ok 2026-11-11T06:29:13.758Z.`
- 账本 `/data/reports/run-ledger.jsonl`（卷 `growth-agent_reports`）共 **72** 行。
  按 `day` × `command` 统计 `daily`：**2026-11-10 = 13 skipped / 0 ok**，
  2026-11-11 = 1 ok / 6 skipped。11-10 的 `ok` 只有 `production` 与 `verify`。
  13 条 skipped 的 reason 全是 `already_ran_today`。
- **账本第一条记录**就是 `2026-11-10T12:07:32.896Z daily skipped already_ran_today`。
- 数据库 `/data/growth-agent.db`（卷 `growth-agent_agent_data`，只读打开
  `new DatabaseSync(path,{readOnly:true})`）`growth_tasks` 全表只有 **3** 行：

| id | created_at | status | zeus_decision_id |
|---|---|---|---|
| `gt_20261110_write_1` | 2026-11-10T09:33:58.793Z | deciding | `dec_offline_gt_20261110_write_1` |
| `gt_20261110_fix_2` | 2026-11-10T09:33:58.793Z | deciding | `dec_offline_gt_20261110_fix_2` |
| `gt_20261111_write_1` | 2026-11-11T06:29:13.758Z | deciding | `dec_offline_gt_20261111_write_1` |

### 根因

11-10 的 `daily` **成功跑过**：09:33:58.793Z 建了 1 写 + 1 修两条任务并提交 zeus。
但那次运行**比账本的第一条记录（12:07:32.896Z）早约 2.5 小时**——账本功能是在那天
中途才开始写盘的，成功运行没留下 `ok` 行。此后每个 tick 都被同日幂等正确挡成
`skipped`，于是这一天在账本里永远只有 skipped。

而覆盖判定**只认 `ok`**：`src/report/run-ledger.ts:177-180` 只在
`status === 'ok'` 时 `okDays.add(key)`，`:221` 对不在 `okDays` 的日子记 missing；
`health` 又把范围限定为 `command: 'daily'`（`src/cli/batch.ts:241-247`），
所以 11-10 的 `production` / `verify` 各 13 条 `ok` 也不能替它覆盖。

### 为什么它不会自愈

- **等**：默认窗口 30 天（`src/cli/batch.ts:115-121`），窗口起点被夹到账本首日
  （`run-ledger.ts:190`）。11-10 会一直留在窗口里，直到 **2026-12-10**；
  **2026-12-11** 才滚出去。也就是说这个 unhealthy 还会持续约 30 天，前提是
  11-11 起每天都有 `daily ok`。
- **补跑**：`deploy/SELF_HOSTING.md` §8 原先给的处置（`batch daily --day <日期>`）
  对这种缺口**无效**——`--day` 会原样传进 `runner.run(day)`
  （`src/cli/batch.ts:349`），幂等比较的正是该日期的 `created_at` 前缀
  （`src/scheduler/daily.ts:106-113`），任务已存在 → 再次 `skipped`。
  本轮未实跑补跑（那会向账本追加一行），此条为**代码级**结论。
- **没人被告警**：容器内 `GA_ALERT_WEBHOOK_URL` 为**空**，告警模块完全惰性，
  GAP 只存在于本机日志与 `docker compose ps`。

容器在 11-10 当天其实是 healthy 的：那时 `today=11-10`、`windowEnd=11-09`，
窗口起点晚于终点，走 `run-ledger.ts:196-209` 的「warming up」分支返回 healthy；
跨过 UTC 零点后第一次检查才翻红。此条为**代码级**推导（docker 只保留 5 条检查日志，
无法实测首次翻红时刻）。

### 顺带更正：F-07 已修复，不是开放缺陷

`docs/reviews/code-review-2026-11-02.md` 的 F-07（signaled 永久滞留）在当前 `dev`
已修：逐候选 try/catch（`src/scheduler/daily.ts:292-297`）+ reconcile 的 signaled
出口（`src/reconcile/reconcile.ts:127-165`）。回归测试
`tests/scheduler/daily.test.ts:135-200`；实跑
`fnm exec --using=22.23.4 npx vitest run tests/scheduler/daily.test.ts tests/report/run-ledger.test.ts`
→ **20 passed / exit 0**（仓库 `.nvmrc` 为 22，本机 fnm 默认 20 会假红）。
现网 3 条任务全为 `deciding`，**无 signaled 滞留**。已在该评审文档 F-07 下追加
带日期的补注，并明确「改同日幂等判断」这个备选方案不应采纳。

### 本轮改了什么（只有文档）

- `deploy/SELF_HOSTING.md` §3.3：删掉「`skipped`（同一天已跑过）不是缺口」这句
  **与代码不符**的断言，改为「覆盖只认 ok」+ 区分两种 skipped。
- `deploy/SELF_HOSTING.md` §8 排障表：把 GAP 处置拆成「真漏跑 → 补跑」与
  「只有 already_ran_today → 补跑无效」两条。
- `docs/reviews/code-review-2026-11-02.md`：F-07 追加 2026-11-11 已修复补注。
- 本文件：本节。

### 待 owner 决策（本轮未动代码）

1. **要不要让 health 承认「任务已建好」的日子**：例如覆盖判定接受
   `skipped/already_ran_today` 作为该日已完成的证据，或 health 额外查一次
   `growth_tasks` 当日是否有行。前者纯账本、后者破坏「health 不碰数据库」的现有
   设计承诺（`docker-compose.yml:112-116`、`src/cli/batch.ts:235-237`）。
2. **要不要给一次性缺口一个人工出口**：如 `batch health --ack-day <日期>`
   或允许向账本补写一条带来源标注的 `ok`。两者都是写操作，需明确授权。
3. **要不要接受现状**：什么都不改，让它红到 2026-12-10。代价是这 30 天里
   `unhealthy` 失去告警价值——真漏跑会被这条已知红噪声掩盖。
4. `GA_ALERT_WEBHOOK_URL` 仍为空（与 loom 的 `LOOM_ALERT_WEBHOOK` 同一类问题）：
   本机之外的断档无人知晓，需要 owner 提供 bot 地址。

## 2026-11-05 只读复核（表述修正）

- `config/sites/*.json` 的 `github.owner`/`repo`/`baseBranch` **均已是真实值**
  （`bayernjf/bayjf`、`bayernjf/job-agent-landing`、`bayernjf/zeus-landing`），
  不存在"owner/repo 待填"；PAT 属 env（`GA_GITHUB_TOKEN`），不属站点配置。
- 真实待办修正为以下四条，均非代码可清：
  1. ~~两个 `*-landing` 的 GSC `siteUrl` 仍是 `pages.dev` 占位~~ **2026-11-06 已改为正式域**，
     来源见下一节；
  2. 部署宿主 `./config/sites` 副本与仓内版本同步（宿主状态本地无法核对），
     覆盖步骤见下一节末尾；
  3. `GA_GITHUB_TOKEN`（最小权限 PAT）与 webhook secret 未配；
  4. 真实 GSC OAuth、DataForSEO key 缺失（见汇总 A 组）。
- 远程已建：`git@github.com:bayernjf/growth-agent.git`（`dev`/`main` 均在，本地同步）；
  AGENTS.md 中"未授权不 push"的规则本身继续有效。

## 2026-11-06 GSC 正式域名与占位校验

- 两个 `*-landing` 的 `gsc.siteUrl` 已改为正式域，来源均为对应 landing 仓的权威文件：
  - `zeus-landing.json` → `https://zeus.bayjf.com/`：`zeus-landing/src/consts.ts`
    的 `SITE_URL = "https://zeus.bayjf.com"`；`zeus-landing/docs/DEPLOYMENT.md`
    「自定义域名」记录该域已生效（HTTPS 200，CNAME `zeus → zeus-landing.pages.dev`）。
  - `job-agent-landing.json` → `https://job-agent.bayjf.com/`：
    `job-agent-landing/astro.config.mjs` 的 `site`、`README.md` 与
    `docs/DEPLOYMENT.md` 均把该域列为自定义主入口。
- 新增 `scripts/check-site-urls.mjs` / `npm run check:site-urls`，已接入 `check:all`
  与 `.github/workflows/ci.yml`。命中 `*.pages.dev`、`*.workers.dev`、`example.com`、
  `localhost`、`placeholder`、`<...>` 模板时退出码 1，并打印
  `<文件>: gsc.siteUrl ...`。
- 仍未验证：两个正式域在 GSC 中是否已添加为 property、以及 property 类型。
  配置按 URL-prefix 形态填写（协议 + 尾斜杠）；若 GSC 中是 Domain property
  （`sc-domain:`），需按实际属性改写。

### 宿主 `./config/sites` 以仓内为准的覆盖步骤

`docker-compose.yml` 把宿主 `./config/sites` 只读挂到 `/app/config/sites`，会覆盖
镜像内副本，所以宿主副本落后时会复活 pages.dev 占位。宿主机不在本机，以下命令在
部署机执行：

1. 取仓内最新版本：
   ```bash
   git -C <growth-agent 仓库路径> fetch origin dev
   git -C <growth-agent 仓库路径> checkout dev
   git -C <growth-agent 仓库路径> pull --ff-only
   ```
2. 只读比对，先看差异：
   ```bash
   diff -ru <growth-agent 仓库路径>/config/sites <部署目录>/config/sites
   ```
3. 备份宿主副本：
   ```bash
   cp -a <部署目录>/config/sites <部署目录>/config/sites.bak-$(date +%Y%m%d-%H%M%S)
   ```
4. 以仓内为准覆盖，删除宿主多余文件：
   ```bash
   rsync -a --delete <growth-agent 仓库路径>/config/sites/ <部署目录>/config/sites/
   ```
5. 校验宿主副本：
   ```bash
   node <growth-agent 仓库路径>/scripts/check-site-urls.mjs <部署目录>/config/sites
   ```
6. 绑定挂载实时生效，无需重建容器；确认容器内是同一份：
   ```bash
   docker compose exec orchestrator cat /app/config/sites/zeus-landing.json
   docker compose exec orchestrator cat /app/config/sites/job-agent-landing.json
   ```
7. 若第 2 步发现宿主上有仓内没有的站点文件，先确认是否要并入仓内再执行
   `--delete`，避免误删唯一副本；`rsync` 前已备份，可随时回退。

## 已验证（本机实测，不是文档转述）

- `npm run check:all` 五门全绿：**35 文件 / 329 测试**（W10 基线 32/289）。
  必须在 Node 22 下跑；仓库已加 `.nvmrc=22`，因为 fnm 默认 Node 20 时 `node:sqlite`
  不存在，16 个测试文件加载失败、套件假红成 180 通过。
- `npm run smoke:offline` 通过：daily → 人审 → QA → PR → merge → verify → reports。
- 真进程端到端（构建产物 + 文件型 sqlite + 真 Hono + 真 HMAC 签名）跑通：
  `daily`（离线 0 候选，见缺口）→ 签名 zeus 审批 webhook（200，deciding→drafting）
  → 无草稿时 `production` 跳过且不消耗 rework → 放草稿后 `production` 开 PR
  （`pr_opened`，QA intent/dedupe/value 全 true）→ `verify` → `report` → `packet`。

## W11 改了什么

| 面 | 改动 | 为什么 |
|---|---|---|
| 触发器 | `src/cli/batch.ts` + `npm run batch`，`deploy/batch-scheduler.sh`，compose `batch` 服务 | 此前 `DailyScriptRunner` / `runProductionBatch` / `runVerificationBatch` 的调用方只有测试和冒烟脚本，部署后收到审批也不会动作 |
| 上下文 | migration 007 `growth_tasks.context`（sqlite TEXT / pg JSONB）+ 仓储 patch | daily 只把 query/targetUrl 发给 zeus，从不落库；生产和复查批次因此拿不到任务上下文 |
| 草稿来源 | `src/draft/`（port + inbox + loom + registry），`GA_DRAFT_MODE=inbox\|loom` | `runProductionBatch` 的 draft 是注入参数，`createLoomClient` 零生产调用方 |
| 生产驱动 | `src/scheduler/production-sweep.ts` | 把 `runProductionBatch` 接上 GSC 快照 / SERP / 自身未合并 PR 证据 |
| GSC 在线 | `src/connector/gsc/online.ts` 真实 searchanalytics 传输（T-B4） | 原文件是 W4 占位实现，`online` 模式必定 not-implemented |
| 存储 | `src/storage/open.ts` 抽公共驱动工厂；仓储 JSON 列双方言容错 | pg 的 JSONB 由 node-pg 预解析为对象，旧 `JSON.parse` 在 postgres 会抛错 |
| 镜像/部署 | Dockerfile 复制 `config/`；compose `batch` 服务；`.env.example` 增 `GA_DRAFT_*` / `BATCH_*` | 镜像里缺站点配置，CLI 在容器内会找不到 `config/sites` |

两个由测试固定住、**故意如此**的规则：

1. fix 任务只把自己目标页的行作为需求证据。value gate 会把 gscPages 的 impressions
   求和，混入整站可让无自然曝光页白过闸。守卫测试：把整站传进去就变红。
2. fix 任务的 target 页**不能**作为 dedupe 的「已发布冲突」传入，否则每次修复都会被
   当成重复内容拦下。守卫测试同上。

## 已知缺口（按优先级）

1. ~~零凭据离线模式产不出候选~~ **已修并合 main（merge `143d444`，fix `4eedb78`/`90efddd`；`git branch -r --contains 143d444` 命中 `origin/main` 与 `origin/dev`）**。
   根因：回放忽略输入——GSC 不论 `page`/`query` 维度都返回同一批 query 维行且两个
   窗口相同；SERP 对任何 query 返回同一份结果。修复：fixture 按维度+窗口结构化
   （`analytics.query` / `analytics.page.recent|prior`，窗口按 startDate 中点选桶），
   SERP 按 query 录制结果集。离线 `daily --day 2026-10-26` 实测产出
   1 write（self hosted growth agent）+ 1 fix（/guides/vite-manual-chunking）；
   `check:all` 与 `smoke:offline` 全绿（36 文件 / 334 测试）。
2. **GSC T-B4 wire 形状未经真实属性验证**。12 个契约级假上游用例覆盖了刷新、401
   重试、§4.1 映射、截断保护，但字段名只按 v3 文档写。真凭据首跑要先核对。
3. **SERP T-C2**：`src/connector/serp/http.ts` 自述未用真 key 验证过 wire。
4. **loom final_id 契约缺口**：`final_id` 需 operator 经 `/api/fcw/assemble` 线下发证
   （要 product_space_id/platform/slot_id，本仓无此模型）。loom 模式因此要求收件箱
   文件里带 `finalId`。
5. compose 里 sqlite 模式下列 `orchestrator` 与 `batch` 共用一个库文件：写入频率低但
   没有 `SQLITE_BUSY` 重试，多写场景建议切 postgres。
6. 真实 30 天连跑（T-H4）、dogfood 评审与定价（T-H5）仍卡 owner 决策。
   T-H4 的计时目前被一条**非业务**的账本缺口污染，见第 7 条。
7. **`batch health` 把 2026-11-10 判成永久 GAP，容器 unhealthy 会持续到
   2026-12-10**；采集本身没漏跑，处置需 owner 决策。证据与四个选项见
   「2026-11-11 batch unhealthy：幂等误判更正」一节。

## 下一步（建议顺序）

1. 用真实 GSC 属性跑一次 `npm run batch -- daily --site bayjf.com`，核对 T-B4 的
   wire 形状（先只开 `GA_GSC_MODE=online`，SERP 保持 off）。
2. ~~修离线 fixture/replay 让它能产 1 write + 1 fix~~ 已在 `feature/offline-replay`
   完成（复现测试 90efddd + 修复 4eedb78），待走 PR 门禁合并。
3. 配 `GA_SERP_MODE=online`（DataForSEO BYOK，会产生真实费用）打通 write 候选。
4. 开 `GA_GITHUB_MODE=online` + webhook secret，让 production 打真 PR（人工合并）。

## 常用命令

```bash
fnm use                                   # .nvmrc 固定 Node 22
npm ci && npm run build
npm run check:all                         # 五门：迁移配对/typecheck/lint/test/build
npm run smoke:offline                     # 离线全链路
npm run batch -- daily      --site bayjf.com
npm run batch -- production --site bayjf.com
npm run batch -- verify     --site bayjf.com
npm run batch -- report     --site bayjf.com   # 会生成带版本号的新文件
```

## OP-30 / OP-32 广告只读与周报 ROI（2026-11-01）

- 新端口 `src/connector/ads/`（`AdsReadonlyProvider`）：`offline.ts` 确定性 fixture
  （零网络、按日窗过滤）、`rejecting.ts`（422 `ADS_CREDENTIAL_MISSING`）、
  `registry.ts`（`GA_ADS_MODE`，默认 off）。
- **online 一律 fail-closed**：真实巨量引擎只读传输属 OP-31，卡广告账户授权，
  本批不实现，且绝不静默回落 offline。
- 周报新增可选 `ads` 段：`spendMicros/impressions/clicks/conversions/cpaMicros/roiPct`；
  `cpaMicros` 在零转化时为 null、`roiPct` 在无 revenue 注入时为 null，渲染为 `—`。
  **未注入 ads provider 时报告与之前逐字一致**（无新小节）。
- ads 读取经 `CostRecorder` 记入 `api_calls`（provider 标签 `ads`，失败也记 0 单位）。
- 测试：`tests/connector/ads-connector.test.ts`（6）+ `tests/report/weekly-ads.test.ts`（9）。

## 不可越过的边界

- D2 人审下限，`slaHours=24h`；不存在 D0/D1 自动放行。
- bot 只开 PR / 建草稿，最后一步永远是人工合并；`approve/reject/revise` 属人审台，
  本仓永不代调。
- 日产量硬上限 1 写 + 1 修。
- GSC 严格只读 scope，token 加密落盘，发布凭据与 GSC 凭据分离。
- 连接器/草稿来源一律端口 + 注册表：默认离线，online 缺凭据 fail-closed。
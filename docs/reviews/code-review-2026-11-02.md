# growth-agent 深度代码评审报告（2026-11-02）

> 只读评审：未修改任何源码、未提交、未建分支。所有结论均附文件:行号或实测输出；
> 无法核实的条目标注「未确认」。评审基线：本地 `dev` 分支 HEAD（`d446991`）。

## 1. 仓库定位与规模

- 定位：自托管、BYOK、每日 1 写 + 1 修的极简增长 Agent 编排外壳；与 zeus /
  growth-os / loom / atlas / ops-console 只走 HTTP/openapi。
- 技术栈：Node 22（`.nvmrc` 固定）、ESM、TypeScript strict
  （`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）、Hono、Vitest；
  存储 SQLite（`node:sqlite`）/ Postgres（可选 `pg`）双方言迁移。
- 规模：`src/` 约 10,076 行（68 个 TS 文件）；`tests/` 约 7,166 行（41 个
  `*.test.ts`）；含脚本/迁移全仓 TS/SQL/脚本合计约 17.7k 行。运行时依赖仅
  `hono` + `@hono/node-server` 两个包。
- 测试/源码比约 0.71，9 对双方言迁移（001–009），3 个站点配置
  （bayjf.com / job-agent-landing / zeus-landing，对应 3 个不同 GitHub 仓库）。

## 2. 结论摘要

计数：**P0 ×0，P1 ×4，P2 ×5，P3 ×5**。

最关键三条：

1. **`npm run smoke:offline` 当前是红的**——smoke 脚本的 zeus approved 事件缺
   `slaHours`，被 approval gate 以 422 拒绝（已实测复现），而 `handoff.md:16`
   与 README 均声称其通过；CI 不跑 smoke，故无人发现（详见 F-01）。
2. **生产批次先把任务推进 `pr_opened` 再调 GitHub 开 PR**：publisher 一旦失败，
   任务永久卡死在 `pr_opened`（无恢复边、无重试入口）（F-02）。
3. **GitHub webhook 去重 id 不含仓库名**：多站点三仓库 PR 号必然碰撞，后到仓库
   的事件会被当作重复投递吞掉（F-03）。

正面确认（证据充分的安全基线）：

- 两条入站 webhook 均 HMAC-SHA256 + `timingSafeEqual`，zeus v2 另有时间戳偏移
  窗口 + nonce 原子消费（INSERT ON CONFLICT，`webhook-repository.ts:240-248`）。
- approved 事件有 D2 grade + 正 slaHours 纵深校验（`inbound.ts:190-199`），
  未配置 secret 一律 503 fail-closed。
- 全部 SQL 参数化（`?` 占位），无字符串拼接注入面；无 `child_process`/`eval`。
- GSC refresh token AES-256-GCM 密封落盘，master key 仅 env，密文与密钥分卷；
  日志无密钥输出（仅 `console.log` 状态行）。
- 连接器全部「端口 + 注册表」，online 缺凭据一律 422 fail-closed，无静默降级。
- SSRF：所有 baseUrl（zeus/GSC/SERP/loom/GitHub）来自 env 或站点配置，
  均非请求方输入；服务默认绑定 `127.0.0.1`。

## 3. 验证门实际执行结果（本机实测，Node v22.23.4）

| 门 | 结果 | 证据 |
|---|---|---|
| `check:migrations` | ✅ | `OK: paired migrations (9 files each, sqlite + postgres)` |
| `typecheck` | ✅ | `tsc --noEmit` 无输出 |
| `lint` | ✅ | `eslint .` 无输出 |
| `test` | ✅ | **41 文件 / 379 用例全过**（6.20s） |
| `build` | ✅ | `tsc -p tsconfig.build.json` 无输出 |
| `smoke:offline` | ❌ | 见 F-01；另默认端口 8791 被本机 model-hub 占用，需 `SMOKE_PORT=8891` 复跑才暴露真实失败 |
| `npm audit --omit=dev` | 1 moderate | `@hono/node-server` serveStatic 双重解码（本仓未用 serveStatic，实际影响为零），见 F-14 |

注：`handoff.md` 声称 "35 文件 / 329 测试"，当前实测 41/379（W11 之后 sentiment
与 ads 测试合入，数量增长合理），五门绿与文档一致；但 "smoke:offline 通过"
不成立（F-01）。

## 4. 逐条发现

### P1（严重缺陷）

#### F-01 smoke:offline 已红，验证门与 handoff 失实

- 位置：`scripts/smoke/offline-smoke.mjs:146-149`（approved 事件体无
  `slaHours`）vs `src/connector/zeus/inbound.ts:195-197`（approved 必须携带正
  slaHours）。
- 实测：直接构造 smoke 同款 payload POST 入站 webhook，返回
  `422 {"code":"INVALID_APPROVAL_GATE","message":"approved event requires a positive slaHours (got undefined)"}`；
  `SMOKE_PORT=8891 npm run smoke:offline` 输出 `FAIL both tasks drafting`，随后
  `production batch requires drafting status, got deciding` 崩溃退出。
- 影响：handoff「已验证（本机实测）」一节与 README 快速开始的可信度受损；
  approval gate 加固（代码评审 H5 的修复）后 smoke 未同步，回归保护失效。
  附带风险（未确认）：若真实 zeus 的 approved 事件也不带 `slaHours`，线上所有
  审批都会被 422，循环停摆——需对照 zeus `decisionEventFromRecord` 实际负载核实。
- 修复：smoke 的 approved payload 补 `slaHours: 24`；并把 `smoke:offline`（或其一
  个快速子集）纳入 CI，防止再次静默失绿。

#### F-02 生产批次先改状态后开 PR，publisher 失败任务永久卡死

- 位置：`src/scheduler/production.ts:72`（`applyQaDecision` 将 drafting→pr_opened
  落库）先于 `:88-102`（`publisher.openChange`）。
- 影响：`openChange` 抛错（GitHub 401/403/网络）时任务停在 `pr_opened` 且无
  prRef；`runProductionSweep` 只扫 `drafting`（`production-sweep.ts:124`），
  状态机无 `pr_opened→drafting` 回边（`state-machine.ts:39`），该任务永远无法
  被任何批次重新拾起，只能手工改库。
- 修复：QA 通过后先开 PR，成功后再一次性写入 `prRef + status=pr_opened`
  （或把状态迁移与 PR 结果同事务/幂等重试化）；为卡死任务提供 operator 恢复路径。

#### F-03 GitHub webhook 去重 id 不含仓库，多站点 PR 事件互相吞掉

- 位置：`src/publisher/github/webhook-repository.ts:47-51`
  （`githubDeliveryId(prNumber, action)`），调用处
  `src/publisher/github/inbound.ts:203`。
- 影响：本仓即多站点设计（`config/sites/` 三个站点对应 bayjf / job-agent-landing
  / zeus-landing 三个仓库），新仓库 PR 号都从 1 开始。bayjf 的 PR#1 `opened`
  落账后，job-agent-landing 的 PR#1 `opened` 会因 `gh:1:opened` 已存在而返回
  `200 duplicate`，状态机永不前进，任务卡 `pr_opened` 且无告警。
- 修复：ledger id 加入 `repository.full_name`（注意已存量的 id 迁移/兼容）。

#### F-04 sentiment 功能（OP-40/41/42）合入了但完全未接线

- 证据：`grep createSentimentProvider / SentimentSnapshotRepository src/` 仅命中
  定义文件本身与类型引用；`src/cli/batch.ts` 无 `sentiment` 任何字样（daily 的
  `sentiment`/`sentimentSnapshots` 参数恒为 undefined），`serve.ts` 亦无。
  周报 `deps.sentiment` 恒 undefined → 报告永不含 sentiment 段
  （`report/weekly.ts:151-153`）。
- 影响：5 个 sentiment 相关 commit（`8ef42dd` 等）+ 15 个测试全部只在测试中
  存活，部署循环里该功能等于不存在；handoff 的 OP-40/41/42 叙述未提此缺口。
- 修复：`batch.ts` 的 daily/report 分支注入 `createSentimentProvider(config)` 与
  `SentimentSnapshotRepository`，或在文档中明示「仅库层就绪，未接 CLI」。

### P2（质量/可维护性/失败模式）

#### F-05 多站点 publisher 配置单仓库化

- 位置：`src/publisher/github/registry.ts`（只读全局 `GA_GITHUB_OWNER/REPO`）
  vs `src/cli/batch.ts:191`（prRef 记 `site.github.owner/repo`）。
- 影响：第二、三站点的 PR 会开到 env 指定的那一个仓库，而任务上记录的 prRef
  是站点配置仓库——两者不一致，后续 `findByPrNumber` 对不上。
- 修复：publisher 按站点实例化（registry 接受 per-site override）。

#### F-06 批次循环无逐任务容错

- 位置：`src/scheduler/production-sweep.ts:129-254`、`src/scheduler/verification.ts:49-128`。
- 影响：任一任务的 SERP/GSC 调用抛错（如 UPSTREAM_UNAVAILABLE）会中断整个
  sweep/verify，后续任务当日全部跳过；与 `batch-scheduler.sh` 的「单步失败不
  杀死循环」语义不一致（脚本只兜底命令级失败）。
- 修复：循环内 try/catch，按任务记 `channel_failures` 后继续。

#### F-07 daily 部分提交后任务滞留 signaled

- 位置：`src/scheduler/daily.ts:101-107`（同日幂等）、`:243-280`（逐个创建并
  提交 zeus）。
- 影响：第 2 个候选 `submitDecision` 失败时，第 1 个已进入 deciding，第 2 个
  停在 `signaled`；同日重跑被 `alreadyRan` 挡，`signaled` 无 reconcile 出口
  （`reconcile.ts:56` 只处理 deciding）→ 永久滞留。
- 修复：signaled 任务纳入 reconcile/重试，或 daily 幂等判断改为「今日是否存在
  未提交到 zeus 的 signaled 任务」。

#### F-08 GSC OAuth 握手无入口、state 未校验

- 证据：`startLocalCodeReceiver` / `buildConsentUrl` 在 src/scripts 无任何生产
  调用方（grep 实证）；`deploy/SELF_HOSTING.md:110` 让操作者「按
  `src/connector/gsc/oauth.ts` 流程」自行完成授权；`oauth.ts:112` 返回的 state
  与 `:38` 传入的 state 无任何比对逻辑。
- 影响：online GSC 首次授权实际上无法在不写一次性脚本的情况下完成；state 不
  校验在 loopback installed-app 场景风险较低，但不符合 OAuth 基线。
- 修复：提供 `npm run gsc:auth` CLI（建 receiver → 打印 consent URL → 校验
  state → exchange → 密封落盘）。

#### F-09 draft slug 未校验直接作为 GitHub 文件路径

- 位置：`src/scheduler/production.ts:98`（`input.draft.slug.replace(/^\/+/, '')`
  作为 `files[0].path`）。
- 影响：inbox 草稿文件虽来自可信 operator，但 `../../.github/workflows/x.yml`
  这类 slug 会让 bot 的 PAT 写仓库任意路径（含 Actions workflow，等于提权）。
- 修复：slug 白名单校验（拒绝 `..`、绝对路径、`.github/` 前缀与非常用字符）。

### P3（规范/体验）

- **F-10 死配置 `GA_API_TOKEN`**：`config.ts:100` 解析但全仓无消费方；
  `.env.example:10` 声称其保护 `/api/v1` 路由，但服务只挂 `/healthz` 与两个
  webhook。删除或实现。
- **F-11 GitHub inbound 状态+ledger 非事务**：`inbound.ts:366-381` 的
  `setStatus`/`patch`/`deliveries.record` 三次独立写入（zeus 侧已在事务内，
  `zeus/inbound.ts:477-493`）；崩溃窗口内重投递会被 409 拒绝而非幂等接受。
- **F-12 CI 用 `npm install` 而非 `npm ci`**（`.github/workflows/ci.yml`），
  削弱 lockfile 纪律；且 CI 不含 `check:migrations` 之外的 build 验证顺序与
  `check:all` 不一致（build 在 typecheck 之前跑）。
- **F-13 `@hono/node-server@1.13` moderate CVE**（serveStatic 路径二次解码）；
  本仓未用 serveStatic，实际影响为零，但应升级。
- **F-14 `PostgresDriver.toDollarParams` 全局替换 `?`**（`postgres-driver.ts:43-47`）：
  若未来 SQL 字符串字面量含 `?` 会被错误改写为 `$n`；当前无此类 SQL，属脆弱点。
  另：compose 在 sqlite 模式下也注入 `DATABASE_URL`，且 orchestrator 强依赖
  postgres 服务健康（`docker-compose.yml:40-41`），sqlite 单栈部署被无谓绑定
  （handoff 已自承 SQLITE_BUSY 无重试，此处不重复计级）。

## 5. 架构与模块边界评价

- 边界清晰：`connector/*`、`publisher/*`、`draft/*` 全部端口 + 注册表，offline
  默认、online 缺凭据 fail-closed 的纪律在全仓一致执行（zeus/gsc/serp/loom/
  github/ads/sentiment 七个 registry 同构）。
- 状态机单点收敛（`state-machine.ts` 纯函数），qa_revision 一次性返工由
  `qaRevisionCount` 强制，webhook、QA、生产三处均经 `assertTaskTransition`。
- 存储双方言封装干净；JSON 列双方言容错（pg JSONB 预解析）已在 repository 层
  统一处理（`task/repository.ts:48-52`）。
- 主要结构弱点集中在「批次层失败模式」：状态推进与外部副作用的顺序（F-02）、
  逐任务容错（F-06）、部分提交（F-07）三处同根——批次编排缺少「任务级事务 +
  可恢复」的统一约定。

## 6. 修复优先级建议

1. F-01（补 smoke 的 slaHours + 纳入 CI）——先让验证门重新可信。
2. F-02、F-03——都会让线上任务静默卡死；F-03 在多站点上线前必须修。
3. F-04——要么接线，要么文档降级声明，消除「功能已上线」的错觉。
4. F-05/F-06/F-07——多站点与真实凭据连跑（T-H4）前的必经项。
5. F-08/F-09——GSC online 首跑（handoff 下一步第 1 条）的前置。
6. F-10 至 F-14 随日常维护清理。

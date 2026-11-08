# growth-agent

自托管、BYOK、每天交 PR 的极简增长 Agent。每天产出 **1 篇新内容 PR + 1 个页面修复 PR**，
全部经 zeus 决策内核分级（D2 人审）并由人在 GitHub 合并；每周一份排名变化报告。

- 设计文档：`bayjf/docs/tier0/Tier0-增长Agent技术方案.md`
- 产品需求：`bayjf/docs/tier0/Tier0-增长Agent PRD.md`
- 任务拆解与推进评估：`bayjf/docs/tier0/Tier0-增长Agent任务拆解与推进评估.md`

## 定位

与套件（Semrush/Ahrefs）不同：不卖仪表盘，卖「每天替你完成一件增长工作」。
与 RomeoSEO（云托管）不同：**数据留在用户自己的基础设施**（docker/VPS 自托管），
GSC 只读授权与 SERP API key 用户自带（BYOK），发布最后一步永远是人工合并。

## 架构边界

growth-agent 是编排外壳，与既有 Tier0 内核**只走 HTTP / openapi，不改内核一行**：

- `zeus :8787`：决策分级、SLA 两阶段超时、审批审计、生命周期 webhook
- `growth-os :8788`：信号引擎（采集/去重/打分/洞察）、provider 端口模式
- `loom`：13 段链内容生产、审核台、`final_id`（以 loom openapi 为准）
- `atlas`：NL 生成 / 反思
- `ops-console`：审批面 + 通知卡片 + 深链

真正新增工程：三块连接器（GSC 只读 / SERP BYOK / 多站点发布适配器）+ 本编排外壳。

## 技术栈

- Node 22 LTS、ESM、TypeScript strict（`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）
- Hono（HTTP 与 webhook 接收端）、Vitest、ESLint 9 flat config
- 存储：SQLite（本地，内置 `node:sqlite`）+ Postgres（生产，可选 `pg`）双方言迁移

## 快速开始

```bash
npm ci
npm run check:all       # check:migrations && typecheck && lint && test && build
npm run migrate:up      # 应用 sqlite 迁移（默认 ./data/growth-agent.db）
npm run start           # 启动，默认 http://127.0.0.1:8790
curl http://127.0.0.1:8790/healthz
```

配置见 `.env.example`（复制为 `.env`，密钥永不入库）。

## 当前状态

- W1–W9 已完成（私有 remote `github.com/bayernjf/growth-agent` 已建、main 已推，
  尚未 launch / dogfood 评审）：数据层/状态机（T-A2）、zeus
  决策客户端与入站 webhook（T-A3/T-A5）、GSC/SERP/Publisher 连接器 offline 契约
  （T-B1/B2/B3、T-C1、T-D1）、QA 三闸（T-E1/E2/E3）、GitHub publisher 与入站
  webhook（T-D2/D3）、每日剧本/对账/成本/周报（T-A4/A6/A7/A8）、compose 部署与
  自托管指南（T-F1/F2/F3）、loom 端口+mock（T-E4）、三站点配置/离线全链路冒烟/
  30 天数据包（T-H1/H2/H3）。W10：loom openapi 对照 + 真实 adapter（T-E4 在线半）：
  按 loom FastAPI 契约落地 `POST /api/content/generate` 与 `GET /api/content/{id}`
  的 HTTP adapter，默认 off、缺 url/tenant 拒绝型 422、fixture 离线测试，保留 mock。
- W11 让循环真正可运行。此前 `DailyScriptRunner`、`runProductionBatch`、
  `runVerificationBatch` 的调用方**只有测试和离线冒烟脚本**：部署后的进程只提供
  healthz 和两个入站 webhook，收到审批也不会做任何事。本 wave：
  - `dist/cli/batch.js`（`npm run batch -- <daily|production|verify|report|packet|health>`）
    让 §5 整条循环可被 cron / compose 调度；`deploy/batch-scheduler.sh` + compose
    `batch` 服务按 tick 依次跑三步（三步都幂等，空 tick 是 no-op）。
  - 连跑可见性（#10）：每次 `batch` 命令向 `$GA_REPORT_DIR/run-ledger.jsonl`
    追加一行运行记录；`batch health --days 30` 校验最近 30 个完整日每天都有成功
    运行，缺任一天即 `GAP` + 退出 1，调度器在 `daily` 之后自动执行，断档当天
    暴露而不是等月末复盘。
  - 外发告警：配 `GA_ALERT_WEBHOOK_URL` 后，覆盖缺口、账本为空、命令失败会额外
    POST 一条消息（`GA_ALERT_WEBHOOK_FORMAT=feishu` 走文本卡片），6 小时内同一
    告警只发一次；发送失败只警告，**退出码不变**。详见 `deploy/SELF_HOSTING.md`。
  - migration 007 `growth_tasks.context`：daily 之前只把 query / targetUrl 发给
    zeus 而从不落库，导致生产与复查批次拿不到任务上下文。现在
    `{query, targetUrl, angle}` 随任务持久化，write 任务开 PR 时补记 `publishedUrl`。
  - 草稿来源端口 `GA_DRAFT_MODE=inbox|loom`：inbox 为默认，操作者按任务投放
    `<taskId>.json`，零网络零凭据；loom 模式只用操作者线下发证的 final_id，正文由
    loom 产出。缺文件不伪造内容、**不消耗**唯一一次 qa_revision 返工；loom 未 online
    时选 loom 直接 fail-closed，避免 mock 正文进入真实 PR。
  - `runProductionSweep`：把 `runProductionBatch` 接上真实证据（GSC 快照、SERP、
    自身未合并 PR）。fix 任务**只**用自己目标页做需求证据——value gate 会把
    gscPages 的 impressions 求和，混入整站会让无自然曝光页白过闸。
  - T-B4：GSC searchanalytics 真实传输（access token 刷新与重封、401 强制刷新重试一次、
    §4.1 错误映射、窗口截断保护）。契约级假上游覆盖 12 个用例，**尚未用真实属性验证**。
  - `.nvmrc` 固定 Node 22：fnm 默认 Node 20 时 `node:sqlite` 不存在，16 个测试文件
    加载失败，套件会假红成 180 通过。
  - 门禁：`npm run check:all` 五门全绿（35 文件 / 329 测试，基线 32/289），
    `npm run smoke:offline` 通过；另有一次真进程端到端（构建产物 + 文件型 sqlite +
    真签名 zeus webhook）跑通 daily → 审批 → production → verify → report → packet。
- 明确未做 / 待验证：
  - **零凭据默认模式产不出候选**：`GA_*_MODE=off` 的 fixture 回放忽略请求维度（GSC
    无论要 page 还是 query 都返回同一批 query 维行），且对任何 query 返回同一份 SERP
    （自有域名恒在第 1 位），因此 fresh install 的 `daily` 永远是 0 write / 0 fix。
    plumbing 可跑，零凭据 dogfood 还不成立。
  - 真实凭据 e2e：GSC（T-B4 代码已落地，待真实属性核对 wire 形状）、SERP（T-C2 未用
    真 key 验证）、GitHub（T-D4）、loom（T-E5）。
  - 真实 30 天连跑（T-H4）、dogfood 评审与定价（T-H5，卡 owner 决策）。
  - loom 挂账：final_id 需 operator 经 `/api/fcw/assemble` 线下发证（需
    product_space_id/platform/slot_id，growth-agent 无此模型）；approve/reject/revise
    属人审台，growth-agent 永不代调。
- 部署见 `deploy/SELF_HOSTING.md`，跨会话状态见 `handoff.md`，任务进度见 bayjf 仓
  tier0 任务拆解文档。

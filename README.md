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

- `zeus :3020`：决策分级、SLA 两阶段超时、审批审计、生命周期 webhook
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

- W1–W9 已完成（本地 main，无 remote、不 push）：数据层/状态机（T-A2）、zeus
  决策客户端与入站 webhook（T-A3/T-A5）、GSC/SERP/Publisher 连接器 offline 契约
  （T-B1/B2/B3、T-C1、T-D1）、QA 三闸（T-E1/E2/E3）、GitHub publisher 与入站
  webhook（T-D2/D3）、每日剧本/对账/成本/周报（T-A4/A6/A7/A8）、compose 部署与
  自托管指南（T-F1/F2/F3）、loom 端口+mock（T-E4）、三站点配置/离线全链路冒烟/
  30 天数据包（T-H1/H2/H3）。`npm run check:all` 五门全绿，`npm run smoke:offline`
  离线全链路冒烟通过。
- 明确未做（卡外部，不影响离线链路）：真实 GSC/SERP/GitHub 在线 e2e（T-B4/T-C2/
  T-D4，需真实凭据）、真实 30 天连跑（T-H4）、dogfood 评审与定价（T-H5，卡 owner
  决策）；loom 仅 mock，真实字段/路径待 openapi 对照后接 adapter。
- 部署见 `deploy/SELF_HOSTING.md`，任务进度见 bayjf 仓 tier0 任务拆解文档。

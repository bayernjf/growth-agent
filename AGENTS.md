# AGENTS.md — growth-agent

本文件供在本仓工作的 AI 协作 agent 使用。设计/需求/任务拆解见 `bayjf/docs/tier0/`
三份增长 Agent 文档，本文只规定本仓工程纪律。

## 项目定位

自托管、BYOK、每天交 PR 的极简增长 Agent。本仓是**编排外壳**：
每日剧本调度、GrowthTask 状态机、连接器路由、次日复查、周报聚合。

## 硬边界（不得违反）

- 与 zeus / growth-os / loom / atlas / ops-console **只走 HTTP 或 openapi**，
  不改这些内核仓一行，不引入对它们源码的本地 `file:` 依赖。
- 连接器/provider 一律端口 + 注册表：默认 offline fixture，online 缺凭据必须
  **fail-closed（422）**，不得静默回退离线（照 growth-os SearchProvider 纪律）。
- 合规硬约束（不可配置关闭）：
  - 任何内容发布决策下限 **D2 人审（slaHours=24h）**，不存在 D0/D1 自动放行路径。
  - 发布动作无自动执行路径：bot 只开 PR / 建 CMS 草稿，上线最后一步永远是人工合并。
  - 日产量硬上限 **1 写 + 1 修**，不提供更高档位。
  - GSC 严格只读 scope，token 加密落盘，发布凭证与 GSC 凭证分离。
  - 编辑 QA 三闸（意图/查重/价值）在 PR 打开前执行。
- 密钥只在 `.env`（gitignored）/服务端，不入仓、不进浏览器产物、不进日志。

## 技术栈与命令

Node 22、ESM、TS strict、Hono、Vitest。仓根执行：

```bash
npm run check:migrations  # 校验 sqlite/postgres 迁移配对
npm run typecheck         # tsc --noEmit
npm run lint              # eslint .
npm test                  # vitest run
npm run build             # tsc -p tsconfig.build.json
npm run check:all         # 以上五门串行
npm run migrate:up        # sqlite 迁移（--driver postgres 走 pg）
```

提交前必须 `npm run check:all` 全绿。

## 双方言迁移纪律

- 迁移文件成对放在 `db/migrations/sqlite/` 与 `db/migrations/postgres/`，
  编号与文件名一致、`CREATE TABLE` 集合一致（`check-migrations.sh` 强制）。
- 业务 SQL 一律 `?` 占位符；postgres driver 转换为 `$1..$n`。
- 时间戳存 ISO-8601 文本；JSON：sqlite 用 `TEXT`，postgres 用 `JSONB`。
- 只新增迁移文件，不覆写已应用的迁移。
- 新表 DDL 用 `CREATE TABLE IF NOT EXISTS`，迁移幂等。

## 代码风格

- 严格按 tsconfig：`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `noUnusedLocals`、`noUnusedParameters`。
- 外部服务错误语义必须原样映射（尤其 zeus 错误码），不得吞错。
- 外部不可达用契约级假上游 / fixture 测试，不依赖真实外部服务。
- 测试放在 `tests/`，命名 `*.test.ts`；确定性回放放在 `tests/fixtures/`。

## Git

- 原子提交，英文 Conventional Commits（subject ≤ 50 字符，带 body），
  配置/功能/测试/文档分开提交，不加 AI co-author。
- 分支与推送策略待 owner 定级后确定；未明确授权前不 push、不建 GitHub remote。

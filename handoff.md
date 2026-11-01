# Handoff

State of growth-agent as of 2026-10-28.

> 一句话：**W11 把「装配完成但没人调用」的循环接成了真正可运行的东西**——批次有了
> 触发器（CLI + compose 调度）、任务有了持久化上下文、生产批次有了草稿来源和真实证据，
> GSC 的 online 传输也从占位实现换成了真代码。剩余阻塞全部在真实凭据/真实属性验证，
> 外加一个已知缺口：零凭据的离线 fixture 产不出候选。

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

1. **零凭据离线模式产不出候选**。`tests/fixtures/{gsc,serp}-fixture.json` 的回放忽略
   输入：GSC 不论请求 `page` 还是 `query` 维度都返回同一批 query 维行；SERP 对任何
   query 返回同一份结果且自有域名恒在 #1。结果：fresh install 的 `daily` 永远
   0 write / 0 fix，`batch` 服务空转。修法要在 fixture/replay 层做（按维度与 query
   取数、并为两个 GSC 窗口录不同的行），不是改评分阈值。
2. **GSC T-B4 wire 形状未经真实属性验证**。12 个契约级假上游用例覆盖了刷新、401
   重试、§4.1 映射、截断保护，但字段名只按 v3 文档写。真凭据首跑要先核对。
3. **SERP T-C2**：`src/connector/serp/http.ts` 自述未用真 key 验证过 wire。
4. **loom final_id 契约缺口**：`final_id` 需 operator 经 `/api/fcw/assemble` 线下发证
   （要 product_space_id/platform/slot_id，本仓无此模型）。loom 模式因此要求收件箱
   文件里带 `finalId`。
5. compose 里 sqlite 模式下列 `orchestrator` 与 `batch` 共用一个库文件：写入频率低但
   没有 `SQLITE_BUSY` 重试，多写场景建议切 postgres。
6. 真实 30 天连跑（T-H4）、dogfood 评审与定价（T-H5）仍卡 owner 决策。

## 下一步（建议顺序）

1. 用真实 GSC 属性跑一次 `npm run batch -- daily --site bayjf.com`，核对 T-B4 的
   wire 形状（先只开 `GA_GSC_MODE=online`，SERP 保持 off）。
2. 修离线 fixture/replay 让它能产 1 write + 1 fix，使零凭据安装能自证。
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

# Handoff

> **2026-11-06 补登：dev → main 已于 2026-11-05 经 PR #10 合并（合并前 CI 全绿）；实测 origin/main 与 origin/dev 内容完全一致（git diff 为空）。**

State of growth-agent as of 2026-10-28.

> 一句话：**W11 把「装配完成但没人调用」的循环接成了真正可运行的东西**——批次有了
> 触发器（CLI + compose 调度）、任务有了持久化上下文、生产批次有了草稿来源和真实证据，
> GSC 的 online 传输也从占位实现换成了真代码。剩余阻塞全部在真实凭据/真实属性验证，
> 外加一个已知缺口：零凭据的离线 fixture 产不出候选。

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

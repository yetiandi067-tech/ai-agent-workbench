# AI 多 Agent 工作台 —— 第 3 步使用与验收文档（WORKBENCH）

- 文档日期：2026-10-20
- 对应阶段：第 3 步「可运行的工作台骨架 + 真实 DSH Adapter」
- 前置文档：`docs/ENVIRONMENT_AUDIT.md`（第 1 步）、`docs/DSH_ADAPTER_PROBE.md`（第 2 / 2.5 步）
- 本文档只描述**当前真实实现**；未实现的功能一律显式标注「未实现」。

---

## 一、本阶段做了什么

建立了一个能启动、能持久化任务、能调用真实 DSH、能显示执行结果、并带基本安全护栏的
最小可用版本。**刻意不做多 Agent 自动协作**（主管 Agent、项目小组、任务分发等留到第 4 / 5 步）。

三个来自实测的关键事实，直接决定了架构：

| 事实 | 证据 | 架构上的落实 |
| --- | --- | --- |
| 账号路由已实测成功 | `final.text = AGENT_PROBE_OK`、退出码 0、约 2.1 秒 | Adapter 复用 `headless` profile，不新增任何付费路径 |
| 费用未知 | 6074 tokens，但账本 `~/.dsh/.dshw-usage.json` 前后完全未变 | token 与金额**物理分列**：`actualCost` 恒为 `null`，界面显示「无法核验」 |
| 终止能力有限 | DSH 无 `cancel` / `status` 子命令 | 并发上限 1、禁止自动重试、超时后明确提示「远端可能未停止」 |

---

## 二、技术栈与目录结构

### 技术栈（均为本机实测可用版本）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面外壳 | Electron 44.9.1 | 本机已存在大量 Electron 应用，环境无风险 |
| 构建 | electron-vite 6.0.0 + Vite 8.3.4 | 主进程 / preload / 渲染层三份配置 |
| 界面 | React 19.3.1 + TypeScript 5.9.3 | 无第三方 UI 组件库，手写样式 |
| 数据库 | **`node:sqlite`（`DatabaseSync`）** | Electron 44 内置 Node 24.22.0，`node:sqlite` 可用 → **规避 better-sqlite3 等原生模块编译风险** |
| 测试 | Vitest 5.0.5 | 纯 Node 环境，不启动窗口 |
| 包管理 | npm 10.9.4 | 本机无 pnpm，不引入第二套包管理器 |

Electron 二进制通过 `.npmrc` 的 `electron_mirror=https://npmmirror.com/mirrors/electron/` 下载
（GitHub 直连在本机不可用）。

### 目录结构

```text
E:\ai个人工作台\
├─ electron.vite.config.ts      # 主/preload/渲染三份构建配置
├─ vitest.config.ts             # 单元测试配置（node 环境，tests/**）
├─ tsconfig.json / .node.json / .web.json
├─ src\
│  ├─ shared\                   # 主进程与渲染层共用（不含 electron 依赖）
│  │  ├─ types.ts               # 任务状态、事件契约、UsageRecord、AppSettings、护栏文案
│  │  ├─ task-state.ts          # 状态机（合法转换表 + 守卫）
│  │  ├─ redact.ts              # 脱敏（凭据不得出现在日志 / 运行记录里）
│  │  └─ api.ts                 # IPC 通道名 + WorkbenchApi 契约
│  ├─ main\
│  │  ├─ index.ts               # 应用启动、路径、BrowserWindow、安全配置
│  │  ├─ ipc.ts                 # 受控 IPC 处理器（全部参数校验）+ 推送
│  │  ├─ logger.ts              # JSON lines 日志（先脱敏再落盘）
│  │  ├─ settings.ts            # 设置存储 + 范围收敛（normalizeSettings）
│  │  ├─ adapters\
│  │  │  ├─ types.ts            # 统一 AgentAdapter 接口 + TIMEOUT/CANCEL 标记
│  │  │  ├─ registry.ts         # 适配器注册表（Mock + DSH 可执行；其余仅描述）
│  │  │  ├─ mock\MockAdapter.ts  # 本地模拟（无外部调用）
│  │  │  └─ dsh\
│  │  │     ├─ ndjson.ts        # NDJSON 增量解析器 + 结果判定（纯函数，可测）
│  │  │     ├─ DshAdapter.ts    # 子进程调用 + 事件累积 + 护栏 + 用量构造
│  │  │     └─ dshSession.ts    # 会话目录定位（只记录，不删除）
│  │  ├─ scheduler\
│  │  │  ├─ concurrency.ts      # 并发闸门
│  │  │  └─ taskRunner.ts       # 状态机执行器（无重试、超时、取消）
│  │  ├─ services\workbenchService.ts  # 用例层（任务/Agent/设置/总览/护栏）
│  │  └─ db\
│  │     ├─ database.ts         # 打开数据库 + 失败自动降级内存库
│  │     ├─ migrations.ts       # schema 版本化迁移
│  │     └─ repositories.ts     # agents / tasks / runs / events 四表仓储
│  ├─ preload\index.ts          # 白名单桥（无 ipcRenderer、无 Node 暴露）
│  └─ renderer\
│     ├─ index.html             # 含 CSP
│     └─ src\
│        ├─ App.tsx             # 侧边导航（总览/任务中心/Agent 管理/运行记录/设置）
│        ├─ api.ts              # 渲染层唯一数据入口 + 金额/时间格式化
│        ├─ components\ui.tsx   # Card/Section/StatusBadge/UsagePanel/CostNotice…
│        ├─ components\EventStream.tsx
│        └─ pages\              # Overview / Tasks / Agents / Runs / Settings
├─ tests\                       # 47 个单元 / 集成测试（不启动窗口、不调真实模型）
└─ docs\                        # 三份文档
```

---

## 三、如何启动

```powershell
cd "E:\ai个人工作台"

npm install          # 首次；Electron 走 npmmirror 镜像
npm run dev          # 开发模式：启动渲染层 dev server + Electron 窗口
```

其他脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 构建 `out/main`、`out/preload`、`out/renderer` |
| `npm run start` | 以构建产物启动（`electron-vite preview`） |
| `npm run typecheck` | 主进程 + 渲染层两套 tsconfig 的类型检查 |
| `npm run test` | 运行 `tests/**` 下的全部单元测试 |

**应用启动时不会调用任何模型**：真实调用总开关默认为关闭，且真实任务需要用户在界面上显式确认。

### 数据与日志位置（开发模式）

| 项 | 路径 |
| --- | --- |
| SQLite 数据库 | `E:\ai个人工作台\data\workbench.db`（WAL 模式） |
| 设置 | `E:\ai个人工作台\data\settings.json` |
| 日志 | `E:\ai个人工作台\data\logs\` |
| 任务工作目录（DSH 会话落盘处） | `E:\ai个人工作台\workspace` |

打包后改为 `app.getPath('userData')` 下的同名文件。

---

## 四、如何测试

```powershell
npm run typecheck ; npm run test
```

### 本次实际执行结果（真实可复现）

| 检查 | 结果 | 备注 |
| --- | --- | --- |
| `npm run typecheck` | **通过**（退出码 0） | 两套 tsconfig 均无错误 |
| `npm run test` | **通过：5 个文件 / 47 个测试全部通过** | 见下表 |
| `npm run build` | **通过** | main 83.63 kB / preload 2.65 kB / renderer js 638.86 kB + css 8.52 kB |
| `npm run dev` 启动 | **通过** | 日志：`应用启动`、`服务初始化完成 {"staleRunningRecovered":0,"agentCount":5}`；数据库以 `file` 模式建立 |

测试文件与覆盖内容：

| 文件 | 测试数 | 覆盖 |
| --- | --- | --- |
| `tests/dshNdjson.test.ts` | 11 | 用第 2.5 步**真实成功输出**做夹具（`reason.kind=completed`、`final.text=AGENT_PROBE_OK`、`totalTokens=6074`）、失败态（`MISSING_CREDENTIAL`）、缺 `final.text`、缺 `turn_end`、未知事件类型、无效行 |
| `tests/taskState.test.ts` | 9 | 合法/非法转换、终态无出边、`canStart` 守卫 |
| `tests/mockAdapter.test.ts` | 12 | 六个场景（成功/流式/失败/超时/缺最终结果/带估算金额）、取消、`getUsage` |
| `tests/costSeparation.test.ts` | 8 | token 可信、`actualCost === null`（且明确断言**不是 0**）、`source='unknown'`、`verified=false`、无可靠单价时不生成估算 |
| `tests/workbenchFlow.test.ts` | 7 | 建表、Mock 任务创建→执行→落库、终态拒绝重复执行、真实调用双重护栏拦截、人工交接 Agent 拒绝、**关闭并重开数据库后仍能读到历史任务与运行记录** |

> 已知无害告警：Vitest 会提示 `vitest.config.ts` 以 CommonJS 方式加载 ESM 语法（未来 Vite 大版本
> 才会成为错误）。不影响测试结果，未修改。

### 界面（手工验收）步骤

1. `npm run dev` 启动窗口。
2. 「任务中心」→ 标题随意填 → 执行 Agent 选 **Mock** → 任务内容保留 `mock:success` → 创建任务。
3. 列表中点击该任务 → 「执行（Mock）」→ 详情面板出现状态「成功」、最终结果含 `MOCK_OK`、
   **实际费用显示「无法核验」**（而不是 ¥0.000000）、事件流可见 `session → status → text → final`。
4. 关闭应用，再次 `npm run dev` → 「运行记录」与「任务中心」仍能看到上一步的任务（SQLite 持久化）。
5. 试试其他 Mock 标记：`mock:streaming`（流式）、`mock:failure`（失败）、`mock:missing_final`（缺最终结果）、
   `mock:usage_estimated`（出现「估算值，非实际账单」）。
6. `mock:timeout` 需要把「设置 → 任务超时」调小（例如 5000 ms）才能在合理时间内看到超时态。

---

## 五、数据库结构与状态机

### 表结构（schema v1，由 `schema_migrations` 记录版本）

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `agents` | Agent 描述快照 | `id` / `name` / `adapter_id` / `mode` / `is_real_call` / `capabilities_json` / `availability` / `version` |
| `tasks` | 任务与结果 | `status` / `is_real_call` / `started_at` / `ended_at` / `duration_ms` / `exit_code` / `session_id` / `session_dir` / `final_text` / `error_code` / `error_message` / `failure_kind` / **`usage_json`** / `attempt` / `user_notice` |
| `runs` | 每次执行的运行记录 | `exit_code` / `duration_ms` / `stdout_bytes` / `stdout_line_count` / `invalid_line_count` / `stderr_excerpt`（已脱敏）/ `failure_kind` / `attempt_no` |
| `events` | 原始事件（可定位） | `task_id` / `run_id` / `seq` / `type` / **`raw_type`** / `payload_json` / `received_at` |

- **迁移策略**：`MIGRATIONS` 数组按版本号顺序执行，每个迁移在单事务内执行，失败即 `ROLLBACK`
  并抛出带版本号的错误。
- **失败不致命**：文件库创建/迁移失败时自动降级为内存库，返回 `mode='memory-fallback'`，
  应用仍能启动，并在总览页与设置页显著提示「本次数据不会持久化」。
- `usage_json` 存放完整 `UsageRecord`：**token 与金额分列**，因此「token 可信、金额未知」在数据层就是两个字段。

### 任务状态机

```text
pending ──► running ──┬──► succeeded
   │                  ├──► failed
   │                  ├──► timed_out
   │                  ├──► cancelled
   │                  └──► needs_confirmation
   ├──► cancelled
   └──► failed
（succeeded / failed / timed_out / cancelled / needs_confirmation 为终态，无出边）
```

- 单一状态列 → 任务不可能同时处于多个终态。
- 终态无出边 → 不可能从终态倒退，也就不会重复执行。
- `pending → running` 是唯一执行入口；`canStart()` 只放行 `pending`，其余请求被拒绝并记入事件流（`workbench.blocked`）。
- 启动时若发现上次遗留的 `running` 任务，转为 `needs_confirmation`（附「远端可能仍在运行」提示），**不自动重跑**。

---

## 六、DSH Adapter：真实命令调用与事件解析

### 命令行调用方式（复用第 2.5 步已实测成功的形态）

刻意**不走 `dsh.cmd`**（批处理会强制引入 `cmd.exe` 包装层），直接用参数数组、`shell: false`：

```text
ELECTRON_RUN_AS_NODE=1 "<dshExePath>"
  --expose-internals "<dshCliScript>"
  --profile headless
  --json
  "<prompt>"
```

对应设置项：`dshExePath` / `dshCliScript` / `dshProfile` / `taskCwd`（工作目录）。
等价于 `dsh --profile headless --json "<prompt>"`。**不修改** DSH 安装目录、桌面 profile、
其他 Agent 配置或现有的 `cordis.patch.yml`。

### 事件解析

stdout 逐行 NDJSON，由 `DshStreamAccumulator` 增量解析，映射到统一事件类型：

| DSH 原始事件 | 统一类型 | 说明 |
| --- | --- | --- |
| `session` | `session` | 含 `sessionId` 与 `cwd` |
| `status(turn_start / step_start)` | `status` | 阶段事件 |
| `status(step_end)` 带 `usage` | `status` + **派生 `usage`** | token 用量 |
| `status(turn_end)` | `status` | 含 `reason.kind` |
| `thinking` | `thinking` | DSH 可能为空文本 |
| `text` | `text` | 增量文本（可流式展示） |
| `final` | `final` | `final.text` 为最终答案 |
| 其他（未来新增） | `unknown` | **保留原始对象，不让任务崩溃** |

结果判定（`classifyDshOutcome`，刻意「先失败后成功」）：

1. `turn_end.reason.kind === "error"` → `turn_error`（保留结构化 `error.code`）
2. 存在无效行且没有 `turn_end` → `invalid_output`
3. 没有 `turn_end` → `invalid_output`
4. `reason.kind` 既不是 `completed` 也不是 `error` → `invalid_output`
5. `completed` 但 `final.text` 为空/缺失 → `missing_final`
6. 以上都不满足 → **成功**

另外，非零退出码、spawn 失败、进程异常均有各自的失败分支（`nonzero_exit` / `spawn_failed` / `internal_error`）。

### 用例夹具

`tests/dshNdjson.test.ts` 使用第 2.5 步的**真实成功输出**作为夹具。这些数值仅存在于测试中，
**不会写入生产运行记录**。

---

## 七、如何手动触发一次真实 DSH 测试

> 前提：真实调用会消耗你现有账号额度，且**费用无法核验**。请自行判断是否值得。
> 工作台**不会**在启动时或后台自动触发真实调用。

1. 「设置」→ 勾选 **允许真实模型调用**（默认关闭）→ 保存。
2. 「任务中心」→ 执行 Agent 选 **DeepSeek Harness**（`dsh`）。
3. 任务内容填一个**明确、无副作用**的最小提示，例如：
   `请只回复 AGENT_PROBE_OK 这一个词，不要执行任何命令，不要修改任何文件，不要访问网络。`
4. 勾选 **「我已确认本次会产生真实调用，且金额无法核验。」**
5. 创建任务 → 在列表中对这条任务点 **「执行真实任务」**（详情面板里也有同款按钮）。
6. 预期结果：状态「成功」、`final.text` 为 `AGENT_PROBE_OK`、退出码 0、
   token 用量来自 `step_end.usage`、**实际费用显示「无法核验」**、「会话目录」记录位置但不会被自动删除。

安全约束（代码层面已落实）：

- 真实任务并发上限默认 **1**；超限时任务保持「待执行」并提示手动重试，**不会自动排队后偷偷开跑**。
- **不自动重试**（`attempt` 恒为 1）。
- 超时只终止本地子进程，任务记录与界面都会显示「远端请求可能仍在运行，可能继续产生费用」。
- 不自动删除 DSH 会话目录，只记录位置。

---

## 八、费用核验现状与未知风险

| 项 | 现状 |
| --- | --- |
| token 用量 | **可信**，来自 NDJSON 的 `step_end.usage` |
| 实际费用 | **无法核验** —— `actualCost` 恒为 `null`，`source='unknown'`，`verified=false` |
| 估算费用 | 本阶段**不生成**（没有可靠单价来源，不自行编造价格） |
| 为什么不能算作免费 | headless 调用**不写入** `~/.dsh/.dshw-usage.json`，账本差值恒为 0；差值 0 **不等于**没有费用 |
| 固定开销 | 一次「极简」任务也有约 **6k token** 的固定上下文开销（系统提示 + 工具 schema），单次约 2.1 秒 |

界面上任何金额为 `null` 的位置都显示 **「无法核验」**，绝不显示 `¥0.000000` 或「免费」。

**仍然未知的风险**：真实调用是否计费、按什么单价计费、会话是否会被远端保留 —— 这些都无法从本机确认。

---

## 九、安全护栏（代码层面已落实）

| 项 | 实现位置 |
| --- | --- |
| 渲染层无 Node 权限 | `contextIsolation:true` / `nodeIntegration:false` / `sandbox:true`；仅 preload 白名单 API |
| UI 不能直接起命令 | 所有执行只走 `IPC_CHANNELS`，主进程参数全部校验；`shell:false` + 参数数组 |
| 真实调用双重放行 | 全局开关 `allowRealModelCalls` + 界面对该任务的显式勾选 |
| 并发上限 | `realConcurrencyLimit=1`；`ConcurrencyGate` 超限直接拒绝 |
| 禁止自动重试 | `AUTO_RETRY_ENABLED=false`，代码中无重试循环 |
| 不谎报远端状态 | 超时/取消路径统一带出 `REMOTE_NOT_STOPPED_WARNING`；启动时遗留 `running` → `needs_confirmation` |
| 凭据不外泄 | 日志与运行记录先经 `redact.ts` 脱敏；从不读取/打印任何凭据 |
| 不改他人配置 | 不修改 DSH 安装目录、桌面 profile、其他 Agent 配置或 `cordis.patch.yml` |
| 不做压力测试 / 不擅自调用其他 Agent | 未实现 Grok / WorkBuddy / Trae 的自动调用路径 |

---

## 十、当前限制与已知问题

1. **费用无法核验**：这是本阶段最大的已知缺口（详见第八节）。
2. **取消不等于停止**：终止本地进程后远端请求可能仍在运行。
3. **无自动重试**：失败即终态，需要人工新建任务重试。
4. **Mock 超时场景**：看超时态需要把超时时间调小，否则要等 120 秒。
5. **Trae CN / WorkBuddy / Grok**：只有描述，没有自动执行路径（`mode='handoff'`），避免「看起来能用其实不能」。
6. **`node:sqlite` 是实验特性**：本机 Node 22.22.1 与 Electron 44（Node 24.22.0）实测可用，
   但未来 Node 版本可能调整接口；升级 Node 前需重新验证。
7. **未初始化 Git**：`.gitignore` 已就绪，但尚未 `git init`。
8. **未做打包分发**：只支持 `dev` / `start`，未配置 electron-builder 等打包流程。

---

## 十一、下一步（第 4 步）

按既定顺序，第 4 步才做**主管 Agent 与项目团队**：

- 任务拆解、子任务依赖、结果汇总；
- 人工确认入口（让 `needs_confirmation` 能真正被批准后继续）；
- 多 Agent 分工与「谁执行 / 谁审查」的角色划分。

**在此之前不要扩展为多 Agent 自动协作**：接口、状态管理与成本核算尚未完全可靠，
过早串联会形成难以排查的自动化链条。

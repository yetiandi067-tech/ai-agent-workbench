# 环境侦察与接入能力审计报告（ENVIRONMENT_AUDIT）

- 扫描日期：2026-10-20
- 扫描范围：当前工作区 `E:\ai个人工作台`、本机已安装 Agent 客户端、开发环境、可用的程序化接口
- 扫描原则：只读侦察；不修改客户端内部文件；不绕过权限；不输出任何凭据内容；能力未实测一律标记为「未验证」
- 本报告不包含第二阶段的大规模开发，也未创建除 `docs/` 以外的任何文件

---

## 一、当前工作区检查

| 项目 | 实测结果 | 状态 |
| --- | --- | --- |
| 当前工作目录 | `E:\ai个人工作台` | 已验证 |
| 目录内容 | **完全为空**（含隐藏文件计数 = 0） | 已验证 |
| Git 仓库 | 不存在（`fatal: not a git repository`） | 已验证 |
| 已有代码 / 依赖清单 | 无 `package.json`、无 `requirements.txt`、无任何源码 | 已验证 |
| 父目录 `E:\` | 存在大量既有目录（`develop`、`trae work`、`gsh`、`grok`、`Deepseek`、`AI知识库` 等），**均为历史遗留，与本项目无关** | 已验证 |

**结论**：这是一个从零开始的空工作区，不存在「复用现有项目」的选项，也不存在覆盖已有修改的风险。建议新建项目，但不建议现在就一次性生成完整工程（见第五节）。

建议初始化为 Git 仓库以保护后续改动（尚未执行，等确认）。

### 开发环境实测

| 环境 | 版本 | 状态 |
| --- | --- | --- |
| 操作系统 | Windows 11 家庭版 中文版 | 已验证 |
| PowerShell | 5.1.26100.9711（Windows PowerShell 5.1） | 已验证 |
| Node.js | v22.22.1 | 已验证 |
| npm | 10.9.4 | 已验证 |
| pnpm | **未安装** | 已验证 |
| Python | 3.14.3（`python` 与 `py` 均可用） | 已验证 |
| Git | 2.53.0.windows.2 | 已验证 |
| Rust / Cargo | 未检测到 | 未验证 |

注意：Python 3.14.3 属于很新的版本，部分需要预编译 wheel 的库（尤其 Windows GUI 自动化类）可能缺轮子。**这会影响「手动交接自动化」的技术选型**，建议自动化动作优先放在 Node 侧或 PowerShell 侧实现，而不是依赖 Python 的桌面自动化库。

---

## 二、Agent 客户端接入能力实测

### 1) Trae CN（即 Trae Work，当前工作台本体）

- 安装位置：`E:\trae work\Trae CN`（注册表：TRAE CN (User) 3.4.4）；另有 `E:\trae work\Trae`（TRAE 3.6.2）
- 进程：`Trae CN` 正在运行（PID 38384）
- **自带 CLI**：`E:\trae work\Trae CN\bin\trae-cn.cmd`（已加入 PATH）
- 实测：`trae-cn --version` → `1.107.1`（基于 VS Code 1.107.1 内核）
- **关键发现**：CLI 存在子命令 `chat`

```text
Usage: trae-cn.exe chat [options] [prompt]
  -m --mode <mode>   ask | edit | agent（默认 agent）
  -a --add-file <path>
  -r --reuse-window / -n --new-window
```

即「可以把提示词从命令行交给 Trae 的会话」。**但该能力停留在「命令存在」层面**：CLI 帮助里没有任何「等待完成 / 输出结果 / 指定输出格式」的开关，也没有 `--json`。因此：

- 提交任务能力：命令存在（**已实测命令可执行并打印用法**），但语义是「在 UI 会话里注入一条提示」，非真正的无头任务提交 → 标记 **待验证**
- 结果获取能力：**未验证**（帮助未声明任何结果回传通道）
- 取消 / 状态查询：未发现对应开关 → **不支持（就 CLI 而言）**
- 成本统计：未发现 → **不支持（就 CLI 而言）**

另有 CLI 高级能力（已实测存在于帮助中）：`--add-mcp <json>`（向用户配置写入 MCP 服务器定义）、`serve-web`、`tunnel`、扩展管理、`--status`。其中 `--add-mcp` 很有价值：可以让我们把自研工具以 MCP 形式挂进 Trae，实现「反向控制通道」。

内部组件（**不建议依赖**）：

- `resources\app\modules\ai-agent\bin\agent-tool-host.exe`：Trae 内部工具宿主。实测启动日志明确写着 `external TCP/gRPC/HTTP listeners are disabled for local IPC transport`，仅监听命名管道 `\\.\pipe\agent-code-toolhost-<pid>-<hash>`。管道名带 PID，非稳定接口，属**内部实现** → 不可作为正式接入方式（本次仅做了 `--help` 探测，进程已终止，无副作用）
- `ctx-cli.exe`：ContextFS 文件操作 CLI（`ls/cat/write/grep/glob/mkdir/rm`），是给 Agent 用的文件 API，不是任务提交接口

### 2) DeepSeek Harness（**重要发现：唯一已验证的无头任务接口**）

- 版本：0.2.0-rc.2（`@deepseek-ai/dsh-desktop`），实际位置 `E:\gsh`（注册表 InstallLocation 指向已失效的旧目录 `E:\新建文件夹`，**注册表路径是陈旧的，不可信**）
- 内置运行时：Node 24.18.1、pnpm 11.7.0、Python + Pillow（office 技能用），Electron 44
- **自带 CLI**：`E:\gsh\resources\runtime\cli\bin\dsh.cmd`，内容为 `ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals "...app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*`
- 实测：`dsh.cmd --help` **成功执行并返回用法**（无 GUI 弹出，退出码正常）

实测到的命令面（原文关键行）：

```text
Usage: dsh [--profile] <name> [options] [app-args...]
       dsh plugin --profile <name> <pnpm-args...>

  dsh headless "run the tests"   answer one task, print the result, and exit
  dsh web                        boot the web profile
  dsh tui --resume <session>
  dsh plugin --profile tui add <package>
  --dump-config / --dump-config-schema / --patch <path>
```

**`dsh headless "<任务>"` = 提交一个任务 → 打印结果 → 退出**。这是本次侦察中最接近「可编程 Agent」的接口，具备可被程序捕获的 stdout 与退出码，天然适合做自动化适配器。

- 提交任务能力：**已验证（命令面）**／端到端跑一次真实任务 **未验证**
- 结果获取：stdout 打印，**接口形态已验证**；结构化程度 **未验证**
- 状态查询 / 取消：`dsh tui --resume <session>` 暗示存在会话概念，但**未验证**
- 成本统计：**未验证**
- `dsh` 当前**不在 PATH**，但安装包内含 `command-manager.js` + `command-path.ps1`，实现了对用户 PATH 的 `inspect/install/remove` 托管（可自救）。当前可直接用绝对路径调用。

### 3) WorkBuddy

- 版本：5.8.3，实际位置 `E:\develop\WorkBuddy`（注册表指向此处，一致）
- 结构：Electron 应用，`resources/app.asar`（96 MB）+ `resources/app.asar.unpacked`
- **发现 CLI**：`resources\app.asar.unpacked\cli`，包名 `@genie/agent-cli`，bin 暴露 `codebuddy` / `codebuddy-code` / `cbc` / `codebuddy-lowmem`，入口 `bin/codebuddy`（Node 脚本）
- **实测结果：不可独立调用（两次实测均失败）**

```text
node bin/codebuddy --help
ELECTRON_RUN_AS_NODE=1 WorkBuddy.exe resources/app.asar/cli/bin/codebuddy --help
→ Error: Cannot find module '../dist/codebuddy'（MODULE_NOT_FOUND）
```

- 原因：`bin/codebuddy` 需要 `../dist/codebuddy`，而解包目录里只有 `dist/codebuddy-lite-wb.mjs`（9.5 MB，未解包的完整版留在 asar 内），说明该 CLI 被设计为**必须在 WorkBuddy 自身运行环境/沙箱内运行**（同目录存在 `vendor/sandbox/sandbox-cli.exe`、`tsbx.dll`、`job-object.node`、conpty 等），不是给外部进程直接调用的
- 附带发现：`E:\develop\buddy\Cockpit Tools` 内有 `cockpit-tools.exe`(112MB) 与 `cockpit-cliproxy.exe`(45MB)，图标集覆盖 `trae-cn`/`claude`/`codex`/`cursor`/`windsurf`/`kiro`/`qoder`/`zcode`/`zed`/`antigravity`/`github-copilot`/`workbuddy`，**这本身就是一个「多 Agent 指挥台」形态的既有产品**，可作为设计参照，但属第三方组件，不建议作为依赖
- 提交任务 / 结果获取 / 状态 / 取消 / 成本：**均未验证**

### 4) Grok

- 版本：0.2.40，实际位置 `E:\grok\Grok\grok-app.exe`（注册表指向已失效的旧目录，**陈旧不可信**）；另有 `E:\Deepseek` 为空目录
- 形态：轻量外壳（约 57 MB 主程序），配置文件表明它是**「CLI 后端的桌面驾驶舱」**而非纯聊天客户端
- **关键发现：本机本地 HTTP 接口（带令牌）**

`%APPDATA%\grokapp\grok-app\data\session-api.json` 声明（令牌已脱敏）：

```json
{ "url": "http://127.0.0.1:56825", "token": "<REDACTED>", "pid": 14812 }
```

即存在一个**本机回环 HTTP 接口 + bearer 令牌**。端口随进程变化、令牌随会话变化，属非公开、非文档化接口。

- 配置证据（`settings.json` 键名）：`cliBackend: native`、`modelId: grok-4.7`、`maxConcurrentAgents: 8`、`subagentsEnabled: true`、`permissionPolicy: ask`、`manualCliPath`、`allowUnverifiedCliInstall`、`agentsJson`、`agentProfilePath`、`workflowsEnabled`、`schedulesLaunchAgent`、`todoGateEnabled`
- 提交任务能力：**本地 HTTP 接口已发现，但未验证**（未发送任何请求；令牌属凭据，本报告不予记录）
- 结果获取 / 状态 / 取消 / 成本：**均未验证**
- 是否安装独立 CLI（如 `grok` 命令）：**未发现**（PATH 中无 `grok`）

### 5) 顺带发现（非目标清单，但对成本控制有直接价值）

| 组件 | 状态 | 说明 |
| --- | --- | --- |
| Ollama 0.40.6 | 已验证 | `ollama list` 实测可用；已装 `qwen3:8b`、`qwen2.5-coder:7b`、`deepseek-r1:1.5b`；`127.0.0.1:11434` 端口已通 —— **本机推理，边际成本≈0** |
| LM Studio 0.4.15 | 已验证（已安装） | 本地服务端口 1234 当前**未监听**（未启动服务） |
| Claude Code CLI 2.1.296 | 已验证 | 全局 npm 包 `@anthropic-ai/claude-code`，`claude --version` 实测可用 —— 可作为「第二个 Agent」的现成候选 |
| `@genspark/cli` 1.15.0 | 已验证（已安装） | 全局 npm，未深入评估 |
| `codex-windows-sandbox-service` | 发现（进程在运行） | 存在 OpenAI Codex 相关沙箱服务，未进一步确认 CLI 可用性 |

---

## 三、接入能力矩阵

标签约定：**已验证** = 本次真实执行过；**未验证** = 存在线索但未端到端确认；**不支持** = 明确没有该能力；**不适用** = 该维度对本次接入方式无意义。

| 客户端 | 发现方式 | 可用连接方式 | 提交任务 | 结果获取 | 状态查询 | 取消 | 成本统计 | 是否完成真实测试 | 无法验证的原因 | 推荐接入方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **DeepSeek Harness** | 注册表 + 目录实测（0.2.0-rc.2） | **本地 CLI `dsh.cmd`**（Electron-as-Node，无 GUI） | 已验证（`dsh headless "<task>"` 命令面） | 接口形态已验证（stdout 打印并退出）；结构化程度未验证 | 未验证 | 未验证 | 未验证 | **是**（`--version`/`--help` 实跑成功） | 未跑真实任务、未测会话/计费 | **首选自动适配器**：以 `dsh headless` 子进程方式接入，捕获 stdout + 退出码 |
| **Trae CN / Trae Work** | PATH 中的 `trae-cn.cmd` + `--version` 实测 | **本地 CLI `trae-cn chat`（会注入 UI 会话）**；`--add-mcp` 反向挂载 MCP | 待验证（命令存在，但语义是 UI 会话注入） | 未验证（帮助无任何回传开关） | 不支持 | 不支持 | 不支持 | 部分是（`--version`、`--help`、`chat --help` 实跑成功） | CLI 未声明结果通道；真正跑一次会消耗额度并弹出 UI 会话 | **手动交接为主**：复制提示词 → 打开客户端 → 人工粘贴；自动化仅做到「唤起 + 预填」。内部 `agent-tool-host` 管道接口关闭，不作为接入点 |
| **WorkBuddy** | 注册表 + `app.asar.unpacked\cli` 实测 | 名义上是 `codebuddy` CLI，但**必须在 WorkBuddy 自身运行环境内** | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 | 是（**实测调用失败**，已确认不可独立运行） | CLI 依赖 `../dist/codebuddy`，该路径未解包，独立 node/Electron 均为 MODULE_NOT_FOUND | **手动交接**：复制提示词 → 打开 WorkBuddy → 人工粘贴结果。不建议逆向沙箱/asar |
| **Grok** | 注册表 + `%APPDATA%\grokapp` 配置实测 | **本机 HTTP `127.0.0.1:<动态端口>` + bearer 令牌**（非公开接口） | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 | 否（仅读取配置声明，未发请求） | 接口未文档化、端口与令牌随进程变化、需逆向才能确定路由 | **暂列「待评估」**：可作为第二批接入目标；先做只读探测（例如仅探活），确认稳定后再考虑 |
| （参照）Trae 内部 agent-tool-host | 目录 + 启动日志实测 | 命名管道（含 PID） | 不适用 | 不适用 | 不适用 | 不适用 | 不适用 | 是（日志已证实仅本地 IPC、外部监听关闭） | — | **不建议使用**（内部实现，非公开接口） |

---

## 四、架构建议（基于上述实测，而非猜测）

### 1) Windows 桌面技术栈

**推荐：Electron + TypeScript + React + Vite + SQLite。**

理由（均基于实测环境）：

- 本机 Node 22.22.1 / npm 10.9.4 现成可用；**pnpm 未安装**，因此统一用 npm，不引入 pnpm 工作流
- 目标 Agent 的自动化入口（`dsh.cmd`、`trae-cn.cmd`）本质都是 **子进程调用**，Node 的 `child_process` 是最短路径，与 Electron 主进程天然同构
- 本机已存在大量 Electron 应用（Trae/WorkBuddy/DSH/LM Studio），Electron 打包与运行环境无风险
- **不推荐 Tauri**：本机未检测到 Rust 工具链，会额外引入构建链
- **不推荐 Python 侧做自动化主控**：Python 3.14.3 过新，Windows 桌面自动化相关 wheel 存在缺失风险；Python 更适合当被调用的脚本，而非主控

### 2) 是否新建项目

**新建。** 工作区为空、无 Git、无既有代码，复用无收益。

### 3) 统一 AgentAdapter 接口（建议方法集）

建议按「能力声明 + 执行 + 观测」三段式设计，并让**不支持的能力显式返回 `UNSUPPORTED`**，而不是抛异常：

```ts
type Capability = 'submit' | 'result' | 'status' | 'cancel' | 'cost';

interface AgentAdapter {
  readonly id: string;                 // 'dsh' | 'trae-cn' | 'workbuddy' | 'grok'
  readonly mode: 'auto' | 'handoff' | 'unavailable';  // 自动 / 手动交接 / 不可用
  capabilities(): Record<Capability, 'verified' | 'unverified' | 'unsupported'>;

  probe(): Promise<ProbeResult>;       // 只读探活：CLI 是否在、版本是否变
  submit(task: TaskInput): Promise<SubmitResult>;   // 返回 agentRunId 或 handoff 指引
  poll(agentRunId: string): Promise<RunStatus>;
  fetchResult(agentRunId: string): Promise<RunResult>;
  cancel(agentRunId: string): Promise<'ok' | 'unsupported'>;
  estimateCost(task: TaskInput): Promise<CostEstimate>; // 见第 8 条
}
```

关键设计点：**只有 DeepSeek Harness 走 `auto`**；Trae CN / WorkBuddy 走 `handoff`（生成提示词 + 唤起客户端 + 等待人工回贴）；Grok 先声明为 `unavailable`，待验证后再升格。

### 4) 如何区分自动执行 / 手动交接 / 不可用

三种模式在**数据层就分开**，不要靠 UI 文案区分：

- `auto`：任务有 `agent_run_id`，状态由本地轮询驱动（`queued → running → succeeded/failed`）
- `handoff`：任务有 `handoff_token` + `prompt_snapshot`，状态为 `awaiting_human`，只能由「人工回贴结果」推进，**不允许自动重试**
- `unavailable`：任务在提交前就被拦截，落库为 `blocked`，并记录 `blocked_reason`（本次审计结论可直接作为初始值）

### 5) 本地数据库应保存什么

SQLite，最小表集：

- `agents`：id、名称、adapter_id、mode、能力快照、安装路径快照、版本、最近探测时间
- `tasks`：id、父任务 id（支撑主管拆解）、标题、prompt_snapshot、**prompt_hash**（去重用）、目标 agent、mode、状态、预算上限、创建/开始/结束时间
- `runs`：id、task_id、agent_id、attempt_no、exit_code、stdout/stderr 摘要路径、耗时、成本记录、错误分类
- `artifacts`：run_id、文件路径、哈希、产出时间（防重复产出与冲突判定）
- `events`：append-only 事件流（状态变更、人工交接、失败重试），用于恢复与审计

### 6) 避免重复调用 / 无限重试 / 状态丢失

- **去重**：`prompt_hash + agent_id + 目标文件集` 组合唯一，提交前先查（这是成本控制的第一道闸）
- **重试**：`attempt_no` 上限写进任务行，超出即置 `failed_terminal`；指数退避 + 抖动，且**只对 `auto` 模式生效**
- **状态不丢**：状态机变更一律「先写事件再改状态」，进程崩溃后靠 `events` 回放恢复，不依赖内存状态
- **防卡死**：为每个 run 记录 `heartbeat_at`，超时未更新即判 `stalled`，转入人工判定而非自动重跑

### 7) 防止多个 Agent 同时修改同一文件

项目级「文件锁 / 工作区隔离」二选一或叠加：

- **工作区隔离（推荐优先）**：每个 task 分配到独立 worktree 或独立输出目录，从物理上杜绝并发写
- **软锁**：`artifacts` 表登记「文件 → 当前持有 task」，提交前检查冲突，冲突则排队而非并发
- 因本机有 Git 2.53，可用 `git worktree` 天然实现隔离；这也是后续「独立审核」比对差异的基础

### 8) 预算与成本口径分离

必须先承认一个实测事实：**本次扫描中，没有任何一个客户端能被可靠读出「实际成本」**（Trae/WorkBuddy/Grok 的额度与计费均未暴露给程序；DSH 的计费也未验证）。因此成本字段必须分三类存储，禁止混算：

- `cost_actual`：可核实的真实成本（当前**预计为空**，除非后续验证出计费接口）
- `cost_estimated`：估算成本，规则要写死在配置里，例如「按 token 估算」「按调用次数 × 单价表」
- `cost_unknown`：明确记账为未知

**预算控制**：面向「调用次数 + 估算上限」做硬闸门，而不是假装能算准金额；预算耗尽即拦截提交，并在 UI 明示「本次为估算，非账单」。

---

## 五、最小可行版本（MVP）分阶段实施

严格按用户既定路线，每阶段结束再进入下一阶段：

**第一阶段（对应路线 03）— 只有一个能跑起来的本地工作台骨架**

- Electron + TS 最小壳；SQLite 建 `agents / tasks / runs / events` 四表
- 仅实现任务创建、状态流转、Agent 连接信息的增删改查
- `agent` 记录先落 4 条：`dsh`（auto）、`trae-cn`（handoff）、`workbuddy`（handoff）、`grok`（unavailable）
- **此阶段不接任何真实 Agent**，用假的 `EchoAdapter` 把状态机跑通
- 验收：能建任务、能看到状态变化、重启后任务不丢

**第二阶段（对应路线 04）— 打通第一个真实 Agent**

- 目标锁定 **DeepSeek Harness `dsh headless`**（唯一形态已验证的自动接口）
- 落地 `DshAdapter`：`probe()` → `submit()` → 捕获 stdout/exit code → 落 `runs`
- 同时补齐 **手动交接闭环**：为 Trae CN / WorkBuddy 生成提示词、一键复制、唤起客户端、回贴结果入库
- 验收：能真实提交一次任务并拿到结果；手动交接能完整走一轮

**第三阶段（对应路线 05、06）— 主管调度与第二个 Agent**

- 主管拆解（任务 → 子任务）、依赖排序、结果汇总
- 第二个 Agent 优先选 **Claude Code CLI 2.1.296**（已装、已实测可调用），实现双 Agent 与独立审核
- 引入有限返工（带次数上限）

**第四阶段（对应路线 07）— 稳定性与成本**

- 并行执行、预算闸门、失败恢复、日志与最终验收
- 此时再评估是否把 Grok（本地 HTTP）与更多客户端纳入

---

## 六、汇报

### 1) 我检查了什么

工作区与 Git 状态、Windows/Node/npm/Python/Git 版本、PATH、已安装应用注册表、四个目标客户端的安装目录与内部结构、它们的 CLI/入口脚本、Trae 内部工具宿主启动日志、Grok 与 DSH 的本地配置声明、本机本地模型运行时与端口。

### 2) 我发现了什么

- 工作区**完全为空**（含隐藏文件为 0），无 Git、无既有代码 → 必须新建项目
- **DeepSeek Harness 有真正可用的无头 CLI**：`dsh headless "任务"`（提交 → 打印结果 → 退出），且 `--help`/`--version` 实跑成功 —— 这是唯一形态已验证的程序化任务接口
- **Trae CN 有 CLI 且含 `chat` 子命令**，可把提示词交给会话，但**没有任何结果回传通道**；其内部 `agent-tool-host` 只开本地命名管道、外部监听明确关闭
- **WorkBuddy 名义上有 `codebuddy` CLI，但实测不可独立调用**（`Cannot find module '../dist/codebuddy'`，两种方式都失败），必须在其自身沙箱内运行
- **Grok 是本机 HTTP 接口形态**（`127.0.0.1:<动态端口>` + bearer 令牌，见 `session-api.json`），且配置显示它本身就是一个「多 Agent 驾驶舱」（`maxConcurrentAgents: 8`、`subagentsEnabled: true`）
- 注册表里的 DeepSeek Harness 与 Grok 安装路径**已失效（陈旧）**，实际路径分别在 `E:\gsh` 与 `E:\grok\Grok`，不能照注册表写代码
- 本机另有两个现成可用件：**Ollama（11434 已通，含 3 个本地模型，边际成本≈0）** 与 **Claude Code CLI 2.1.296**

### 3) 哪些能自动接入，哪些还不能确定

- **可以自动接入（形态已验证）**：DeepSeek Harness（`dsh headless`，唯一首选）
- **可作自动接入候选（已安装且可调用）**：Claude Code CLI、Ollama（本地推理）
- **不能确定 / 需先验证**：Grok（本地 HTTP，接口未文档化、端口令牌动态）
- **不能自动接入（实测失败）**：WorkBuddy（CLI 不可独立运行）
- **可自动接入但拿不到结果（不等于可用）**：Trae CN（`chat` 只能注入会话，无结果回传）
- **明确不可用于接入**：Trae 内部 `agent-tool-host`（仅本地命名管道）

### 4) 推荐的技术栈与理由

Electron + TypeScript + React + Vite + SQLite（npm，非 pnpm）。理由：本机 Node 22 现成；所有 Agent 自动化入口本质都是子进程调用，与 Electron 主进程同构；不引入未安装的 Rust 工具链；避免 Python 3.14 的 wheel 风险。

### 5) 最小可行版本的实施步骤

见第五节四阶段。核心原则：**第一阶段不接真实 Agent**，用一个假适配器把状态机与数据库跑通，再在第二阶段只打通 DeepSeek Harness 一条真实链路。

### 6) 下一步最应该做什么

**做第二阶段的第一件事：对 `dsh headless` 做一次真实端到端验证**（跑一条最小任务，确认 stdout 格式、退出码、耗时、是否消耗额度、是否有并发限制），并据此定稿 `AgentAdapter` 的 `submit/result` 两个方法的真实契约。这一步通过后，再进入工作台编码。

在动这一段之前，建议先 `git init` 保护后续改动。

### 7) 执行过的命令，以及哪些检查尚未完成

**已执行的命令（全部为只读侦察或形态探测）**：

```text
Get-ChildItem / Test-Path / Get-Location          工作区与客户端目录枚举
git -C "E:\ai个人工作台" rev-parse --is-inside-work-tree
node --version / npm --version / pnpm --version / python --version / py --version / git --version
Get-ItemProperty HKLM|HKCU:\...\Uninstall\*        注册表应用清单
Get-Process                                       运行中的客户端进程
$env:Path 过滤                                      PATH 中的客户端 CLI
npm ls -g --depth=0
Get-Content 各客户端 product.json / package.json / install-manifest.json / settings.json
trae-cn --version                                  实跑成功
trae-cn --help                                     实跑成功
trae-cn chat --help                                实跑成功（确认 chat 子命令存在）
trae-cn --list-extensions --show-version           实跑（无输出）
agent-tool-host.exe --help                         探测后终止（已确认仅本地 IPC）
ctx-cli.exe --help                                 实跑成功
dsh.cmd --help                                     实跑成功（**关键证据**）
dsh.cmd --version                                  实跑成功
node codebuddy --help                              **实测失败**（MODULE_NOT_FOUND）
ELECTRON_RUN_AS_NODE=1 WorkBuddy.exe .../codebuddy --help   **实测失败**（MODULE_NOT_FOUND）
ollama list / ollama --version                     实跑成功
claude --version                                   实跑成功
Test-NetConnection 127.0.0.1:11434 / :1234         端口探测（11434 通，1234 未监听）
```

**尚未完成的检查（诚实标记）**：

- 未真实执行任何 Agent 任务（**未消耗任何模型额度**）；`dsh headless`、`trae-cn chat`、`codebuddy` 的端到端任务均未跑
- Grok 的本地 HTTP 接口未发送任何请求（端口与令牌属动态凭据，需谨慎设计只读探活）
- 各客户端的**成本/额度回传能力全部未验证**（因此所有成本字段初始只能记「未知 / 估算」）
- 取消（cancel）与运行状态查询能力，四个客户端**均未验证**
- 未确认 `codex-windows-sandbox-service` 对应的 Codex CLI 是否可调用
- 未测并发提交同一客户端时的行为与限流表现
- 未验证各客户端订阅/额度是否允许被程序化高频调用（这是后续必须前置确认的合规与成本风险）

**本次未创建任何源码或工程结构**，仅创建了 `docs/` 目录与本报告。

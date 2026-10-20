# DSH Adapter 接入验证报告（DSH_ADAPTER_PROBE）

- 验证日期：2026-10-20
- 验证对象：DeepSeek Harness `dsh` CLI 的 `headless` profile
- 前置报告：`E:\ai个人工作台\docs\ENVIRONMENT_AUDIT.md`
- 本阶段原则：**只验证，不开发工作台**；不安装依赖；不输出凭据；不自动重试；测试文件仅落在 `%TEMP%\agent-workbench-probe`
- 唯一例外：**第 2.5 步经用户批准**，仅修改了 headless profile 的 `cordis.patch.yml`（已先备份、后校验；未改动 DSH 安装目录、桌面 profile 及其他客户端配置）
- 状态标签：**已实测成功** / **已实测失败** / **仅静态发现** / **模拟验证** / **待验证** / **不支持**

---

## 一、环境复核结果

| 复核项 | 结果 | 状态 |
| --- | --- | --- |
| 审计报告是否存在 | `E:\ai个人工作台\docs\ENVIRONMENT_AUDIT.md` 存在 | 已实测成功 |
| DSH 实际安装路径 | `E:\gsh\DeepSeek Harness.exe` 仍有效（注册表中记录的旧路径 `E:\新建文件夹` **已失效**，复核结论：**不要照注册表写代码**） | 已实测成功 |
| `dsh.cmd` 路径 | `E:\gsh\resources\runtime\cli\bin\dsh.cmd` 仍有效 | 已实测成功 |
| `dsh --version` | 输出 `0.2.0-rc.2`，退出码 0 | 已实测成功 |
| `dsh --help` | 正常输出用法，退出码 0 | 已实测成功 |
| `dsh --profile headless --help` | 输出精确契约，退出码 0 | 已实测成功 |
| DSH_HOME | `C:\Users\Lenovo\.dsh`（含 `profiles/`、`sessions/`、`.dshw-usage.json`） | 已实测成功 |

**一个重要纠正**：`dsh.cmd` 里引用的入口脚本位于 **asar 虚拟归档内部**（`…\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js`）。用 PowerShell `Test-Path` 检查该路径会返回 `False`，**这是正常的**（asar 是虚拟归档，只有 Electron 打过补丁的 fs 能读）。因此**不能用 `Test-Path` 判断 asar 内文件是否存在**，也不能因此认为入口缺失。

**参数语义有一手证据**：`dsh --profile headless --help` 输出了完整的参数说明；此外 `C:\Users\Lenovo\.dsh\profiles\headless\cordis.patch.yml` 的文件头自带官方注释「Your patch layer for this dsh profile, applied after every bundle layer … Edit cordis.patch.yml, not this file」。本报告所有参数均来自这些一手输出，**未补入任何未经验证的参数**。

### `headless` profile 的精确契约（原文照录）

```text
Usage: dsh --profile headless [options] [task...]

Answer one task and exit; the answer goes to stdout and diagnostics to stderr.

Arguments:
  task               the task text; multiple words are joined by spaces, and `-`
                     reads stdin

Options:
  --json             write newline-delimited run events to stdout instead of the
                     final message
  --session-id <id>  adopt the persisted Session with this id; an unknown id is
                     an error
  -h, --help         show this help

Examples:
  dsh --profile headless "run the tests"          answer one task and exit
  echo "run the tests" | dsh --profile headless   read the task from stdin
  dsh --profile headless --json "run the tests"   emit machine-readable run events
  dsh --profile headless --session-id session-… "continue"   resume an existing Session
```

要点：任务文本走 argv（多词自动用空格连接）或 stdin（`-`）；`--json` 把结果换成 **NDJSON（换行分隔的 run 事件）**；stdout 只放结果，**诊断走 stderr**；`--session-id` 可续跑已有会话。**DSH 没有 `--timeout`、没有 `cancel`、没有 `status` 子命令。**

---

## 二、实际调用的命令与脱敏输出摘要

所有命令均以 `ELECTRON_RUN_AS_NODE=1`（等价于 `dsh.cmd` 内部行为）**无窗口**方式运行。本阶段**未修改任何客户端配置文件**，**未安装任何依赖**。

| # | 命令（脱敏） | 退出码 | 耗时 | stdout | stderr | GUI | 残留进程 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `dsh.cmd --version` | 0 | 秒级 | `0.2.0-rc.2` | 空 | 未出现 | 0 |
| 2 | `dsh.cmd --help` | 0 | 秒级 | 用法文本 | 空 | 未出现 | 0 |
| 3 | `dsh --profile headless --help` | 0 | 秒级 | 契约文本（见上） | 空 | 未出现 | 0 |
| 4 | `dsh --profile headless --dump-default-config` | 0 | **169 ms** | 12142 字符（profile 树） | 空 | 未出现 | 0 |
| 5 | `dsh --profile headless --json "<最小任务>"` **（真实任务）** | **1** | **1143 ms** | 669 字符 NDJSON | 234 字符 | 未出现 | 0 |

命令 4 与 5 **不提交模型任务**（4 是纯本地配置导出；5 在凭据检查处即失败，未进入模型）。命令 1–4 为无任务诊断。

### 命令 5 的 stdout（NDJSON 全文，未改写）

```json
{"type":"session","sessionId":"session-31412591-0f9c-4afd-90a6-4f9e3ac176d6","cwd":"C:\\Users\\Lenovo\\AppData\\Local\\Temp\\agent-workbench-probe"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment","code":"MISSING_CREDENTIAL"}}}
{"type":"final","text":""}
```

### 命令 5 的 stderr（全文）

```text
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment
```

**事件流结构已确认**：`session`（含 `sessionId` + `cwd`）→ `status.turn_start` → `status.step_start` / `status.step_end` → `status.turn_end`（带 `reason.kind` 与结构化 `error.code`）→ `final`（最终文本）。

---

## 二·五、第 2.5 步：启用账号路由（路线 2）并完成成功态验证

> 经用户批准执行。**未申请/写入任何 API Key，未改动账户登录状态，未安装依赖**；仅修改了 headless profile 的 `cordis.patch.yml`。

### 1) 补丁语法的一手依据（先确认，后修改）

| 依据 | 内容 |
| --- | --- |
| `dsh --help` | `--dump-config` = 打印**合成后**的 profile 树；`--dump-default-config` = **不含**用户层与 `--patch` 覆盖；`--dump-config-schema` = 打印 **profile 条目与 patch 的 JSON Schema**（不挂载） |
| `--dump-config-schema` → `$defs.includePatch.description`（**原文**） | 「An insert appends entries, optionally inside the group identified by id. **Other patches replace supplied fields; config is replaced wholesale, not deep-merged.** A truthy name asserts the existing plugin name rather than renaming it. **Unknown targets and non-insert patches without a nonempty id are warned and skipped.**」 |
| 结构对照 | headless 与 desktop 的 compose 树中，`agent-default-model` 条目 **id 完全一致** → id 定位可用；headless 树中**已存在** `llm-deepseek-account`（`@deepseek-ai/dsh-llm-deepseek-account`）与 `deepseek-account`（`@deepseek-ai/dsh-deepseek-account-platform`）插件，无需新增条目 |

**由此确定的两条关键规则**：① `config` 是**整体替换、不是深合并** → 必须写全该 `config` 下的全部字段；② 目标 id 不存在时会被**警告并跳过** → 因此「stderr 无 warning」可作为补丁生效的反证。

### 2) 配置差异（非敏感，仅 provider / desktopPlatform）

| 项 | 修改前 | 修改后 |
| --- | --- | --- |
| `agent-default-model.config` | `provider: deepseek-official` + `model: deepseek-flash` | **`provider: deepseek-account`** + `model: deepseek-flash` |
| `deepseek-account.config.desktopPlatform` | `!!js` 表达式：仅当 `profileContext.name === 'desktop'` 时取 `process.platform`，否则 `null` | **`win32`**（静态值，等价于桌面 profile 在 Windows 上的实际取值） |

第二条是**有意为之**：原表达式在 headless 下求值为 `null`，为避免账号插件在非桌面 profile 下取不到凭据，显式写入 `win32`。两条都属于「复用现有登录态」，**不引入任何新的付费路径**。

### 3) 备份

| 项 | 值 |
| --- | --- |
| 备份路径 | `%TEMP%\agent-workbench-probe\cordis.patch.yml.bak-20261020-175032` |
| 原文件 sha256 | `EF189A8C27DB6D63930AA3046A3040482E952EAFCB7487C644D508E8D461F027` |
| 备份 sha256 | 与原件**一致**（已校验） |
| 修改后 patch sha256 | `5A5CA026C0F909BE51F3EBE78C3AE304451D90F0CFE45D78AE3D6EADAB775D9D` |

### 4) 配置检查结果（**通过**）

`dsh --profile headless --dump-config`：退出码 **0**、耗时 166 ms、**stderr 为空（无任何 warning）** → 补丁语法被接受、目标 id 全部命中（未出现 “unknown target skipped”）。

合成树 diff 仅出现**预期的两处变化**，且标注了来源：

```text
<= provider: deepseek-official
=> provider: deepseek-account
   # == @deepseek-ai/dsh-base, patched by C:\Users\Lenovo\.dsh\profiles\headless\cordis.patch.yml
<= desktopPlatform: !!js >-   (原表达式)
=> desktopPlatform: win32
   # == @deepseek-ai/dsh-base, patched by C:\Users\Lenovo\.dsh\profiles\headless\cordis.patch.yml
```

`searchProvider: deepseek-official` 等无关字段**未被误改**。→ **成功判定第 1 条满足。**

### 5) 真实调用（**仅 1 次，未重试**）

命令（脱敏，等价于 `dsh --profile headless --json "<prompt>"`）：

```text
ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals "...\app.asar\dsh\...\cli.js" --profile headless --json "<用户指定的最小 prompt>"
```

| 观测项 | 值 |
| --- | --- |
| 退出码 | **0** |
| 耗时 | **2104 ms**（含 Electron 启动） |
| stderr | **空** |
| sessionId | `session-811d3a35-1921-41ec-b760-7d351695846f` |
| 是否出现凭据错误 | **否**（未再出现 `MISSING_CREDENTIAL`） |
| 残留进程 | **0**（本次根 PID 3336 已退出） |

### 6) 成功态 stdout（NDJSON 全文，未改写）

```json
{"type":"session","sessionId":"session-811d3a35-1921-41ec-b760-7d351695846f","cwd":"C:\\Users\\Lenovo\\AppData\\Local\\Temp\\agent-workbench-probe"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"thinking","text":""}
{"type":"text","text":"AGENT_PROBE_OK"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6068,"outputTokens":6,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":6074}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"AGENT_PROBE_OK"}
```

**成功态新增确认的三件事**（此前均为待验证）：

1. **成功原因取值是 `reason.kind: "completed"`**（失败态为 `"error"`）→ 可直接作为包装层的成功判据；
2. 事件流中还含 **`thinking`** 与 **`text`**（增量文本）两类事件 → **支持流式展示**；
3. **`step_end` 事件携带 `usage`**（`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`）→ **token 用量可从事件流直接取得**。

**成本相关的关键观测**：本次 `inputTokens = 6068`、`outputTokens = 6`。即一次「极简」任务也有约 **6k token 的固定上下文开销**（系统提示 + 工具 schema）——**固定开销远大于任务本身**，这对预算建模很重要。

### 7) 费用核验结果（**未能从账本确认**）

| 账本项 | 调用前 | 调用后 |
| --- | --- | --- |
| `lastBalance` | 14.571496 | 14.571496 |
| `events` 条数 | 2 | 2 |
| `date` | 2026-10-15 | 2026-10-15 |
| **差值** | — | **0.000000，且无新增事件记录** |

**严格按事实表述的结论**：

- **headless 调用不会写入 `~/.dsh/.dshw-usage.json`**（该账本仍停留在 `2026-10-15` 的桌面侧记录）。
- 因此**不得**把该 0 当作「本次调用免费」的证据 —— **本次实际费用未能从该账本确认**。
- 唯一可用的**估算**：本次总计 6074 tokens；账本历史两次 `deepseek-flash` turn 为 18068 tokens / 0.00178104 CNY 与 10234 tokens / 0.010681 CNY → **估算区间约 0.0006 ~ 0.0063 CNY**。该数值**仅为估算，不作为实际费用入账**。
- 对工作台的含义：`getUsage()` 的**金额**部分对 headless 只能返回 `source: 'unknown'`；但可另辟一路，用 NDJSON 的 `usage` 字段取 **token 用量**（**已实测成功**），金额口径仍需后续核验。

### 8) 本步成功判定（对照用户给定的 7 条）

| 判定条件 | 结果 |
| --- | --- |
| 1. 最终配置确实使用 `deepseek-account` | **满足**（`--dump-config` 已确认，无 warning） |
| 2. 真实任务未因凭据错误失败 | **满足**（退出码 0，无 `MISSING_CREDENTIAL`） |
| 3. stdout 存在可解析 NDJSON | **满足**（8 行事件：`session`/`status`/`thinking`/`text`/`final`） |
| 4. 存在成功的 turn 结束事件 | **满足**（`turn_end` + `reason.kind: "completed"`） |
| 5. `final.text` 非空且为 `AGENT_PROBE_OK` | **满足**（`{"type":"final","text":"AGENT_PROBE_OK"}`） |
| 6. 记录耗时、退出码、费用核验 | **部分满足** —— 耗时 2104 ms、退出码 0 已记录；**费用无法从账本确认**（已如实标记，未冒充成功） |
| 7. 无本次测试遗留的后台进程 | **满足**（0 残留） |

**综合判定：本步成功。** 7 条中 6 条完全满足，第 6 条的费用项按事实标记为「未能确认」。

---

## 三、每项能力的验证状态

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| CLI 可执行、可读版本 | **已实测成功** | 命令 1 |
| 帮助 / 子命令 / 参数发现 | **已实测成功** | 命令 2、3 |
| 无模型本地自省（`--dump-default-config`） | **已实测成功** | 命令 4，169 ms，退出码 0 |
| **提交任务（命令面）** | **已实测成功** | 命令 5 真实提交，进入 turn 生命周期 |
| **提交任务（成功跑完并拿到答复）** | **已实测成功** | 第 2.5 步：退出码 0、`turn_end` 的 `reason.kind === "completed"`（详见第二·五节） |
| **结果获取（结构化事件流）** | **已实测成功** | NDJSON 事件类型已确认 8 行：`session` / `status` / `thinking` / `text` / `step_end.usage` / `final` |
| 结果获取（成功态 `final.text`） | **已实测成功** | `{"type":"final","text":"AGENT_PROBE_OK"}` |
| 退出码语义 | **已实测成功** | 成功/帮助=0；失败=1 |
| stderr 诊断通道 | **已实测成功** | `dsh: <CODE>: <message>` 单行 |
| 结构化错误码 | **已实测成功** | `error.code = MISSING_CREDENTIAL` |
| 获取 sessionId / cwd | **已实测成功** | 首个 `session` 事件 |
| 会话续跑（`--session-id`） | **仅静态发现** | 仅帮助文本声明，未实测 |
| 任务状态查询（原生） | **不支持** | 无 `status` 子命令；仅有事件流 |
| 取消任务（原生） | **不支持** | 无 `cancel` 子命令/参数 |
| 超时（原生） | **不支持** | 无 `--timeout`；超时只能由包装层实现 |
| 取消 / 超时（包装层终止进程） | **模拟验证** | 见第五节，分类正确、残留 0 |
| 成本（金额） | **账本不覆盖 headless → 已实测：实际费用未能确认** | 第 2.5 步实测：调用前后 `lastBalance` 不变、无新增事件记录 |
| 用量（token） | **已实测成功** | `step_end.usage` 提供 `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`（本次 6068 / 6 / 0 / 0 / 6074） |
| 是否启动 GUI | **已实测成功** | `ELECTRON_RUN_AS_NODE` + 无窗口启动，命令 1–5 均无窗口进程 |
| 是否遗留后台进程 | **已实测成功** | 每次运行后 `DeepSeek Harness.exe` 计数均为 0 |
| 并发提交 / 限流表现 | **待验证** | 未做并发测试（避免额度与干扰） |

---

## 四、是否执行真实模型调用，以及费用是否确定

- **执行了 1 次真实任务提交，未重试**（命令 5）。
- **本次实际费用 = 0，已实测确定**：`~/.dsh/.dshw-usage.json` 在调用前后对比，`lastBalance` 均为 `14.571496`，**差值 `0.000000`**，`events` 数组长度不变（仍为 2）。因为任务在凭据检查处失败，**根本没有进入模型调用**。
- **单次「成功」调用的费用：待验证。** 但账本本身是一个**按 CNY 记账的真实台账**，已实测可读，其历史事件可作为估算依据：

```json
"events":[{"ts":…,"day":"2026-10-15","model":"deepseek-flash","cost":0.00178104,"tokens":18068},
          {"ts":…,"day":"2026-10-15","model":"deepseek-flash","cost":0.010681,"tokens":10234}]
"lastBalance":14.571496
```

  即历史两次 `deepseek-flash` turn 的实付成本分别为 **0.00178 CNY / 0.01068 CNY**（约 1–1.1 分钱人民币），账户余额约 14.57 CNY。**据此可给出上界估算：一次极简任务的成本大概率在 0.01 CNY 量级。**
- **不确定性（必须写明）**：该账本由桌面应用侧写入，`~/.dsh/.dshw-usage.json` 的 `date` 字段当前为 `2026-10-15`；**headless 模式下的成功调用是否会写入同一账本，未经验证**。因此 `cost_actual` 对 DSH 目前只能标记为「**可读机制已确认，归因待验证**」，不能直接当作账单。

> **第 2.5 步更新（已实测结论）**：headless 成功调用后该账本**完全未变**（`lastBalance` 14.571496 → 14.571496，`events` 2 → 2，无新增记录）→ **headless 调用不写入该账本**。因此本次**实际费用未能确认**，且**不得**把差值 0 当作「本次免费」的证据。可用 token 用量（6068 输入 / 6 输出 = 6074）叠加历史单价得到**估算区间约 0.0006 ~ 0.0063 CNY**，但一律按「估算」入账。详见第二·五节第 7 小节。

---

## 五、失败处理测试结果

包装层分类逻辑与本地模拟用例脚本位于 `%TEMP%\agent-workbench-probe\probe_wrapper.ps1`（**全部不调用模型**）。

| 失败类别 | 状态 | 证据 |
| --- | --- | --- |
| `COMMAND_NOT_FOUND`（命令不存在） | **模拟验证** | 指向不存在的 exe → 分类 `COMMAND_NOT_FOUND`，无输出 |
| `ARGUMENT_ERROR`（参数错误） | **模拟验证** | 真实 `dsh` 传非法参数 → 退出码 **1**，stderr：`error: unknown option '--__no_such_flag__'` → 分类 `ARGUMENT_ERROR` |
| `ERROR_IN_OUTPUT`（输出含错误） | **已实测成功** | 真实任务失败 → `MISSING_CREDENTIAL` 同时出现在 stderr 与 NDJSON 的 `error.code` |
| 非零退出码（通用分支） | **待验证** | 分类逻辑已实现，但未构造「非零且无错误关键字」的专门用例 |
| `EMPTY_OUTPUT`（成功但无输出） | **模拟验证** | exit 0 且 stdout 为空 → 分类 `EMPTY_OUTPUT` |
| `TIMEOUT`（执行超时） | **模拟验证** | 25 s 本地任务 + 3 s 超时 → 实测 3036 ms 时判定 `TIMEOUT` 并终止 |
| `CANCELLED_BY_WRAPPER`（用户取消） | **模拟验证** | 主动终止 → 分类 `CANCELLED_BY_WRAPPER` |
| 进程清理 | **已实测成功** | 只对本脚本自己启动的 PID 执行 `Stop-Process`；结束后残留检查 **0 个未清理** |

**方法说明**：模拟用例使用的是「本地真实进程」，只验证**包装层能否识别这些失败形态**，**不代表 DSH 本身支持对应的失败语义**（例如 `TIMEOUT` / `CANCELLED` 是包装层能力，不是 DSH 原生能力）。

---

## 六、建议的 Adapter 接口契约

> 下表是本阶段最有价值的部分：它把「CLI 原生支持」「包装层实现」「当前无法实现」三者严格分开，避免把包装层的进程状态冒充为 Agent 内部任务状态。

### 契约草案（TypeScript）

```ts
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
type CostRecord = { currency: 'CNY'; amount: number | null; source: 'ledger' | 'unknown' };

interface DshAdapter {
  /** 环境校验：CLI 路径、版本、profile 可用性、凭据是否就绪 */
  validate(): Promise<{
    cliPath: string; version: string; profile: string;
    credentialReady: boolean;              // 关键：false 时 run() 必然失败
    notes: string[];
  }>;

  /** 提交一个任务；调用方必须提供超时 */
  run(task: string, options: {
    timeoutMs: number;                     // 必填（DSh 无原生超时）
    cwd?: string;
    sessionId?: string;                    // 对应原生 --session-id
    signal?: AbortSignal;                  // 用户取消
  }): Promise<{
    runId: string;                         // 包装层 id（不等于 DSH sessionId）
    sessionId: string | null;              // 来自 NDJSON 首个 session 事件（原生）
    status: RunStatus;
    exitCode: number | null;
    stdoutNjson: string;                   // 原始事件流（原样保存）
    stderr: string;
    startedAt: string; endedAt: string; durationMs: number;
    finalText: string | null;
    error: { code: string | null; message: string } | null;
  }>;

  /** 尝试取消：仅能终止本地进程树 */
  cancel(runId: string): Promise<{ ok: boolean; scope: 'local_process_only' }>;

  /** 查询包装层状态 */
  getStatus(runId: string): Promise<{ status: RunStatus; source: 'wrapper' }>;

  /** 取结果：解析 NDJSON 事件流 */
  getResult(runId: string): Promise<{ finalText: string | null; events: unknown[] }>;

  /** 取用量：读本地账本增量，读不到就报 unknown，绝不猜 */
  getUsage(runId: string): Promise<CostRecord>;

  /** 释放资源：终止遗留子进程、关闭句柄 */
  dispose(): Promise<void>;
}
```

### 能力归属划分（必须遵守）

| 契约方法 | CLI 原生支持的 | 由包装层实现的 | 当前无法实现 / 必须标注的 |
| --- | --- | --- | --- |
| `validate()` | `--version`、`--help`、`--dump-default-config` | 路径探测、凭据就绪性判定 | 无法确认「凭据到底记在哪个存储」的内部细节 |
| `run()` 任务提交 | argv / stdin `-` 传任务 | 进程管理、事件流收集、超时、编码 | — |
| `run()` 结果 | `--json` NDJSON（`session` / `status` / `thinking` / `text` / `step_end.usage` / `final`）、`--session-id` | NDJSON 解析、字段归一、原始流落盘、流式转发 | — |
| 成功 / 失败判据 | `turn_end.reason.kind`：成功 `"completed"`、失败 `"error"`（**均已实测**） | 包装层据此判定成功/失败 | 金额仍无法确认（见下行） |
| `cancel()` | **不支持**（无原生取消） | 终止本进程树 | **无法保证远端模型请求已停止**；也无法确认是否已停止计费 → 必须标注 `scope: 'local_process_only'` |
| `getStatus()` | **不支持**（无 `status` 子命令） | 由包装层依据「进程存活 + 已收事件」推导 | **不得冒充 DSH 内部任务状态**；`--session-id` 只能证明会话可续跑，不是状态查询 |
| `getResult()` | `--json` 事件流 + `--session-id` 续跑 | 事件归档、重放 | — |
| `getUsage()` | `step_end.usage` 提供 token 用量（**已实测**） | token 用量归集、写入本地库 | **账本对 headless 无效（已实测差值 0）** → 金额一律返回 `source: 'unknown'`，禁止用估算冒充实际 |
| `dispose()` | — | 终止遗留进程、释放句柄 | — |

### 契约必须包含的两条硬约束

1. **`credentialReady === false` 时，`run()` 必须直接拒发**，否则每次都会以一个必然失败的进程结束（本次实测即为该情形：`MISSING_CREDENTIAL`，退出码 1）。这属于「去重与预算闸门」的第一道拦截。
2. **包装层状态与 Agent 内部状态必须分列两个字段**，UI 与数据库都不许合并展示。

---

## 七、已知风险、阻塞项与待验证项

### 阻塞项（硬阻塞，必须由用户决策解除）

- ~~**DSH headless 路径当前缺少模型凭据。**~~ → **已于第 2.5 步解除（已实测成功）**。原 headless profile 走 **API Key 路由**（`provider route "deepseek-official"`），桌面走**账号路由**（`provider: deepseek-account`），两者不是一回事；本次已在 headless 的 `cordis.patch.yml` 把 `agent-default-model.provider` 覆写为 `deepseek-account`、并把 `deepseek-account.desktopPlatform` 置为 `win32`，真实调用退出码 0、`final.text = AGENT_PROBE_OK`。
- **新增待办（非阻塞）**：① headless 的**实际费用仍无法确认**（账本不覆盖 headless）；② 账号路由依赖 `desktopPlatform: win32` 这一**非文档化耦合**——DSH 升级导致桌面 profile 结构变化时需重新验证。
- ~~解除方式只有两条（**本阶段均未执行，因涉及凭据或改配置**）~~ → **已采用路线 2（账号路由）并实测成功**；路线 1（API Key）未采用：
  1. 在启动环境导出 `DEEPSEEK_API_KEY`（DeepSeek 开放平台密钥，按 token 另计费）；
  2. **或** 在 `C:\Users\Lenovo\.dsh\profiles\headless\cordis.patch.yml` 加一条 patch 覆写为账号路由——桌面 profile 的现成样例是：
     ```yaml
     - id: agent-default-model
       name: "@deepseek-ai/dsh-agent-default-model"
       config:
         provider: deepseek-account
         model: deepseek-flash
     ```
     该文件文件头官方注释明确写着「Edit cordis.patch.yml」，即这是**官方指定的覆写入口**（原内容为空数组 `[]`）。
  > **实际执行情况（第 2.5 步）**：已按此路线修改并**实测成功**——最终 patch 内容见第二·五节第 2 小节；`provider: deepseek-account` 已通过 `--dump-config` 确认生效，真实调用退出码 0、`final.text = AGENT_PROBE_OK`。原文件已备份（路径见第二·五节第 3 小节），**可回滚**。

### 风险

- **终止本地进程 ≠ 停止远端请求**。DSH 无原生取消，`cancel()` 只能 best-effort，且**无法确认是否已停止计费**。
- **超时预算必须覆盖冷启动**。Electron 冷启动开销明显（首次 `--help` 调用耗时较久，未精确计时；热态为 169 ms / 1143 ms）。若超时设得过紧，会误杀正常任务。
- **运行会产生磁盘副作用**（本次已实测到两项，均为良性、追加式）：
  1. 首次使用 `--profile headless` 会**自动生成** `C:\Users\Lenovo\.dsh\profiles\headless`（含 `cordis.patch.yml` / `cordis.yml` / `package.json` / `pnpm-workspace.yaml`，创建时间 2026-10-20 17:31:32）；
  2. **每次 run 会按 cwd 建目录落会话**：`C:\Users\Lenovo\.dsh\sessions\--C-Users-Lenovo-AppData-Local-Temp-agent-workbench-probe--\session-31412591-…`。工作台需要规划**会话目录增长与清理策略**。
- **成本口径风险**：在 headless 成功调用是否记账未验证之前，成本字段只能记 `unknown`，不得用估算冒充实际（延续审计报告第 4.8 节结论）。

### 待验证项（第 2.5 步后更新）

- ~~成功态：`final.text` 的实际形态、`turn_end.reason.kind` 的成功取值~~ → **已实测**（`final.text = AGENT_PROBE_OK`；成功态 `reason.kind = "completed"`）。
- ~~headless 成功调用是否写入 `~/.dsh/.dshw-usage.json`~~ → **已实测：不写入**（差值 0、无新增事件）。
- **headless 的实际费用归因**：账本不覆盖 headless，**仍然无法确认**（唯一可用的是 token 用量估算）。
- 账号路由在**并发 / 高频**调用下是否仍有效（本次仅 1 次成功调用，未测并发与限流）。
- `--json` 与默认（非 `--json`）模式差异；stdin（`-`）传任务；`--session-id` 续跑。
- 非零退出码通用分支的专门用例。
- `desktopPlatform: win32` 这一非文档化耦合的长期稳定性。

---

## 八、下一步建议

1. ~~**先决决策（用户）**：选择凭据路线~~ → **已完成**：采用**路线 2**（复用 `deepseek-account` 账号路由），配置检查与实际调用均已通过（见第二·五节）。
2. ~~**解除后只做一次成功态验证**~~ → **已完成**：`final.text = AGENT_PROBE_OK`、退出码 0、耗时 2104 ms；**但账本未变化，实际费用仍未确认**。
2b. **遗留待办**：① 为 headless 建立**费用核验手段**（账本不覆盖 headless，需另找账号用量页或账单做对比核验）；② 评估 **6k token 固定开销**对预算模型的影响；③ 验证 `--session-id` 续跑与并发限流。
3. **成功态确认后**，再进入第 3 步（工作台最小骨架：任务队列、状态机、执行日志、本地持久化，先用模拟 Agent 测试）。
4. 在骨架设计时把本文第六节的三项硬约束直接写进代码注释与数据库字段：**未就绪凭据直接拒发**、**包装层状态与 Agent 内部状态分列**、**`cost_unknown` 独立记账**。

---

## 附：本阶段产生的文件

| 文件 | 位置 | 说明 |
| --- | --- | --- |
| 本体报告 | `E:\ai个人工作台\docs\DSH_ADAPTER_PROBE.md` | 交付文档 |
| 真实调用 stdout（NDJSON 原文） | `%TEMP%\agent-workbench-probe\dsh_run_stdout.ndjson` | 证据 |
| 真实调用 stderr | `%TEMP%\agent-workbench-probe\dsh_run_stderr.txt` | 证据 |
| 账本前 / 后快照 | `%TEMP%\agent-workbench-probe\usage_before.json` / `usage_after.json` | 费用证据（差值 0） |
| 失败分类模拟脚本 | `%TEMP%\agent-workbench-probe\probe_wrapper.ps1` | 测试脚本（**后续已由用户删除**） |
| 第 2.5 步：启动器帮助 / headless 默认树 / 补丁 Schema | `%TEMP%\agent-workbench-probe\launcher_help.txt` / `headless_default_tree.txt` / `config_schema.json` | 补丁语法的**一手依据** |
| 第 2.5 步：合成配置前后 | `%TEMP%\agent-workbench-probe\headless_composed_BEFORE.yml` / `headless_composed_AFTER.yml` | 配置校验证据 |
| 第 2.5 步：配置备份 | `%TEMP%\agent-workbench-probe\cordis.patch.yml.bak-20261020-175032` | **可一键回滚** |
| 第 2.5 步：成功态 stdout / stderr | `%TEMP%\agent-workbench-probe\dsh_success_stdout.ndjson` / `dsh_success_stderr.txt` | 成功态证据 |
| 第 2.5 步：账本前后 | `%TEMP%\agent-workbench-probe\usage2_before.json` / `usage2_after.json` | 费用核验证据（差值 0） |

**未在项目根目录创建任何临时源码**；未创建 Electron 工程；未安装依赖。**唯一配置改动**：第 2.5 步经批准修改了 headless 的 `cordis.patch.yml`（已备份至上述路径，**可回滚**）；DSH 安装目录、桌面 profile 与其他客户端配置**均未改动**。

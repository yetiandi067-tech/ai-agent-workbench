# 第 4 步·阶段 2：主管 Agent 调度层验收与加固 —— 实施报告

> 对应 SPEC：`docs/STEP4_PHASE2_SPEC.md`
> 前置阶段：`docs/STEP4_PHASE1_SPEC.md` / `docs/STEP4_PHASE1_REPORT.md`（阶段 1 提交 `0a3a1ba`）
> 本阶段提交：见文末「九、Git 审计」。

---

## 一、实际检查的 Git 基线和工作区状态

| 项 | 实际结果 |
|---|---|
| 分支 | `master` |
| 阶段 1 提交 | `0a3a1ba` ✅ 存在（校验通过，阶段 1 代码完整） |
| 上一阶段提交 | `92d83ea`（第 3 步工作台底座） |
| 阶段 1 完整性 | `planService.ts` 中 `BLOCKED_BY_DEPENDENCY_CODE` / `confirmPlan` / `runPlan` / `recoverStalePlans` 均在，代码与阶段 1 报告一致 |
| 执行前工作区 | 无已跟踪文件被修改；仅 `docs/STEP4_PHASE1_REPORT.md`（阶段 1 报告，当时未入库）与 `docs/STEP4_PHASE2_SPEC.md`（本阶段 SPEC）为未跟踪文件 —— 均**保留**，未覆盖/重置/清理 |

**结论：基线与 SPEC 描述一致，未发现「报告与代码不一致」。**

自动化基线（改动前复跑）：

- `npm run typecheck` → 通过（退出码 0）
- `npm run test` → **65 项全部通过**（8 个测试文件）
- `npm run build` → 通过

---

## 二、核心任务 A：人工可执行的 Mock 端到端验收

**执行环境说明（重要）**：本次执行环境**无法进行真实 GUI 交互操作**（自动化代理无法点击/输入 Electron 原生窗口控件）。因此下列 GUI 交互项**不能**以自动化单元测试冒充验收，统一标记为「**待人工验收**」，并附上可亲自操作的步骤（见第十节）。

| # | 验收项 | 实际结果 |
|---|---|---|
| 1 | 应用可正常启动，页面无致命错误 | ✅ **已实测**。`npm run dev` 启动成功：主进程/预加载构建成功，渲染进程 dev server 起于 `http://localhost:5174/`，日志输出「应用启动」（appRoot=`E:\ai个人工作台`，dataDir=`E:\ai个人工作台\data`）与「服务初始化完成」（`staleRunningRecovered: 0`、`agentCount: 5`），无致命错误；随后已正常关闭，**无残留 electron 进程** |
| 2 | 任务中心能输入总目标 | ⚠️ 待人工验收 |
| 3 | 点击「生成计划」后出现计划预览 | ⚠️ 待人工验收 |
| 4 | 预览显示子任务标题/类型/依赖/执行 Agent/验收标准 | ⚠️ 待人工验收（代码层面这些字段均已在预览卡片渲染，见任务 D 核查） |
| 5 | 未点「确认执行」前不自动执行任何子任务 | ✅ 逻辑已自动化验证（E1：创建计划后运行记录数为 0）；GUI 呈现待人工验收 |
| 6 | 确认后 Mock 子任务按依赖顺序执行 | ✅ 逻辑已自动化验证（E2/E6）；GUI 呈现待人工验收 |
| 7 | 能查看各子任务状态/执行结果/错误信息 | ⚠️ 待人工验收 |
| 8 | 计划结束后能查看汇总报告 | ⚠️ 待人工验收（报告内容由任务 D 自动化验证） |
| 9 | 刷新/重启后历史计划及子任务状态仍在 | ⚠️ 待人工验收（持久化已由单测「关闭并重开数据库后仍可读取」与迁移测试覆盖） |
| 10 | 页面明确显示「Mock 演示结果」 | ⚠️ 待人工验收（常量 `MOCK_PLAN_BADGE = 'Mock 演示结果'`，报告与预览均引用） |

**补充证据（非 GUI，但可证真实链路）**：真实应用数据库 `E:\ai个人工作台\data\workbench.db` 当前 `plans = 0`、`tasks = 0`、schema = 2。即：**真实应用尚未被人工跑过一条完整计划**，故第 2–10 项必须以人工操作补验，不能记为「本次已实测通过」。

---

## 三、发现的缺陷、修复方案和修改文件

代码审计（阅读 `planService.ts` / `taskRunner.ts` / `repositories.ts` / `task-state.ts` / `migrations.ts` / `ipc.ts` / `preload/index.ts` / `TasksPage.tsx`）后，发现并修复以下缺陷：

| # | 缺陷 | 严重度 | 修复方案 |
|---|---|---|---|
| D1 | `blockTask` 直接调用 `repos.tasks.update` 把 pending 改 failed，**绕过状态机** | 中（违反 SPEC 四·「禁止直接改数据库状态绕过合法转换」） | 改为 `assertTransition(task.status, 'failed')`；`pending → failed` 本就是 `ALLOWED_TRANSITIONS` 中声明的合法转换，现显式走状态机并注释说明 |
| D2 | `confirmPlan` 缺**显式**进程内防重复执行保护（当前仅靠「首个 `await` 前同步完成」隐式保证） | 中 | 增加进程内运行锁 `activePlans: Set<string>`，校验+加锁均在首个 `await` 前同步完成；调度结束 `finally` 释放；并补并发测试（E8） |
| D3 | 汇总报告统计口径**不闭合**：`failedCount` 只统计 `status==='failed'` 且非 BLOCKED 的任务，`timed_out` / `cancelled` / `needs_confirmation` 等终态被漏统计，导致「总数 ≠ 成功+失败+阻断」 | 高 | 改为 `failedCount = totalCount − succeededCount − blockedCount`，并新增断言「成功+失败+阻断 = 总数」（E5a/E6/E12 校验） |
| D4 | `finalizePlan` 未防御性保证「计划结束时无 pending/running 残留」 | 低（正常路径 runPlan 已处理） | 新增 `ensureNoNonTerminalTasks`：pending → 阻断落终态；running → 记 error 日志（防未来改动的兜底） |
| D5 | `recoverStalePlans` 只改**计划**状态，其下**从未执行**的 pending 子任务永远停在 pending，造成「计划已结束、子任务仍在 pending」不一致 | 中（违反 SPEC 五·3 / 五·4） | 新增 `settleInterruptedTasks`：pending → failed + `INTERRUPTED_LAST_RUN`（明确「未执行、需人工检查」，不伪装成功/失败）；running → `needs_confirmation`（遵循既有恢复策略）。计划 `blockedReason` 统一改为「上次运行被中断……需要人工检查」 |

**修改文件**

- `src/main/services/planService.ts`（D1–D5，+109 / −17 行）
- `src/shared/types.ts`（新增 `INTERRUPTED_LAST_RUN_CODE` 常量，用于区分「中断未执行」与「依赖阻断」）
- `tests/planHardening.test.ts`（新增，覆盖 SPEC 第七节场景）

**兼容性说明**：以上修改**未新增/未变更任何数据库表结构**（无 schema 变更，仍为 v2），仅新增一个错误码常量、调整服务层状态落库路径与统计口径。IPC 通道、Preload 桥接、Renderer 组件均**未改动**，对现有 UI 与数据完全兼容。

---

## 四、依赖阻断、防重复执行、重启恢复的验证结果

### 4.1 依赖调度与失败阻断（SPEC 四）

| 要求 | 验证 | 结果 |
|---|---|---|
| 仅当所有依赖 `succeeded` 才执行 | `runPlan` 中 `task.dependsOn.every(dep => status==='succeeded')` | ✅ E2 |
| 上游失败 → 全部下游阻断 | `blockDownstreamTasks` 递归 | ✅ E3（首项失败，下游 3 项全部阻断） |
| 递归传播、无 pending 残留 | 递归阻断 + `ensureNoNonTerminalTasks` | ✅ E4（中间失败，writing→review 两级递归）、E3/E6（无 pending） |
| 阻断码 `BLOCKED_BY_DEPENDENCY` + 可读原因 | `blockedReason` 含「依赖的上游任务『X』未成功（failed）」 | ✅ E3/E4 |
| 计划完成无 pending/running | 断言 | ✅ E6/E10 |
| 全成功 → `succeeded` | — | ✅ E2/E12 |
| 有成功+失败/阻断 → `partial` | — | ✅ E4 |
| 零成功 → `failed` | — | ✅ E3、E9a、E9b |
| 重复确认/并发确认不重复执行 | — | ✅ E7/E8 |
| 循环依赖/无效依赖安全终止、不死循环 | runnable 为空 → 阻断剩余 pending → break | ✅ E9a（A↔B 循环）、E9b（依赖指向不存在 ID） |
| `confirmPlan` 首个 `await` 前同步建立防重 | 已确认为**全同步**且新增显式锁 | ✅ 见 4.2 |

### 4.2 防重复执行 / 并发确认

- `confirmPlan` 从「取计划 → 校验 `status==='draft'` → 写 `running`」全过程**在第一个 `await` 之前同步完成**（函数体内无 `await`），单线程事件循环下两次并发确认**不可能**同时通过 `draft` 检查。
- 额外增加**进程内运行锁** `activePlans`：同一计划执行期间拒绝再次启动，调度结束释放。作为「将来若有人在中间插入 `await` 也不会重复执行」的第二道防线。
- **并发测试 E8**：`Promise.allSettled([confirm, confirm])` → 恰好 1 个 fulfilled、1 个 rejected；计划完成后**运行记录数 == 子任务数（4）**，证明无重复执行、无重复计费。
- **重复确认 E7**：一次确认后再次确认被拒；运行记录数仍为 4。

### 4.3 超时 / 取消的上游阻断（SPEC 四·2）

- **E5a（超时）**：把首个子任务改为 Mock `mock:timeout` 场景，`taskTimeoutMs=5000`，实际得到 `timed_out`（durationMs≈5008），其下游全部 `BLOCKED_BY_DEPENDENCY`，计划 `failed`。
- **E5b（取消）**：运行中调用 `runner.cancelTask` → 首个子任务 `cancelled`，下游全部阻断，计划 `failed`。

### 4.4 重启恢复（SPEC 五）

| 要求 | 结果 |
|---|---|
| 执行中退出，重启后不自动继续执行未知任务 | ✅ E11/E11b：恢复后运行记录数为 **0**，未自动重跑 |
| 正在运行的子任务遵循 `needs_confirmation` | ✅ E11：模拟 running 子任务 → 恢复为 `needs_confirmation` |
| 计划与子任务状态一致 | ✅ E11：恢复后无 pending/running，计划为明确终态 |
| 恢复明确提示「上次运行被中断，需要人工检查」，不伪装成功/失败 | ✅ 计划 `blockedReason` 含该文案；未执行子任务用 `INTERRUPTED_LAST_RUN` + `userNotice` 标注「未执行」 |
| 历史计划/子任务/依赖/汇总可读取 | ✅ 由既有单测（关闭重开数据库）与计划详情接口覆盖 |
| 恢复幂等 | ✅ E11 第二次调用返回 0 |

---

## 五、新增测试清单与通过数量

新增文件 `tests/planHardening.test.ts`（**17 项**），对应 SPEC 第七节：

| 编号 | 测试 | 用例名 |
|---|---|---|
| E1 | 创建计划只生成草稿不执行 | 创建计划只生成草稿，不执行任何子任务（无运行记录） |
| E2 | 正常依赖链按顺序执行 | 正常依赖链按 seq 顺序串行执行 |
| E3 | 首项失败全部下游阻断 | 第一项任务失败，全部下游被阻断且无 pending 残留 |
| E4 | 中间失败递归阻断 | 中间任务失败，后续任务递归阻断（含多级下游） |
| E5a | 上游超时阻断 | 上游超时（timed_out）后，下游被阻断 |
| E5b | 上游取消阻断 | 上游取消（cancelled）后，下游被阻断 |
| E6 | 计划最终状态与统计一致 | 完成计划无 pending/running 残留，汇总与数据库最终状态一致 |
| E6b | 报告不伪装产出 | 报告明确标注 Mock，且不把未执行任务伪装成成功 |
| E7 | 重复确认不重复执行 | 重复确认被拒绝，且不会重复执行子任务 |
| E8 | 并发确认不重复执行 | 并发两次确认只允许一次生效，子任务不重复执行 |
| E9a | 循环依赖安全终止 | 循环依赖的计划不会无限循环，被安全终止 |
| E9b | 无效依赖安全阻断 | 依赖 ID 无效（指向不存在的任务）时被安全阻断 |
| E10 | 无 pending/running 残留 | 同上（E6/E10/E12 合并用例） |
| E11 | 重启恢复不自动重跑 | 中断的计划重启后不自动重跑，子任务落成明确终态且需要人工检查 |
| E11b | 恢复幂等 | 恢复不会重跑未知状态任务（多次调用后仍为 0 运行记录） |
| E12 | 汇总与数据库一致 | 同上（E6/E10/E12 合并用例） |
| E13 | v1→v2 迁移保留旧数据 | ✅ 既有 `tests/migration.test.ts`（2 项）已覆盖：迁移幂等 + 旧任务数据保留，本阶段未改动迁移代码 |
| E14a | 无效目标 | 空目标被拒绝 |
| E14b | 无效计划 ID | 确认不存在的计划 ID 报错，查询返回 null |
| E14c | 非法状态转换 | 对已完成计划再次确认被明确拒绝 |

**全部测试不依赖真实模型、网络或 API 密钥**：仅使用 Mock 适配器 + 临时数据库。

**测试总数：65 → 82（+17），9 个测试文件全部通过。**

---

## 六、typecheck、test、build 实际结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 通过（`tsc -p tsconfig.node.json` + `tsconfig.web.json` 均无错误） |
| `npm run test` | ✅ **9 个文件 / 82 项全部通过**（13.1s） |
| `npm run build` | ✅ 通过（main / preload / renderer 三段均构建成功） |

---

## 七、数据库迁移和数据保留验证结果

- 本阶段**未新增数据库迁移**，schema 仍为 **v2**（`plans-and-subtask-linkage`），未删除/重建/清空任何数据库。
- `tests/migration.test.ts` 验证：v1 → v2 迁移**可重复启动**（已应用则跳过）且**旧任务数据保留**。
- 真实应用数据库 `E:\ai个人工作台\data\workbench.db` 只读探查：`schema_migrations` 最高版本 = **2**，表 `plans/events/runs/tasks/agents` 均存在，现有 `plans=0 / tasks=0`（无历史任务数据可被破坏）。
- 迁移测试全程使用**独立临时数据库**，未触碰真实库。

---

## 八、未解决问题及风险

1. **GUI 交互未实测（最大边界）**：第 2–10 项 GUI 验收在本次环境无法人工点击，**必须由你亲自操作确认**（步骤见第十节）。真实库 `plans=0/tasks=0` 说明 GUI 全链路尚未在真实应用上跑过。
2. **进程内锁为第二道防线**：由于 `confirmPlan` 本身全同步，锁在现有代码路径下不会被真正触发；其价值在于「未来若引入 `await`」的防回归。真正的并发安全目前由「同步校验」保证 —— 两者均已由 E7/E8 以「行为结果（无重复执行）」验证。
3. **中断恢复的状态语义**：`PlanStatus` 枚举无独立「已中断」值，恢复时计划被置为 `failed`，靠 `blockedReason` 文案（「上次运行被中断……需要人工检查」）与子任务 `INTERRUPTED_LAST_RUN` 错误码区分。UI 需正确展示该文案，人工验收时请重点核对，避免误读为「普通失败」。
4. **仅覆盖 Mock 适配器**：本阶段所有验证限于 Mock；真实 DSH 适配器在计划调度下的行为（真实调用确认、并发闸门、费用无法核验提示）**未在本阶段验证**，属下一阶段范围。
5. **`timed_out`/`cancelled` 计入「失败」口径**：汇总报告的 `failedCount` 现包含超时/取消/中断等非成功终态，报告文案与计划状态判定一致；如需在 UI 上把超时/取消单列，可在下一阶段细化（本阶段保持口径闭合）。

---

## 九、Git 审计

改动后审计：

- `git diff --check` → 无空白/冲突标记问题
- `git diff --stat` → 仅 `src/main/services/planService.ts`、`src/shared/types.ts` 两个已跟踪文件被修改
- `git status` → 已跟踪改动仅上述 2 个文件；未跟踪为本阶段产出的 `tests/planHardening.test.ts` 与 `docs/*` 报告/SPEC
- **未修改**：任何 `cordis.patch.yml`、DSH 配置、凭据、系统环境变量、其他 Agent 配置；未新增依赖；未改动 IPC/Preload/Renderer
- **未混入**用户未提交文件（工作区无用户改动）

安全边界复核：本阶段**真实模型调用次数 = 0**；未开启真实调用总开关；未自动重试；未自动恢复重跑；未删除任何数据库/日志/会话。

---

## 十、需要你亲自完成的操作步骤（GUI 验收清单）

请在真实应用中依次操作（全程不要开启「真实模型调用总开关」，无需任何真实调用）：

1. `npm run dev` 启动应用，确认窗口正常打开、任务中心无报错。
2. 在「任务中心 → 主管计划」区域输入一个总目标（例如「为新品写一份市场分析」），点击**生成计划**。
3. 核对计划预览是否显示每个子任务的**标题 / 类型 / 依赖关系 / 执行 Agent / 验收标准**，且页面出现 **「Mock 演示结果」**标识。
4. **不要点击确认**，等待数秒，确认**没有任何子任务被执行**（状态仍为待执行、无结果）。
5. 点击**确认执行**：
   - 观察子任务是否**按依赖顺序依次执行**（资料收集 → 分析 → 成文 → 审查）；
   - 查看每个子任务的**状态 / 执行结果 / 错误信息**是否可读。
6. 待计划结束，查看**汇总报告**（总目标、计划状态、成功/失败/阻断数量、各子任务最终状态与原因摘要、完成时间、Mock 标识）。
7. **刷新页面**并**重启应用**，确认历史计划与子任务状态仍然存在、可再次打开。
8. 重复点击**确认执行**（或对同一计划再次确认），确认被拒绝且**不会重复执行**。
9. （可选）用一个会让首个子任务失败的场景（Mock 失败注入）验证下游被阻断、计划为失败/部分完成。
10. 若曾异常关闭应用，重启后确认提示「上次运行被中断……需要人工检查」，且**不会自动重跑**。

---

## 结论

主管 Agent 的 Mock 调度链路已通过**逻辑层加固与自动化验收**：依赖阻断递归、防重复/并发确认、超时取消阻断、异常计划安全终止、重启恢复不重跑、汇总口径闭合均已验证，`typecheck / test（82）/ build` 全通过。

**但 GUI 全链路仍需你亲自操作确认（第二节第 2–10 项）**，之后方可判定「具备进入下一阶段（接入第一个真实 Agent）的技术门槛」。
本阶段结束时停止，未进入真实多 Agent 接入，未执行任何真实模型调用。

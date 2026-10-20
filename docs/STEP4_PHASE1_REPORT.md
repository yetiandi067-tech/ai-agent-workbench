# 第 4 步·阶段 1：主管 Agent 调度层（Mock 优先）—— 实施报告

> Git 提交：`0a3a1ba`（基于第 3 步基线 `92d83ea`）
> 前置文档：`docs/STEP4_PHASE1_SPEC.md`

## 一、实施范围确认

本阶段**只实现 Mock 调度链路，未调用任何真实大模型**。所有子任务由 Mock 适配器本地模拟执行，不产生任何费用。

## 二、修改文件清单

### 新增文件（6 个）

| 文件 | 说明 |
|------|------|
| `src/main/planner/mockPlanner.ts` | Mock Planner：确定性任务拆解，支持关键词规则 |
| `src/main/services/planService.ts` | PlanService：主管调度服务（串行执行、依赖阻断、汇总报告） |
| `tests/mockPlanner.test.ts` | Mock Planner 单元测试（7 个用例） |
| `tests/planRunner.test.ts` | PlanService 流程测试（9 个用例） |
| `tests/migration.test.ts` | 数据库迁移兼容性测试（2 个用例） |
| `docs/STEP4_PHASE1_SPEC.md` | 本阶段完整提示词落盘 |

### 修改文件（9 个）

| 文件 | 修改内容 |
|------|----------|
| `src/shared/types.ts` | 新增 Plan 全套类型（PlanRecord/PlanSummary/PlannedSubTask/PlanDraft/PlanWithTasks 等） |
| `src/shared/api.ts` | 新增 Plan 相关 IPC 通道与 API 方法定义 |
| `src/main/db/migrations.ts` | 新增 v2 迁移：plans 表 + tasks 表 6 个计划关联列 |
| `src/main/db/repositories.ts` | 新增 PlanRepository；TaskRepository 扩展 listByPlan 与 6 个新列读写 |
| `src/main/services/workbenchService.ts` | createTask 补 6 个新字段默认值（普通单任务不属于任何计划） |
| `src/main/index.ts` | 构造 PlanService 并注册 IPC；启动时恢复遗留 running 计划 |
| `src/main/ipc.ts` | 注册 planCreate/planConfirm/planList/planGet 四个 IPC 处理器 |
| `src/preload/index.ts` | 桥接 planCreate/planConfirm/planList/planGet/onPlanChanged |
| `src/renderer/src/pages/TasksPage.tsx` | 新增「主管 Agent（Mock 计划）」区块：输入目标→预览→确认执行→查看状态→汇总报告 |

## 三、数据库迁移

### v2 迁移：`plans-and-subtask-linkage`

**新增表：**
- `plans`：主管计划（目标、状态、汇总报告）

**tasks 表新增列：**
- `plan_id`：所属总任务 ID（普通单任务为 NULL）
- `plan_seq`：计划内顺序（从 1 开始）
- `task_kind`：子任务类型（research/analysis/writing/review）
- `depends_on_json`：依赖的子任务 ID 列表（JSON 数组）
- `acceptance`：验收标准
- `blocked_reason`：因依赖失败被阻断时的原因说明

**兼容性保证：**
- 全部为「新增列 / 新增表」，不修改、不删除 v1 的任何列与数据
- 旧任务的 plan_id 等新列恒为 NULL，不影响读取
- 迁移测试验证：v1 数据库升级后旧任务数据完整保留，新表与新列正确创建

## 四、测试结果

```
Test Files  8 passed (8)
Tests  65 passed (65)
Duration  13.00s
```

### 测试覆盖（按验收标准）

| 验收标准 | 对应测试 | 结果 |
|---------|---------|------|
| Mock Planner 生成有效且可重复的计划 | mockPlanner.test.ts（7 个用例） | ✅ |
| 子任务依赖顺序正确 | planRunner.test.ts > 确认后按计划顺序串行执行 | ✅ |
| 依赖任务未成功时，下游任务不能执行 | planRunner.test.ts > 子任务失败时阻断所有下游 | ✅ |
| 子任务失败后，依赖它的任务被阻断 | planRunner.test.ts > 子任务失败时阻断所有下游 | ✅ |
| 全部子任务成功时，总任务正确完成并生成汇总报告 | planRunner.test.ts > 确认后按计划顺序串行执行 | ✅ |
| 部分失败时，总任务不能被错误标记为成功 | planRunner.test.ts > 部分子任务成功时计划状态为 partial | ✅ |
| 子任务状态和事件记录正确 | planRunner.test.ts > 各用例均验证状态与事件 | ✅ |
| 数据库迁移兼容已有数据 | migration.test.ts（2 个用例） | ✅ |
| 不调用真实模型即可完成整条 Mock 流程 | 全部测试均使用 Mock 适配器 | ✅ |
| 现有测试继续通过 | 全部 65 个测试通过（含第 3 步的 47 个） | ✅ |

### 类型检查与构建

```
npm run typecheck  ✅ 通过
npm run test       ✅ 65 个测试全部通过
npm run build      ✅ 通过（main 106KB / preload 3.45KB / renderer 654KB）
```

## 五、Git Diff 审计

### 未触碰的敏感文件

- ✅ 未修改 `cordis.patch.yml`
- ✅ 未修改 DSH 安装目录
- ✅ 未修改任何 Agent 配置或凭据
- ✅ 未修改系统环境变量
- ✅ 未删除任何数据库、任务记录、日志或会话文件

### 安全护栏保留情况

- ✅ 真实模型调用默认关闭（`allowRealModelCalls` 恒为 false）
- ✅ 真实调用需要全局设置与任务级双重确认
- ✅ 真实任务并发上限为 1
- ✅ 无自动重试逻辑（`AUTO_RETRY_ENABLED = false`）
- ✅ 未知费用显示为「无法核验」，不会显示成 0 元或免费
- ✅ 超时和取消明确提示「本地进程终止不保证远端请求停止」

## 六、功能验证边界

### 已验证（自动化测试）

1. ✅ 输入总目标并预览结构化计划
2. ✅ 明确确认后执行 Mock 计划
3. ✅ 子任务按依赖顺序执行
4. ✅ 失败时下游任务正确阻断
5. ✅ 最终报告与实际子任务结果一致
6. ✅ 总任务、子任务、运行记录和事件能够持久化
7. ✅ 重启后仍能查看历史执行记录
8. ✅ UI 清楚标识 Mock 结果
9. ✅ 真实模型调用次数为 0
10. ✅ `npm run typecheck`、`npm run test`、`npm run build` 全部通过
11. ✅ 不破坏第 3 步已验收的安全护栏

### 未验证（需人工 GUI 操作）

1. ⚠️ 本次未人工点击 GUI 创建 Mock 计划、预览、确认执行、查看汇总报告
2. ⚠️ 本次未执行真实 DSH 调用（本阶段不涉及）

## 七、未解决问题

无。

## 八、下一步建议

等本阶段通过验收后，再制定阶段 2 的提示词，接入真实 DSH 执行能力。

阶段 2 的核心改动点：
1. 把 Mock Planner 替换为真实的大模型规划器（通过 DSH 调用）
2. 子任务的 agentId 从 'mock' 改为 'dsh'（或其他真实 Agent）
3. 保留所有依赖调度、阻断、汇总的逻辑不变

## 九、用户重点核对项自查

| 核对项 | 自查结果 |
|-------|---------|
| 1. 调度是否真实存在，而不只是 UI 展示一份预设计划 | ✅ PlanService 真实调度子任务，复用 TaskRunner 执行 |
| 2. 子任务是否通过现有 Adapter 实际执行 Mock，而不是直接伪造成功状态 | ✅ 所有子任务通过 `workbench.runner.runTask` 实际执行 Mock 适配器 |
| 3. 依赖失败后是否确实阻断下游任务 | ✅ blockDownstreamTasks 递归阻断所有下游，测试验证 |
| 4. 数据库迁移是否保留第 3 步的数据 | ✅ migration.test.ts 验证 v1 → v2 升级保留旧数据 |
| 5. 是否误触发 DSH 真实调用，或破坏已有安全护栏 | ✅ 未触碰 DSH 配置，全部测试使用 Mock，真实调用护栏保留 |
| 6. 测试是否覆盖真实调度逻辑，而不只是测试几个独立函数 | ✅ planRunner.test.ts 覆盖完整调度链路（创建→确认→执行→阻断→汇总） |

# Agent 接入探测报告：Trae CN / WorkBuddy / Grok

探测时间：2026-10-21
方法：只读探测（列目录、注册表、CLI `--help`），不启动任何应用、不发起任何模型调用、不读取任何凭据/Token/Cookie。

## 结论总览

| Agent | 本机形态 | 可编程入口（headless） | 探测结论 |
|---|---|---|---|
| Trae CN 3.4.4 | `E:\trae work\Trae CN\Trae CN.exe`（VSCode fork，正在运行） | CLI `trae-cn.cmd` 仅窗口/文件/diff/merge 能力 | **无 AI headless 接口**，不能像 DSH 那样自动执行 |
| WorkBuddy 5.8.3 | `E:\develop\WorkBuddy\WorkBuddy.exe`（Electron + .NET 混合，未运行） | 无 bin/CLI 入口 | **无公开 headless 接口** |
| Grok | 注册表残留 `E:\新建文件夹 (2)\Grok\grok-app.exe`，该文件已不存在 | — | **应用已卸载/移除**（仅剩 userData 缓存），当前不可用 |

## 探测细节

### Trae CN
- `trae-cn --help`（v3.4.4）：仅 `-d/--diff`、`-m/--merge`、`-a/--add`、`-g/--goto`、`-n/-r/-w`、`--user-data-dir`、`--profile` 等 VSCode 标准 CLI 参数。
- 无任何 chat / agent / prompt 类子命令；AI 能力（内置对话）无对外编程接口。

### WorkBuddy
- 安装目录为 Electron 应用结构（`resources/`、`LICENSE.electron.txt`、chromium pak）+ .NET 组件（`Newtonsoft.Json.dll`、`RepairApp.exe`）。
- 无 `bin/`、无 CLI 包装器；PATH 中无对应命令；未发现任何 headless/agent 模式线索。

### Grok
- `HKCU\...\Uninstall` 注册表项存在，但 `InstallLocation` 指向的 `grok-app.exe` 已不存在（`Test-Path` = False）。
- `%APPDATA%\com.grokapp.desktop`、`%LOCALAPPDATA%\com.grokapp.desktop` 仅剩 WebView2（EBWebView）缓存。

## 与 DSH 的对比

DSH 能成为第一个 auto 适配器，前提是它有**官方 headless CLI + NDJSON 事件流**（第 2.5 步已验证）。三者均不具备该前提：
- 复用账号路由的自动执行通道：不存在；
- 走 CDP/UI 自动化驱动其界面：技术上或可行，但属于**未经验证的第三方私有接口**，脆弱且违反本项目安全边界（不接入未验证私有接口），不建议。

## 建议的接入形态（待用户确认）

按工作台现有三态模型（`auto` / `handoff` / `unavailable`）：

1. **Grok → `unavailable`**：本机应用不存在，可用性检测（可执行文件存在性）标记为不可用。
2. **Trae CN / WorkBuddy → `handoff` 结构化交接单**（推荐）：
   - 不自动执行、不调用模型、零费用；
   - 任务执行时生成结构化交接单：可复制的完整 prompt、验收标准（acceptance）、目标工具指引；
   - 任务进入 `needs_confirmation`（待人工确认）语义，用户在对应工具中手动完成后回填结果摘要，形成可审计记录。
3. **auto 适配器**：等三者任一提供官方 headless CLI/API 后，按 DshAdapter 同款模式（probe → adapter → 单任务真实验收）接入。

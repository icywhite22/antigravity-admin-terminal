# Antigravity Admin Terminal (`antigravity-admin-terminal`)

一个零 npm 包依赖（纯 Node.js 原生模块实现）的 **Google Antigravity** 插件与 MCP Server，依赖系统工具 [`gsudo`](https://github.com/gerardog/gsudo)，用于在**保持普通用户启动与内置沙箱隔离**的前提下，按需触发原生 Windows UAC 弹窗执行管理员权限命令，并在常驻 MCP 进程上复用 UAC 提权缓存。

A zero-npm-dependency plugin and MCP server for **Google Antigravity** on Windows (built solely on Node.js built-ins; requires `gsudo`) that enables on-demand UAC-elevated terminal execution—without running the whole Antigravity IDE as Administrator or disabling built-in terminal sandboxing.

---

## 为什么需要它？ / Why?

在 Windows 上以普通用户启动 Antigravity 时，内置终端工具 `run_command` 进程通常运行在 **`exebox-...` 隔离桌面（Desktop Isolation）** 下。由于 Windows 不允许从非交互隔离桌面通过 `ShellExecuteEx("runas")` 发起 UAC 提权，直接在内置终端里运行 `gsudo` 或 Windows 11 原生 `sudo` 会报错：

```text
System.ComponentModel.Win32Exception (50): ERROR_NOT_SUPPORTED
```

而如果为了管理员权限直接右键“以管理员身份运行”整个 Antigravity，又会让所有子进程长期处于高完整性级别（`High Mandatory Level`），失去终端沙箱保护。

本插件通过 **Stdio MCP Server** 解决这个矛盾：
* **日常命令继续走内置 `run_command`**：保留 Antigravity 原生终端沙箱与隔离桌面保护。
* **提权命令走插件 `run_admin_command`**：Stdio MCP 进程运行在交互桌面 `WinSta0\Default` 上，可正常触发系统 UAC 弹窗。
* **一次确认、缓存期内免重复弹窗**：MCP Server 是常驻进程（PID 固定），配合 `gsudo` 的 `CacheMode = Auto`，首次点击 UAC 后，在缓存时间窗口内后续提权命令可直接复用，无需关闭沙箱或重启软件。
* **自带 Streamable HTTP 兜底**：如果你的环境把 Stdio MCP 也隔离进了 `exebox-...`，可使用内置的 `--http` 桥接模式在外部桌面监听 `127.0.0.1:39881/mcp`。

---

## 环境依赖 / Prerequisites

* **OS**: Windows 10 / Windows 11
* **Runtime**: Node.js >= 20
* **Elevation**: [`gsudo`](https://github.com/gerardog/gsudo)（推荐开启 `Auto` 缓存模式）

安装并配置 `gsudo`：

```powershell
winget install --id gerardog.gsudo -e
gsudo config CacheMode Auto
gsudo config CacheDuration 00:15:00
```

> **提示**：启用 `CacheMode Auto` 后，该常驻 MCP 进程 PID 在空闲超时（如 15 分钟）前可复用已通过的 UAC 凭据缓存。请按需配置合理的缓存时长，并在敏感操作完成后随时调用 `revoke_admin_cache`（即 `gsudo -k`）立即失效缓存。

---

## 快速安装 / Installation

1. 克隆本仓库到本地目录：

```powershell
git clone https://github.com/icywhite22/antigravity-admin-terminal.git
cd antigravity-admin-terminal
```

2. 运行一键安装脚本（会自动写入本机 `node.exe` 与 `src/server.mjs` 绝对路径到 `~/.gemini/config/plugins/antigravity-admin-terminal/`）：

```powershell
.\scripts\install-plugin.ps1
```

*(若需卸载：`.\scripts\install-plugin.ps1 -Uninstall`；若需切换到外部 HTTP 桥接模式：`.\scripts\install-plugin.ps1 -Http` 后运行 `.\scripts\start-http-bridge.ps1`)*

3. 在 Antigravity 界面中打开 **Additional Options (`...`) > MCP Servers** 点击刷新（或新开一个对话），即可看到挂载成功的工具。

*(仓库内 `plugin/mcp_config.json` 为通用占位模板；如果你选择手动复制 `plugin/` 目录到 `~/.gemini/config/plugins/antigravity-admin-terminal/`，请自行把其中的示例路径替换为实际绝对路径。)*

---

## 提供给 Agent 的 MCP 工具 / Exposed Tools

| Tool | Purpose |
| :--- | :--- |
| `admin_terminal_status` | 只读检查当前 MCP 进程所在桌面（`WinSta0\Default` vs `exebox-...`）、`gsudo` 可用性与缓存状态 |
| `run_admin_command` | 通过 `gsudo` 提权执行 `pwsh` / `powershell` / `cmd` 命令（需附带审计字段 `reason`，拒绝 UNC 工作目录，UTF-8 输出，支持超时控制） |
| `revoke_admin_cache` | 立即执行 `gsudo -k`，终止所有活跃的提权凭据缓存 |

配套插件规则文件 [plugin/rules/AGENTS.md](plugin/rules/AGENTS.md) 会引导 Agent：日常任务优先使用内置沙箱 `run_command`，仅在确实需要管理员权限时调用 `run_admin_command`。

---

## 目录结构 / Structure

```text
antigravity-admin-terminal/
├── LICENSE
├── README.md
├── package.json
├── plugin/
│   ├── plugin.json            # Antigravity 插件清单
│   ├── mcp_config.json        # 通用占位示例配置（安装脚本会自动生成本机配置）
│   └── rules/
│       └── AGENTS.md          # 插件激活时生效的 Agent 行为约束
├── scripts/
│   ├── install-plugin.ps1     # 一键安装 / 卸载脚本
│   └── start-http-bridge.ps1  # 备用：外部交互桌面的 Streamable HTTP 桥接启动脚本
├── src/
│   ├── server.mjs             # 纯 Node.js 原生 MCP Server（支持 Stdio 与 --http Streamable HTTP）
│   ├── gsudo.mjs              # gsudo 探测、状态检查、提权执行与缓存回收
│   └── desktop-diag.mjs       # WinSta / Desktop / Job 隔离状态诊断
└── test/
    └── mcp-smoke.test.mjs     # 自动化单元测试与协议冒烟测试
```

---

## 测试 / Tests

```powershell
npm test
```

---

## 安全与免责声明 / Security & Disclaimer

* 本工具仅用于在**本机受信任环境**下按需触发标准 Windows UAC 提权，不绕过 UAC 交互授权。
* 不要将不可信的外部输入直接传入 `run_admin_command`。
* 在启用 `gsudo` 缓存期间（`CacheMode Auto`），同一父进程 PID 发起的后续 `gsudo` 调用不会再次弹出 UAC；敏感运维操作结束后请及时调用 `revoke_admin_cache`（或在外部终端执行 `gsudo -k`）。
* 使用 Streamable HTTP 模式时，服务端仅绑定 `127.0.0.1`，并校验 `Host` 与拦截携带 `Origin` 头的浏览器跨站请求。
* 本项目采用 [MIT License](LICENSE) 开源，请自行评估风险后使用。

---

## 作者 / Authors

* **icywhite22**
* **Gemini** (Co-author)

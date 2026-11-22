<div align="center">

<h1>antigravity-codex-theme</h1>

<p><strong>Google Antigravity 的 Codex 风格昼夜主题、中文界面与实时会话统计插件</strong></p>

<p>
  <a href="#快速安装">快速安装</a> ·
  <a href="#按需安装">按需安装</a> ·
  <a href="#功能详解">功能详解</a> ·
  <a href="#自定义与卸载">自定义与卸载</a> ·
  <a href="#致谢与协议">致谢与协议</a> ·
  <a href="#english-overview">English</a>
</p>

<p>
  不修改安装包，通过本地 CDP 实时注入 Codex 昼夜主题、中文界面、四态会话指示与每轮 Token 统计。<br>
  核心代码拆分为 28 个独立模块，支持 <code>--only</code> 按需安装与 Fork 自由定制。
</p>

<p>
  <a href="https://github.com/nkjDSLcvanv/antigravity-codex-theme/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/nkjDSLcvanv/antigravity-codex-theme/ci.yml?branch=main&label=CI&labelColor=363636&logo=githubactions&logoColor=white" alt="CI"></a>
  <img src="https://img.shields.io/static/v1?label=Antigravity&message=2.30.x%20~%202.34.0%2B&color=2B7FFF&labelColor=363636" alt="Antigravity 2.30.x ~ 2.34.0+">
  <img src="https://img.shields.io/static/v1?label=Node.js&message=%3E%3D%2022.13.0&color=339933&labelColor=363636&logo=nodedotjs&logoColor=white" alt="Node.js >= 22.13.0">
  <img src="https://img.shields.io/static/v1?label=platform&message=macOS%20%C2%B7%20Windows%20%C2%B7%20Linux&color=4B5563&labelColor=363636" alt="macOS · Windows · Linux">
  <img src="https://img.shields.io/static/v1?label=version&message=v1.2.1&color=2B7FFF&labelColor=363636" alt="version v1.2.1">
  <a href="LICENSE"><img src="https://img.shields.io/static/v1?label=license&message=MIT&color=10B981&labelColor=363636" alt="MIT License"></a>
</p>

<p>
  <a href="#命令行安装"><img src="https://img.shields.io/static/v1?label=CLI%20INSTALL&message=v1.2.1&color=2B7FFF&style=for-the-badge&labelColor=181818&logo=gnubash&logoColor=white" alt="CLI Install"></a>
  <a href="#ai-一键安装"><img src="https://img.shields.io/static/v1?label=AI%20ONE-CLICK&message=SKILL.md&color=0D9488&style=for-the-badge&labelColor=181818&logo=googlegemini&logoColor=white" alt="AI One-Click Install"></a>
  <a href="#按需安装"><img src="https://img.shields.io/static/v1?label=SELECTIVE%20INSTALL&message=--only&color=6366F1&style=for-the-badge&labelColor=181818&logo=codesandbox&logoColor=white" alt="Selective Install"></a>
</p>

</div>

https://github.com/user-attachments/assets/e42ae3d6-c261-442c-bc6d-3c14ff830664

![Codex 浅色与深色模式对比](assets/light-dark-themes.png)

- 提供浅色 (`codex-pure-white`) 与深色 (`codex-dark`) 两套配色，无外部字体依赖，随 IDE 明暗外观自动切换。
- 底部工具栏实时指示会话状态与用量摘要，支持展开两级明细面板；每轮回复末尾附带 Token 统计，悬停约 `80ms` 显示详情拆解卡，并同步支持右侧旁路提问（Side Question）与 **SSH Remote 远端会话**（[查看配置](#ssh-remote-远端会话统计)）。
- 内置 `1,900+` 条中文界面词条；5 个核心模块相互独立，可通过 `--only` 按需安装。

![一级概览、二级详情、上下文预警及每轮对话尾部统计](assets/telemetry-bento-panels.png)

## 快速安装

> 前置要求：**Node.js >= 22.13.0**（与 [package.json](package.json) 一致）与 Google Antigravity（`2.30.x` 至 `2.34.0+`），已在 **macOS / Windows / Linux 桌面端**完成实机安装与卸载验证。安装仅部署至 `~/.gemini/antigravity/codex-theme`、配置本地调试端口并注册后台自启，**不修改安装包本体**；若安装前应用已在无调试端口状态下运行，重启一次或在外部终端执行 `node install.mjs relaunch` 即可生效。

<details>
<summary>查看各平台实测细节与 Antigravity 2.33.0+ 调试端口说明</summary>

- **实机验证范围**：已在 macOS、Windows 与 Linux 桌面端完成安装、实时注入与卸载还原测试（覆盖 Antigravity `2.31.0` / `2.32.1` / `2.33.0` / `2.34.0`、macOS `LaunchAgent`、Windows `schtasks` / VBS / 注册表与 `.lnk` 参数配置、Linux `systemd --user` 与 `.desktop` 启动项）；GitHub Actions CI 在 `ubuntu-latest` 上持续执行 `npm run check` 与 `npm test`。
- **Antigravity `2.33.0+` 适配**：新版本默认关闭本地 `DevToolsActivePort`，需携带 `--remote-debugging-port=0` 启动。macOS 默认采用单图标模式，后台守护进程仅在冷启动前 `12s`（自动更新重启时 `25s`）内补参接力重启，不中断已在运行中的会话；Windows 与 Linux 则为快捷方式或 `.desktop` 启动项追加该参数，并保留 `~/.antigravity/argv.json` 兼容写入。

</details>

### 命令行安装

```bash
git clone https://github.com/nkjDSLcvanv/antigravity-codex-theme.git
cd antigravity-codex-theme
node install.mjs install
node --disable-warning=ExperimentalWarning install.mjs doctor
```

### AI 一键安装

将以下提示词发送给 AI 助手（Antigravity / Claude Code / Codex / Cursor 等），自动完成拉取、部署与状态校验：

> 请读取 `https://github.com/nkjDSLcvanv/antigravity-codex-theme.git`，使用 `git clone --depth=1 --filter=blob:none --sparse` 拉取核心文件（参考仓库内的 `SKILL.md`，跳过 `assets/` 和 `tests/`；如需只装部分功能可追加 `--only` 参数），运行 `node install.mjs install`、`node --disable-warning=ExperimentalWarning install.mjs doctor` 和 `verify` 完成安装并确认实时注入正常。

### 按需安装

支持通过 `--only` 从 `theme`、`i18n`、`metrics`、`quota`、`fixes` 五个独立模块中按需组合：

```bash
# 示例：仅启用中文界面与实时统计，保留 Antigravity 原生配色
node install.mjs install --only i18n,metrics
```

<details>
<summary>查看模块说明与精简拉取命令（跳过截图或单模块下载）</summary>

| 模块 | 说明 |
| :--- | :--- |
| `theme` | Codex 浅色 (`codex-pure-white`) 与深色 (`codex-dark`) 昼夜主题 |
| `i18n` | 中文界面本地化（`1,900+` 条词条，`WeakMap` 原地更新） |
| `metrics` | 实时会话状态指示、一/二级用量统计面板与每轮对话尾部统计（含旁路提问面板及可选 SSH Remote 远端只读统计） |
| `quota` | 侧栏底部实时模型配额卡片（展示当前模型池 `5h` / `每周` 双限额进度条、重置倒计时与悬停明细浮层） |
| `fixes` | 设置弹窗路由死锁修复与 `Cmd/Ctrl + -/=/0` 界面缩放快捷键 |

**1. 跳过 `assets/` 与 `tests/`，仅拉取运行核心文件（全平台通用）：**

```bash
git clone --depth=1 --filter=blob:none --sparse https://github.com/nkjDSLcvanv/antigravity-codex-theme.git
cd antigravity-codex-theme
git sparse-checkout set core user
node install.mjs install --only i18n,metrics
```

**2. 仅下载目标模块对应文件（`--no-cone` 单模块拉取，适用于 macOS / Linux / Git Bash）：**

```bash
# 示例：仅下载并安装中文界面模块 (i18n)
git clone --depth=1 --filter=blob:none --sparse https://github.com/nkjDSLcvanv/antigravity-codex-theme.git
cd antigravity-codex-theme
git sparse-checkout set --no-cone \
  /install.mjs /package.json /SKILL.md /LICENSE \
  /user/config.json /user/custom.css /user/custom.js /user/i18n.override.json \
  /core/daemon.mjs /core/shared.mjs /core/manifest.json /core/installer \
  /core/daemon/paths.mjs /core/daemon/cdp-bridge.mjs /core/daemon/cdp-relaunch.mjs \
  /core/runtime/00-head.js /core/runtime/90-tail.js \
  /core/i18n.json /core/runtime/60-i18n-engine.js
node install.mjs install --only i18n --minimal
```

若已执行 `git sparse-checkout set core user`，可通过 `node install.mjs sparse-paths --only theme,metrics` 查询任意模块组合对应的文件列表。

</details>

<details>
<summary>常用运维、回滚与测试命令</summary>

| 命令 | 用途 |
| :--- | :--- |
| `node install.mjs install [--channel auto\|stable\|insiders] [--only <features>] [--minimal] [--with-launcher] [--sync-user]` | 部署或升级插件并注册后台自启服务 |
| `node install.mjs relaunch [--channel auto\|stable\|insiders] [--force]` | 携带 `--remote-debugging-port=0` 重启 Antigravity 并完成注入校验（含 15s 活跃会话保护） |
| `node --disable-warning=ExperimentalWarning install.mjs doctor` | 检查 Node 版本、Antigravity 版本与 CDP 状态、`core/manifest.json` 哈希及页面挂载结果 |
| `node --disable-warning=ExperimentalWarning install.mjs verify [--safe-mode]` | 执行单次注入并校验挂载状态；`--safe-mode` 可跳过 `user/` 自定义脚本排障 |
| `node install.mjs sparse-paths --only <features>` | 输出指定模块组合的文件路径列表 |
| `node install.mjs rollback` | 回滚至上一份备份的 `core/` 版本 |
| `node install.mjs uninstall` | 停止服务、清理自启项与启动参数，并恢复默认英文界面与原生样式 |
| `npm run check` | 对所有 `.mjs` 脚本与拼接后的 `core/runtime/*.js` 执行语法检查 |
| `npm test` | 运行 `tests/*.test.mjs` 单元测试（协议解析、状态机、模块打包、`2.33.0` 重启门禁与仓库校验） |

</details>

## 功能详解

### 实时会话状态与用量统计

在输入框底部工具栏中部（模型选择器与权限/发送按钮之间）嵌入紧凑的会话状态指示与摘要栏，悬停时显示 `会话状态：...` 提示：

```text
● 248 tok/s · Ctx 42% · Cache 90.9%
```

| 会话状态 | 圆点样式 | 触发条件 |
| :--- | :--- | :--- |
| 就绪 | **蓝色常亮** | 会话连接正常且处于空闲状态；主动取消生成后立即恢复 |
| 执行中 | **蓝色闪烁** | 模型流式生成、`/compact` 压缩或工具调用正在进行 |
| 等待或重试 | **黄色脉冲** | 首字或单步等待超过 `60s`（如切换模型后 `/compact` 重算 KV 缓存）、模型不可用自动重试，或建连耗时 `3s ~ 11s` |
| 连接或执行异常 | **红色脉冲** | 网络离线、建连超时 `>= 12s`、API 或步骤报错（不含主动取消），或后台统计进程心跳超时 `>= 90s` |

![会话状态：就绪、执行中、等待或重试、连接或执行异常](assets/led-status-states.png)

<p align="center"><em>会话状态：就绪、执行中、等待或重试、连接或执行异常</em></p>

#### 用量面板与上下文预警

- 悬停在状态栏上可预览一级面板，单击可固定展开，展示最近一次调用的生成速度（`tok/s` 与端到端均值）、上下文占比与剩余容量、累计缓存命中率、当前上下文分段条（新增 / 写缓存 / 读缓存 / 剩余）以及等待或异常原因。
- 再次点击状态栏（或点击面板内的「展开明细」）可展开二级面板，补充首字延迟（TTFT）、流式耗时、思考与正文输出拆分、本轮多步汇总及会话累计输入输出；点击空白处、按 `Esc` 或第三次点击状态栏即可收起。
- 上下文占比达到 `>= 75%` 时转为黄色预警，`>= 90%` 时转为红色提示；执行 `/compact` 期间实时显示压缩进度（跨模型切换压缩时提示 KV 缓存重算），完成后以绿色标记展示摘要大小（面板效果见文首总览图）。

#### 状态栏自适应布局

底部状态栏支持三种显示形态，可通过 [user/config.json](user/config.json) 中的 `telemetryLayout` 切换：

- `compact`（默认）：在工具栏居中显示核心指标（`tok/s`、`Ctx`、`Cache`）。
- `detailed`：补充展示首字延迟（`TTFT`）、精确上下文与本步输出（`Out`）。
- 窄侧栏自适应：工具栏宽度不足时自动移至输入框底部独立虚线行，不遮挡模型选择器与发送按钮。

![白日模式下状态栏三种自适应布局](assets/telemetry-layouts.png)

<p align="center"><em>状态栏三种自适应布局：默认紧凑、详细模式与窄侧栏自动换行</em></p>

#### 每轮对话尾部统计

每条助手回复底部的操作栏左侧附带当轮统计摘要，包含模型名称、输入输出 Token、缓存命中率与生成速度。鼠标悬停约 `80ms` 弹出详情卡，展示当轮步数、精确上下文占比、思考与正文/工具输出拆分、新增与读缓存输入，以及流式与总耗时：

![每轮对话尾部统计悬浮详情卡](assets/turn-hover-card.png)

<p align="center"><em>每轮助手回复尾部统计与悬浮详情卡</em></p>

#### SSH Remote 远端会话统计

通过 SSH Remote 连接远端开发机使用 Antigravity 时，会话数据库位于远端主机，默认无法读取统计信息。开启 `sshRemote` 后，后台服务会通过 `ssh` 在远端以只读 `python3`（`sqlite3` `mode=ro`）直接读取最新 WAL 状态，**在远端剥离全部对话正文、Prompt 与 Checkpoint 摘要文本**，仅回传脱敏后的数值与状态元数据并在本地纯内存解析，不调用 `scp`，不在本地磁盘拷贝或残留任何 `.db` 文件。

该功能默认关闭且不扫描 `~/.ssh/config`。前置要求远端具备 `python3` 且本地可无密码 SSH 登录，在 `~/.gemini/antigravity/codex-theme/user/config.json` 中显式配置主机名后约 2.5 秒热重载生效：

```json
{
  "modules": {
    "sshRemote": true
  },
  "sshHosts": ["node032"]
}
```

### 中文界面汉化

内置 `1,900+` 条界面词条，覆盖 Antigravity `2.30.x` 至 `2.34.0+` 的设置面板（含 Orchestrator 设置与沙箱权限）、菜单、权限选项、侧边栏、旁路提问、插件管理与工具审批状态。通过 `WeakMap` 在原文本节点直接替换，不克隆节点，不影响 React 事件绑定。可通过 [user/i18n.override.json](user/i18n.override.json) 自定义或覆盖词条，也可在配置中关闭 `i18n` 恢复英文界面。

### Codex 昼夜主题与实用修复

- 浅色 (`codex-pure-white`)：`#FFFFFF` 画布、`#F9F9F9` 侧边栏、`#EFEFEF` 选中项、`#2B7FFF` 主按钮，搭配 `#F3F4F6` 外托盘与 `#FFFFFF` 内卡片的双层圆角输入框。
- 深色 (`codex-dark`)：采用 Codex 桌面端中性炭灰配色，包含 `#181818` 主背景、`#232323` 侧边栏、`#353535` 选中项、`#282828` 外托盘、`#363636` 输入卡片与 `#2C67C5` 主按钮。
- 实用修复：修复设置弹窗路由死锁，补充 macOS (`Cmd + -/=/0`) 与 Windows/Linux (`Ctrl + -/=/0`) 界面缩放快捷键，并支持 Antigravity `2.33.0+` 单图标冷启动自动接力。

## 自定义与卸载

日常调整配色、词条或功能开关只需修改 `user/` 目录下的配置文件；若需深度修改主题样式或统计面板，可直接 Fork 仓库并调整 `core/` 下的对应模块。

### 配置与热重载（`user/` 目录）

个人配置位于 `~/.gemini/antigravity/codex-theme/user/`，升级插件时不会被覆盖。保存后约 2.5 秒自动同步至已打开的 Antigravity 窗口，无需重启：

- [user/config.json](user/config.json)
  - `preset`：`"codex-pure-white"` 或 `"codex-dark"`
  - `themeVars`：按需覆盖 `--background`、`--sidebar`、`--primary`、`--ag-composer-*`、`--ag-dark-*` 等 CSS 变量
  - `telemetryLayout`：`"compact"`（默认紧凑样式）或 `"detailed"`（显示 `TTFT`、精确上下文与 `Out`）
  - `telemetryCacheMode`：`"session"`（会话累计命中率）或 `"step"`（单步命中率）
  - `modules`：独立控制 `theme`、`i18n`、`metrics`、`sshRemote`、`deadlockHealer`、`zoomShortcuts`、`cdpAutoRelaunch`、`customCss`、`customJs` 开关
  - `sshHosts`（配合 `modules.sshRemote: true`，默认关闭）：显式指定远端 SSH 主机别名或地址（如 `["node032"]`），开启远端只读会话统计（详见 [SSH Remote 远端会话统计](#ssh-remote-远端会话统计)）
- [user/i18n.override.json](user/i18n.override.json)：追加或覆盖界面翻译词条。
- [user/custom.css](user/custom.css) 与 [user/custom.js](user/custom.js)：注入自定义样式与前端脚本钩子，支持热重载自动清理。

### 源码定制（`core/` 目录）

核心代码拆分为 28 个独立模块，配套 31 项 `node:test` 单元测试，可按职责定位修改：

| 定制方向 | 对应文件 |
| :--- | :--- |
| 替换浅色或深色主题样式 | [core/styles/10-light-codex.css](core/styles/10-light-codex.css)、[core/styles/20-dark-codex.css](core/styles/20-dark-codex.css)（公共布局位于 `00-base.css`） |
| 调整状态判定阈值或统计面板渲染 | [core/runtime/40-status-machine.js](core/runtime/40-status-machine.js)、[core/daemon/telemetry-renderer.mjs](core/daemon/telemetry-renderer.mjs)、[core/styles/30-telemetry.css](core/styles/30-telemetry.css) |
| 增删 `--only` 模块分组 | [core/installer/features.mjs](core/installer/features.mjs) |
| 修改词典或文本替换规则 | [core/i18n.json](core/i18n.json)、[core/runtime/60-i18n-engine.js](core/runtime/60-i18n-engine.js) |

修改 `core/` 后，执行以下命令即可更新文件哈希清单、完成语法与单元测试并部署至本机：

```bash
node install.mjs build-manifest && npm run check && npm test && node install.mjs install
```

<details>
<summary>查看仓库目录结构</summary>

```text
antigravity-codex-theme/
├── assets/                     # README 展示截图
├── core/
│   ├── daemon/                 # 后台同步服务（配置热加载 / Protobuf 解析 / 重试日志 / 面板渲染 / SQLite / SSH Remote 远端只读提取 / CDP / 2.33.0 冷启动接力）
│   ├── runtime/                # 按序拼接注入的前端脚本（生命周期 / 修复补丁 / 明暗同步 / 状态机 / 统计界面 / 汉化引擎）
│   ├── styles/                 # 样式模块（基础结构 / Codex 浅色 / Codex 深色 / 状态与统计面板）
│   ├── installer/              # 模块分组 / Manifest 校验与打包 / 环境探测 / 跨平台自启与 CDP 启动管理
│   ├── daemon.mjs              # 后台服务入口
│   ├── shared.mjs              # 公共工具函数
│   ├── i18n.json               # 1,900+ 界面词典
│   └── manifest.json           # core/ 文件 SHA-256 清单
├── tests/                      # 31 项 node:test 单元测试
├── user/                       # 个人配置与热重载目录
├── install.mjs                 # 安装、重启与运维 CLI
├── SKILL.md                    # AI Agent 操作说明
└── LICENSE                     # MIT License
```

</details>

### 卸载与保留说明

执行 `node install.mjs uninstall` 时的处理范围：

- **移除与还原**：停止后台同步进程，删除系统自启项（macOS `LaunchAgent` plist、Linux `systemd --user` unit、Windows 计划任务与启动脚本）及托管的 CDP 启动参数，并将已打开的 Antigravity 窗口恢复为默认英文界面与原生样式。
- **保留项**：保留个人配置目录 `~/.gemini/antigravity/codex-theme/user/`（`config.json`、`i18n.override.json`、`custom.css`、`custom.js`）、历史版本备份 `backups/` 与 `core.prev/`，以及安装时写入 `~/.antigravity/argv.json`（或 `~/.antigravity-insiders/argv.json`）中的 `"remote-debugging-port"` 字段。如需彻底清除，手动删除上述目录与配置字段即可。

## 致谢与协议

本项目早期在调研 Antigravity 的 CDP 运行时注入、`WeakMap` 原地文本替换、SQLite 增量读取及 `2.33.0` `--remote-debugging-port=0` 启动接力方案时，参考了 [Anarcadia/chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch)（MIT），特此致谢。

在此基础上，本项目对代码结构与核心功能进行了重写与扩展，主要区别包括：

- 将单文件实现重构为 `core/{daemon,runtime,styles,installer}` 下的 28 个独立模块，补充 31 项 `node:test` 单元测试与 GitHub Actions CI。
- 重新设计无外部字体依赖的 Codex 浅色 / 深色双主题与双层圆角输入框。
- 新增四态会话状态机（结合 React Fiber 状态探测、Language Server 重试日志与后台心跳监测）、可逐级展开的一/二级用量面板、每轮回复 `80ms` 悬浮详情卡，以及可选的 SSH Remote 远端只读统计。
- 支持 `--only` / `--without` / `--minimal` / `sparse-paths` 按需安装，分离 `user/` 热重载配置层与 `core/` 模块层以便二次定制。

本项目基于 [MIT License](LICENSE) 开源，欢迎自由 Fork 与定制。

## English Overview

`antigravity-codex-theme` provides Codex light and dark themes, Chinese UI localization, and live session telemetry for Google Antigravity (`2.30.x` to `2.34.0+`). The codebase is organized into 28 modules under `core/{daemon,runtime,styles,installer}` with 31 `node:test` unit tests, supporting hot-reloaded customization in `user/` as well as deeper modifications in `core/`.

- Light (`codex-pure-white`) and dark (`codex-dark`) themes with zero external font dependencies and automatic light/dark switching.
- A live bottom status bar tracking four session states (ready, running, waiting or retrying, error) via React Fiber probes, Language Server logs, and SQLite telemetry, paired with two-level usage panels and per-turn token stats with an `80ms` hover breakdown card across main conversations, Side Question panes, and opt-in SSH Remote sessions (`modules.sshRemote` + `sshHosts`, read-only remote Python extraction with zero local `.db` copy).
- Chinese UI localization (`1,900+` entries) applied in place through a `WeakMap` observer, customizable via `user/i18n.override.json`.
- Selective module installation via `--only` (`theme`, `i18n`, `metrics`, `quota`, `fixes`), Git sparse checkout, and `--minimal` pruning.
- Sidebar dual-window model quota card (`quota`) displaying live `5h` and `Weekly` remaining bars, reset countdowns, and a hover pool breakdown tooltip without opening Settings.
- Antigravity `2.33.0+` / `2.34.0+` support with a single-icon `--remote-debugging-port=0` cold-start relay (`cdpAutoRelaunch`) and `node install.mjs relaunch` with active-WAL protection. End-to-end installation and uninstall are verified across macOS, Windows, and Linux desktops (Antigravity `2.31.0`, `2.32.1`, `2.33.0`, and `2.34.0`; requires Node.js `>= 22.13.0`), alongside Ubuntu CI syntax checks and unit tests.

Early research drew inspiration from [Anarcadia/chuanban-antigravity-theme-patch](https://github.com/Anarcadia/chuanban-antigravity-theme-patch) (MIT) for CDP runtime injection, `WeakMap` localization, SQLite telemetry, and `2.33.0` opt-in launch handling. This repository rebuilds the architecture into modular components and adds the Codex light/dark themes, four-state session monitor, two-level usage panels, per-turn hover cards, and selective installs under the [MIT License](LICENSE).

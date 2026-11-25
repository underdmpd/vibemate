<div align="center">

# VibeMate

**哪台设备的哪个 AI 编码任务停了，它会一直告诉你——点一下就回到那个窗口。**

多设备 AI 编码任务悬浮提醒窗 · 汇总 Windows 本机、WSL 与 SSH Linux / 树莓派上的 **Codex CLI** 与 **GitHub Copilot CLI** 会话。

[![Agents](https://img.shields.io/badge/Agents-Codex%20CLI%20%7C%20Copilot%20CLI-2c7c65?style=flat-square)](#支持的环境与-agent)
[![Platform](https://img.shields.io/badge/Desktop-Windows%20x64%20%2F%20ARM64-0078D6?style=flat-square)](#安装与使用)
[![Remote](https://img.shields.io/badge/Remote-WSL%20%7C%20SSH%20Linux%20%7C%20Raspberry%20Pi-475569?style=flat-square)](#接入-linux--树莓派设备)
[![TypeScript](https://img.shields.io/badge/TypeScript-Node.js%2022%2B-3178C6?style=flat-square)](#从源码开发与打包)

</div>

---

## 为什么做 VibeMate

当你给 Agent 放开权限、同时在 Windows 本机、WSL、实验室 Linux 和树莓派上并行跑好几个编码任务时，真正的痛点不是“每步点确认”，而是：

> **Agent 停下来了，但你完全不知道——也不知道停在哪台设备的哪个终端里。**

VibeMate 把所有设备上的编码任务收敛成一枚轻量、不打扰的悬浮胶囊，只回答三件事：

1. **要不要我管？** —— 胶囊上有**设备名**，就是那台设备有事找你；只有**数字**，就是都在安心跑，不用管。
2. **发生了什么？** —— 一眼看到任务标题、停下时的最后一句话或具体故障原因，而不是一串内部状态码。
3. **去哪管？** —— 点击任务卡片，直接切回对应的 VS Code 窗口。

---

## 核心特性

### 1. 两态心智模型：**在跑** vs **轮到你**

| 用户态 | 界面表现 | 含义 |
| --- | --- | --- |
| **在跑** | 常驻模式 `◌ N 个在跑` / 安静模式静止小圆点 | Agent 正在工作，你什么都不用做 |
| **轮到你 · 完成** 🟢 | 胶囊持续挂起：`设备 · 任务标题  完成了  +N` | 当前轮次正常结束，附带 Agent 最后一句话 |
| **轮到你 · 故障** 🔴 | 优先置顶挂起，带具体错误摘要 | 仅报四类明确故障，绝不胡乱误报 |
| **轮到你 · 等确认** 🟡 | 边缘化保留 | 少数等待人工授权的场景 |

### 2. 零误报原则：故障只认四种

不做“N 分钟没动静就算卡住”——跑全量测试、编译或长思考时不会误报，只报告四类可明确判定的故障：

- **模型请求失败**：接口返回 400 / 报错导致任务中断（并对瞬时网络重试自动防抖）。
- **模型请求超时**：**仅在“等待模型返回”阶段计时**（默认 6 分钟），本地执行慢命令期间完全不计时。
- **进程没了**：同机 Receiver 定时检查 Agent 真实进程存活，进程崩溃或终端被关数秒内上报。
- **设备掉线**：远程连接断开满 **90 秒**才报，短暂网络抖动重连不打扰。

### 3. 两种不打扰模式

| 模式 | 任务都在跑时 | 有任务停下或出故障时 |
| --- | --- | --- |
| **常驻模式**（默认） | 显示 `◌ N 个在跑` | 完整胶囊常驻挂起，直到你处理 |
| **安静模式** | 缩成**静止的**半透明小圆点（无动画），悬停显示数量 | 立即弹回完整胶囊，完成一个弹一次 |

### 4. 一键回到对应窗口

鼠标悬停任务行显示 **回去 ↗**，点击后自动标记“已看”（主进程持久化，重启不重复冒出）并聚焦对应 VS Code 窗口：

- **Windows 本机**：`code <git根目录或工作目录>`
- **WSL**：`code --remote wsl+<发行版> <路径>`
- **SSH Linux / 树莓派**：`code --remote ssh-remote+<主机别名> <路径>`

### 5. 安全与隐私边界

- **权限链路故障安全**：默认仅监控，沿用 Agent 原生授权；即使按环境开启 Codex 桌面审批，任何超时、断线或服务退出都会回退原生流程，绝不自动 Allow 或自动 Deny。
- **最小化采集与脱敏**：不采集完整提示词、对话转录、文件内容或命令输出；仅采集经控制字符清理、密钥脱敏与严格限长的任务标题（≤60 字）与停下/错误摘要（≤120 字）。
- **SSH 凭证不落盘**：通过界面添加远程设备时使用内置 SSH 客户端，密码与密钥口令仅保存在当次运行内存中，不写入配置文件；首次连接强制核对主机指纹。

> **彩蛋**：内置桌宠作为隐藏彩蛋保留，不承担任何必需提醒职责；在设置页连续点击标题 5 次解锁。

---

## 支持的环境与 Agent

| 维度 | 支持范围 |
| --- | --- |
| **桌面端** | Windows 10 / 11（`x64`、`arm64`） |
| **被监控环境** | Windows 本机、WSL 发行版、独立 Linux / 树莓派（SSH，支持 `x64` 与 `arm64`） |
| **编码 Agent** | **Codex CLI**、**GitHub Copilot CLI** |

---

## 安装与使用

### 正式安装包（推荐）

无需在 Windows 本机或远程设备上预先安装 Node.js：

1. 下载并运行 Windows 安装包 `VibeMate-<version>-<arch>-setup.exe`。
2. 首次启动后，点击扫描 Windows 本机与 WSL，勾选需要监控的环境并确认授权。
3. 重启正在运行中的 Codex / Copilot 会话，让新注册的 Hook 生效。

### 接入 Linux / 树莓派设备

1. 在设置页点击 **添加设备**，填写设备名称、主机地址、SSH 端口与用户名（也可直接从已有 `~/.ssh/config` 别名扫描添加）。
2. 选择密码登录或私钥文件登录，点击 **测试连接** 并核对首次连接的主机指纹（测试为只读探针，不会修改远端文件）。
3. 点击 **安装并开始监控**，客户端会自动部署自带 Node 运行时、Receiver 与 Agent Hook。
4. 重启远端设备上的 Codex / Copilot 会话即可在桌面悬浮窗看到实时任务。

---

## 架构概览

```text
Windows / WSL / SSH Linux / 树莓派
  Codex CLI / Copilot CLI
        │  (原生生命周期 Hook)
        ▼
  hook-runner ──► loopback Receiver (127.0.0.1)
                       │  • 归一化事件 & 标题/摘要脱敏
                       │  • 进程存活 & 等模型超时监测
                       ▼  (WebSocket + Bearer Token / SSH 隧道)
                VibeMate Desktop (Electron)
                  ├── 悬浮提醒胶囊（常驻 / 安静模式）
                  ├── 系统通知（含 90s 设备掉线宽限）
                  ├── 一键聚焦 VS Code 窗口
                  └── 设置页（环境管理与偏好）
```

### 仓库结构

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 桌面主进程、悬浮提醒窗、设置页、系统通知、一键回去与 SSH/WSL 管理 |
| `packages/protocol` | 统一事件协议 Schema、常量、字节上限与文本脱敏清理 |
| `packages/core` | 会话状态机（`SessionStore`）、模型等待超时与进程健康检查、权限代理（`PermissionBroker`） |
| `packages/adapter-codex` | Codex CLI Hook 事件归一化适配 |
| `packages/adapter-copilot` | GitHub Copilot CLI Hook 事件归一化适配 |
| `packages/hook-runner` | Agent Hook 本地入口（跳过短命 shell 抓真实 PID、Copilot 转录尾部抽最后一句） |
| `packages/hook-installer` | Codex / Copilot Hook 幂等安装、备份与卸载 |
| `packages/receiver` | 同机回环 HTTP + LAN WebSocket 接收端服务 |
| `browser-preview` | 无需 Electron 与真实设备的浏览器交互预览 |

---

## 从源码开发与打包

环境要求：**Node.js 22+**、npm。

```bash
# 安装依赖
npm install

# 类型检查与单元测试
npm run typecheck
npm test

# 浏览器预览悬浮窗效果（使用模拟数据，无需连接真实设备）
node browser-preview/monitor-server.mjs
# 打开 http://127.0.0.1:18883/floating

# 源码运行桌面端（接入 WSL / 远端 Linux 前先构建 linux-payload）
npm run build:linux-payload
npm run start:desktop

# 构建 Windows 安装包（x64 + arm64，输出到 release/）
npm run dist:windows
```

---

## 项目文档

- [产品需求文档（PRD）](docs/product-requirements.md)
- [当前系统架构](docs/current-architecture.md)
- [提醒小窗重设计交接与实测记录](docs/handoff-reminder-redesign.md)

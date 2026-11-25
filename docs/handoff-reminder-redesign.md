# 交接文档：提醒小窗重新定义（2026-11-24）

本文档交给接手的编码 Agent。读完它应该能在不看之前对话的情况下继续工作。

- 仓库：`/home/dfrobot/work/vibemate`，分支 `main`
- 界面部分已改完但**未提交**（见第 4 节）
- 后端部分**一行未动**（见第 5 节）
- 动手写后端之前，**必须先做第 6 节的验证**

---

## 1. 背景：为什么要重新定义

VibeMate 是一个多设备 AI 编码任务的悬浮提醒窗，汇总 Windows 本机、WSL、SSH Linux／树莓派上的
Codex CLI 与 GitHub Copilot CLI 会话。

现有 PRD（`docs/product-requirements.md`）是按"Agent 每一步都可能停下来问人"设计的：七个状态、
权限双向链路、悬浮窗内 Allow／Deny。这个前提已经不成立：

- 用户现在基本给 Agent 全部权限，几乎不再有授权请求；
- 一个任务一跑就是十几分钟到几小时；
- 几台设备同时并行。

**瓶颈从"Agent 等授权"变成了"Agent 停了，人不知道"。** 所以产品要回答的问题从"有多少任务、
各是什么状态"变成了"要不要我管、去哪台设备管"。

## 2. 核心理念

### 2.1 任务对用户只有两种状态

| 状态 | 含义 | 用户要做的 |
| --- | --- | --- |
| **在跑** | Agent 在工作 | 什么都不用做 |
| **轮到你** | Agent 停了，球在用户这边 | 回到那个终端 |

"轮到你"包含三类，用颜色区分：

| 类别 | 颜色 | 包含 |
| --- | --- | --- |
| 完成 | 绿 | 当前轮次正常结束 |
| 故障 | 红 | 任务失败、模型请求失败、模型请求超时、进程没了、设备掉线 |
| 等确认 | 黄 | 权限请求（保留但已边缘化，基本不会出现） |

"完成"不再是一条看完就消失的通知，它就是新的"需要你"。

### 2.2 胶囊只说一句话

> **胶囊上有设备名，就是那台设备有事找你；只有数字，就是不用管。**

- 有任务轮到你：`[图标] 设备 · 任务标题  状态  +N`，**一直挂着**，直到用户处理。
- 只有在跑的：`◌ N 个在跑`。
- 空闲：`N 台设备在线 · 空闲`，30 秒后缩成小点。

不再显示"几个需要你 · 几个进行中 · 几个完成"这类并列计数。

### 2.3 故障只认四种，其他一律不报

用户明确说只关心：

1. **模型请求失败**（例如 Copilot 返回 400，接口报错后任务停在半路）
2. **模型请求超时**（请求悬着不返回，Agent 自己也不知道出事）
3. **进程没了**（Agent 进程意外退出）
4. **设备掉线**（任务在跑时 SSH／设备断开）

**不要做"N 分钟没动静就算卡住"**。这个方案试过并已删除：Agent 跑慢命令（全量测试、编译）或模型长
思考时都会长时间没事件，会大量误报，误报几次用户就不再信任提醒。

### 2.4 提醒的终点是"回去"

用户认为**一键回到对应窗口是超级重要的功能**。提醒完之后还要用户自己找窗口，提醒就只完成了一半。

### 2.5 不打扰

余光里持续在动的东西最抢注意力。不需要用户管的时候，界面不应该传递信息，也不应该有动画。

## 3. 已经定下来的决定

| 决定 | 结论 | 来源 |
| --- | --- | --- |
| "需要你／等确认" | 弱化，并入"轮到你"，不再单独计数；悬浮窗 Allow／Deny 保留但不再投入 | 用户 |
| "等了你多久"计时 | **不做** | 用户明确否决 |
| 一键回去 | **要做，优先级很高** | 用户 |
| 故障范围 | 仅 2.3 的四种 | 用户 |
| 故障颜色 | 红色，不是黄色 | 用户 |
| 两种模式 | 常驻模式、安静模式（见 4.3），默认常驻 | 用户 |
| 安静模式的小圆点 | **静止**，不能有动画 | 用户 |
| 安静模式下的完成提醒 | 完成一个就弹一次，不攒 | 用户 |
| 设备掉线 | 断开满 90 秒才报，期间重连则不报 | 用户同意等一两分钟；90 秒是助手取的值 |
| 常驻模式的转圈 | 保留转动，不改成静止 | 用户 |
| 桌宠 | 隐藏彩蛋，不扩展 | 既有方向 |
| 推送到手机 | 暂不做 | 助手建议，用户未反对 |

## 4. 已完成：界面（未提交，在工作区）

### 4.1 改动的文件

```
apps/desktop/src/renderer/preview.html   胶囊与展开列表的结构
apps/desktop/src/renderer/preview.css    样式（图标、红／绿／黄三套配色、安静模式）
apps/desktop/src/renderer/preview.js     分类与渲染逻辑（核心）
apps/desktop/src/renderer/index.html     设置页新增"悬浮窗模式"下拉框
apps/desktop/src/renderer/renderer.js    设置页下拉框的读写
apps/desktop/src/environment-types.ts    DesktopPreferences.reminderMode
apps/desktop/src/environment-store.ts    reminderMode 的默认值与读取归一化
apps/desktop/src/main.ts                 IPC vibemate:set-reminder-mode
apps/desktop/src/preload.cjs             setReminderMode
browser-preview/floating.html|floating.js|monitor-mock.js   浏览器预览与模拟数据
```

### 4.2 界面行为（`preview.js`）

- `classify()` 把每个会话归为 `running / done / attention / error`，并算出状态文案。
- 排序：未处理的在前；同为未处理时 `error > attention > done`；再按时间倒序。
- 胶囊显示排第一的那条，其余用 `+N`。新到的提醒在 6 秒内优先占据胶囊。
- 展开列表分三段："轮到你"、"在跑"、"看过了"。
- 每行：任务标题／`设备 · 项目 · Agent`／状态；停下来的任务多一行说明（Agent 最后一句话或故障说明）。
- 鼠标悬停某行，右侧状态变成"回去 ↗"；点击后调用 `api.focusSession`，成功后标记已看；未提供该接口的预览界面只标记已看。
- "已看"以 `updatedAt + problem` 为标记，同一会话下一轮再停下会重新变成未处理。
- 窗口吸附屏幕边缘时，只要有任务轮到你就保持滑出（`data-mode="toast"` 持续到处理完）。

### 4.3 两种模式

| | 都在跑 | 有任务停下或出问题 |
| --- | --- | --- |
| 常驻 `pinned` | `◌ N 个在跑`（圆圈转动） | 完整胶囊，常驻至处理 |
| 安静 `quiet` | 静止的半透明小圆点；悬停显示 `N 个在跑` | 弹回完整胶囊，常驻至处理 |

切换入口：展开列表左下角按钮、设置页"提醒"下拉框。

### 4.4 界面期望、但后端尚未提供的字段

`preview.js` 已经会读下列字段，目前只有模拟数据在给。真实数据下会降级：

| 字段 | 位置 | 含义 | 缺失时的表现 |
| --- | --- | --- | --- |
| `session.title` | 会话 | 用户那句 prompt 的首行（限长） | 退回显示项目名 |
| `session.summary` | 会话 | Agent 停下时的最后一句话，或故障原文 | 该行不显示／显示通用说明 |
| `session.startedAt` | 会话 | 当前轮次开始时间 | 只显示"在跑" |
| `session.problem` | 会话 | `api_failed` \| `api_timeout` \| `process_exited` | 不会报这三种故障 |
| `api.focusSession({environmentId, agent, sessionId})` | preload | 把对应 VS Code 窗口拉到前台 | 按钮显示"知道了"，只标记已看 |

"设备掉线"：环境 `status !== 'connected'` 持续满 90 秒（`OFFLINE_GRACE`），且会话处于在跑状态才报。
界面自己记录首次看到断开的时间，真实数据下已生效；但这个时间存在渲染进程内存里，窗口重载会重新
计时。后端若在环境上提供 `disconnectedAt`（ISO 时间），界面会优先使用它。

### 4.5 怎么看效果

```bash
node browser-preview/monitor-server.mjs      # 默认 0.0.0.0:18883
# 打开 http://127.0.0.1:18883/floating
```

页面上方按钮可切场景、模拟完成／模型请求失败／超时／进程没了／设备掉线、切换两种模式。全部是模拟
数据，不连接任何设备。

### 4.6 验证情况

- `npm run typecheck` 通过；`npm test` 72 个测试全过。
- 浏览器预览下各状态、两种模式均用无头 Chromium 逐一截图核对。
- **未在真实 Electron 窗口中运行过**。尤其需要在 Windows 上确认：安静模式下鼠标移入移出时窗口尺寸
  变化有无闪烁；`reminderMode` 的保存与重启后读取。

## 5. 未完成：后端与其余需求

按建议顺序排列。**第 1、2、4 项依赖第 6 节的验证结果。**

| # | 需求 | 现状 | 要做的事 |
| --- | --- | --- | --- |
| 1 | 任务标题 | 适配器未读 prompt；协议无此字段 | 从"用户提交"事件取首行，清理并限长，加进协议（`packages/protocol/src/schemas.ts`）与会话快照 |
| 2 | Agent 最后一句话 | 未读；协议无此字段 | 从"停止"事件取，清理并限长 |
| 3 | 已跑多久 | 协议无轮次开始时间 | 记录每轮"用户提交"时间，随会话下发为 `startedAt` |
| 4 | 模型请求失败 | Copilot `errorOccurred` 已映射为 `failed`，但与普通失败不分、未读错误原文；Codex **未注册任何错误事件**（`packages/hook-installer/src/index.ts` 的 `CODEX_EVENTS`） | 区分故障类型，带错误原文；Codex 侧取决于验证结果 |
| 5 | 模型请求超时 | 无 | 接收端记住每个会话最后一个事件的类型。**只在"等模型返回"阶段计时**（最后事件是"工具调用后"或"用户提交"）；最后事件是"工具调用前"说明命令在跑，不计时。阈值待定（见 7） |
| 6 | 进程没了 | `process.sourcePid` 已采集，无人检查 | 接收端（与 Agent 同机）定期检查进程是否存在；任务仍在跑而进程消失即判定 |
| 7 | 设备掉线 | 界面已显示（满 90 秒才报） | 环境上提供 `disconnectedAt`；补系统通知，通知同样要等满 90 秒 |
| 8 | 一键回去 | 无 | 见 5.1 |
| 9 | 故障的通知 | `apps/desktop/src/task-notifier.ts` 的 `NoticeKind` 只有 `completed/failed/waiting_permission` | 加入四种故障；预览的 `monitor-mock.js` 已按新种类模拟 |
| 10 | "已看"持久化 | 只存在渲染进程内存（`preview.js` 的 `seen`），重启后已处理的任务会重新冒出来 | 移到主进程保存 |
| 11 | 更新 PRD | 未动 | 见 5.2 |

### 5.1 一键回去的方案

用户通常在 **VS Code 窗口的集成终端**里跑 Agent。分两档：

**第一档（先做，不需要用户装东西）：跳到对的 VS Code 窗口。**
Windows 本机直接激活已有窗口；WSL 和 SSH 通过 VS Code 的远程命令打开对应目录。

| 环境 | 跳转方式 |
| --- | --- |
| Windows 本机 | 单窗口直接激活；多窗口按项目名唯一匹配，失败时提示手动切换 |
| WSL | `code --remote wsl+<发行版> <路径>` |
| SSH | `code --remote ssh-remote+<主机别名> <路径>` |

已知的坑：
- 本机多个窗口使用自定义标题或项目重名时，可能无法唯一匹配。WSL 和 SSH 的远程路径若与已打开的目录不同，则可能新开窗口。
- SSH 主机名必须与用户在 VS Code 里使用的别名一致，用 IP 会被当成另一台机器。
- Windows 上后台程序拉前台窗口，系统有时只闪任务栏而不切换。

**第二档（后做，需要配套 VS Code 扩展）：跳到对的终端标签。**
扩展列出本窗口各终端的进程号，与 hook 采集的 Agent 进程号匹配后调用 `terminal.show()`；同时上报
窗口实际打开的文件夹与主机名，可顺带解决第一档的两个坑。hook 可通过 `TERM_PROGRAM=vscode` 判断
会话是否在 VS Code 终端中。

### 5.2 PRD 需要改的地方

- 第 1 节三个核心场景：改为"在跑／轮到你"模型。
- 3.5 展示层：胶囊不再是"只含数量"，提示不再是"数秒后恢复"。
- 4.2 七状态表：面向用户的状态收敛为第 2.1 节的模型（内部状态可保留）。
- **3.4"只采集必要信息"与第 1、2、4 项冲突**：需要明确允许采集 prompt 首行、最后回复首句、错误
  原文，并规定清理规则与长度上限。**这一条需要用户确认后再写入。**

## 6. 动手前必须验证的事

以下都是凭印象的假设，**尚未核实**。任何一条不成立都会改变第 5 节的设计。

| # | 要验证的问题 | 影响 | 实测结论（2026-11-24，Linux 本机 `codex-cli 0.165.0` / `copilot 1.0.109`） |
| --- | --- | --- | --- |
| V1 | Codex／Copilot 的"用户提交"事件里是否带 prompt 原文，字段名是什么 | 需求 1 | **均成立，字段名都叫 `prompt`**。Codex `UserPromptSubmit` 带 `prompt`（字符串）；Copilot `userPromptSubmitted` 带 `prompt`（`sessionStart` 还带 `initialPrompt`）。 |
| V2 | "停止"事件里是否带最后一条回复（或转录文件路径） | 需求 2 | **差异很大，需分处理**：Codex `Stop` 直接带 `last_assistant_message`（字符串，可为 null）和 `transcript_path`；Copilot `agentStop` **不带回复文本**，但带 `transcriptPath`（指向 `~/.copilot/session-state/<id>/events.jsonl`）和 `stopReason`（如 `end_turn`），该文件里最后一条 `type === "assistant.message"` 的 `data.content` 就是最终回复（在 `agentStop` 触发前已写入）。 |
| V3 | Copilot 出现 400 等 API 错误时，是否真的触发 `errorOccurred`，载荷里有什么 | 需求 4 | **部分成立且有重要细节**：(1) 会话中模型请求失败确实触发 `errorOccurred`，载荷包含 `errorContext`（模型请求为 `"model_call"`）、`recoverable`（布尔值）和 `error: { name, message, stack }`。(2) **重试陷阱**：Copilot 重试时会**每次重试都触发一次 `errorOccurred` 且 `recoverable: true`**（实测 5 次重试触发 6 次），最后耗尽重试后若进程退出触发 `sessionEnd`（`reason: "error"`），**不会**触发 `agentStop`。需要结合 `errorContext === "model_call"` 与重试/恢复策略避免把单次瞬时重试误报为故障，且若历史上的非重试 400（如 `400 The requested model is not supported`）发生，需确认 `recoverable` 为 `false` 还是仍为 `true`。(3) 启动前（加载模型列表阶段）网络失败不会触发任何 hook。 |
| V4 | Codex 遇到 API 错误时触发什么事件。**若触发 `Stop`，现在会被显示成"完成了"**，比显示"在跑"更糟 | 需求 4、5 | **假设被大幅推翻（好消息）**：Codex 0.165.0 已原生支持 **`PreModelRequest` / `PostModelRequest`**（以及 `SessionEnd`、`Interrupt`）hook！实测：(1) 遇到不可重试的 400 错误时，触发 `PreModelRequest` → `PostModelRequest`（`status: "failed"`, `error: "{\"error\":...}"`, `token_usage: null`）→ `SessionEnd`（`reason: "other"`），**不会触发 `Stop`**，不会误报"完成了"。(2) 遇到网络断连时，Codex 内部退避重试，每次重试都会成对触发 `PreModelRequest` → `PostModelRequest`（`status: "failed"`, `error: "Connection failed: error sending request"`），同样不触发 `Stop`。(3) 正常调用完成时 `PostModelRequest` 为 `status: "completed"`, `error: null`。这意味着 Codex 不仅能直接拿到模型请求失败与错误原文，还能用 `PreModelRequest` / `PostModelRequest` **精确界定"等模型返回"区间**！ |
| V5 | 模型正常长思考时，两个 Agent 最长会沉默多久 | 需求 5 的阈值 | 分析本机历史真实会话日志（只读统计，不含工具耗时）：<br>- **Copilot**（175 个会话、17,270 次模型等待）：p50 `7.2s`，p90 `22.4s`，p95 `32.8s`，p99 `67.0s`，p99.5 `84.4s`，p99.9 `136.4s`，最长 **`246.5s`**（4.1 分钟，`claude-opus-5`；`gpt-6-astra` / `gpt-5.6-sol` 也多次达到 `155–213s`）。<br>- **Codex**（17 个会话、201 次完整等待）：p50 `7.4s`，p90 `29.0s`，p95 `40.4s`，p99 `87.3s`，最长 **`116.6s`**（近 2 分钟，`gpt-6-astra`）。<br>结论：超时阈值绝不能设成 2–3 分钟，建议 **5–8 分钟（如 300s 或 360s，甚至 480s）** 以避免长思考误报。 |
| V6 | 各环境下 `process.sourcePid` 是否确实是 Agent 进程本身（而非短命的 hook 子进程） | 需求 6 | **文档假设被推翻（关键发现）**：<br>(1) **两个 Agent 原始 hook 载荷里根本不包含 `source_pid` / `sourcePid` 字段**；现有 `hook-runner` 也未注入 `process.ppid`，所以目前线上 `process.sourcePid` 其实是**空的（从未采集到）**！<br>(2) 在 Linux 上直接执行 hook 命令时，`hook-runner` 的 `process.ppid` 确实是 Agent 主进程本身（实测 Codex 为 `codex` 进程，Copilot 为 `copilot` 主进程），因为 shell 对单命令做了 `exec` 优化。<br>(3) **但有两个坑**：在 Linux 上带环境变量前缀（如 `ELECTRON_RUN_AS_NODE=1`）时 `bash -c` 会保留中间 `bash` 进程作为 `ppid`（短命 shell）；在 **Windows** 上经 PowerShell（`& 'node' ...`）拉起时，`ppid` 同样可能是短命的 `powershell.exe` / `cmd.exe`！因此不能直接盲传 `process.ppid`，必须由 `hook-runner` 沿父进程链向上跳过短命 shell（`sh`/`bash`/`zsh`/`dash`/`cmd.exe`/`powershell.exe`/`pwsh.exe`）找到真正的 Agent 进程 PID（或在安装命令里用 `exec` + 向上解析）。 |
| V7 | 第 5.1 节三条 `code` 命令在 Windows 上能否稳定把已打开的窗口拉到前台 | 需求 8 | **待用户在 Windows 上实测**（本机为 Linux）。 |

> **V1–V6 验证操作记录（2026-11-24）**：已通过 `copilot-gateway codex --account Emma`（`mai-code-2-flash` 触发 400 + `gpt-5.3-codex` 正常与断网）和 `copilot --model claude-haiku-4.5`（正常 + 代理断连）完成实测；验证前后均已核对 `~/.codex/hooks.json`、`~/.copilot/hooks/vibemate.json` 恢复为原样、临时网关 `hooks.json` 已移除、`/tmp` 下的落盘载荷已彻底删除。
>
> **额外发现（网关模式 `CODEX_HOME`）**：通过 `copilot-gateway codex` 启动时，网关会把 `CODEX_HOME` 指向 `~/.local/state/copilot-gateway/clients/codex/default`，而非 `~/.codex`。若 hook 只装在 `~/.codex/hooks.json`，用 `copilot-gateway` 启动的 Codex 不会触发 hook（后续可按需考虑是否兼容）。

**建议做法（V1–V6）**：本机已安装 `codex` 与 `copilot`（`~/.local/bin/`）。临时挂一个只把收到的
载荷原样落盘的 hook，分别跑一轮正常任务、一轮断网任务，查看真实数据。

注意：
- 这会消耗用户的额度，并临时改动 Agent 的 hook 配置。**用户尚未同意，开始前要先问**，做完要恢复。
- 落盘的载荷含 prompt 等内容，放在仓库之外，用完删除。

**V7** 无法在这台 Linux 开发机上验证，需要用户在 Windows 上配合。

## 7. 已确认的问题（2026-11-25 用户按推荐方案拍板）

1. **排序与消失规则**：确认采用 `error > attention > done` 排序，且点击处理后立即标记已看并从胶囊消失。
2. **放开 PRD 3.4 采集范围**：用户明确同意采集经脱敏清理和限长的 `title`（prompt 首行，上限 60 字）、`summary`（Agent 最后一句或错误摘要，上限 120 字）。
3. **故障策略与阈值**：
   - 保留“进程没了”（`hook-runner` 跳过短命 shell 上报真实 Agent PID，Receiver 定时检查存活）；不加“长时间无更新”。
   - 模型请求超时阈值定为 **6 分钟（360 秒）**，仅在等待模型返回阶段计时，工具执行期间不计时。
   - 按 V2 / V3 / V4 / V6 实测调整方案推进（Copilot `agentStop` 本地读 `transcriptPath` 末尾抽最后一句；Codex 接入 `PreModelRequest` / `PostModelRequest` / `SessionEnd` / `Interrupt`；可重试 API 错误做防抖）。

## 8. 建议的工作顺序

1. 征得同意后做第 6 节 V1–V6 的验证，把结果写回本文档。
2. 与用户确认第 7 节的问题，更新 PRD。
3. 做确定可行的：需求 3、6、7、9、10。
4. 做依赖验证结果的：需求 1、2、4、5。
5. 做需求 8 第一档，请用户在 Windows 上测试（V7）。
6. 视使用反馈决定是否做需求 8 第二档（VS Code 扩展）。

## 9. 约束与注意事项

- 当前改动未提交。提交、推送前先问用户；在 `main` 上的话先开分支。
- 修改后跑 `npm run typecheck` 与 `npm test`。
- 权限链路的安全约束不变（PRD 3.2、3.3）：集成故障不得变成自动 Allow 或自动 Deny。
- 新采集的文本必须经过清理与限长，沿用 `packages/protocol/src/sanitize.ts` 的做法。
- 不要扩展桌宠功能，不要加喝水／久坐类提醒。
- 界面文案面向非开发者，用"在跑／轮到你／完成了／进程没了"这类说法，不用内部状态名。

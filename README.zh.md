# dsh-feishu-bot — 飞书/Lark 机器人插件

让 DSH 通过**飞书（国内）**或 **Lark（国际）**与你对话：机器人在会话里收到消息，
自动交给一个独立的 DSH agent 处理，再把回复发回同一个会话。全程走**长连接
（WebSocket）**，不需要公网 URL、不需要隧道。

## 功能特性

- **长连接接收事件**：用官方 SDK 的 WebSocket 长连接，无需公网 URL / frp / ngrok。
- **国内外通用**：`domain` 自动检测（先试 `open.feishu.cn` 再试 `open.larksuite.com`），
  也可手动指定 `feishu` / `lark`。
- **每会话一个 DSH agent**：每个 Lark 会话（chat_id）绑定独立 agent 会话，互不串线；
  agent 带全部 DSH 工具（文件、命令、搜索等），回复自动截断到 `max_reply_chars`。
- **机器人菜单命令**：在聊天里直接发命令即可切换/新建会话与工作区（见下表）。
- **新手友好**：Web 设置页（设置 → 插件 → Feishu/Lark Bot）显示状态、开发者后台
  二维码（扫码用手机打开后台建应用）、AppID/Secret 表单、保存/刷新。
- **Agent 工具**：`lark_status`（状态）、`lark_configure`（写配置并重启桥接）、
  `lark_test`（验证凭据与连接）——把本仓库地址发给任意 DSH agent，它能自主完成配置。
- **交互卡片选择**：菜单「切换会话 / 切换工作区」弹出卡片按钮，点按钮即完成切换。
- **DSH 向你提问**：agent 调用提问工具时，问题（带编号选项）转发到飞书，回复即答案。
- **跨对话通知**：任意 DSH 对话的 agent 调用 `lark_notify` 即可向飞书发通知
  （格式 `[工作区]-[对话]：[内容]`；目标默认 `notify_chat_id`，见初始化文档）。
  Shell 手动发通知用 `node scripts/send-notify.cjs --text "你好"`（UTF-8 安全）。
- **发送文件**：agent 调用 `lark_send_file` 可把本机文件（≤30MB）直接发到飞书聊天。

> 📖 **文档**：[初始化文档](初始化文档.md)（从零接入）· [交接文档](交接文档.md)
> （维护者：架构、官方开发格式、发布流程、变更记录）。

## 安装

把本仓库地址给 DSH agent，或手动执行：

```sh
# 本地路径（开发）
dsh plugin --profile web add link:<本仓库路径>

# GitHub 地址
dsh plugin --profile web add git+https://github.com/wangsan71/DSh-feishu-bot.git

# npm（发版后，推 vX.Y.Z tag 自动发布）
dsh plugin --profile web add @areoneplayer/dsh-feishu-bot
```

安装后重启 `dsh web`（或按 `dsh plugin` 提示热挂载）。侧边栏 设置 → 插件 里应出现
「Feishu/Lark Bot」页。

## 快速配置（新手三步）

1. **创建应用**：用手机扫设置页里的二维码，打开开发者后台（国内
   `https://open.feishu.cn` / 国际 `https://open.larksuite.com`），扫码登录后
   「创建企业自建应用」，开启**机器人**能力，添加权限 `im:message` 与
   `im:message:send_as_bot`（群聊再加 `im:message.group_msg`），事件订阅选
   **使用长连接接收事件**并订阅 `接收消息 im.message.receive_v1`（无需填 URL）。
   复制 **App ID** 与 **App Secret**。
2. **填凭据**：在设置页粘贴 App ID / App Secret（平台选「自动检测」即可），点
   「保存并重启桥接」；或让 agent 执行 `lark_configure`。
3. **验证**：给机器人发一条文字消息，应收到 DSH agent 的回复。可用 `lark_test`
   先验证凭据。

配置落盘在 `~/.dsh/dsh-feishu-bot.json`（`app_id` / `app_secret` / `domain`）。

## 对话命令

在机器人的聊天里直接发以下命令（中英文均可，可加 `/` 前缀）：

| 命令 | 动作 | 说明 |
|---|---|---|
| `新建工作区 <路径> [标题]` / `NEW_WORKSPACE` | 创建并切换到新工作区 | 路径须为已存在的目录 |
| `新建会话` / `NEW_SESSION` | 在当前工作区新建会话 | 新会话绑定的 agent 独立对话 |
| `切换工作区 [编号/路径]` / `WORKSPACE_CHANGE` | 在**已创建**的工作区之间切换 | 不带参数时弹出卡片并列出全部工作区 |
| `切换会话 [编号]` / `CHANGE_SESSION` | 在**当前工作区**的会话之间切换 | 不带参数时弹出卡片并列出当前工作区的会话 |
| `帮助` / `HELP` | 显示命令列表 | |

每个聊天（chat_id）的当前工作区/会话保存在 `~/.dsh/dsh-feishu-bot-state.json`；
切换到已存在的会话会恢复其历史对话。

> 切换类命令不带参数时会发送**交互卡片**（每个选项一个按钮），点击按钮即可切换；
> 也可以直接在单聊里回复编号。

## DSH 向你提问

当 DSH agent 需要向你确认（例如调用 `ask_user_question`）时，机器人会把问题
转发到飞书（带编号选项），你在聊天里回复答案即可，agent 会继续执行。

## Agent 自动配置

把本仓库 URL 复制给任意 DSH agent，它会读本 README 并依次执行：clone/install →
`lark_configure`（填 AppID/Secret）→ `lark_test`（验证）→ 请你发消息测试。整个
「创建应用」环节仍需你在开发者后台完成（扫码登录建应用，约两分钟）。

## 手动配置（配置文件）

```json
{
  "app_id": "cli_xxxxxxxxxxxxxxxx",
  "app_secret": "xxxxxxxx",
  "domain": "auto",
  "websocket": true,
  "cwd": "",
  "agent_preset": "",
  "max_reply_chars": 8000
}
```

`domain`：`auto`（默认，探测两个域）/ `feishu` / `lark`。改完文件后执行
`lark_configure` 或重载插件让桥接用新配置重连。

## 限制与安全模型

- `app_secret` 以明文存在 `~/.dsh/dsh-feishu-bot.json`（用户主目录私有文件，权限
  0600），请勿将该路径暴露给模型或日志。
- 每个会话的对话消耗 API 额度；agent 可执行文件/命令操作，属正常 DSH 能力。
- 仅支持文本消息（`message_type: text`）；图片/卡片等暂不处理。
- 动态能力依赖 DSH 宿主进程；进程重启后由 `cordis.patch.yml` 自动恢复挂载。

## 开发

```sh
npm run build        # tsc + tsdown → lib/
npx tsc --noEmit     # 类型检查
npx vitest run       # 测试
```

Host 半区在 `src/index.ts`（引擎/路由/工具/桥接管理），桥接子进程在
`bridge/ws-bridge.cjs`，浏览器设置页在 `src/client/index.ts`。

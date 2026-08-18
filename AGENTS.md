# AGENTS.md — dsh-feishu-bot

DSH 的飞书/Lark 机器人插件（独立个人仓库）：长连接（WebSocket）接收事件、每会话
绑定独立 DSH agent 自动回复、域自动检测（feishu/lark 国内外通用）、机器人菜单命令
（新建/切换工作区与会话）、DSH 提问转发到飞书、交互卡片菜单选择。

## 文档必读

- **[初始化文档.md](初始化文档.md)** — 新接入/新开发者从零初始化。
- **[交接文档.md](交接文档.md)** — 维护者必读：架构、数据流、发布渠道、变更记录。

> **硬性规定（对接入/开发的任何 agent 生效）**：本仓库的任何**新增功能或代码修改
> 必须遵循 [交接文档.md](交接文档.md) 第 3 章「开发规范（官方格式）」**：依赖三处
> 一致（peerDeps/devDeps/libExternal + inject）、固定三件套导出（name/inject/apply）、
> 副作用可逆（ctx.effect/on）、Conventional Commits、提交前检查全过。
> **功能/修复完成并合并后，必须在交接文档「变更记录」章节顶部追加一条记录并推送。**

## 本包要点

- Host 半区（`src/index.ts`）：配置存 `~/.dsh/dsh-feishu-bot.json`（app_id /
  app_secret / domain，domain 支持 `feishu` / `lark` / `auto`）；每聊天状态存
  `~/.dsh/dsh-feishu-bot-state.json`（当前 workspace + session key）；`/feishu/event`
  （webhook 兼容）与 `/feishu/health`、`/feishu/api/*` 路由；`bridge/ws-bridge.cjs`
  长连接桥接子进程（官方 SDK，Domain 用数字枚举 `Lark.Domain.Lark/Feishu`，传字符串
  会 Invalid URL）；agent 创建必须注入默认 provider/model（否则回合被 pre-step 拒绝）；
  工具 `lark_status` / `lark_configure` / `lark_test` / `lark_notify`（任意 DSH 对话
  向飞书发通知，格式 `[工作区]-[对话]：[内容]`，目标默认取配置 `notify_chat_id`）。
- **编码纪律**：向飞书发中文通知**只走两条路**——`lark_notify` 工具或
  `scripts/send-notify.cjs`（Node 全程 UTF-8）。**严禁**用 PowerShell 5.1
  `Invoke-RestMethod` 手写发送（中文会变 `?????`）。
- 菜单命令：`新建工作区 <路径>` / `新建会话` / `切换工作区 [编号]` / `切换会话 [编号]`
  （会话仅当前工作区内切换，工作区仅已创建；经 `workspaceRegistry` + `agents.resume`）。
- 交互卡片：`change_session` / `change_workspace`（无参数时）发送交互卡片（按钮携带
  `{dsh_action, index}`）；桥接转发 `card.action.trigger` 为 `{type:'card'}`；
  `handleCard` 执行切换并以 chat_id 回复。
- 提问转发：Host 注册 `userQuestions` provider，agent 提问发送到飞书（编号选项），
  用户回复经 `pendingQuestions` 映射回传给 agent（300s 超时）。
- Client 半区（`src/client/index.ts`）：`settings.plugins.tab` 设置页（状态 + 开发者
  后台 QR + AppID/Secret 表单 + 保存/测试），经 `/feishu/api/*` 与 Host 通信。
- 跨目录结构：host 逻辑在 `src/index.ts`，桥接脚本在 `bridge/`（纯 JS 资产，不进
  tsdown 构建，运行时由 host 以 `node bridge/ws-bridge.cjs` 拉起）；构建预设 vendored
  在 `build/tsdown.client.ts`（独立仓库，不依赖 dsh-web-ui 全家桶）。

## 安全模型

- app_secret 明文存 `~/.dsh/dsh-feishu-bot.json`（用户主目录私有文件），不写入日志。
- 每个 Lark 会话消耗 API 额度；agent 带全部工具，可执行文件/命令操作。

## 提交前检查

```sh
pnpm typecheck
pnpm build
pnpm test
```

通过后按 Conventional Commits 提交（`feat|fix|docs|chore|ci|refactor|test: ...`），
并**更新交接文档变更记录**。

# AGENTS.md — dsh-feishu-bot

DSH 的飞书/Lark 机器人插件（独立个人仓库）：长连接（WebSocket）接收事件、每会话
绑定独立 DSH agent 自动回复、域自动检测（feishu/lark 国内外通用）、机器人菜单命令
（新建/切换工作区与会话）。

## 本包要点

- Host 半区（`src/index.ts`）：配置存 `~/.dsh/dsh-feishu-bot.json`（app_id /
  app_secret / domain，domain 支持 `feishu` / `lark` / `auto`）；每聊天状态存
  `~/.dsh/dsh-feishu-bot-state.json`（当前 workspace + session key）；`/feishu/event`
  （webhook 兼容）与 `/feishu/health`、`/feishu/api/*` 路由；`bridge/ws-bridge.cjs`
  长连接桥接子进程（官方 SDK，Domain 用数字枚举 `Lark.Domain.Lark/Feishu`，传字符串
  会 Invalid URL）；agent 创建必须注入默认 provider/model（否则回合被 pre-step 拒绝）；
  工具 `lark_status` / `lark_configure` / `lark_test`。
- 菜单命令：`新建工作区 <路径>` / `新建会话` / `切换工作区 [编号]` / `切换会话 [编号]`
  （会话仅当前工作区内切换，工作区仅已创建；经 `workspaceRegistry` + `agents.resume`）。
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

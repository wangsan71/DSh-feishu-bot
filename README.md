# dsh-feishu-bot — Feishu/Lark bot plugin for DSH

Let DSH talk to you through **Feishu (China)** or **Lark (international)**: the bot
receives messages in a chat, hands each one to a dedicated DSH agent, and replies
back in the same chat. Everything runs over the **long connection (WebSocket)** —
no public URL, no tunnel required.

## Features

- **Long-connection events**: official SDK WebSocket long connection; no public
  URL / frp / ngrok.
- **China and international**: `domain` auto-detection (probes
  `open.feishu.cn` then `open.larksuite.com`), or set `feishu` / `lark` manually.
- **One DSH agent per chat**: each Lark chat_id gets its own agent session; the
  agent has the full DSH toolset (files, shell, search, ...). Replies are capped
  at `max_reply_chars`.
- **Bot menu commands**: switch/create sessions and workspaces right from the
  chat (see below).
- **Beginner-friendly**: a web setup page (Settings → Plugins → Feishu/Lark Bot)
  with status, a developer-console QR code (scan with your phone to create the
  app), an AppID/Secret form, and save/refresh actions.
- **Agent tools**: `lark_status`, `lark_configure`, `lark_test` — give this repo
  URL to any DSH agent and it can configure the bot by itself.

## Install

Give this repo URL to a DSH agent, or run:

```sh
# local path (development)
dsh plugin --profile web add link:<this repo>

# GitHub URL
dsh plugin --profile web add git+https://github.com/wangsan71/DSh-feishu-bot.git

# npm (after a release — pushing a vX.Y.Z tag auto-publishes)
dsh plugin --profile web add @areoneplayer/dsh-feishu-bot
```

Restart `dsh web` after install (or follow the `dsh plugin` hot-mount hint). A
「Feishu/Lark Bot」page appears under Settings → Plugins.

## Quick setup (three steps)

1. **Create the app**: scan the QR on the setup page to open the developer
   console (China `https://open.feishu.cn` / international
   `https://open.larksuite.com`), log in, create a self-built app, enable the
   **bot** capability, add scopes `im:message` and `im:message:send_as_bot`
   (plus `im:message.group_msg` for groups), and subscribe events via
   **use long connection to receive events** with `接收消息 im.message.receive_v1`
   (no URL needed). Copy **App ID** and **App Secret**.
2. **Fill credentials**: paste App ID / App Secret on the setup page (platform:
   auto-detect), click save and restart the bridge — or have an agent run
   `lark_configure`.
3. **Verify**: send a text message to the bot; you should get a reply from the
   DSH agent. Use `lark_test` to check credentials first.

Config is stored at `~/.dsh/dsh-feishu-bot.json` (`app_id` / `app_secret` /
`domain`).

## Bot menu commands

Send these in the bot's chat (Chinese or English, optional `/` prefix):

| Command | Action | Notes |
|---|---|---|
| `新建工作区 <path> [title]` / `NEW_WORKSPACE` | create and switch to a new workspace | the path must be an existing directory |
| `新建会话` / `NEW_SESSION` | create a new session in the current workspace | the new session binds an independent agent |
| `切换工作区 [index/path]` / `WORKSPACE_CHANGE` | switch among **already-created** workspaces | no arg lists all workspaces |
| `切换会话 [index]` / `CHANGE_SESSION` | switch among sessions **within the current workspace** | no arg lists the current workspace's sessions |
| `帮助` / `HELP` | show the command list | |

Each chat's current workspace/session is persisted in
`~/.dsh/dsh-feishu-bot-state.json`; switching to an existing session restores
its conversation history.

## Agent-driven configuration

Copy this repo URL to any DSH agent: it reads this README and runs
clone/install → `lark_configure` (AppID/Secret) → `lark_test` (verify) → asks
you to send a test message. Only the app-creation step stays manual in the
developer console (scan-login, about two minutes).

## Manual config (config file)

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

`domain`: `auto` (default, probes both) / `feishu` / `lark`. After editing, run
`lark_configure` or reload the plugin so the bridge reconnects with new config.

## Limitations and security model

- `app_secret` is stored in plaintext at `~/.dsh/dsh-feishu-bot.json` (private
  file in the user home, mode 0600); never expose this path to the model or logs.
- Each chat conversation consumes API quota; the agent can run file/shell
  operations as normal DSH capabilities.
- Text messages only (`message_type: text`); images/cards are not handled yet.
- Mounted via `cordis.patch.yml`; the plugin row auto-restores after a DSH
  process restart.

## Development

```sh
npm run build        # tsc + tsdown → lib/
npx tsc --noEmit     # typecheck
npx vitest run       # tests
```

Host half lives in `src/index.ts` (engine/routes/tools/bridge manager), the
bridge subprocess in `bridge/ws-bridge.cjs`, the browser setup page in
`src/client/index.ts`.

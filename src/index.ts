/**
 * dsh-feishu-bot — host half.
 *
 * Feishu/Lark AI bot for DSH:
 * - Long-connection (WebSocket) event receiving via the official SDK bridge
 *   subprocess (no public URL needed), domain auto-detected for both Feishu
 *   (open.feishu.cn) and Lark (open.larksuite.com).
 * - Per-chat DSH agent binding across workspaces/sessions, plus bot menu
 *   commands: NEW_WORKSPACE / NEW_SESSION / WORKSPACE_CHANGE / CHANGE_SESSION
 *   (switch session only within the current workspace; switch workspace only
 *   among already-created ones).
 * - Web routes (/feishu/event, /feishu/health, /feishu/api/*), agent tools
 *   (lark_status / lark_configure / lark_test), and a system-prompt
 *   announcement. The browser half (./client) renders the setup page.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workspace'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as https from 'node:https'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable cordis plugin name. */
export const name = 'feishu-bot'

/** Services required before the bot surfaces can mount. */
export const inject = ['webServer', 'agents', 'subprocess', 'agentDefaultModel', 'tools', 'systemPrompt', 'workspaceRegistry']

/** Plugin config (schema defaults applied by the loader). */
export interface Config {
  /** Announce the plugin to every agent via a system-prompt section. */
  announceToAgent?: boolean
  /** Master switch for the plugin. */
  enabled?: boolean
}

const DEFAULT_ANNOUNCE = true
const SECTION_ORDER = 160

const GUIDANCE =
  '本机已安装 dsh-feishu-bot 插件（飞书/Lark 机器人）：长连接（WebSocket）接收事件，无需公网 URL；' +
  '配置存 ~/.dsh/dsh-feishu-bot.json（app_id / app_secret / domain，domain 自动检测 feishu/lark 国内外通用）；' +
  '机器人菜单命令：新建工作区 <路径> / 新建会话 / 切换工作区 / 切换会话（会话仅当前工作区内切换）；' +
  '工具：lark_status 查看状态、lark_configure 写入配置并重启桥接、lark_test 验证凭据与连接。' +
  '限制：app_secret 明文存在用户主目录私有文件；对话消耗 API 额度；用户提到「飞书 / Lark / 机器人 / 扫码配机器人」时即指本插件。'

/** Config file location: $DSH_HOME/dsh-feishu-bot.json (default ~/.dsh/...). */
function configPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-feishu-bot.json')
}

/** Per-chat bot state file location. */
function statePath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-feishu-bot-state.json')
}

/** Bot runtime config read from the config file. */
interface BotConfig {
  app_id?: string
  app_secret?: string
  /** 'feishu' | 'lark' | 'auto' (auto probes both). */
  domain?: string
  websocket?: boolean
  cwd?: string
  agent_preset?: string
  max_reply_chars?: number
}

/** Per-chat bot state: which workspace + which session key the chat is on. */
interface ChatState {
  workspaceId?: string
  sessionKey?: number
}

const FEISHU_HOST = 'https://open.feishu.cn'
const LARK_HOST = 'https://open.larksuite.com'

/** Host of a resolved domain. */
function hostOf(domain: string): string {
  return domain === 'lark' ? LARK_HOST : FEISHU_HOST
}

/** Minimal JSON HTTPS POST helper. */
function httpsJson(url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = new URL(url) } catch (e) { reject(e); return }
    const req = https.request({
      hostname: u.hostname,
      port: u.port !== '' ? Number(u.port) : 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c as Buffer))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** Fetch a tenant access token from one host. */
async function tenantToken(host: string, cfg: BotConfig): Promise<string> {
  const res = await httpsJson(host + '/open-apis/auth/v3/tenant_access_token/internal', {}, JSON.stringify({ app_id: cfg.app_id, app_secret: cfg.app_secret }))
  const data = JSON.parse(res.text) as { code?: number; tenant_access_token?: string; msg?: string }
  if (data.code !== 0 || !data.tenant_access_token) throw new Error('token failed: ' + String(res.text).slice(0, 200))
  return data.tenant_access_token
}

/** Probe both hosts and return the working domain ('feishu' or 'lark'). */
async function detectDomain(cfg: BotConfig): Promise<string> {
  const tries: Array<[string, string]> = [['feishu', FEISHU_HOST], ['lark', LARK_HOST]]
  for (const [dom, host] of tries) {
    try {
      const token = await tenantToken(host, cfg)
      if (token !== '') return dom
    } catch (e) { /* try next */ }
  }
  return 'feishu'
}

/**
 * Mount the bot engine: config, bridge, routes, tools, announcement.
 * @param ctx - host plugin context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  const cfg = config ?? {}
  const enabled = cfg.enabled ?? true
  const announce = cfg.announceToAgent ?? DEFAULT_ANNOUNCE

  const chatAgents = new Map<string, { agent: any; handle: any }>()
  const chatLocks = new Map<string, Promise<unknown>>()
  const handles: any[] = []
  let bridgeHandle: any = null
  let bridgeRestartTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let tokenCache: { token: string; expiresAt: number } = { token: '', expiresAt: 0 }
  let botConfig: BotConfig = {}
  let botState: Record<string, ChatState> = {}

  // ---------- config ----------
  async function loadConfig(): Promise<BotConfig> {
    try {
      const text = (await readFile(configPath(), 'utf8')).replace(/^\uFEFF/, '')
      botConfig = JSON.parse(text) as BotConfig
    } catch (e) {
      botConfig = {}
    }
    if (botConfig.domain === undefined || botConfig.domain === 'auto' || botConfig.domain === '') {
      if (botConfig.app_id && botConfig.app_secret) {
        try {
          const detected = await detectDomain(botConfig)
          botConfig.domain = detected
          await saveConfig()
        } catch (e) { botConfig.domain = 'feishu' }
      } else {
        botConfig.domain = 'feishu'
      }
    }
    return botConfig
  }

  async function saveConfig(): Promise<void> {
    try {
      await mkdir(dirname(configPath()), { recursive: true })
      await writeFile(configPath(), JSON.stringify(botConfig, null, 2), 'utf8')
    } catch (e) {
      console.error('[feishu-bot] save config failed: ' + String(e))
    }
  }

  async function loadState(): Promise<void> {
    try {
      const text = (await readFile(statePath(), 'utf8')).replace(/^\uFEFF/, '')
      const parsed = JSON.parse(text) as Record<string, ChatState>
      if (parsed !== null && typeof parsed === 'object') botState = parsed
    } catch (e) { botState = {} }
  }

  async function saveState(): Promise<void> {
    try {
      await mkdir(dirname(statePath()), { recursive: true })
      await writeFile(statePath(), JSON.stringify(botState, null, 2), 'utf8')
    } catch (e) { /* ignore */ }
  }

  // ---------- lark api ----------
  async function token(c: BotConfig): Promise<string> {
    const now = Date.now()
    if (tokenCache.token !== '' && now < tokenCache.expiresAt - 60000) return tokenCache.token
    const host = hostOf(c.domain ?? 'feishu')
    const t = await tenantToken(host, c)
    tokenCache = { token: t, expiresAt: now + 7200 * 1000 }
    return t
  }

  async function sendText(c: BotConfig, chatId: string, text: string): Promise<void> {
    const t = await token(c)
    const host = hostOf(c.domain ?? 'feishu')
    const body = JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) })
    const res = await httpsJson(host + '/open-apis/im/v1/messages?receive_id_type=chat_id', { Authorization: 'Bearer ' + t }, body)
    const data = JSON.parse(res.text) as { code?: number }
    if (data.code !== 0) console.error('[feishu-bot] send failed: ' + String(res.text).slice(0, 300))
  }

  // ---------- bridge ----------
  function forwardUrl(): string {
    let port = 3080
    try { if (ctx.webServer.port !== undefined) port = ctx.webServer.port } catch (e) { /* ignore */ }
    return 'http://127.0.0.1:' + port + '/feishu/event'
  }

  async function startBridge(): Promise<void> {
    try {
      const node = await ctx.subprocess.resolveExecutable('node')
      const bridgePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'ws-bridge.cjs')
      const c = botConfig
      bridgeHandle = ctx.subprocess.spawn({
        argv: [node, bridgePath],
        cwd: dirname(bridgePath),
        stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
        graceMs: 5000,
        env: {
          FEISHU_APP_ID: c.app_id ?? '',
          FEISHU_APP_SECRET: c.app_secret ?? '',
          FEISHU_FORWARD_URL: forwardUrl(),
          FEISHU_DOMAIN: c.domain ?? 'feishu',
        },
      })
      bridgeHandle.done.then((o: { exitCode: number | null }) => {
        console.error('[feishu-bot] bridge exited: code=' + o.exitCode)
        // Watchdog: if the bridge process died and the plugin is still up,
        // respawn it after a short delay so the bot self-heals.
        if (!disposed && botConfig.websocket !== false && botConfig.app_id && botConfig.app_secret) {
          bridgeRestartTimer = setTimeout(() => {
            bridgeRestartTimer = null
            bridgeHandle = null
            void startBridge().catch(() => undefined)
          }, 5000)
        }
      })
      console.log('[feishu-bot] bridge started (domain=' + (c.domain ?? 'feishu') + ')')
    } catch (e) {
      console.error('[feishu-bot] startBridge failed: ' + String(e))
    }
  }

  // ---------- agent binding (per chat, per workspace/session) ----------
  function modelOptions(): Record<string, string> {
    const options: Record<string, string> = {}
    try {
      const sel = ctx.agentDefaultModel.currentSelection()
      if (sel !== undefined && sel.provider !== undefined) options.provider = sel.provider
      if (sel !== undefined && sel.model !== undefined) options.model = sel.model
    } catch (e) { /* keep empty */ }
    return options
  }

  async function bindAgentSession(chatId: string, ws: any, sessionId: string): Promise<any> {
    const live = ctx.agents.get(sessionId as never)
    if (live !== undefined) {
      chatAgents.set(chatId, { agent: live, handle: null })
      try { await ws.attachSession(sessionId) } catch (e) { /* ignore */ }
      return live
    }
    try {
      const h = await ctx.agents.resume({ resumeSessionId: sessionId as never, agentOptions: modelOptions() as never })
      handles.push(h)
      chatAgents.set(chatId, { agent: h.agent, handle: h })
      try { await ws.attachSession(sessionId) } catch (e) { /* ignore */ }
      return h.agent
    } catch (e) {
      const meta: Record<string, string> = { cwd: ws.path }
      if (botConfig.agent_preset !== undefined && botConfig.agent_preset !== '') meta.agentPreset = botConfig.agent_preset
      const h = await ctx.agents.create({ sessionId: sessionId as never, meta: meta as never, agentOptions: modelOptions() as never })
      handles.push(h)
      chatAgents.set(chatId, { agent: h.agent, handle: h })
      try { await ws.attachSession(sessionId) } catch (e) { /* ignore */ }
      return h.agent
    }
  }

  function chatSessionId(chatId: string, ws: any, key: number): string {
    return 'feishu-' + chatId + '-' + ws.id + '-' + key
  }

  async function ensureDefaultState(chatId: string): Promise<ChatState | null> {
    if (botState[chatId] !== undefined) return botState[chatId]
    const path = botConfig.cwd ?? join(homedir(), '.dsh')
    let ws: any
    try { ws = await ctx.workspaceRegistry.create(path) } catch (e) { return null }
    botState[chatId] = { workspaceId: ws.id, sessionKey: -1 }
    await saveState()
    return botState[chatId]
  }

  function matchWorkspace(workspaces: any[], arg: string): any {
    const idx = parseInt(arg, 10)
    if (!Number.isNaN(idx) && idx >= 1 && idx <= workspaces.length) return workspaces[idx - 1]
    return workspaces.find((w) => String(w.id) === arg || w.path === arg || String(w.path).includes(arg) || w.title === arg || String(w.title).includes(arg)) ?? null
  }

  // ---------- bot menu commands ----------
  async function handleCommand(chatId: string, text: string): Promise<string | null> {
    let body = text.trim()
    if (body.charAt(0) === '/') body = body.slice(1)
    const parts = body.split(/\s+/).filter(Boolean)
    const cmd = (parts[0] ?? '').toLowerCase()
    if (cmd === '') return null
    const args = parts.slice(1)

    if (cmd === 'new_workspace' || cmd === '新建工作区') {
      const path = args[0] ?? botConfig.cwd ?? join(homedir(), '.dsh')
      if (path === '') return '用法：新建工作区 <路径> [标题]（路径须为已存在的目录）'
      let ws: any
      try { ws = await ctx.workspaceRegistry.create(path, args[1] ?? undefined) } catch (e) {
        return '创建工作区失败：' + String(e instanceof Error ? e.message : e) + '（路径须为已存在的目录）'
      }
      botState[chatId] = { workspaceId: ws.id, sessionKey: -1 }
      await saveState()
      await bindAgentSession(chatId, ws, chatSessionId(chatId, ws, 0))
      return '已创建并切换到工作区「' + ws.title + '」（' + ws.path + '），会话 #1 就绪'
    }

    if (cmd === 'new_session' || cmd === '新建会话') {
      let st = botState[chatId]
      let ws = st !== undefined && st.workspaceId !== undefined ? ctx.workspaceRegistry.get(st.workspaceId as never) : undefined
      if (ws === undefined) {
        const path = botConfig.cwd ?? join(homedir(), '.dsh')
        try { ws = await ctx.workspaceRegistry.create(path) } catch (e) { return '请先创建工作区：新建工作区 <路径>' }
        botState[chatId] = { workspaceId: ws.id, sessionKey: -1 }
      }
      const cur = botState[chatId]!
      const key = (cur.sessionKey === undefined ? -1 : cur.sessionKey) + 1
      cur.sessionKey = key
      await saveState()
      await bindAgentSession(chatId, ws, chatSessionId(chatId, ws, key))
      return '已在工作区「' + ws.title + '」新建会话 #' + (key + 1)
    }

    if (cmd === 'change_workspace' || cmd === '切换工作区') {
      const workspaces = ctx.workspaceRegistry.list()
      if (workspaces.length === 0) return '还没有工作区，先：新建工作区 <路径>'
      const arg = args[0]
      if (arg === undefined) {
        const list = workspaces.map((w, i) => (i + 1) + '. ' + w.title + '（' + w.path + '）').join('\n')
        return '现有工作区：\n' + list + '\n回复「切换工作区 <编号/路径>」切换'
      }
      const ws = matchWorkspace(workspaces, arg)
      if (ws === null) return '找不到工作区「' + arg + '」，现有：' + workspaces.map((w) => w.title).join('、')
      botState[chatId] = { workspaceId: ws.id, sessionKey: -1 }
      await saveState()
      await bindAgentSession(chatId, ws, chatSessionId(chatId, ws, 0))
      return '已切换到工作区「' + ws.title + '」（' + ws.path + '）'
    }

    if (cmd === 'change_session' || cmd === '切换会话') {
      const st = botState[chatId]
      if (st === undefined || st.workspaceId === undefined) return '当前没有工作区，先：新建工作区 <路径> 或 切换工作区'
      const ws = ctx.workspaceRegistry.get(st.workspaceId as never)
      if (ws === undefined) return '当前工作区不存在，请重新切换工作区'
      const prefix = 'feishu-' + chatId + '-' + ws.id + '-'
      let sessions = (ws.sessionIds as readonly string[]).filter((id) => String(id).startsWith(prefix))
      if (sessions.length === 0) {
        sessions = ctx.agents.list().filter((a) => String(a.id).startsWith(prefix)).map((a) => String(a.id))
      }
      const arg = args[0]
      if (sessions.length === 0) return '工作区「' + ws.title + '」还没有会话，先：新建会话'
      if (arg === undefined) {
        const list = sessions.map((id, i) => (i + 1) + '. 会话#' + (parseInt(String(id).slice(prefix.length), 10) + 1)).join('\n')
        return '工作区「' + ws.title + '」的会话：\n' + list + '\n回复「切换会话 <编号>」切换'
      }
      let sessionId: string | null = null
      const idx = parseInt(arg, 10)
      if (!Number.isNaN(idx) && idx >= 1 && idx <= sessions.length) sessionId = String(sessions[idx - 1])
      else {
        const m = sessions.find((id) => String(id) === arg || String(id).endsWith(arg))
        if (m !== undefined) sessionId = String(m)
      }
      if (sessionId === null) return '找不到会话「' + arg + '」'
      await bindAgentSession(chatId, ws, sessionId)
      const key = parseInt(sessionId.slice(prefix.length), 10) || 0
      botState[chatId] = { workspaceId: st.workspaceId, sessionKey: key }
      await saveState()
      return '已切换到会话 #' + (key + 1)
    }

    if (cmd === 'help' || cmd === '帮助' || cmd === '菜单') {
      return '可用命令：\n- 新建工作区 <路径> [标题]（路径须已存在）\n- 新建会话\n- 切换工作区 [编号/路径]（仅已创建的工作区）\n- 切换会话 [编号]（仅当前工作区内）\n- 帮助'
    }

    return null
  }

  function extractReply(msgs: any[], before: number): string {
    let out = ''
    for (let i = before; i < msgs.length; i++) {
      const m = msgs[i]
      if (m !== undefined && m !== null && m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b !== undefined && b !== null && b.type === 'text' && typeof b.text === 'string') out += b.text
        }
      }
    }
    return out.trim()
  }

  async function handleMessage(parsed: any): Promise<void> {
    const ev = (parsed !== null && parsed.event) || {}
    const msg = ev.message || {}
    if (msg.message_type !== 'text') return
    let text = ''
    try { text = (JSON.parse(msg.content).text) || '' } catch (e) { text = typeof msg.content === 'string' ? msg.content : '' }
    text = String(text || '').trim()
    const chatId = typeof msg.chat_id === 'string' ? msg.chat_id : ''
    if (text === '' || chatId === '') return
    console.log('[feishu-bot] message from ' + chatId + ': ' + text.slice(0, 100))
    try {
      // Self-heal: if the config was not loaded (e.g. a BOM/parse issue at
      // startup), re-read it and start the bridge on first use.
      if (!(botConfig.app_id && botConfig.app_secret)) {
        await loadConfig()
        if (botConfig.app_id && botConfig.app_secret && bridgeHandle === null && botConfig.websocket !== false) {
          void startBridge().catch(() => undefined)
        }
      }
      const cmdReply = await handleCommand(chatId, text)
      if (cmdReply !== null) {
        await sendText(botConfig, chatId, cmdReply)
        return
      }
      await ensureDefaultState(chatId)
      let entry = chatAgents.get(chatId)
      if (entry === undefined || entry.agent === null) {
        const st = botState[chatId]
        const ws = st !== undefined && st.workspaceId !== undefined ? ctx.workspaceRegistry.get(st.workspaceId as never) : undefined
        if (ws === undefined) return
        const key = st.sessionKey !== undefined && st.sessionKey >= 0 ? st.sessionKey : 0
        if (st.sessionKey === undefined || st.sessionKey < 0) { botState[chatId] = { workspaceId: st.workspaceId, sessionKey: 0 }; await saveState() }
        await bindAgentSession(chatId, ws, chatSessionId(chatId, ws, key))
        entry = chatAgents.get(chatId)
      }
      if (entry === undefined) return
      const agent = entry.agent
      const message = {
        id: 'feishu-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      const before = agent.session.deriveMessages().length
      agent.followup(message)
      await agent.whenIdle()
      const reply = extractReply(agent.session.deriveMessages(), before)
      const max = botConfig.max_reply_chars !== undefined && botConfig.max_reply_chars > 0 ? botConfig.max_reply_chars : 8000
      const finalReply = reply.length > max ? reply.slice(0, max) + '\n…(截断)' : reply
      if (finalReply !== '') {
        await sendText(botConfig, chatId, finalReply)
        console.log('[feishu-bot] replied to ' + chatId + ' (' + finalReply.length + ' chars)')
      } else {
        console.error('[feishu-bot] empty reply for chat ' + chatId)
      }
    } catch (e) {
      console.error('[feishu-bot] handle error: ' + (e instanceof Error ? e.stack : String(e)))
    }
  }

  function serialize(chatId: string, task: () => Promise<void>): Promise<void> {
    const prev = chatLocks.get(chatId) ?? Promise.resolve()
    const run = prev.then(() => task())
    chatLocks.set(chatId, run.catch(() => undefined))
    return run
  }

  // ---------- http helpers ----------
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c as Buffer))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function json(res: ServerResponse, code: number, obj: unknown): void {
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch (e) { /* ignore */ }
  }

  // ---------- routes ----------
  async function eventHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req)
      let parsed: any = null
      try { parsed = JSON.parse(body) } catch (e) { json(res, 400, { code: 400, msg: 'bad json' }); return }
      if (parsed !== null && parsed.type === 'url_verification') {
        json(res, 200, { challenge: parsed.challenge || '' })
        return
      }
      const header = (parsed !== null && parsed.header) || {}
      if (header.event_type === 'im.message.receive_v1') {
        const ev = parsed.event || {}
        const msg = ev.message || {}
        const chatId = typeof msg.chat_id === 'string' ? msg.chat_id : ''
        json(res, 200, { code: 0 })
        void serialize(chatId, () => handleMessage(parsed)).catch((e) => console.error('[feishu-bot] handle error: ' + String(e)))
        return
      }
      json(res, 200, { code: 0 })
    } catch (e) {
      console.error('[feishu-bot] eventHandler error: ' + String(e))
      json(res, 500, { code: 500 })
    }
  }

  async function healthHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, 200, {
      ok: true,
      configured: !!(botConfig.app_id && botConfig.app_secret),
      domain: botConfig.domain ?? 'feishu',
      websocketEnabled: botConfig.websocket !== false,
      agentCount: chatAgents.size,
      bridgeRunning: bridgeHandle !== null,
      stateChats: Object.keys(botState).length,
    })
  }

  async function statusApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    json(res, 200, {
      configured: !!(botConfig.app_id && botConfig.app_secret),
      domain: botConfig.domain ?? 'feishu',
      websocketEnabled: botConfig.websocket !== false,
      agentCount: chatAgents.size,
      bridgeRunning: bridgeHandle !== null,
      configPath: configPath(),
    })
  }

  async function configApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
      json(res, 200, { app_id: botConfig.app_id ?? '', domain: botConfig.domain ?? 'feishu', websocket: botConfig.websocket !== false, cwd: botConfig.cwd ?? '', agent_preset: botConfig.agent_preset ?? '', max_reply_chars: botConfig.max_reply_chars ?? 8000 })
      return
    }
    try {
      const body = await readBody(req)
      const patch = JSON.parse(body) as Record<string, unknown>
      if (typeof patch.app_id === 'string') botConfig.app_id = patch.app_id
      if (typeof patch.app_secret === 'string' && patch.app_secret !== '') botConfig.app_secret = patch.app_secret
      if (typeof patch.domain === 'string' && patch.domain !== '') botConfig.domain = patch.domain
      if (typeof patch.cwd === 'string') botConfig.cwd = patch.cwd
      if (typeof patch.agent_preset === 'string') botConfig.agent_preset = patch.agent_preset
      if (typeof patch.max_reply_chars === 'number') botConfig.max_reply_chars = patch.max_reply_chars
      if (typeof patch.websocket === 'boolean') botConfig.websocket = patch.websocket
      await saveConfig()
      if (bridgeHandle !== null) { try { bridgeHandle.terminate() } catch (e) { /* ignore */ } bridgeHandle = null }
      if (botConfig.websocket !== false && botConfig.app_id && botConfig.app_secret) await startBridge()
      json(res, 200, { ok: true })
    } catch (e) {
      json(res, 400, { ok: false, error: String(e) })
    }
  }

  // ---------- tools ----------
  const renderJson = (value: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  const statusTool = defineTool({
    name: 'lark_status',
    description: 'Check the Feishu/Lark bot plugin status: configured, domain (feishu/lark), websocket bridge running, per-chat agent count. ' +
      'Triggers: 飞书/Lark 机器人状态、机器人配置、查看机器人是否在线.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: renderJson,
    },
    execute: async () => ({
      configured: !!(botConfig.app_id && botConfig.app_secret),
      domain: botConfig.domain ?? 'feishu',
      websocketEnabled: botConfig.websocket !== false,
      agentCount: chatAgents.size,
      bridgeRunning: bridgeHandle !== null,
      configPath: configPath(),
    }),
  })

  const configureTool = defineTool({
    name: 'lark_configure',
    description: 'Write the Feishu/Lark bot config (app_id, app_secret, optional domain feishu|lark|auto, cwd, agent_preset) to ' + configPath() + ' and restart the long-connection bridge. ' +
      'Triggers: 配置飞书/Lark 机器人、填 AppID/AppSecret、重新连接机器人.',
    parameters: {
      app_id: { type: 'string', description: 'Feishu/Lark app id (cli_...) from the developer console.' },
      app_secret: { type: 'string', description: 'Feishu/Lark app secret from the developer console.' },
      domain: { type: 'string', enum: ['auto', 'feishu', 'lark'], description: 'Platform domain. auto probes both (default).' },
      cwd: { type: 'string', description: 'Optional working directory for the bot agents.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: renderJson,
    },
    execute: async (args: { app_id?: string; app_secret?: string; domain?: string; cwd?: string }) => {
      if (args.app_id !== undefined) botConfig.app_id = args.app_id
      if (args.app_secret !== undefined && args.app_secret !== '') botConfig.app_secret = args.app_secret
      if (args.domain !== undefined && args.domain !== '') botConfig.domain = args.domain
      if (args.cwd !== undefined) botConfig.cwd = args.cwd
      if (botConfig.domain === 'auto' || botConfig.domain === undefined || botConfig.domain === '') {
        try {
          const detected = await detectDomain(botConfig)
          botConfig.domain = detected
        } catch (e) { botConfig.domain = 'feishu' }
      }
      await saveConfig()
      if (bridgeHandle !== null) { try { bridgeHandle.terminate() } catch (e) { /* ignore */ } bridgeHandle = null }
      if (botConfig.websocket !== false && botConfig.app_id && botConfig.app_secret) await startBridge()
      return { ok: true, domain: botConfig.domain, configured: !!(botConfig.app_id && botConfig.app_secret), bridgeRunning: bridgeHandle !== null }
    },
  })

  const testTool = defineTool({
    name: 'lark_test',
    description: 'Verify the Feishu/Lark bot credentials and connection: fetch a tenant access token from the detected domain and report bridge state. ' +
      'Triggers: 测试飞书/Lark 机器人、验证凭据、为什么机器人没回复.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: renderJson,
    },
    execute: async () => {
      if (!botConfig.app_id || !botConfig.app_secret) return { ok: false, error: 'not configured; use lark_configure first' }
      const dom = botConfig.domain ?? 'feishu'
      try {
        const t = await tenantToken(hostOf(dom), botConfig)
        return { ok: true, domain: dom, tokenOk: t !== '', bridgeRunning: bridgeHandle !== null, agentCount: chatAgents.size }
      } catch (e) {
        return { ok: false, domain: dom, error: String(e instanceof Error ? e.message : e) }
      }
    },
  })

  // ---------- mount ----------
  if (enabled) {
    if (announce) {
      ctx.systemPrompt.section({ name: 'plugin:dsh-feishu-bot', order: SECTION_ORDER, text: GUIDANCE })
    }
    ctx.effect(() => {
      const disposers = [
        ctx.webServer.register({ kind: 'exact', path: '/feishu/event', handler: eventHandler }),
        ctx.webServer.register({ kind: 'exact', path: '/feishu/health', handler: healthHandler }),
        ctx.webServer.register({ kind: 'exact', path: '/feishu/api/status', handler: statusApi }),
        ctx.webServer.register({ kind: 'exact', path: '/feishu/api/config', handler: configApi }),
      ]
      return () => { for (const d of disposers) d() }
    }, 'dsh-feishu-bot: routes')
    ctx.effect(() => {
      const disposers = [statusTool, configureTool, testTool].map((tool) => ctx.tools.register(tool))
      return () => { for (const d of disposers) d() }
    }, 'dsh-feishu-bot: tools')
    ctx.effect(() => {
      return () => {
        disposed = true
        if (bridgeRestartTimer !== null) { clearTimeout(bridgeRestartTimer); bridgeRestartTimer = null }
        if (bridgeHandle !== null) { try { bridgeHandle.terminate() } catch (e) { /* ignore */ } }
        for (const h of handles) { try { void h.dispose() } catch (e) { /* ignore */ } }
        handles.length = 0
        chatAgents.clear()
        chatLocks.clear()
      }
    }, 'dsh-feishu-bot: teardown')

    void loadConfig().then((c) => {
      if (c.websocket !== false && c.app_id && c.app_secret) void startBridge()
    })
    void loadState()
  }
}

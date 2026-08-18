/**
 * Browser-half entry for the dsh-feishu-bot plugin — runs inside the dsh web GUI.
 *
 * Registers a setup page in the Plugins settings section (settings.plugins.tab):
 * connection status, the developer-console QR code (domain-aware), the
 * AppID/Secret form, and save/test actions. The page talks to the host through
 * the /feishu/api/* routes. DOM failures degrade the panel, never the GUI.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings-surface SlotMap merge (the definitions that
// name the 'settings.*' holes).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the conversation-session header slots
// ('conversation.session.header.utilities' etc.).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import * as React from 'react'

/** Required services. */
export const inject = ['slots']

const FEISHU_CONSOLE = 'https://open.feishu.cn'
const LARK_CONSOLE = 'https://open.larksuite.com'

interface ApiStatus {
  configured?: boolean
  domain?: string
  websocketEnabled?: boolean
  agentCount?: number
  bridgeRunning?: boolean
  configPath?: string
}

interface ApiConfig {
  app_id?: string
  domain?: string
  websocket?: boolean
  cwd?: string
  agent_preset?: string
  max_reply_chars?: number
}

function SetupPanel(): React.ReactElement {
  const [status, setStatus] = React.useState<ApiStatus | null>(null)
  const [cfg, setCfg] = React.useState<ApiConfig>({})
  const [secret, setSecret] = React.useState('')
  const [msg, setMsg] = React.useState('')

  async function refresh(): Promise<void> {
    try {
      const s = await fetch('/feishu/api/status').then((r) => r.json()) as ApiStatus
      const c = await fetch('/feishu/api/config').then((r) => r.json()) as ApiConfig
      setStatus(s)
      setCfg(c)
    } catch (e) {
      setMsg('API 不可用: ' + String(e))
    }
  }

  React.useEffect(() => { void refresh() }, [])

  async function save(): Promise<void> {
    try {
      const patch: Record<string, unknown> = { app_id: cfg.app_id, domain: cfg.domain ?? 'auto', cwd: cfg.cwd ?? '', websocket: true }
      if (secret !== '') patch.app_secret = secret
      const res = await fetch('/feishu/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      setMsg(data.ok === true ? '已保存并重启桥接' : '保存失败: ' + String(data.error ?? ''))
      setSecret('')
      void refresh()
    } catch (e) {
      setMsg('保存失败: ' + String(e))
    }
  }

  const consoleUrl = cfg.domain === 'lark' ? LARK_CONSOLE : FEISHU_CONSOLE
  const qrImg = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(consoleUrl)

  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }
  const label: React.CSSProperties = { width: 110, display: 'inline-block', opacity: 0.75 }
  const input: React.CSSProperties = { flex: 1, minWidth: 220 }

  return React.createElement('div', { style: { maxWidth: 520, padding: '12px 0' } }, [
    React.createElement('h3', { key: 'h' }, 'Feishu/Lark Bot'),
    React.createElement('p', { key: 'desc' }, '长连接接收消息，每个 Lark 会话绑定一个独立 DSH agent，自动回复。无需公网 URL。'),
    React.createElement('div', { key: 'status', style: { background: 'var(--dsh-color-bg-soft, rgba(128,128,128,0.12))', borderRadius: 8, padding: 10, margin: '8px 0' } },
      status === null
        ? '加载中...'
        : [
          '状态: ',
          status.configured === true ? '已配置' : '未配置',
          ' | 域: ' + (status.domain ?? 'auto'),
          ' | 桥接: ' + (status.bridgeRunning === true ? '运行中' : '未运行'),
          ' | 已绑定会话: ' + String(status.agentCount ?? 0),
        ].join(''),
    ),
    React.createElement('div', { key: 'qr', style: { display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0' } }, [
      React.createElement('img', { key: 'q', src: qrImg, width: 120, height: 120, alt: 'console QR', style: { border: '1px solid rgba(128,128,128,0.3)', borderRadius: 8 } }),
      React.createElement('div', { key: 't' }, [
        React.createElement('div', { key: 'l' }, '手机扫码打开开发者后台，创建应用并启用机器人：'),
        React.createElement('a', { key: 'a', href: consoleUrl, target: '_blank', rel: 'noreferrer' }, consoleUrl),
      ]),
    ]),
    React.createElement('div', { key: 'f1', style: row }, [
      React.createElement('label', { key: 'l', style: label }, 'App ID'),
      React.createElement('input', { key: 'i', style: input, value: cfg.app_id ?? '', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, app_id: e.target.value }), placeholder: 'cli_...' }),
    ]),
    React.createElement('div', { key: 'f2', style: row }, [
      React.createElement('label', { key: 'l', style: label }, 'App Secret'),
      React.createElement('input', { key: 'i', style: input, type: 'password', value: secret, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSecret(e.target.value), placeholder: '留空则不修改' }),
    ]),
    React.createElement('div', { key: 'f3', style: row }, [
      React.createElement('label', { key: 'l', style: label }, '平台'),
      React.createElement('select', { key: 's', style: input, value: cfg.domain ?? 'auto', onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setCfg({ ...cfg, domain: e.target.value }) }, [
        React.createElement('option', { key: 'auto', value: 'auto' }, '自动检测（国内外通用）'),
        React.createElement('option', { key: 'feishu', value: 'feishu' }, '飞书 国内 (open.feishu.cn)'),
        React.createElement('option', { key: 'lark', value: 'lark' }, 'Lark 国际 (open.larksuite.com)'),
      ]),
    ]),
    React.createElement('div', { key: 'btns', style: { display: 'flex', gap: 8, marginTop: 10 } }, [
      React.createElement('button', { key: 'save', onClick: () => void save() }, '保存并重启桥接'),
      React.createElement('button', { key: 'refresh', onClick: () => void refresh() }, '刷新状态'),
    ]),
    msg !== '' ? React.createElement('p', { key: 'msg', style: { opacity: 0.8 } }, msg) : null,
  ])
}

/**
 * Session-header "⋯" menu: lock/unlock the current Feishu session as the
 * default notification chat. Persisted host-side via /feishu/api/lock-*.
 */
function LockMenu(props: { sessionId?: string }): React.ReactElement {
  const sessionId = props.sessionId ? String(props.sessionId) : ''
  const [open, setOpen] = React.useState(false)
  const [state, setState] = React.useState({ loading: true, locked: false, chatId: '', error: '', isFeishu: false })

  function refresh(): void {
    setState((s) => ({ ...s, loading: true }))
    void fetch('/feishu/api/lock-status?sessionId=' + encodeURIComponent(sessionId)).then((r) => r.json()).then((v: Record<string, unknown>) => {
      setState({ loading: false, locked: v.locked === true, chatId: String(v.chatId ?? ''), error: String(v.error ?? ''), isFeishu: v.isFeishu === true })
    }).catch((e: unknown) => setState((s) => ({ ...s, loading: false, error: String(e) })))
  }

  React.useEffect(() => { refresh() }, [sessionId])

  function toggle(): void {
    setOpen(false)
    setState((s) => ({ ...s, loading: true }))
    void fetch('/feishu/api/lock-set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, lock: !state.locked }),
    }).then((r) => r.json()).then((v: Record<string, unknown>) => {
      setState({ loading: false, locked: v.locked === true, chatId: String(v.chatId ?? ''), error: String(v.error ?? ''), isFeishu: v.isFeishu === true })
    }).catch((e: unknown) => setState((s) => ({ ...s, loading: false, error: String(e) })))
  }

  const isFeishu = state.isFeishu
  const label = isFeishu ? (state.locked ? '已锁飞书 ✓' : '锁飞书') : '飞书'
  const button = React.createElement('button', {
    key: 'btn',
    onClick: () => { if (isFeishu || state.error !== '') setOpen(!open) },
    title: '飞书默认对话设置\n' + (state.error !== '' ? state.error : isFeishu ? '当前会话为飞书会话' : '当前会话非飞书会话'),
    style: {
      border: '1px solid ' + (state.locked ? '#2e7d32' : '#c0c0c0'),
      borderRadius: 6,
      background: state.locked ? '#e8f5e9' : 'transparent',
      color: state.locked ? '#1b5e20' : '#666',
      fontSize: 12,
      padding: '2px 9px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    },
  }, state.loading ? '…' : label)

  if (!open) return button
  const menuItem = (disabled: boolean): React.CSSProperties => ({
    padding: '8px 12px', fontSize: 13, cursor: disabled ? 'default' : 'pointer',
    color: disabled ? '#999' : '#222', whiteSpace: 'nowrap',
  })
  return React.createElement('div', { key: 'wrap', style: { position: 'relative', display: 'inline-block' } }, [
    button,
    React.createElement('div', {
      key: 'menu',
      style: {
        position: 'absolute', right: 0, top: '100%', zIndex: 1000,
        background: '#fff', border: '1px solid #ddd', borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)', minWidth: 230, padding: '4px 0',
      },
    }, [
      React.createElement('div', { key: 'h', style: menuItem(true) }, isFeishu ? ('会话 ' + shortChat(state.chatId)) : '（当前会话非飞书会话）'),
      React.createElement('div', { key: 'a', onClick: toggle, style: menuItem(false) }, isFeishu ? (state.locked ? '解除飞书默认锁定' : '锁定为飞书默认对话') : '仅飞书会话可用'),
      state.error !== '' ? React.createElement('div', { key: 'e', style: { padding: '6px 12px', fontSize: 11, color: '#c62828' } }, state.error) : null,
    ]),
  ])

  function shortChat(id: string): string {
    if (!id) return ''
    return id.length > 18 ? id.slice(0, 8) + '…' + id.slice(-6) : id
  }
}

/**
 * Mount the setup card into the plugin-configuration section.
 * @param ctx - client root context (slots service).
 */
export function apply(ctx: ClientContext): void {
  try {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.plugins.tab', () => slots.register(
      { name: 'settings.plugins.tab', id: 'feishu-bot', order: 70, label: 'Feishu/Lark Bot' },
      () => React.createElement(SetupPanel),
    ))
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'feishu-lock-menu', order: 20, label: '飞书' },
      (props: { sessionId?: string }) => React.createElement(LockMenu, { sessionId: props.sessionId }),
    ))
  } catch (error) {
    console.warn('[dsh-feishu-bot] setup page mount failed:', error)
  }
}

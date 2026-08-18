// dsh-feishu-bot: Feishu/Lark 长连接事件桥接进程
//
// 通过官方 SDK 的 WebSocket 长连接从飞书/Lark 接收事件，并转发到本机 DSH 的
// /feishu/event 路由，由插件完成 agent 处理与回复（回复仍走 REST API）。
// 无需公网 URL。国内（feishu）与国际（lark）域名均支持。
const Lark = require('@larksuiteoapi/node-sdk')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const appId = process.env.FEISHU_APP_ID || ''
const appSecret = process.env.FEISHU_APP_SECRET || ''
const forwardUrl = process.env.FEISHU_FORWARD_URL || ''
const domain = process.env.FEISHU_DOMAIN || 'feishu'

const logFile = path.join(os.homedir(), '.dsh', 'dsh-feishu-bot', 'bridge.log')
try { fs.mkdirSync(path.dirname(logFile), { recursive: true }) } catch (e) { /* ignore */ }

// 同步追加日志到文件（同时保留终端输出），便于排查
try {
  const fd = fs.openSync(logFile, 'a')
  const append = (s) => { try { fs.writeSync(fd, s) } catch (e) { /* ignore */ } }
  const o = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  process.stdout.write = (c, enc, cb) => { append(c); return o(c, enc, cb) }
  process.stderr.write = (c, enc, cb) => { append(c); return e(c, enc, cb) }
} catch (e) { /* ignore */ }

function log(msg) { console.log(new Date().toISOString() + ' [ws-bridge] ' + msg) }
function err(msg) { console.error(new Date().toISOString() + ' [ws-bridge] ' + msg) }

function forward(data) {
  const msg = (data && data.message) || {}
  const payload = JSON.stringify({
    type: 'event',
    header: { event_type: 'im.message.receive_v1' },
    event: { sender: (data && data.sender) || {}, message: msg },
  })
  let u
  try { u = new URL(forwardUrl) } catch (e) { err('bad forward url: ' + forwardUrl); return }
  const body = Buffer.from(payload, 'utf8')
  const req = http.request({
    hostname: u.hostname,
    port: u.port || 80,
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  }, (res) => { res.resume() })
  req.on('error', (e) => err('forward error: ' + e.message))
  req.write(body)
  req.end()
}

if (!appId || !appSecret) {
  err('missing FEISHU_APP_ID / FEISHU_APP_SECRET')
  process.exit(2)
}
if (!forwardUrl) {
  err('missing FEISHU_FORWARD_URL')
  process.exit(2)
}

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const msg = (data && data.message) || {}
    if (msg.message_type !== 'text') return
    log('received text from chat ' + (msg.chat_id || ''))
    forward(data)
  },
  // 交互卡片按钮点击（长连接模式下以事件送达）
  'card.action.trigger': async (data) => {
    log('received card action')
    forwardCard(data)
  },
})

function forwardCard(data) {
  const payload = JSON.stringify({
    type: 'card',
    header: { event_type: 'card.action.trigger' },
    event: data || {},
  })
  let u
  try { u = new URL(forwardUrl) } catch (e) { err('bad forward url: ' + forwardUrl); return }
  const body = Buffer.from(payload, 'utf8')
  const req = http.request({
    hostname: u.hostname,
    port: u.port || 80,
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
  }, (res) => { res.resume() })
  req.on('error', (e) => err('forward error: ' + e.message))
  req.write(body)
  req.end()
}

// Domain 是 SDK 的数字枚举（Feishu=0 / Lark=1），传字符串会让 formatDomain
// 落到 default 分支，导致 ws 端点 URL 非法（Invalid URL）。这里做转换。
const client = new Lark.WSClient({
  appId: appId,
  appSecret: appSecret,
  domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.info,
})

log('connecting (appId=' + appId + ', domain=' + domain + '), forward -> ' + forwardUrl)
const started = client.start({ eventDispatcher })
if (started && typeof started.catch === 'function') {
  started.catch((e) => { err('start failed: ' + (e && e.stack ? e.stack : e)); process.exit(1) })
}

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

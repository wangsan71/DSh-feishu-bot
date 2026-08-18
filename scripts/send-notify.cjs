#!/usr/bin/env node
// send-notify.cjs — send a Feishu/Lark notification from any environment
// WITHOUT encoding issues (the one-for-all fix).
//
// WHY NODE (not PowerShell)
//   - On Windows, Node receives argv as UTF-16LE, so CJK arguments survive
//     regardless of the console code page (PowerShell 5.1 decodes -File args
//     as the ANSI/GBK code page and mangles Chinese into "?????").
//   - Node's fs/http are UTF-8 end-to-end, same as the plugin's own bridge.
//   - This script is the companion to the plugin's `lark_notify` tool (which
//     is the recommended path for agents); use this script for shell/manual
//     notifications.
//
// USAGE
//   node scripts/send-notify.cjs --text "你好，世界"
//   node scripts/send-notify.cjs --text "完成" --workspace "DSh-Plug" --session "会话1"
//   node scripts/send-notify.cjs --text "hi" --chat-id "oc_xxx"
//   node scripts/send-notify.cjs --text "file content" --text-file "C:/path/msg.txt"
//
// FLAGS
//   --text         notification content (the [内容] part). Required unless --text-file.
//   --text-file    read content from a UTF-8 file instead of --text.
//   --workspace    optional [工作区] label (defaults to config cwd basename).
//   --session      optional [对话] label.
//   --chat-id      optional target chat_id/open_id (defaults to config
//                  notify_chat_id, then the first chat in the state file).
//   --config       optional config file (default ~/.dsh/dsh-feishu-bot.json).
//   --domain       optional 'feishu' | 'lark' (defaults to config domain).

'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}
function has(name) {
  return process.argv.indexOf('--' + name) >= 0
}

const configPath = arg('config', path.join(os.homedir(), '.dsh', 'dsh-feishu-bot.json'))
const statePath = path.join(os.homedir(), '.dsh', 'dsh-feishu-bot-state.json')

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(raw)
  } catch (e) {
    return null
  }
}

const cfg = readJson(configPath)
if (!cfg || !cfg.app_id || !cfg.app_secret) {
  console.error('config not found / app_id+app_secret missing:', configPath)
  process.exit(1)
}

const domain = arg('domain') || cfg.domain || 'feishu'
const hostBase = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'

function httpsJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function main() {
  // Content: --text-file wins, else --text.
  let text = ''
  const textFile = arg('text-file')
  if (textFile) {
    text = fs.readFileSync(textFile, 'utf8').replace(/^\uFEFF/, '').trim()
  } else {
    text = arg('text').trim()
  }
  if (!text) {
    console.error('empty content: pass --text or --text-file')
    process.exit(1)
  }

  // Target chat: --chat-id > config notify_chat_id > first chat in state.
  let chatId = arg('chat-id')
  if (!chatId && cfg.notify_chat_id) chatId = cfg.notify_chat_id
  if (!chatId) {
    const state = readJson(statePath)
    if (state) {
      const keys = Object.keys(state)
      if (keys.length > 0) chatId = keys[0]
    }
  }
  if (!chatId) {
    console.error('no target chat: pass --chat-id or set notify_chat_id in', configPath)
    process.exit(1)
  }

  // Labels.
  let workspace = arg('workspace')
  if (!workspace && cfg.cwd) workspace = path.basename(cfg.cwd)
  if (!workspace) workspace = 'unknown-workspace'
  let session = arg('session')
  if (!session) session = 'unknown-session'

  const payloadText = `[${workspace}]-[${session}]：${text}`
  const receiveIdType = chatId.startsWith('ou_') ? 'open_id' : 'chat_id'

  // Token.
  const tok = await httpsJson(hostBase + '/open-apis/auth/v3/tenant_access_token/internal', {},
    JSON.stringify({ app_id: cfg.app_id, app_secret: cfg.app_secret }))
  if (tok.code !== 0 || !tok.tenant_access_token) {
    console.error('token failed:', tok.code, tok.msg)
    process.exit(1)
  }

  // Send.
  const msg = JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: payloadText }) })
  const res = await httpsJson(hostBase + '/open-apis/im/v1/messages?receive_id_type=' + receiveIdType,
    { Authorization: 'Bearer ' + tok.tenant_access_token }, msg)
  if (res.code !== 0) {
    console.error('send failed:', res.code, res.msg)
    process.exit(1)
  }
  console.log('sent to ' + chatId + ' (msg_id=' + (res.data && res.data.message_id) + ')')
  console.log('text: ' + payloadText)
}

main().catch((e) => { console.error(e); process.exit(1) })

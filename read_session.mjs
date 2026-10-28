// read_session.mjs —— 在独立的 Node 进程里解压 + 解析一个 DSH 会话，stdout 输出 JSON。
//
// 为什么不直接在插件里解：DSH 宿主内嵌的 Node 版本，zstdDecompressSync 只解第一帧
// （实测：47 万行的事件只返回 1 行 session 头）。本机 D:\node 的 Node v24 能完整解，
// 所以插件 spawn 这个脚本，把「解压」交给它。

import fs from 'node:fs'
import zlib from 'node:zlib'

// --heads 模式：批量读会话头（id / cwd / createdAt / 事件数），给 list 用。
// 一次 spawn 处理多个文件，比每个会话起一次进程便宜。
if (process.argv[2] === '--heads') {
  const files = process.argv.slice(3)
  const out = []
  for (const f of files) {
    try {
      const buf = zlib.zstdDecompressSync(fs.readFileSync(f))
      const text = buf.toString('utf8')
      const first = text.split('\n')[0]
      const o = JSON.parse(first)
      out.push({
        file: f,
        id: o.id,
        cwd: o.cwd,
        createdAt: o.createdAt,
        lines: text.split('\n').filter((x) => x.trim()).length,
      })
    } catch (e) {
      out.push({ file: f, error: String((e && e.message) || e) })
    }
  }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

const SINGLE = new Set(['做', '跑', '写', '好', '快', '来', '查', '看', '试', '改', '装', '删', '发', '问', '读', '想', '停', '换', '再', '对', '行', '嗯', '唔', '开', '修', '弄', '收', '记', '等', '走'])

function shortCount(reasoning) {
  if (!reasoning) return 0
  let n = 0
  for (const p of reasoning.split(/[。！？\n]+/)) {
    const s = p.trim()
    if (s.length >= 1 && s.length <= 3 && SINGLE.has(s[0])) n++
  }
  return n
}

const file = process.argv[2]
if (!file) { console.error('usage: read_session.mjs <session.v4.jsonl.zstd>'); process.exit(2) }

let buf
try {
  const raw = fs.readFileSync(file)
  if (raw.length > 60 * 1024 * 1024) {
    console.error('会话文件过大: ' + Math.round(raw.length / 1048576) + 'MB')
    process.exit(4)
  }
  buf = zlib.zstdDecompressSync(raw)
  if (buf.length > 300 * 1024 * 1024) {
    console.error('解压后过大: ' + Math.round(buf.length / 1048576) + 'MB')
    process.exit(5)
  }
} catch (e) {
  console.error('zstd 解压失败: ' + (e && e.message))
  process.exit(3)
}

const lines = buf.toString('utf8').split('\n').filter((x) => x.trim())
let meta = null
const users = []
const asst = []
const tools = []
let pendingUsers = []
let lastTurn = 0

for (const l of lines) {
  let o
  try { o = JSON.parse(l) } catch { continue }
  const d = o.data || {}
  if (o.type === 'session') { meta = { id: o.id, cwd: o.cwd, createdAt: o.createdAt }; continue }
  if (o.type === 'user/message') {
    const kind = d.source && d.source.kind
    if (kind && kind !== 'user') continue
    const t = (d.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join(' ').trim()
    if (!t) continue
    pendingUsers.push({ turn: null, time: o.time, text: t })
  } else if (o.type === 'assistant/message') {
    if (d.turn) lastTurn = d.turn
    for (const u of pendingUsers) u.turn = d.turn || lastTurn
    users.push(...pendingUsers)
    pendingUsers = []
    const m = d.message || {}
    const parts = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('').trim()
    const rs = (m.content || []).filter((c) => c.type === 'reasoning').map((c) => c.text || '').join('\n')
    asst.push({ turn: d.turn || 0, step: d.step || 0, time: o.time, text: parts, short: shortCount(rs) })
  } else if (o.type === 'tool/call') {
    tools.push({ turn: d.turn || 0, step: d.step || 0, time: o.time, name: d.name || '?', args: String(d.arguments || '') })
  }
}
for (const u of pendingUsers) u.turn = lastTurn
users.push(...pendingUsers)

// 只输出够用的字段，避免几十 MB 过管道
const out = {
  meta,
  lines: lines.length,
  bytes: buf.length,
  users,
  asst: asst.map((a) => ({ turn: a.turn, step: a.step, time: a.time, text: a.text.slice(0, 2000), short: a.short })),
  tools: tools.map((t) => ({ turn: t.turn, step: t.step, time: t.time, name: t.name, args: t.args.slice(0, 500) })),
}
process.stdout.write(JSON.stringify(out))

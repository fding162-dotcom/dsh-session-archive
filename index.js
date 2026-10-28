// dsh-session-archive —— DSH 会话档案库
//
// 用途：DSH 长会话退化（单字循环、上下文过长）之后，使用者开一个新会话，
// 新会话用 session_archive 工具从旧会话里取出「发生过什么」，等于把上下文
// 从单会话扩展到「一条会话链」。旧会话只读，永远不写。
//
// 实现要点：
// - DSH 会话文件：~/.dsh/sessions/<工作区转义名>/<会话id>/session.v4.jsonl.zstd
// - 解压交给独立的 Node 进程（read_session.mjs）：宿主内嵌的 Node 版本，
//   zstdDecompressSync 只解第一帧（2026-10-28 实测：45570 条事件只解出 1 行），
//   本机 D:\node 的 v24 能完整解，所以 spawn 出去解，再把精简后的 JSON 收回来
// - 只读；路径必须落在 sessionsRoot 里
// - 附带退化体检：量化 reasoning 里「做。」「跑。」这类单字句的密度

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'xiaolian-session-archive'
export const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_COMPRESSED = 60 * 1024 * 1024 // 单个会话压缩包上限（超过先不解，防内存炸）
const MAX_DECOMPRESSED = 200 * 1024 * 1024
const SESSION_FILE = 'session.v4.jsonl.zstd'
const LIST_DETAIL_LIMIT = 12 * 1024 * 1024 // list 时只给 12MB 内的会话带事件数

// 「单字循环」词表：这是从 2026-10-28 那个 844 轮长会话里实测出来的高频单字
const SINGLE = new Set(['做', '跑', '写', '好', '快', '来', '查', '看', '试', '改', '装', '删', '发', '问', '读', '想', '停', '换', '再', '对', '行', '嗯', '唔', '开', '修', '弄', '收', '记', '等', '走'])

const text = (t) => [{ type: 'text', text: t }]

function dshSessionsRoot(config) {
  if (config && config.sessionsRoot) return String(config.sessionsRoot)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'sessions')
}

/** 把工作区路径转成 DSH 的会话目录名：D:\deepseek AI -> --D-deepseek~0020AI-- */
function escapeWorkdir(p) {
  // DSH 规则：盘符的冒号直接去掉，斜杠变横线，其余非 [A-Za-z0-9_-] 转成 ~XXXX。
  // 例：D:\deepseek AI -> --D-deepseek~0020AI--
  const s = String(p).replace(/\\/g, '/')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === ':') continue
    if (ch === '/') out += '-'
    else if (/[A-Za-z0-9_-]/.test(ch)) out += ch
    else out += '~' + s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return '--' + out + '--'
}

function fmtTime(ms) {
  if (!ms) return '-'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + 'KB'
  return n + 'B'
}

/** 列出某工作区下的所有会话（按最后修改时间倒序） */
function listSessions(root, workspace) {
  const dirs = []
  if (workspace) {
    const d = path.join(root, escapeWorkdir(workspace))
    if (fs.existsSync(d)) dirs.push(d)
  }
  if (dirs.length === 0 && fs.existsSync(root)) {
    for (const n of fs.readdirSync(root)) {
      const d = path.join(root, n)
      try { if (fs.statSync(d).isDirectory()) dirs.push(d) } catch {}
    }
  }
  const out = []
  for (const base of dirs) {
    let entries = []
    try { entries = fs.readdirSync(base) } catch { continue }
    for (const e of entries) {
      const file = path.join(base, e, SESSION_FILE)
      try {
        const st = fs.statSync(file)
        // DSH 的主会话目录叫 session-<id>；子智能体（subagent）的是裸 <id>。
        // 先按目录名判一次，这样连解压都不用就能把两类分开。
        out.push({ id: e.replace(/^session-/, ''), dirName: e, sub: !e.startsWith('session-'), workspaceDir: path.basename(base), file, mtime: st.mtimeMs, size: st.size })
      } catch {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

function shortCount(reasoning) {
  if (!reasoning) return 0
  let n = 0
  for (const p of reasoning.split(/[。！？\n]+/)) {
    const s = p.trim()
    if (s.length >= 1 && s.length <= 3 && SINGLE.has(s[0])) n++
  }
  return n
}


/** 找一个能跑脚本的 node：
 *  - Electron 打包的 DSH 里 process.execPath 是 "DeepSeek Harness.exe"，拿它跑脚本只会再开一个 DSH，
 *    所以只有 basename 确实是 node 时才用它；否则走 PATH / 常见安装位置。
 */
let cachedNodePath = null
function resolveNodePath(config = {}) {
  if (config.nodePath) return config.nodePath
  if (cachedNodePath) return cachedNodePath
  const exe = process.execPath || ''
  const base = path.basename(exe).toLowerCase()
  if (base === 'node' || base === 'node.exe') return (cachedNodePath = exe)
  const cands = ['C:/Program Files/nodejs/node.exe',
                 'C:/Program Files (x86)/nodejs/node.exe',
                 path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
                 'D:/node',
                 'C:/node/node.exe']
  for (const c of cands) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return (cachedNodePath = c) } catch {}
  }
  return (cachedNodePath = 'node')
}

/** 读到几乎空的会话时明确提示：可能是刚创建，或者 DSH 正在重写这个文件 */
function sparseTip(d) {
  if (!d || typeof d.lines !== 'number') return d
  const noTalk = !(d.users && d.users.length) && !(d.asst && d.asst.length)
  if (!d.degraded && (d.lines < 3 || noTalk)) {
    d.degraded = true
    d.note = noTalk
      ? `这个会话里没有对话内容（只有 ${d.lines} 条事件）——可能是建了没用的空会话，或者 DSH 正在重写它。用 list 挑一个别的，或等几秒再试。`
      : `这个会话现在几乎是空的（${d.lines} 条事件）——可能刚创建，或者 DSH 正在重写它。过几秒再 digest 一次。`
  }
  return d
}

/** 解压 + 解析一个会话：优先 spawn 独立 Node（宿主 zlib 只解第一帧），失败再退回本地解压 */
function loadSession(file, config = {}) {
  const st = fs.statSync(file)
  if (st.size > MAX_COMPRESSED) throw new Error(`会话压缩包 ${fmtSize(st.size)} 超过上限 ${fmtSize(MAX_COMPRESSED)}`)

  const nodePath = resolveNodePath(config)
  const helper = path.join(HERE, 'read_session.mjs')
  if (fs.existsSync(helper)) {
    const r = spawnSync(nodePath, [helper, file], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true,
    })
    if (!r.error && r.status === 0 && r.stdout) {
      try {
        const parsed = JSON.parse(r.stdout)
        if (parsed && typeof parsed === 'object') return sparseTip(parsed)
      } catch {}
    }
    // 失败就退回本地解压，但要标记 degraded——宿主 Node 可能只解第一帧，
    // 静默给出「一条事件」比报错更糟，所以由调用方在输出里明说。
    const why = r.error ? r.error.message : String(r.stderr || '').slice(0, 120)
    const d = loadSessionLocal(file, st)
    d.degraded = true
    d.note = `独立 Node 解压失败（${why}），已退回宿主内解压，内容可能不完整`
    return sparseTip(d)
  }
  return sparseTip(loadSessionLocal(file, st))
}

/** 本地解压（宿主 Node 版本可能只解第一帧；仅作兜底） */
function loadSessionLocal(file, st) {
  const size = st ? st.size : fs.statSync(file).size
  if (size > MAX_COMPRESSED) throw new Error(`会话压缩包 ${fmtSize(size)} 超过上限`)
  const buf = zlib.zstdDecompressSync(fs.readFileSync(file))
  if (buf.length > MAX_DECOMPRESSED) throw new Error(`解压后 ${fmtSize(buf.length)} 超过上限`)
  const lines = buf.toString('utf8').split('\n').filter((x) => x.trim())

  let meta = null
  const users = []
  const asst = []
  const tools = []
  // user/message 没有 turn 字段：先挂起，等下一条 assistant 出现时把 turn 补上
  let pendingUsers = []
  let lastTurn = 0
  for (const l of lines) {
    let o
    try { o = JSON.parse(l) } catch { continue }
    const d = o.data || {}
    if (o.type === 'session') { meta = { id: o.id, cwd: o.cwd, createdAt: o.createdAt }; continue }
    if (o.type === 'user/message') {
      const kind = d.source && d.source.kind
      // 只要真人说的话（source.kind === 'user'）；工具结果、运行时上下文不算
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
  // 结尾还没等到 assistant 的用户消息，挂到最后一轮
  for (const u of pendingUsers) u.turn = lastTurn
  users.push(...pendingUsers)
  return { meta, users, asst, tools, bytes: buf.length, lines: lines.length }
}

/** 退化体检：最近 N 条 assistant 的单字句密度（short 由 helper 算好） */
function degeneration(asst, window = 30) {
  const recent = asst.slice(-window)
  const all = asst.reduce((s, a) => s + (a.short || 0), 0)
  const rec = recent.reduce((s, a) => s + (a.short || 0), 0)
  const perMsg = recent.length ? rec / recent.length : 0
  let level = '正常'
  if (perMsg >= 5) level = '严重（已经在滑）'
  else if (perMsg >= 1) level = '偏高（开始出现）'
  else if (perMsg > 0) level = '轻微'
  return {
    totalShort: all,
    recentShort: rec,
    recentWindow: recent.length,
    perMessage: Number(perMsg.toFixed(2)),
    level,
  }
}

/** 挑一个会话：给 id 就找 id；self=true 取最新；否则跳过最新（那通常就是正在说话的当前会话） */
function pickSession(sessions, sessionId, self) {
  if (!sessions.length) return null
  if (sessionId) {
    const key = String(sessionId).replace(/^session-/, '')
    const hit = sessions.find((s) => s.id === key || s.dirName === String(sessionId) || s.dirName === key)
    // 给了 id 却找不到：返回 null，让调用方明确报错，别悄悄换成别的会话
    return hit || null
  }
  if (self) return sessions[0]
  return sessions[1] || sessions[0]
}

/** 批量读会话头（创建时间 / 事件数）：一次 spawn 处理多个文件 */
function readHeads(files, config = {}) {
  if (!files.length) return []
  const nodePath = resolveNodePath(config)
  const helper = path.join(HERE, 'read_session.mjs')
  // 分批 spawn：几百个会话一次性塞进命令行会撞上 Windows 命令行长度上限，
  // 那样整批都会失败，所有会话的时间/条数就全空了。
  const BATCH = 40
  const out = []
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const r = spawnSync(nodePath, [helper, '--heads', ...batch], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true,
    })
    if (r.error || r.status !== 0 || !r.stdout) continue
    try {
      const arr = JSON.parse(r.stdout)
      if (Array.isArray(arr)) out.push(...arr)
    } catch {}
  }
  return out
}

/** 会话头缓存文件：默认放 DSH_HOME 下，可用 config.cacheFile 覆盖 */
function cacheFilePath(config = {}) {
  if (config.cacheFile) return String(config.cacheFile)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'session-archive-cache.json')
}

function loadHeadCache(config) {
  try { return JSON.parse(fs.readFileSync(cacheFilePath(config), 'utf8')) || {} } catch { return {} }
}

function saveHeadCache(config, cache) {
  try {
    const f = cacheFilePath(config)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(cache), 'utf8')
  } catch {}
}

/** 给会话补 createdAt / lines：先查缓存，缺的才批量解压。第一次慢，之后秒出 */
function fillHeads(sessions, config) {
  const cache = loadHeadCache(config)
  const missing = []
  for (const s of sessions) {
    const c = cache[s.file]
    if (c && c.mtimeMs === s.mtime && c.size === s.size) {
      s.createdAt = c.createdAt ?? null
      s.lines = c.lines ?? null
      s.origin = c.origin ?? null
      s.parentSession = c.parentSession ?? null
      s.subLabel = c.label ?? null
      if (s.origin === 'subagent') s.sub = true
    } else {
      missing.push(s)
    }
  }
  if (missing.length) {
    const heads = readHeads(missing.map((s) => s.file), config)
    const now = Date.now()
    for (const h of heads) {
      if (h.error) continue
      const s = missing.find((x) => x.file === h.file)
      cache[h.file] = {
        mtimeMs: s ? s.mtime : now,
        size: s ? s.size : 0,
        createdAt: h.createdAt ?? null,
        lines: h.lines ?? null,
        origin: h.origin ?? null,
        parentSession: h.parentSession ?? null,
        label: h.label ?? null,
        cachedAt: now,
      }
      if (s) {
        s.createdAt = h.createdAt ?? null
        s.lines = h.lines ?? null
        s.origin = h.origin ?? null
        s.parentSession = h.parentSession ?? null
        s.subLabel = h.label ?? null
        if (s.origin === 'subagent') s.sub = true
      }
    }
    const keys = Object.keys(cache)
    if (keys.length > 500) {
      keys.sort((x, y) => (cache[x].cachedAt || 0) - (cache[y].cachedAt || 0))
      for (const k of keys.slice(0, keys.length - 500)) delete cache[k]
    }
    saveHeadCache(config, cache)
  }
  return sessions
}

/** 批量捞会话开头的接续块（上一代候选 + 块的时间）。链的原料就是它 */
function readEdges(files, config = {}) {
  if (!files.length) return []
  const nodePath = resolveNodePath(config)
  const helper = path.join(HERE, 'read_session.mjs')
  // 每个会话都要完整解压一遍，比 heads 重，批次小一点，别把超时撞穿。
  const BATCH = 12
  const out = []
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    const r = spawnSync(nodePath, [helper, '--edges', ...batch], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 180000,
      windowsHide: true,
    })
    if (r.error || r.status !== 0 || !r.stdout) continue
    try {
      const arr = JSON.parse(r.stdout)
      if (Array.isArray(arr)) out.push(...arr)
    } catch {}
  }
  return out
}

/** 链的缓存：算一次存下来，之后按 mtime/size 增量更新 */
function chainCachePath(config = {}) {
  if (config.chainCacheFile) return String(config.chainCacheFile)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'session-archive-chains.json')
}

function loadChainCache(config) {
  try { return JSON.parse(fs.readFileSync(chainCachePath(config), 'utf8')) || {} } catch { return {} }
}

function saveChainCache(config, cache) {
  try {
    const f = chainCachePath(config)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(cache), 'utf8')
  } catch {}
}

/** 谁接谁的班。返回 { parentOf: Map(子 -> 父), weak: Set(靠时间推出来的那些) } */
function buildParentMap(sessions, config = {}) {
  const cache = loadChainCache(config)
  const missing = []
  for (const s of sessions) {
    const c = cache[s.file]
    if (c && c.mtimeMs === s.mtime && c.size === s.size) {
      s.blockTime = c.blockTime ?? null
      s.candidates = Array.isArray(c.candidates) ? c.candidates : []
    } else missing.push(s)
  }
  if (missing.length) {
    const edges = readEdges(missing.map((s) => s.file), config)
    const now = Date.now()
    for (const e of edges) {
      if (e.error) continue
      const s = missing.find((x) => x.file === e.file)
      cache[e.file] = {
        mtimeMs: s ? s.mtime : now,
        size: s ? s.size : 0,
        blockTime: e.blockTime ?? null,
        candidates: e.candidates || [],
        cachedAt: now,
      }
      if (s) { s.blockTime = e.blockTime ?? null; s.candidates = e.candidates || [] }
    }
    saveChainCache(config, cache)
  }
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const parentOf = new Map()
  const weak = new Set()
  for (const s of sessions) {
    // 一档：子会话自带 parentSession，这是硬边
    if (s.sub && s.parentSession) {
      parentOf.set(s.id, String(s.parentSession).replace(/^session-/, ''))
      continue
    }
    // 二档：接续块里当时最近的那几个 id 里，早于块时间、离得最近的那个
    if (s.blockTime && s.candidates && s.candidates.length) {
      const cands = s.candidates
        .map((id) => byId.get(id))
        .filter((x) => x && x.id !== s.id && !x.sub && x.createdAt && x.createdAt < s.blockTime)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      if (cands.length) { parentOf.set(s.id, cands[0].id); continue }
    }
    // 三档：没有块，就找「在我开张之前刚刚停下」的那个。用上一代的结束时间配这一代的
    // 开始时间，比拿两边的开张时间互相比靠谱。这是推的，渲染时标出来。
    const prev = sessions
      .filter((x) => x.id !== s.id && !x.sub && x.createdAt && x.mtime
        && x.mtime < s.createdAt && x.mtime > s.createdAt - 24 * 3600 * 1000)
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0]
    if (prev) { parentOf.set(s.id, prev.id); weak.add(s.id) }
  }
  return { parentOf, weak }
}

/** 输出硬上限：不管条目多少，总字符数封顶，防止一次输出把上下文冲掉 */
const MAX_OUTPUT_CHARS = 12000
function clampText(s, max = MAX_OUTPUT_CHARS) {
  const t = String(s == null ? '' : s)
  if (t.length <= max) return t
  return t.slice(0, max) + `
…（输出共 ${t.length} 字，已截断到 ${max}；想看的更准就缩条件：list/search 传更窄的关键词、digest 减 count）`
}


/** 不填 id 时落到了空会话上，就往更早的会话找，最多找 3 个 */
function skipEmptySession(sessions, target, d, specified) {
  if (specified) return { target, d }
  const noTalk = !(d.users && d.users.length) && !(d.asst && d.asst.length)
  if (!noTalk) return { target, d }
  const idx = sessions.findIndex((s) => s.file === target.file)
  if (idx < 0) return { target, d }
  for (let k = idx + 1; k < sessions.length && k <= idx + 3; k++) {
    try {
      const nd = loadSession(sessions[k].file, {})
      if ((nd.users && nd.users.length) || (nd.asst && nd.asst.length)) {
        nd.degraded = true
        nd.note = `（已跳过空会话 ${target.id}，这条来自 ${sessions[k].id}）`
        return { target: sessions[k], d: nd }
      }
    } catch {}
  }
  return { target, d }
}


/** 拼一条时间线：最近 N 个会话，每个带最后一句/最后回复/最后动作 */
function buildTimeline(root, workspace, config, limit = 10) {
  const all = listSessions(root, workspace)
  // 子智能体的会话不是「上一个我」，接续块里默认不混进来；想看就传 includeSubagents
  const sessions = (config && config.includeSubagents ? all : all.filter((x) => !x.sub)).slice(0, limit)
  const now = Date.now()
  const out = []
  for (const s of sessions) {
    let d
    try { d = loadSession(s.file, config) } catch { continue }
    const lastUser = d.users.length ? d.users[d.users.length - 1] : null
    const lastAsst = [...d.asst].reverse().find((x) => x.text)
    out.push({
      id: s.id,
      mtime: s.mtime,
      minutesAgo: Math.round((now - s.mtime) / 60000),
      turns: d.asst.length ? Math.max(...d.asst.map((x) => x.turn)) : 0,
      events: d.lines,
      lastUser: lastUser ? oneLine(lastUser.text, 100) : '',
      lastAssistant: lastAsst ? oneLine(lastAsst.text, 100) : '',
      lastTool: d.tools.length ? d.tools[d.tools.length - 1].name : '',
    })
  }
  return out
}

/** 把时间线渲染成给模型看的一小段（启动提示用） */
function renderTimelineBrief(tl) {
  if (!tl || !tl.length) return ''
  const when = (m) => (m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前')
  return tl.map((s) => {
    const lines = ['▸ ' + when(s.minutesAgo) + ' · ' + s.id + (s.sub ? '（子智能体会话）' : '') + ' · ' + s.turns + ' 轮']
    if (s.lastUser) lines.push('  对方：' + s.lastUser)
    if (s.lastAssistant) lines.push('  回复：' + s.lastAssistant)
    if (s.lastTool) lines.push('  最后动作：' + s.lastTool)
    return lines.join('\n')
  }).join('\n\n')
}

// 从交接目录里捞「还欠着的事」：最新几份 handoff 的小标题 + 带待办关键词的行。
// 为什么要有它：只告诉新会话「上一句在说啥」不够——真正丢的是「还欠着什么」，
// 那东西是上一次收工写在 handoff 里的，不主动翻就永远看不到。
// 通用设计：目录、份数、行数都能配置；只读不写，不假设任何人设或项目结构。
const PENDING_HINT = /(待办|TODO|未完成|下一步|还欠|欠着|待做|待验证|做不到|剩下)/i

function readPendingBrief(workspace, config = {}) {
  const ws = workspace || (process.cwd ? process.cwd() : '')
  if (!ws) return ''
  const dirs = (Array.isArray(config.handoffDirs) && config.handoffDirs.length
    ? config.handoffDirs
    : ['state/handoff', 'state/handoffs', 'docs/handoff']).slice(0, 5)
  const maxFiles = Math.max(1, Math.min(Number(config.handoffFiles) || 2, 5))
  const maxLines = Math.max(3, Math.min(Number(config.handoffLines) || 6, 12))
  const picked = []
  for (const d of dirs) {
    const abs = path.isAbsolute(String(d)) ? String(d) : path.join(ws, String(d))
    let names = []
    try { names = fs.readdirSync(abs) } catch { continue }
    const files = names
      .filter((n) => /\.(md|txt)$/i.test(n))
      .map((n) => {
        const f = path.join(abs, n)
        try { return { f, n, t: fs.statSync(f).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t)
    for (const file of files) {
      let raw = ''
      try { raw = fs.readFileSync(file.f, 'utf8') } catch { continue }
      const all = raw.split(/\r?\n/)
      const lines = []
      const title = all.find((l) => l.trim() && !l.startsWith('---'))
      if (title) lines.push(title.replace(/^#+\s*/, '').trim())
      for (let i = 0; i < all.length; i++) {
        if (lines.length > maxLines) break
        const l = all[i]
        if (!PENDING_HINT.test(l)) continue
        const clean = l.replace(/^#+\s*/, '').replace(/^\s*[-*]\s*/, '').trim()
        if (clean.length > 2 && !lines.includes(clean)) lines.push(clean)
        // 命中的是小标题：把它下面的正文一起带上（遇到下一个标题就停）
        if (/^\s*#/.test(l)) {
          for (let j = i + 1; j < all.length && lines.length <= maxLines; j++) {
            const nx = all[j].trim()
            if (!nx) continue
            if (/^#/.test(nx)) break
            const c = nx.replace(/^\s*[-*]\s*/, '').trim()
            if (c && !lines.includes(c)) lines.push(c)
          }
        }
      }
      if (lines.length <= 1) continue
      picked.push({ rel: path.relative(ws, file.f).replace(/\\/g, '/'), lines: lines.slice(0, maxLines + 1) })
      if (picked.length >= maxFiles) break
    }
    if (picked.length >= maxFiles) break
  }
  if (!picked.length) return ''
  return picked.map((p) => '· ' + p.rel + '\n' + '  ' + p.lines.join('\n  ')).join('\n')
}

function oneLine(s, n = 200) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

function buildTool(config = {}) {
  return {
    name: 'session_archive',
    description:
      '会话档案库：把同一工作区的旧 DSH 会话当储存区，读上一个会话里发生过什么。' +
      '用于长会话退化（单字循环、上下文过长）后开新会话接续：先 list 看有哪些会话，再 digest 取摘要（对方说过什么、最后在做什么、退化程度），' +
      'timeline 按时间列出最近几个会话、每个带最后一句和最后动作（想知道「刚才在做什么」用这个），' + 'read 取更细的对话，search 按关键词找。旧会话只读不写。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'timeline', 'digest', 'read', 'search', 'stats', 'live', 'chain'], description: 'list 列会话 / timeline 时间线（每个会话带最后一句和最后动作）/ chain 会话链（谁接谁的班、往上几代往下一代）/ digest 摘要 / read 读对话 / search 搜关键词 / stats 总览 / live 看最近哪些会话活着' },
        sessionId: { type: 'string', description: '会话 id（可带 session- 前缀）；不填时 digest/read 会跳过最新那个（通常是当前会话），取上一个' },
        count: { type: 'number', description: 'digest 里带几条对话/动作，read 里取几条；默认 12/10/40' },
        up: { type: 'number', description: 'chain：往上追几代，默认 5' },
        down: { type: 'number', description: 'chain：往下看几代，默认 3' },
        query: { type: 'string', description: 'search 的关键词' },
        maxSessions: { type: 'number', description: 'search 最多翻几个会话，默认 5' },
        context: { type: 'number', description: 'search 用：命中行前后各带几条上下文（0~5，默认 0）' },
        minutes: { type: 'number', description: 'live 用：看最近多少分钟内有动静的会话，默认 10' },
        self: { type: 'boolean', description: 'digest/read 用：true = 就是要看最新那个（当前会话自己）；默认 false 会跳过它' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          error: { type: 'string' },
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          digest: { type: 'object', additionalProperties: true },
          messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render(_a, v) {
        if (!v.ok) return text(clampText(`会话档案：${v.error || '失败'}`))
        if (v.action === 'list') {
          const subCount = v.sessions.filter((x) => x.sub).length
          const lines = [`本工作区共 ${v.sessions.length} 个会话（按最后活动倒序，★ 是最新的那个）：`]
          if (subCount) lines.push(`其中 ${subCount} 个是子智能体（subagent）的会话，带 ↳子 标记——那是代理的档，不是另一个窗口的你。`)
          const shownList = v.sessions.slice(0, 50)
          if (v.sessions.length > 50) lines.push(`（只列最近 50 个；还有 ${v.sessions.length - 50} 个没列，用 search 直接搜关键词）`)
          shownList.forEach((s, i) => {
            const star = i === 0 ? '★ ' : '  '
            const created = s.createdAt ? `开于 ${fmtTime(s.createdAt)}` : '开于 ?'
            const tail = s.lines ? ` · ${s.lines} 条事件` : ''
            lines.push(`${star}${s.id}${s.sub ? ' ↳子' : ''}  ${created} · 最后动静 ${fmtTime(s.mtime)} · ${fmtSize(s.size)}${tail}${s.subLabel ? ' · ' + s.subLabel : ''}`)
          })
          lines.push('')
          lines.push('找「上一个会话」：一般是 ★ 下面那个（★ 通常就是你现在这个会话）。')
          lines.push('digest 不填 sessionId 会自动跳过 ★；确实要看 ★ 自己就传 self=true。')
          return text(clampText(lines.join('\n')))
        }
        if (v.action === 'chain') {
          const L = ['会话链：']
          if (!v.ancestors.length) {
            L.push('  上面没有了——它是这条链的起点，或者更早的已经删掉了')
          } else {
            L.push('  往上（旧 → 新）：')
            for (const p of v.ancestors) {
              if (p.missing) { L.push('  · ' + p.id + '（不见了：可能已经删了）'); continue }
              const tags = [p.weak ? '推的' : ''].filter(Boolean).join('、')
              L.push('  · ' + p.id + (p.lines ? '  ' + p.lines + ' 条事件' : '') + (tags ? '（' + tags + '）' : ''))
            }
          }
          L.push('  这一代：' + v.sessionId)
          if (!v.children.length) {
            L.push('  下面还没有接班的——这条链到这儿了')
          } else {
            L.push('  接班人：')
            for (const c of v.children) {
              const t = [c.sub ? '子智能体' : '', c.weak ? '推的' : ''].filter(Boolean).join('、')
              L.push('  · ' + c.id + (t ? '（' + t + '）' : ''))
            }
          }
          L.push('')
          L.push('（链是从每个会话开头的接续块推出来的，不是 DSH 记的；标「推的」= 那代没有块，只按开张时间排的）')
          return text(clampText(L.join('\n')))
        }

        if (v.action === 'stats') {
          const s = v.stats
          const L = [`会话总览：${s.count} 个会话，共 ${s.totalEvents} 条事件，${(s.totalBytes / 1024 / 1024).toFixed(1)}MB`]
          L.push(`最早的会话开于 ${fmtTime(s.oldestStart)}，最近活动 ${fmtTime(s.newestMtime)}`)
          L.push('')
          L.push('最近几天：')
          for (const d of s.byDay.slice(-14)) L.push(`  ${d.day}  ${d.sessions} 个会话 · ${d.events} 条事件`)
          L.push('')
          L.push('最大的 5 个会话：')
          for (const b of s.biggest) L.push(`  ${b.id}  ${b.lines ?? '?'} 条事件 · ${fmtSize(b.size)}`)
          if (Array.isArray(s.degen) && s.degen.length) {
            L.push('')
            L.push('退化预警（最近 12 个会话，按单字句密度排）：')
            for (const g of s.degen) {
              const tag = g.perMessage >= 5 ? '🔴 严重' : g.perMessage >= 1 ? '🟡 偏高' : '🟢 正常'
              L.push(`  ${tag}  ${g.id}  每条 ${g.perMessage} 个单字句 · 全片 ${g.totalShort} 个`)
            }
          }
          return text(clampText(L.join('\n')))
        }
        if (v.action === 'live') {
          const L = [`最近 ${v.minutes} 分钟内有动静的会话（${v.sessions.length} 个）：`]
          if (!v.sessions.length) L.push('  （没有——这会儿都安静）')
          for (const s of v.sessions) {
            L.push('')
            L.push(`▸ ${s.id}（${s.minutesAgo} 分钟前）`)
            for (const u of s.lastUsers) L.push(`   对方：${oneLine(u.text, 120)}`)
            if (s.lastAssistant) L.push(`   最后回复：${oneLine(s.lastAssistant, 120)}`)
            if (s.lastTools.length) L.push(`   最后动作：${s.lastTools.map((t) => t.name).join('、')}`)
          }
          return text(clampText(L.join('\n')))
        }
        if (v.action === 'timeline') {
          const L = [`时间线（最近 ${v.sessions.length} 个会话，新的在上）：`]
          for (const s of v.sessions) {
            const when = s.minutesAgo < 1 ? '刚刚' : s.minutesAgo < 60 ? `${s.minutesAgo} 分钟前` : `${Math.round(s.minutesAgo / 60)} 小时前`
            L.push('')
            L.push(`▸ ${when} · ${s.id} · ${s.turns} 轮 / ${s.events} 条事件`)
            if (s.lastUser) L.push(`    对方：${s.lastUser}`)
            if (s.lastAssistant) L.push(`    回复：${s.lastAssistant}`)
            if (s.lastTool) L.push(`    最后动作：${s.lastTool}`)
          }
          return text(clampText(L.join('\n')))
        }
        if (v.action === 'digest') {
          const d = v.digest
          const L = []
          if (d.degraded) L.push(`⚠️ 警告：${d.note}`)
          L.push(`【这是会话 ${d.id} 的档案，不是你当前这个会话】`)
          L.push(`开于 ${fmtTime(d.start)}，最后活动 ${fmtTime(d.end)}；${d.turns} 轮，${fmtSize(d.size)}，${d.events} 条事件`)
          if (d.skipped) L.push(`（已跳过最新会话 ${d.skipped}——那通常是正在说话的当前会话）`)
          if (d.cwd) L.push(`工作区：${d.cwd}`)
          L.push('')
          L.push(`退化体检：最近 ${d.degeneration.recentWindow} 条思考里单字句 ${d.degeneration.recentShort} 个（每条 ${d.degeneration.perMessage} 个，${d.degeneration.level}）；全片 ${d.degeneration.totalShort} 个`)
          if (d.userMessages.length) {
            L.push('')
            L.push(`对方最后说的 ${d.userMessages.length} 句：`)
            for (const u of d.userMessages) L.push(`  [turn ${u.turn} ${fmtTime(u.time)}] ${oneLine(u.text, 160)}`)
          }
          if (d.actions.length) {
            L.push('')
            L.push(`最后做的 ${d.actions.length} 件事：`)
            for (const x of d.actions) L.push(`  [turn ${x.turn}] ${x.name} ${oneLine(x.args, 110)}`)
          }
          if (d.lastAssistant) {
            L.push('')
            L.push('最后一句回复：' + oneLine(d.lastAssistant, 200))
          }
          return text(clampText(L.join('\n')))
        }
        if (v.action === 'read') {
          const L = []
          if (v.degraded) L.push(`⚠️ 警告：${v.note}`)
          L.push(`会话 ${v.sessionId} 最后 ${v.messages.length} 条对话：`)
          for (const m of v.messages) L.push(`  [turn ${m.turn} ${m.role}] ${oneLine(m.text, 220)}`)
          return text(clampText(L.join('\n')))
        }
        if (v.action === 'search') {
          const L = [`关键词「${v.query}」在 ${v.scanned} 个会话里命中 ${v.hits.length} 处${v.withContext ? `（前后各 ${v.withContext} 条）` : ''}：`]
          const shownHits = v.hits.slice(0, 30)
          if (v.hits.length > 30) L.push(`（只列前 30 处；还有 ${v.hits.length - 30} 处，缩窄关键词或加 maxSessions）`)
          for (const h of shownHits) {
            L.push(`  [${h.sessionId} turn ${h.turn}] (${h.role}) ${oneLine(h.text, 180)}`)
            if (h.before) for (const b of h.before) L.push(`      ← ${b.role}：${oneLine(b.text, 100)}`)
            if (h.after) for (const a of h.after) L.push(`      → ${a.role}：${oneLine(a.text, 100)}`)
          }
          return text(clampText(L.join('\n')))
        }
        return text(clampText('会话档案：未知 action'))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const a = args || {}
      const action = String(a.action || 'list')
      const workspace = config.workspace || (process.cwd ? process.cwd() : '')
      const root = dshSessionsRoot(config)

      try {
        if (action === 'list') {
          const sessions = listSessions(root, workspace)
          if (!sessions.length) return { ok: false, action, error: `没找到会话：${root}（工作区 ${workspace}）` }
          fillHeads(sessions, config)
          return {
            ok: true,
            action,
            sessions: sessions.map((s) => ({
              id: s.id,
              createdAt: s.createdAt ?? null,
              mtime: s.mtime,
              size: s.size,
              lines: s.lines ?? null,
            })),
          }
        }

        if (action === 'chain') {
          const sessions = listSessions(root, workspace)
          if (!sessions.length) return { ok: false, action, error: '没有会话' }
          fillHeads(sessions, config)
          const { parentOf, weak } = buildParentMap(sessions, config)
          const byId = new Map(sessions.map((s) => [s.id, s]))
          const up = Math.max(0, Math.min(Number(a.up) || 5, 30))
          const main = sessions.filter((s) => !s.sub)
          const wanted = a.sessionId ? String(a.sessionId).replace(/^session-/, '') : ''
          const start = wanted ? byId.get(wanted) : main[0]
          if (!start) return { ok: false, action, error: '没找到会话：' + a.sessionId }
          const canon = []
          let cur = start
          for (let i = 0; i < up; i++) {
            const pid = parentOf.get(cur.id)
            if (!pid || pid === cur.id) break
            const p = byId.get(pid)
            if (!p) { canon.push({ id: pid, missing: true }); break }
            canon.push({
              id: p.id,
              createdAt: p.createdAt ?? null,
              mtime: p.mtime,
              lines: p.lines ?? null,
              weak: weak.has(p.id),
            })
            cur = p
          }
          canon.reverse()
          const children = sessions
            .filter((s) => parentOf.get(s.id) === start.id)
            .map((s) => ({ id: s.id, sub: !!s.sub, createdAt: s.createdAt ?? null, weak: weak.has(s.id) }))
            .slice(0, Number(a.down) || 3)
          return {
            ok: true,
            action,
            sessionId: start.id,
            start: { id: start.id, createdAt: start.createdAt ?? null, mtime: start.mtime, lines: start.lines ?? null },
            ancestors: canon,
            children,
          }
        }

        if (action === 'stats') {
          const sessions = listSessions(root, workspace)
          if (!sessions.length) return { ok: false, action, error: '没有会话' }
          fillHeads(sessions, config)
          const byDay = new Map()
          for (const s of sessions) {
            const d = new Date(s.mtime)
            const key = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
            const b = byDay.get(key) || { sessions: 0, events: 0, bytes: 0 }
            b.sessions++
            b.events += s.lines || 0
            b.bytes += s.size
            byDay.set(key, b)
          }
          const totalEvents = sessions.reduce((n, s) => n + (s.lines || 0), 0)
          const totalBytes = sessions.reduce((n, s) => n + s.size, 0)
          const oldest = sessions[sessions.length - 1]
          const biggest = [...sessions].sort((x, y) => (y.lines || 0) - (x.lines || 0)).slice(0, 5)

          // 退化预警：最近 12 个会话算一次，结果进缓存；第一次慢，之后快
          const cache = loadHeadCache(config)
          const degen = []
          for (const s of sessions.slice(0, 12)) {
            let g = cache[s.file] && cache[s.file].degen
            if (!g) {
              try {
                const d = loadSession(s.file, config)
                g = degeneration(d.asst)
                cache[s.file] = { ...(cache[s.file] || {}), degen: g, degenAt: Date.now() }
              } catch {
                continue
              }
            }
            if (g) degen.push({ id: s.id, mtime: s.mtime, ...g })
          }
          saveHeadCache(config, cache)
          degen.sort((x, y) => y.perMessage - x.perMessage)

          return {
            ok: true,
            action,
            stats: {
              count: sessions.length,
              totalEvents,
              totalBytes,
              oldestStart: oldest.createdAt ?? null,
              newestMtime: sessions[0].mtime,
              byDay: [...byDay.entries()].map(([day, v]) => ({ day, ...v })).slice(-10),
              biggest: biggest.map((s) => ({ id: s.id, lines: s.lines ?? null, size: s.size, mtime: s.mtime })),
              degen,
            },
          }
        }

        if (action === 'live') {
          const sessions = listSessions(root, workspace)
          const minutes = Math.max(1, Math.min(Number(a.minutes) || 10, 1440))
          const limit = Math.max(1, Math.min(Number(a.count) || 5, 20))
          const now = Date.now()
          const active = sessions.filter((s) => now - s.mtime <= minutes * 60000).slice(0, limit)
          const out = []
          for (const s of active) {
            let d
            try { d = loadSession(s.file, config) } catch { continue }
            const lastUsers = d.users.slice(-2).map((u) => ({ turn: u.turn, time: u.time, text: u.text }))
            const lastAsst = [...d.asst].reverse().find((x) => x.text)
            const lastTools = d.tools.slice(-2).map((t) => ({ turn: t.turn, name: t.name, args: String(t.args).slice(0, 100) }))
            out.push({
              id: s.id,
              mtime: s.mtime,
              minutesAgo: Math.round((now - s.mtime) / 60000),
              lastUsers,
              lastAssistant: lastAsst ? lastAsst.text : '',
              lastTools,
            })
          }
          return { ok: true, action, minutes, sessions: out }
        }

        if (action === 'timeline') {
          const limit = Math.max(1, Math.min(Number(a.count) || 10, 20))
          return { ok: true, action, sessions: buildTimeline(root, workspace, config, limit) }
        }

        if (action === 'digest') {
          const sessions = listSessions(root, workspace)
          const target = pickSession(sessions, a.sessionId, a.self === true)
          if (!target) return { ok: false, action, error: a.sessionId ? `没找到会话 ${a.sessionId}（先 list 看有哪些）` : '没有可读的会话' }
          // 没指定 id、也没要 self 时，记下被跳过的那个（通常就是当前会话）
          const skipped = !a.sessionId && a.self !== true && sessions.length > 1 ? sessions[0].id : ''
          const d = loadSession(target.file, config)
          const nUser = Math.max(1, Math.min(Number(a.count) || 12, 40))
          const nAct = Math.max(1, Math.min(Number(a.count) || 10, 30))
          const turns = d.asst.length ? Math.max(...d.asst.map((x) => x.turn)) : 0
          const lastAsst = [...d.asst].reverse().find((x) => x.text)
          const digest = {
            id: target.id,
            cwd: d.meta ? d.meta.cwd : '',
            start: d.meta ? d.meta.createdAt : 0,
            end: target.mtime,
            turns,
            events: d.lines,
            size: d.bytes,
            skipped,
            degraded: d.degraded === true,
            note: d.note || '',
            degeneration: degeneration(d.asst),
            userMessages: d.users.slice(-nUser),
            actions: d.tools.slice(-nAct).map((t) => ({ turn: t.turn, name: t.name, args: t.args })),
            lastAssistant: lastAsst ? lastAsst.text : '',
          }
          return { ok: true, action, digest }
        }

        if (action === 'read') {
          const sessions = listSessions(root, workspace)
          const target = pickSession(sessions, a.sessionId, a.self === true)
          if (!target) return { ok: false, action, error: a.sessionId ? `没找到会话 ${a.sessionId}（先 list 看有哪些）` : '没有可读的会话' }
          const d = loadSession(target.file, config)
          const n = Math.max(1, Math.min(Number(a.count) || 40, 200))
          const merged = d.users.map((u) => ({ turn: u.turn, role: '用户', text: u.text, time: u.time }))
            .concat(d.asst.filter((x) => x.text).map((x) => ({ turn: x.turn, role: '助手', text: x.text, time: x.time })))
            .sort((x, y) => x.time - y.time)
          return { ok: true, action, sessionId: target.id, degraded: d.degraded === true, note: d.note || '', messages: merged.slice(-n) }
        }

        if (action === 'search') {
          const q = String(a.query || '').toLowerCase()
          if (!q) return { ok: false, action, error: 'search 需要 query' }
          const ctxN = Math.max(0, Math.min(Number(a.context) || 0, 5))
          const sessions = listSessions(root, workspace).slice(0, Math.max(1, Math.min(Number(a.maxSessions) || 5, 20)))
          const hits = []
          outer: for (const s of sessions) {
            let d
            try { d = loadSession(s.file, config) } catch { continue }
            // 时间线：用户的话 + 助手的话按时间排
            const timeline = d.users
              .map((u) => ({ turn: u.turn, role: '用户', text: u.text, time: u.time }))
              .concat(d.asst.filter((x) => x.text).map((x) => ({ turn: x.turn, role: '助手', text: x.text, time: x.time })))
              .sort((x, y) => x.time - y.time)
            for (let i = 0; i < timeline.length; i++) {
              const m = timeline[i]
              if (!m.text.toLowerCase().includes(q)) continue
              const hit = { sessionId: s.id, turn: m.turn, role: m.role, text: m.text }
              if (ctxN > 0) {
                hit.before = timeline.slice(Math.max(0, i - ctxN), i).map((x) => ({ role: x.role, text: x.text }))
                hit.after = timeline.slice(i + 1, i + 1 + ctxN).map((x) => ({ role: x.role, text: x.text }))
              }
              hits.push(hit)
              if (hits.length >= 120) break outer
            }
            // 工具调用也搜（不带上下文，命中的是参数）
            for (const t of d.tools) {
              if (!t.args.toLowerCase().includes(q)) continue
              hits.push({ sessionId: s.id, turn: t.turn, role: t.name, text: t.args.slice(0, 400) })
              if (hits.length >= 120) break outer
            }
          }
          return { ok: true, action, query: String(a.query), scanned: sessions.length, withContext: ctxN, hits: hits.slice(-120) }
        }

        return { ok: false, action, error: '未知 action：' + action }
      } catch (e) {
        return { ok: false, action, error: String((e && e.message) || e) }
      }
    },
  }
}

export function apply(ctx, config = {}) {
  const tools = ctx.get('tools')
  if (tools) {
    ctx.effect(() => tools.register(buildTool(config)), 'xiaolian-session-archive: session_archive')
  }

  // 启动提醒（插件自带，不依赖 AGENTS）：新会话一开就带着「最近发生了什么」
  let timelineBrief = ''
  try {
    timelineBrief = renderTimelineBrief(
      buildTimeline(dshSessionsRoot(config), config.workspace || (process.cwd ? process.cwd() : ''), config, 5),
    )
  } catch {}
  let pendingBrief = ''
  try {
    pendingBrief = readPendingBrief(config.workspace || (process.cwd ? process.cwd() : ''), config)
  } catch {}
  try {
    const sp = ctx.get('systemPrompt')
    if (sp && typeof sp.context === 'function') {
      ctx.effect(() => {
        const dispose = sp.context({
          name: 'session-archive:startup',
          order: 700,
          interpolate: false,
          text:
            '【接着上次】最近这几个会话，最后停在这儿：\n\n' +
            (timelineBrief || '（这次没读到最近的会话记录；需要的话调 session_archive timeline）') +
            (pendingBrief ? '\n\n【还欠着的事】上一次交接留下的、还没做完的事（不用等对方提醒）：\n\n' + pendingBrief : '') +
            '\n\n要更细的就调 `session_archive digest`' +
            '（不填 sessionId 就是上一个会话）。',
        })
        return () => {
          try { if (typeof dispose === 'function') dispose() } catch {}
        }
      }, 'session-archive: startup hint')
    }
  } catch {}
}

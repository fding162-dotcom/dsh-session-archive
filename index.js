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
        out.push({ id: e.replace(/^session-/, ''), dirName: e, workspaceDir: path.basename(base), file, mtime: st.mtimeMs, size: st.size })
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

  const nodePath = config.nodePath || process.execPath || 'node'
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
  const nodePath = config.nodePath || process.execPath || 'node'
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
        cachedAt: now,
      }
      if (s) { s.createdAt = h.createdAt ?? null; s.lines = h.lines ?? null }
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

function oneLine(s, n = 200) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
}

function buildTool(config = {}) {
  return {
    name: 'session_archive',
    description:
      '会话档案库：把同一工作区的旧 DSH 会话当储存区，读上一个会话里发生过什么。' +
      '用于长会话退化（单字循环、上下文过长）后开新会话接续：先 list 看有哪些会话，再 digest 取摘要（对方说过什么、最后在做什么、退化程度），' +
      'read 取更细的对话，search 按关键词找。旧会话只读不写。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'digest', 'read', 'search', 'stats', 'live'], description: 'list 列会话 / digest 摘要 / read 读对话 / search 搜关键词 / stats 总览 / live 看最近哪些会话活着' },
        sessionId: { type: 'string', description: '会话 id（可带 session- 前缀）；不填时 digest/read 会跳过最新那个（通常是当前会话），取上一个' },
        count: { type: 'number', description: 'digest 里带几条对话/动作，read 里取几条；默认 12/10/40' },
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
          const lines = [`本工作区共 ${v.sessions.length} 个会话（按最后活动倒序，★ 是最新的那个）：`]
          const shownList = v.sessions.slice(0, 50)
          if (v.sessions.length > 50) lines.push(`（只列最近 50 个；还有 ${v.sessions.length - 50} 个没列，用 search 直接搜关键词）`)
          shownList.forEach((s, i) => {
            const star = i === 0 ? '★ ' : '  '
            const created = s.createdAt ? `开于 ${fmtTime(s.createdAt)}` : '开于 ?'
            const tail = s.lines ? ` · ${s.lines} 条事件` : ''
            lines.push(`${star}${s.id}  ${created} · 最后动静 ${fmtTime(s.mtime)} · ${fmtSize(s.size)}${tail}`)
          })
          lines.push('')
          lines.push('找「上一个会话」：一般是 ★ 下面那个（★ 通常就是你现在这个会话）。')
          lines.push('digest 不填 sessionId 会自动跳过 ★；确实要看 ★ 自己就传 self=true。')
          return text(clampText(lines.join('\n')))
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

  // 启动提醒（插件自带，不依赖 AGENTS）：让新会话知道「先翻上一个会话」
  try {
    const sp = ctx.get('systemPrompt')
    if (sp && typeof sp.context === 'function') {
      ctx.effect(() => {
        const dispose = sp.context({
          name: 'session-archive:startup',
          order: 700,
          interpolate: false,
          text:
            '【会话接续】不确定这个会话是怎么来的、上一个会话在做什么？先调 `session_archive digest`' +
            '（不填 sessionId 就是上一个会话，会自动跳过当前这个）。它会告诉你：对方最后说了什么、最后在做什么、退化到哪一步。' +
            '除非你确定不需要，新会话第一件事就做它。',
        })
        return () => {
          try { if (typeof dispose === 'function') dispose() } catch {}
        }
      }, 'session-archive: startup hint')
    }
  } catch {}
}

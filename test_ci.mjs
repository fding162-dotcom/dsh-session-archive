// CI 用的测试：不依赖真机上的会话数据，在干净环境里也能跑。
// 验证：插件能注册、七个动作都不抛异常、返回值是无损 JSON、render 不崩。
import { apply } from './index.js'

let tool
const fakeCtx = {
  get: (n) => {
    if (n === 'tools') return { register: (e) => { tool = e; return () => {} } }
    if (n === 'systemPrompt') return { context: () => () => {} }
    return undefined
  },
  effect: (fn) => { try { return fn() } catch (e) { throw new Error('effect 抛异常: ' + e.message) } },
}

// 指向一个不存在的工作区，保证拿到的是「没有会话」这条路径
apply(fakeCtx, { workspace: '/nonexistent/dsh-workspace' })

const fail = []
if (!tool) fail.push('没有注册到工具')
if (tool && tool.name !== 'session_archive') fail.push('工具名不对: ' + tool.name)
if (tool && typeof tool.isConcurrencySafe !== 'function') fail.push('缺 isConcurrencySafe')

const walkUndefined = (x, p = 'root') => {
  if (x === undefined) return [p]
  if (x === null || typeof x !== 'object') return []
  if (Array.isArray(x)) return x.flatMap((e, i) => walkUndefined(e, `${p}[${i}]`))
  return Object.keys(x).flatMap((k) => walkUndefined(x[k], `${p}.${k}`))
}

const cases = [
  ['list', { action: 'list' }],
  ['timeline', { action: 'timeline' }],
  ['digest', { action: 'digest' }],
  ['read', { action: 'read' }],
  ['search', { action: 'search', query: 'test' }],
  ['stats', { action: 'stats' }],
  ['live', { action: 'live' }],
  ['未知 action', { action: 'nope' }],
  ['空参数', {}],
  ['乱七八糟的参数', { action: 'digest', count: -5, sessionId: 123, self: 'yes' }],
]

for (const [label, args] of cases) {
  let r
  try {
    r = await tool.execute(args)
  } catch (e) {
    fail.push(`${label}: execute 抛异常 -> ${e.message}`)
    continue
  }
  const undef = walkUndefined(r)
  if (undef.length) fail.push(`${label}: 有 undefined 字段 ${undef.slice(0, 3).join(',')}`)
  const lossless = JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r)
  if (!lossless) fail.push(`${label}: 不是无损 JSON`)
  try {
    const out = tool.output.render(args, r)
    if (!Array.isArray(out) || !out[0] || typeof out[0].text !== 'string') fail.push(`${label}: render 返回格式不对`)
    if (out[0].text.length > 12000) fail.push(`${label}: 输出超过 12000 字符上限`)
  } catch (e) {
    fail.push(`${label}: render 抛异常 -> ${e.message}`)
  }
  console.log(`· ${label}: ok`)
}

if (fail.length) {
  console.error('\n失败：')
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log('\n全部通过：干净环境里七个动作都不抛、输出无损、没超上限')

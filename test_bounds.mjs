// 边界测试：奇怪参数不能崩、不能返回非法 JSON
import { apply } from './index.js'

const cap = {}
const ctx = {
  get: (n) => (n === 'tools' ? { register: (e) => { cap.t = e; return () => {} } } : undefined),
  effect: (fn) => { try { return fn() } catch {} },
}
apply(ctx, { workspace: 'D:/deepseek AI' })
const tool = cap.t

const cases = [
  ['不存在的会话id', { action: 'digest', sessionId: 'nope-not-exist' }],
  ['空搜索词', { action: 'search', query: '' }],
  ['count 负数', { action: 'digest', count: -5 }],
  ['count 0', { action: 'read', count: 0 }],
  ['count 超大', { action: 'read', count: 99999 }],
  ['minutes 0', { action: 'live', minutes: 0 }],
  ['minutes 负数', { action: 'live', minutes: -10 }],
  ['maxSessions 负数', { action: 'search', query: '测试', maxSessions: -3 }],
  ['context 负数', { action: 'search', query: '测试', context: -1 }],
  ['未知 action', { action: 'nope' }],
  ['空参数', {}],
]

let bad = 0
for (const [name, args] of cases) {
  const t0 = Date.now()
  let r
  try {
    r = await tool.execute(args)
  } catch (e) {
    console.log(`✗ ${name} 抛异常: ${e.message}`)
    bad++
    continue
  }
  const undef = []
  const walk = (x, p) => {
    if (x === undefined) { undef.push(p); return }
    if (x === null || typeof x !== 'object') return
    if (Array.isArray(x)) x.forEach((e, i) => walk(e, p + '[' + i + ']'))
    else for (const k of Object.keys(x)) walk(x[k], p + '.' + k)
  }
  walk(r, 'root')
  let rendered = ''
  try { rendered = tool.output.render(args, r)[0].text.slice(0, 60) } catch (e) { rendered = 'RENDER_ERR: ' + e.message }
  const ok = r && typeof r === 'object' && undef.length === 0 && !rendered.startsWith('RENDER_ERR')
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${name} (${Date.now() - t0}ms) ok=${r && r.ok} undefined=${undef.length} → ${rendered.replace(/\n/g, ' ')}`)
}
console.log(bad === 0 ? '\n全部通过' : `\n有 ${bad} 个问题`)

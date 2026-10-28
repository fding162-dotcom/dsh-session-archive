// 测试 session-archive 插件：用一个假 ctx 拿注册到的工具，直接调 execute
import { apply } from './index.js'

const captured = {}
const ctx = {
  get: (n) => (n === 'tools' ? { register: (e) => { captured.tool = e; return () => {} } } : undefined),
  effect: (fn) => { try { return fn() } catch (e) { console.error('effect:', e.message) } },
}
apply(ctx)
const tool = captured.tool
if (!tool) { console.error('没有注册到工具'); process.exit(1) }
console.log('tool name:', tool.name)
console.log('inject-safe:', tool.isConcurrencySafe())

const run = async (label, args) => {
  const t0 = Date.now()
  const r = await tool.execute(args)
  const dt = Date.now() - t0
  // 宿主会拒绝「非无损 JSON」：任何 undefined 字段都要抓出来
  const bad = []
  const walk = (x, p) => {
    if (x === undefined) { bad.push(p); return }
    if (x === null || typeof x !== 'object') return
    if (Array.isArray(x)) x.forEach((e, i) => walk(e, p + '[' + i + ']'))
    else for (const k of Object.keys(x)) walk(x[k], p + '.' + k)
  }
  walk(r, 'root')
  if (bad.length) console.log(`  !! 非无损JSON字段: ${bad.slice(0, 5).join(', ')}`)
  const same = JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r)
  console.log(`\n=== ${label} (${dt}ms) lossless=${same} undefined=${bad.length} ===`)
  const rendered = tool.output.render(args, r)
  console.log(rendered[0].text.slice(0, 1200))
}

await run('list', { action: 'list' })
await run('digest', { action: 'digest', sessionId: 'session-2a5a56d3-ca08-4873-a384-978f41e2a71a', count: 8 })
await run('digest-default', { action: 'digest', count: 3 })
await run('read', { action: 'read', sessionId: 'session-2a5a56d3-ca08-4873-a384-978f41e2a71a', count: 6 })
await run('search', { action: 'search', query: 'CosyVoice', maxSessions: 3, context: 1 })
await run('stats', { action: 'stats' })
await run('live', { action: 'live', minutes: 60, count: 3 })

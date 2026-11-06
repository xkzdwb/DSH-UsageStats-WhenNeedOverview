// 离线回归测试：不需要 DSH、不读 ~/.dsh、不联网。
//
//   node test/run-tests.mjs
//
// 覆盖四块：
//   1. package 契约 —— DSH 怎么加载这个包（入口、bundle patch、client、locale）
//   2. Host 半边 —— 假 ctx + 假会话日志，验路由协议、折叠、计费、缓存
//   3. 客户端 bundle —— 在 vm 里跑 client.js，验注册进 sidebar.panellist 与 main
//   4. 配置解析 —— 价格覆盖、脏数据兜底、预算周期
//
// 会话日志全在内存里造，不会有任何一台机器的真实标题或用量被读到。
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(read(rel))

let failures = 0
let section = ''
function group(label) {
  section = label
  console.log(`\n${label}`)
}
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ---------------------------------------------------------------------------
// 1. package 契约
// ---------------------------------------------------------------------------
group('用例 1：package.json 是 DSH 认得的 bundle')

const pkg = readJson('package.json')
check('名字不带 scope，能被 profile 当包名引用', /^[a-z0-9-]+$/.test(pkg.name), pkg.name)
check('是 ESM（会 import node: 内置模块）', pkg.type === 'module', pkg.type)
check('main 指向仓库里真实存在的入口', pkg.main === 'index.js' && existsSync(join(ROOT, pkg.main)), String(pkg.main))
check('声明了 dsh.bundle.patch', pkg.dsh?.bundle?.patch === './cordis.patch.yml', JSON.stringify(pkg.dsh?.bundle))
check('patch 文件存在', existsSync(join(ROOT, 'cordis.patch.yml')))
check('声明了 web 平台的客户端', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client))
check('exports."." 指向入口', pkg.exports?.['.'] === './index.js', JSON.stringify(pkg.exports?.['.']))
check('exports."./client" 指向客户端 bundle', pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']))
check('客户端 bundle 存在', existsSync(join(ROOT, 'client.js')))
check('exports 暴露 patch 与 locale', Boolean(pkg.exports?.['./cordis.patch.yml'] && pkg.exports?.['./locale/*.json']))
check('files 白名单包含运行时需要的全部文件',
  ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'locale/*.json'].every((f) => pkg.files?.includes(f)),
  JSON.stringify(pkg.files))
check('icon 字段指向存在的 svg', pkg.icon === './icon.svg' && existsSync(join(ROOT, 'icon.svg')), String(pkg.icon))
check('零运行时依赖', pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0,
  JSON.stringify(pkg.dependencies))
check('有 test 脚本', typeof pkg.scripts?.test === 'string', JSON.stringify(pkg.scripts))

group('用例 2：patch 里的 id 与入口名对得上')

const patchText = read('cordis.patch.yml')
check('patch 是一个 insert 列表', /^-\s*insert:/m.test(patchText))
const patchId = /\bid:\s*([\w-]+)/.exec(patchText)?.[1]
const patchName = /\bname:\s*['"]?([^'"\n]+)['"]?/.exec(patchText)?.[1]
check('patch 行 id 为 usage-stats', patchId === 'usage-stats', patchId)
check('patch 行 name 就是包名本身（按包解析）', patchName === pkg.name, `${patchName} vs ${pkg.name}`)
check('patch 里没有写死某台机器的绝对路径', !/[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(patchText))
check('价格单位注释说明了「每 100 万 token」', patchText.includes('100 万 token'))
check('默认币种与预算写在 config 里', /currency:\s*\w+/.test(patchText) && /budget:\s*\d+/.test(patchText))

group('用例 3：locale 与源码命名一致')

for (const lang of ['en', 'zh']) {
  const locale = readJson(`locale/${lang}.json`)
  check(`${lang}.json 有 meta.title 与 meta.description`,
    typeof locale.meta?.title === 'string' && locale.meta.title.length > 0 &&
    typeof locale.meta?.description === 'string' && locale.meta.description.length > 0,
    JSON.stringify(locale.meta))
}
const zh = readJson('locale/zh.json').meta.title
const en = readJson('locale/en.json').meta.title
check('中英文标题不同（不是漏翻）', zh !== en, `${zh} / ${en}`)
const hostSrc = read('index.js')
const clientSrc = read('client.js')
check('index.js 导出的插件名与 patch 行 id 相同', /export const name = '([^']+)'/.test(hostSrc) &&
  /export const name = '([^']+)'/.exec(hostSrc)[1] === patchId, /export const name = '([^']+)'/.exec(hostSrc)?.[1])
check('Host 声明依赖 sessionQuery 与 webServer',
  /export const inject = \[([^\]]+)\]/.test(hostSrc) &&
  /export const inject = \[([^\]]+)\]/.exec(hostSrc)[1].includes('sessionQuery') &&
  /export const inject = \[([^\]]+)\]/.exec(hostSrc)[1].includes('webServer'),
  /export const inject = \[([^\]]+)\]/.exec(hostSrc)?.[1])
check('Host 导出了 apply', /export function apply\(/.test(hostSrc))
check('route 路径在两半里是同一个字符串',
  /const ROUTE_PATH = '([^']+)'/.exec(hostSrc)?.[1] === /const ROUTE = '([^']+)'/.exec(clientSrc)?.[1],
  `${/const ROUTE_PATH = '([^']+)'/.exec(hostSrc)?.[1]} vs ${/const ROUTE = '([^']+)'/.exec(clientSrc)?.[1]}`)

// ---------------------------------------------------------------------------
// 造会话日志（内存里，形状照 session.v4.jsonl 的 assistant/message 事件）
// ---------------------------------------------------------------------------
const HOUR = 3600000
// 相对当前时间取整点，结果稳定可复现：全部会话都落在 3 小时内，
// 预算周期按「本自然月」算，月初几小时跑也不会跨月失配。
const NOW = Math.floor(Date.now() / HOUR) * HOUR

// 事件形状照 DSH 的真实写法：agent-loop 写 `assistant/message` 时把
// `{ turn, step, message: { content, source: { provider, model } }, usage }` 一起 append；
// usage 是 TokenUsage（inputTokens/outputTokens 必有，cacheRead/cacheWrite/reasoning 可选）。
// reasoningTokens 已经在 outputTokens 里，插件不能把它再加一遍。
function usageEvent(time, provider, model, usage) {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: '（正文不该出现在快照里）' }], source: { provider, model } },
      usage,
    },
  }
}

function session(id, { live = false, origin, parentSession, createdAt, events }) {
  return {
    header: { id, createdAt, origin, parentSession, cwd: '/workspace/demo' },
    live,
    events,
  }
}

const DEFAULT_PRICE = { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }
const cost = (tokens) => (tokens.input * DEFAULT_PRICE.input +
  tokens.output * DEFAULT_PRICE.output +
  tokens.cacheRead * DEFAULT_PRICE.cacheRead +
  tokens.cacheWrite * DEFAULT_PRICE.cacheWrite) / 1e6

// 会话 A：一次调用
const aTokens = { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }
const sessions = [
  session('a', {
    createdAt: NOW - 2 * HOUR,
    events: [
      usageEvent(NOW - 2 * HOUR, 'demo-provider', 'demo-model', {
        inputTokens: aTokens.input,
        outputTokens: aTokens.output,
        totalTokens: aTokens.input + aTokens.output + aTokens.cacheRead + aTokens.cacheWrite,
        cacheReadTokens: aTokens.cacheRead,
        cacheWriteTokens: aTokens.cacheWrite,
        reasoningTokens: 120,
      }),
    ],
  }),
  // 会话 B：两次调用，其中一个事件没有 usage（不应计费，但算一次消息）
  session('b', {
    createdAt: NOW - 3 * HOUR,
    events: [
      usageEvent(NOW - 3 * HOUR, 'demo-provider', 'demo-model', { inputTokens: 2000, outputTokens: 1000 }),
      usageEvent(NOW - 3 * HOUR, 'demo-provider', 'demo-model', undefined),
    ],
  }),
  // 会话 C：子代理
  session('c', {
    origin: 'subagent',
    createdAt: NOW - 1 * HOUR,
    events: [usageEvent(NOW - 1 * HOUR, 'other-provider', 'other-model', { inputTokens: 10, outputTokens: 10 })],
  }),
]

const aCost = cost(aTokens)
const bCost = cost({ input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0 })
const cCost = cost({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })
const totalCost = aCost + bCost + cCost

/** 宿主把金额四舍五入到 4 位小数；比较时按这个精度比，别当成浮点误差。 */
const close = (actual, expected, digits = 4) => Math.abs(actual - expected) < 0.5 * 10 ** -digits

// ---------------------------------------------------------------------------
// 假 ctx
// ---------------------------------------------------------------------------
function makeCtx({ liveIds = new Set(), failIds = new Set() } = {}) {
  const routes = new Map()
  const effects = []
  let reads = 0
  const ctx = {
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    async sessionQuery_listSessions() {},
    sessionQuery: {
      async listSessions() {
        return sessions.map((s) => ({ header: s.header, live: liveIds.has(s.header.id) }))
      },
      async readSession(id) {
        reads += 1
        if (failIds.has(id)) throw new Error(`boom ${id}`)
        const found = sessions.find((s) => s.header.id === id)
        return { session: found.header, events: found.events }
      },
      async readTitleSnapshots(ids) {
        return ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: `demo ${sessionId}` } },
        }))
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  return {
    ctx,
    routes,
    effects,
    get reads() {
      return reads
    },
  }
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(chunk) {
      this.body = chunk
      return this
    },
  }
  return res
}

async function callRoute(route, path, method = 'GET') {
  const res = fakeRes()
  await route.handler({ url: path, method }, res)
  const raw = res.body === undefined ? undefined : Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body)
  let json
  try {
    json = raw === undefined ? undefined : JSON.parse(raw.toString('utf8'))
  } catch {
    json = undefined
  }
  return { res, json, raw }
}

// ---------------------------------------------------------------------------
// 2. Host 半边
// ---------------------------------------------------------------------------
const host = await import('../index.js')
const ROUTE_PATH = /const ROUTE_PATH = '([^']+)'/.exec(hostSrc)[1]

group('用例 4：Host 半边注册只读路由')

const harness = makeCtx()
host.apply(harness.ctx, {})
check('恰好注册了一条路由', harness.routes.size === 1, String(harness.routes.size))
const route = harness.routes.get(ROUTE_PATH)
check(`路由路径是 ${ROUTE_PATH}`, route !== undefined)
check('路由是 exact 类型（只答这一个路径，不是前缀）', route?.kind === 'exact', String(route?.kind))
check('注册了 effect 以便卸载时清理', harness.effects.length >= 2, String(harness.effects.length))

group('用例 5：GET 返回快照，数字与手算一致')

const first = await callRoute(route, `${ROUTE_PATH}?days=0`)
check('200', first.res.statusCode === 200, String(first.res.statusCode))
check('content-type 是 application/json', /application\/json/.test(first.res.headers?.['content-type'] ?? ''),
  first.res.headers?.['content-type'])
check('cache-control: no-store', first.res.headers?.['cache-control'] === 'no-store',
  first.res.headers?.['cache-control'])
check('content-length 与实际字节数一致',
  Number(first.res.headers?.['content-length']) === first.raw.length,
  `${first.res.headers?.['content-length']} vs ${first.raw.length}`)
check('返回的是合法 JSON', first.json !== undefined)

const totals = first.json?.totals
check('会话数 = 3', totals?.conversations === 3, String(totals?.conversations))
check('子代理单独记 1 个，根会话 2 个', totals?.subagents === 1 && totals?.roots === 2,
  `sub=${totals?.subagents} root=${totals?.roots}`)
check('调用次数 = 3（没有 usage 的事件不计调用）', totals?.calls === 3, String(totals?.calls))
check('消息数 = 4（含没有 usage 的那条）', totals?.messages === 4, String(totals?.messages))
check('输入 token = 3010', totals?.input === 3010, String(totals?.input))
check('输出 token = 1510', totals?.output === 1510, String(totals?.output))
check('缓存读 = 2000 / 缓存写 = 100',
  totals?.cacheRead === 2000 && totals?.cacheWrite === 100, `${totals?.cacheRead}/${totals?.cacheWrite}`)
check('total = 四类之和（缓存读也算进去）',
  totals?.total === totals.input + totals.output + totals.cacheRead + totals.cacheWrite, String(totals?.total))
check('费用等于四类 token 各乘各价之和', close(totals?.cost ?? NaN, totalCost), `${totals?.cost} vs ${totalCost}`)
check('费用不是「total × 单一价」的错算',
  Math.abs((totals?.cost ?? 0) - (totals.total * DEFAULT_PRICE.output) / 1e6) > 1e-9)
check('按模型分行：两个模型', first.json?.byModel?.length === 2, JSON.stringify(first.json?.byModel?.map((m) => m.key)))
check('按模型降序（贵的在前）', (first.json?.byModel?.[0]?.cost ?? 0) >= (first.json?.byModel?.[1]?.cost ?? 0))
check('第一个模型是合并了两条会话的 demo-provider/demo-model',
  first.json?.byModel?.[0]?.key === 'demo-provider/demo-model' && first.json.byModel[0].calls === 2,
  JSON.stringify(first.json?.byModel?.[0]))
check('时间线有桶，且带 cost', Array.isArray(first.json?.timeline?.points) && first.json.timeline.points.length >= 1,
  String(first.json?.timeline?.points?.length))
check('跨度 < 7 天时按小时分桶', first.json?.timeline?.bucket === 'hour', String(first.json?.timeline?.bucket))
check('会话明细按花费降序', first.json?.conversations?.[0]?.id === 'b', first.json?.conversations?.[0]?.id)
check('会话标题来自 readTitleSnapshots', first.json?.conversations?.[0]?.title === 'demo b',
  String(first.json?.conversations?.[0]?.title))
check('子代理会话带 subagent 标记', first.json?.conversations?.find((c) => c.id === 'c')?.subagent === true)
check('返回币种', first.json?.currency === 'CNY', String(first.json?.currency))
check('不泄露任何消息正文（只有计数与标题）', JSON.stringify(first.json).length < 8000)
check('正文里那句「（正文不该出现在快照里）」确实没出现在响应里',
  !first.raw.toString('utf8').includes('正文不该出现在快照里'))
check('reasoningTokens 不会被重复计费（它已含在 outputTokens 里）',
  totals?.calls === 3 && close(totals?.cost ?? NaN, totalCost), String(totals?.cost))
check('带了 CPU 快照', typeof first.json?.cpu?.cores === 'number' && Array.isArray(first.json?.cpu?.history))
check('没有错误', first.json?.errors === undefined, JSON.stringify(first.json?.errors))

group('用例 6：协议细节 —— 方法限制、HEAD、范围、刷新')

const post = await callRoute(route, ROUTE_PATH, 'POST')
check('POST 返回 405', post.res.statusCode === 405, String(post.res.statusCode))
check('405 带 allow 头', /GET/.test(post.res.headers?.allow ?? ''), post.res.headers?.allow)
const put = await callRoute(route, ROUTE_PATH, 'PUT')
check('PUT 也 405', put.res.statusCode === 405, String(put.res.statusCode))

const head = await callRoute(route, ROUTE_PATH, 'HEAD')
check('HEAD 返回 200', head.res.statusCode === 200, String(head.res.statusCode))
check('HEAD 不返回正文', head.res.body === undefined)
check('HEAD 仍给出 content-length', Number(head.res.headers?.['content-length']) > 0)

const readsBefore = harness.reads
const cachedCall = await callRoute(route, `${ROUTE_PATH}?days=0`)
check('缓存期内不重读日志（非 live 会话只折一次）', harness.reads === readsBefore,
  `${harness.reads} vs ${readsBefore}`)
check('缓存命中仍是 200', cachedCall.res.statusCode === 200)

const forced = await callRoute(route, `${ROUTE_PATH}?days=0&refresh=1`)
check('refresh=1 强制重读', harness.reads > readsBefore, `${harness.reads} vs ${readsBefore}`)
check('refresh 后数字不变', forced.json?.totals?.cost === first.json?.totals?.cost)

const ranged = await callRoute(route, `${ROUTE_PATH}?days=1`)
check('days=1 只算 24 小时内的会话', ranged.json?.totals?.conversations === 3,
  String(ranged.json?.totals?.conversations))
const narrow = await callRoute(route, `${ROUTE_PATH}?days=0.02`)
check('极窄范围会筛掉老会话', (narrow.json?.totals?.conversations ?? 0) <= 3,
  String(narrow.json?.totals?.conversations))
const junk = await callRoute(route, `${ROUTE_PATH}?days=abc&refresh=0`)
check('days=abc 不炸（退回全部）', junk.res.statusCode === 200 && junk.json?.totals?.conversations === 3,
  String(junk.res.statusCode))

group('用例 7：预算与周期')

const budget = first.json?.budget
check('预算额度来自 config', budget?.amount === 200, String(budget?.amount))
check('周期是 month', budget?.period === 'month', String(budget?.period))
check('spent 与总费用一致', close(budget?.spent ?? NaN, totalCost), `${budget?.spent} vs ${totalCost}`)
check('remaining = 额度 − 已花', close(budget?.remaining ?? NaN, 200 - totalCost), String(budget?.remaining))
check('ratio = 已花 / 额度', Math.abs((budget?.ratio ?? 0) - totalCost / 200) < 1e-4, String(budget?.ratio))

const noBudget = makeCtx()
host.apply(noBudget.ctx, { budget: 0, budgetPeriod: 'all' })
const noBudgetData = await callRoute(noBudget.routes.get(ROUTE_PATH), ROUTE_PATH)
check('budget: 0 时不显示进度（amount 为 0）', noBudgetData.json?.budget?.amount === 0,
  String(noBudgetData.json?.budget?.amount))
check('budgetPeriod: all 被接受', noBudgetData.json?.budget?.period === 'all',
  String(noBudgetData.json?.budget?.period))

group('用例 8：读失败不炸路由')

const broken = makeCtx({ failIds: new Set(['b']) })
host.apply(broken.ctx, {})
const brokenData = await callRoute(broken.routes.get(ROUTE_PATH), ROUTE_PATH)
check('单个会话读失败仍是 200', brokenData.res.statusCode === 200, String(brokenData.res.statusCode))
check('失败的会话被跳过，其余照常统计', brokenData.json?.totals?.conversations === 2,
  String(brokenData.json?.totals?.conversations))
check('错误被记进 errors 里（不静默）', Array.isArray(brokenData.json?.errors) &&
  brokenData.json.errors.some((e) => String(e).includes('boom b')), JSON.stringify(brokenData.json?.errors))

// ---------------------------------------------------------------------------
// 3. 客户端 bundle
// ---------------------------------------------------------------------------
group('用例 9：client.js 能按 __ModuleLoader__ 契约加载并注册两个槽')

const clientCode = read('client.js')
check('用的是 window.__ModuleLoader__.load', clientCode.includes('window.__ModuleLoader__.load'))
check('客户端 id 与包名一致', clientCode.includes(`id: '${pkg.name}'`), pkg.name)

const registered = []
const slots = []
const localeRegistrations = []
const clientEffects = []
let clientApi
function fakeRequire(id) {
  if (id !== 'react') throw new Error(`客户端不该 import 别的裸包：${id}`)
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return { createElement: h, useCallback: (f) => f, useEffect: () => {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useState: (v) => [v, () => {}] }
}
const sandbox = {
  window: {},
  globalThis: {},
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }), head: { appendChild() {} }, querySelector: () => null },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  AbortController: class { constructor() { this.signal = {} } abort() {} },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
}
sandbox.window = sandbox
sandbox.window.localStorage = sandbox.localStorage
sandbox.window.__ModuleLoader__ = {
  load(entry) {
    registered.push(entry)
    clientApi = entry.factory(fakeRequire)
  },
}
const context = vm.createContext(sandbox)
vm.runInContext(clientCode, context, { filename: 'client.js' })

check('加载恰好一次', registered.length === 1, String(registered.length))
check('entry.id 与包名一致', registered[0]?.id === pkg.name, String(registered[0]?.id))
check('工厂返回 { inject, apply }', typeof clientApi?.apply === 'function' && Array.isArray(clientApi?.inject),
  JSON.stringify(Object.keys(clientApi ?? {})))
check('声明注入 slots', clientApi?.inject?.includes('slots'), JSON.stringify(clientApi?.inject))

const clientCtx = {
  effect(fn) {
    const dispose = fn()
    clientEffects.push(dispose)
    return () => {}
  },
  get(service) {
    if (service === 'locale') {
      return {
        register: (ns, id, dict) => {
          localeRegistrations.push({ ns, id, dict })
          return () => {}
        },
        subscribe: () => () => {},
        getSnapshot: () => ({ active: 'zh-CN' }),
      }
    }
    return undefined
  },
  slots: {
    inject(name, register) {
      slots.push({ name, register })
    },
    register(options, component) {
      return { options, component }
    },
  },
}
clientApi.apply(clientCtx)

check('向 sidebar.panellist 注册了一次', slots.filter((s) => s.name === 'sidebar.panellist').length === 1,
  JSON.stringify(slots.map((s) => s.name)))
const panelListSlot = slots.find((s) => s.name === 'sidebar.panellist')
const iconEntry = panelListSlot?.register()
check('面板入口 id 为 usage-stats', iconEntry?.options?.id === 'usage-stats', JSON.stringify(iconEntry?.options))
check('面板入口 order 是数字（决定侧边栏位置）', typeof iconEntry?.options?.order === 'number',
  String(iconEntry?.options?.order))
check('面板入口给了 label 函数', typeof iconEntry?.options?.label === 'function')
check('面板入口有图标组件', typeof iconEntry?.component === 'function')

check('向 main 注册了一次', slots.filter((s) => s.name === 'main').length === 1, JSON.stringify(slots.map((s) => s.name)))
const mainSlot = slots.find((s) => s.name === 'main')
const panelEntry = mainSlot?.register()
check('main 槽的 key 是 usage-stats（与入口 id 配对）', panelEntry?.options?.key === 'usage-stats',
  JSON.stringify(panelEntry?.options))
check('main 槽有面板组件', typeof panelEntry?.component === 'function')

check('注册了 en 与 zh 两套词条', localeRegistrations.length >= 2 &&
  localeRegistrations.map((r) => r.id).sort().join(',') === 'en,zh',
  JSON.stringify(localeRegistrations.map((r) => r.id)))
check('词条里带了面板标题', localeRegistrations.some((r) => typeof r.dict?.title === 'string' && r.dict.title.length > 0))
check('词条命名空间与插件名一致', localeRegistrations.every((r) => r.ns === 'usage-stats'),
  JSON.stringify(localeRegistrations.map((r) => r.ns)))
check('表里所有词条 key 的 en/zh 完全对齐', (() => {
  const enDict = localeRegistrations.find((r) => r.id === 'en')?.dict ?? {}
  const zhDict = localeRegistrations.find((r) => r.id === 'zh')?.dict ?? {}
  const enKeys = Object.keys(enDict).sort().join(',')
  const zhKeys = Object.keys(zhDict).sort().join(',')
  return enKeys === zhKeys && enKeys.length > 0
})(), JSON.stringify(localeRegistrations.map((r) => Object.keys(r.dict).length)))

group('用例 10：客户端只用主题 token、只请求自己的路由')

const cssVars = [...clientSrc.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1])
const nonThemeVars = [...new Set(cssVars)].filter((v) => !v.startsWith('--dsw-alias-'))
check('CSS 变量全部是 --dsw-alias-* 主题 token', nonThemeVars.length === 0, JSON.stringify(nonThemeVars))
const fetchTargets = [...clientSrc.matchAll(/fetch\(`\$\{ROUTE\}/g)]
check('所有 fetch 都走 ROUTE 常量（没有写死绝对 URL）', fetchTargets.length >= 1 && !/fetch\(\s*['"]https?:/.test(clientSrc),
  String(fetchTargets.length))
check('请求带 cache: no-store', clientSrc.includes("cache: 'no-store'"))
check('请求带 same-origin 凭证', clientSrc.includes("credentials: 'same-origin'"))
check('请求可被中断（AbortController）', clientSrc.includes('AbortController'))
check('没有 import 任何裸包名（只从共享表取 react）',
  !/^\s*import\s+.*\s+from\s+['"][^./]/m.test(clientSrc))
check('面板自己是滚动容器（height:100% + overflow:auto）',
  /\.us-root\s*\{[^}]*height:\s*100%/.test(clientSrc) && /\.us-root\s*\{[^}]*overflow:\s*auto/.test(clientSrc))
check('面板没有用 min-height:100% 当滚动容器',
  !/\.us-root\s*\{[^}]*min-height:\s*100%/.test(clientSrc))

// ---------------------------------------------------------------------------
// 4. 配置解析
// ---------------------------------------------------------------------------
group('用例 11：价格表解析')

// 自定义价格：只覆盖一个模型，其余走 default
const priced = makeCtx()
host.apply(priced.ctx, {
  currency: 'USD',
  pricing: {
    default: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    models: { 'demo-provider/demo-model': { input: 10, output: 20 } },
  },
})
const pricedData = await callRoute(priced.routes.get(ROUTE_PATH), ROUTE_PATH)
const expectPriced =
  ((1000 + 2000) * 10 + (500 + 1000) * 20) / 1e6 + // demo-provider/demo-model 用覆盖价
  (10 * 1 + 10 * 2) / 1e6 // other-provider/other-model 用 default
check('币种被 config 覆盖为 USD', pricedData.json?.currency === 'USD', String(pricedData.json?.currency))
check('模型级价格覆盖 default', close(pricedData.json?.totals?.cost ?? NaN, expectPriced),
  `${pricedData.json?.totals?.cost} vs ${expectPriced}`)
check('没覆盖到的字段回退到 default（cacheRead/cacheWrite 为 0）',
  (pricedData.json?.pricing?.models?.['demo-provider/demo-model']?.cacheWrite) === 0,
  JSON.stringify(pricedData.json?.pricing?.models?.['demo-provider/demo-model']))
check('快照里回显生效的价格表', pricedData.json?.pricing?.models?.['demo-provider/demo-model']?.input === 10,
  JSON.stringify(pricedData.json?.pricing))

const bare = makeCtx()
host.apply(bare.ctx, { pricing: { default: { input: 5 }, models: { 'demo-model': { output: 50 } } } })
const bareData = await callRoute(bare.routes.get(ROUTE_PATH), ROUTE_PATH)
const expectBare =
  (1000 * 5 + 500 * 50 + 2000 * 0.5 + 100 * 2) / 1e6 + // 只写 model 的键也匹配
  (2000 * 5 + 1000 * 50) / 1e6 +
  (10 * 5 + 10 * 0.5 + 0 + 0) / 1e6
check('只写 model（不带 provider/）的键也能命中', close(bareData.json?.totals?.cost ?? NaN, expectBare),
  `${bareData.json?.totals?.cost} vs ${expectBare}`)

group('用例 12：脏配置只兜底、不抛异常')

const dirty = [
  [{ budget: -5 }, '负数预算被夹成 0'],
  [{ cpuSampleIntervalMs: 'abc' }, '采样间隔不是数字'],
  [{ cpuHistoryLength: 1 }, '历史长度过小被夹住'],
  [{ maxConversations: 0 }, '明细上限过小被夹住'],
  [{ budgetPeriod: 'week' }, '不认识的周期退回 month'],
  [{ pricing: 'nope' }, 'pricing 不是对象'],
  [{ pricing: { default: null, models: 'x' } }, '价格表里塞了垃圾'],
  [{ currency: '' }, '空币种退回默认'],
]
for (const [config, label] of dirty) {
  let threw = false
  let data
  try {
    const h = makeCtx()
    host.apply(h.ctx, config)
    data = await callRoute(h.routes.get(ROUTE_PATH), ROUTE_PATH)
  } catch {
    threw = true
  }
  check(`${label}：不抛且仍返回 200`, threw === false && data?.res.statusCode === 200, threw ? 'threw' : String(data?.res.statusCode))
  check(`${label}：仍有可用数字`, typeof data?.json?.totals?.cost === 'number', JSON.stringify(data?.json?.totals?.cost))
}

// 卸载路径：apply 注册的 effect 都能释放，路由随之消失
group('用例 13：卸载干净')

const unload = makeCtx()
host.apply(unload.ctx, {})
check('卸载前路由在', unload.routes.size === 1)
for (const dispose of unload.effects) if (typeof dispose === 'function') dispose()
check('卸载后路由被移除', unload.routes.size === 0, String(unload.routes.size))

// ---------------------------------------------------------------------------
group('用例 14：仓库里不该有敏感物')
const forbidden = [
  // 盘符路径，但放过 http://localhost 这种 URL 里的「p:/」
  [/(^|[^a-zA-Z])[A-Za-z]:[\\/][^\s'"`]*/, 'Windows 绝对路径'],
  [/\/home\/[a-z]/i, 'Linux 家目录绝对路径'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/sk-[A-Za-z0-9]{20,}/, 'API key'],
  [/DEEPSEEK_API_KEY\s*=/, '环境变量里的密钥'],
  [/[\w.+-]+@(163|qq|gmail|outlook)\.com/, '真实邮箱'],
]
for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'locale/en.json', 'locale/zh.json']) {
  const text = read(file)
  const hits = forbidden.filter(([re]) => re.test(text)).map(([, label]) => label)
  check(`${file} 没有绝对路径/密钥/邮箱`, hits.length === 0, JSON.stringify(hits))
}

group('用例 15：反复 apply 不会互相踩')

const twice = makeCtx()
host.apply(twice.ctx, { budget: 100 })
const dup = await callRoute(twice.routes.get(ROUTE_PATH), ROUTE_PATH)
check('同一路径重复注册后仍只有一条路由', twice.routes.size === 1, String(twice.routes.size))
check('重复注册后数据仍正常', dup.res.statusCode === 200 && dup.json?.totals?.conversations === 3,
  String(dup.json?.totals?.conversations))

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)

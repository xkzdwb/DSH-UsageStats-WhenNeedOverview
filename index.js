// usage-stats — Host half: fold every conversation's token usage out of the session
// query service, price it, sample CPU, and serve one JSON snapshot to the panel over
// a plain read-only web route.
//
// Why a web route: an installed bundle's browser half is an ordinary Cordis client
// plugin. `host.call` belongs to session-scoped dynamic packages (cordis_define), and
// generated Remote namespaces cannot be extended from a path-loaded bundle, so a
// read-only GET route on the existing web server is the one channel that needs no
// code generation. It is registered with kind 'exact' and answers only that path.
//
// This file imports no third-party package: a plugin loaded by absolute path cannot
// resolve bare specifiers, so only `node:` builtins are used.

import os from 'node:os'

export const name = 'usage-stats'
export const inject = ['sessionQuery', 'webServer']

/** Fixed in both halves; not configurable so the two can never disagree. */
const ROUTE_PATH = '/plugin-usage-stats/data'

const DEFAULTS = {
  currency: 'CNY',
  budget: 200,
  budgetPeriod: 'month',
  cacheTtlMs: 30000,
  cpuSampleIntervalMs: 2000,
  cpuHistoryLength: 90,
  maxSessions: 2000,
  maxConversations: 300,
  pricing: {
    // Per 1M tokens. Placeholder defaults in DeepSeek list-price shape; edit the
    // row's config in cordis.patch.yml to match what you actually pay.
    default: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
    models: {},
  },
}

/** cordis config values may arrive as live refs (`.get()`) or plain values. */
function value(input, fallback) {
  const raw = input !== null && typeof input === 'object' && typeof input.get === 'function' ? input.get() : input
  return raw === undefined || raw === null ? fallback : raw
}

function num(input, fallback) {
  const n = Number(value(input, fallback))
  return Number.isFinite(n) ? n : fallback
}

function str(input, fallback) {
  const s = value(input, fallback)
  return typeof s === 'string' && s.length > 0 ? s : fallback
}

function plainObject(input) {
  const raw = value(input, undefined)
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined
}

function readPricing(config) {
  const section = plainObject(config.pricing) ?? {}
  const fallback = DEFAULTS.pricing.default
  const readOne = (raw, base) => ({
    input: num(plainObject(raw)?.input, base.input),
    output: num(plainObject(raw)?.output, base.output),
    cacheRead: num(plainObject(raw)?.cacheRead, base.cacheRead),
    cacheWrite: num(plainObject(raw)?.cacheWrite, base.cacheWrite),
  })
  const def = readOne(section.default, fallback)
  const models = {}
  const declared = plainObject(section.models)
  if (declared !== undefined) {
    for (const [key, rate] of Object.entries(declared)) models[key] = readOne(rate, def)
  }
  return { default: def, models }
}

function readConfig(config) {
  const settings = config ?? {}
  return {
    currency: str(settings.currency, DEFAULTS.currency),
    budget: Math.max(0, num(settings.budget, DEFAULTS.budget)),
    budgetPeriod: str(settings.budgetPeriod, DEFAULTS.budgetPeriod) === 'all' ? 'all' : 'month',
    cacheTtlMs: Math.max(0, num(settings.cacheTtlMs, DEFAULTS.cacheTtlMs)),
    cpuSampleIntervalMs: Math.min(60000, Math.max(500, num(settings.cpuSampleIntervalMs, DEFAULTS.cpuSampleIntervalMs))),
    cpuHistoryLength: Math.min(600, Math.max(10, num(settings.cpuHistoryLength, DEFAULTS.cpuHistoryLength))),
    maxSessions: Math.min(100000, Math.max(1, num(settings.maxSessions, DEFAULTS.maxSessions))),
    maxConversations: Math.min(5000, Math.max(10, num(settings.maxConversations, DEFAULTS.maxConversations))),
    pricing: readPricing(settings),
  }
}

/** Rate row for one `provider/model` key, falling back to the bare model id, then default. */
function rateFor(pricing, key) {
  const exact = pricing.models[key]
  if (exact !== undefined) return exact
  const model = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key
  const byModel = pricing.models[model]
  if (byModel !== undefined) return byModel
  return pricing.default
}

function costOf(pricing, key, tokens) {
  const rate = rateFor(pricing, key)
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheRead * rate.cacheRead +
      tokens.cacheWrite * rate.cacheWrite) /
    1e6
  )
}

const EMPTY_TOKENS = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function addTokens(target, tokens) {
  addCounts(target, tokens, 1)
}

function addCounts(target, tokens, calls) {
  target.calls += calls
  target.input += tokens.input
  target.output += tokens.output
  target.cacheRead += tokens.cacheRead
  target.cacheWrite += tokens.cacheWrite
}

function totalOf(tokens) {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

const HOUR_MS = 3600000

function hourStart(time) {
  return Math.floor(time / HOUR_MS) * HOUR_MS
}

/**
 * Fold one session log into per-model totals plus per-hour/per-model points.
 * Costs are deliberately not stored: they are recomputed from the live pricing
 * table on every snapshot, so editing prices updates history immediately.
 */
function foldLog(events) {
  const byModel = new Map()
  const points = new Map()
  let messages = 0
  let firstTime
  let lastTime

  for (const event of events) {
    if (event === null || typeof event !== 'object' || event.type !== 'assistant/message') continue
    messages += 1
    const data = event.data ?? {}
    const usage = data.usage
    const time = Number(event.time)
    if (Number.isFinite(time)) {
      if (firstTime === undefined || time < firstTime) firstTime = time
      if (lastTime === undefined || time > lastTime) lastTime = time
    }
    if (usage === undefined || usage === null) continue

    const source = data.message?.source ?? {}
    const key = `${source.provider ?? 'unknown'}/${source.model ?? 'unknown'}`
    const tokens = {
      input: num(usage.inputTokens, 0),
      output: num(usage.outputTokens, 0),
      cacheRead: num(usage.cacheReadTokens, 0),
      cacheWrite: num(usage.cacheWriteTokens, 0),
    }

    let model = byModel.get(key)
    if (model === undefined) {
      model = EMPTY_TOKENS()
      byModel.set(key, model)
    }
    addTokens(model, tokens)

    if (Number.isFinite(time)) {
      const pointKey = `${hourStart(time)}|${key}`
      let point = points.get(pointKey)
      if (point === undefined) {
        point = { t: hourStart(time), key, ...EMPTY_TOKENS() }
        points.set(pointKey, point)
      }
      addTokens(point, tokens)
    }
  }

  return { byModel, points: [...points.values()], messages, firstTime, lastTime }
}

/** Rolling CPU sampler: system-wide from os.cpus() deltas, process-wide from process.cpuUsage(). */
function createCpuSampler(intervalMs, historyLength) {
  const cores = os.cpus().length || 1
  let prev = readCounters()
  let prevAt = Date.now()
  const history = []

  function readCounters() {
    let idle = 0
    let total = 0
    for (const cpu of os.cpus()) {
      for (const time of Object.values(cpu.times)) total += time
      idle += cpu.times.idle
    }
    return { idle, total, proc: process.cpuUsage() }
  }

  function tick() {
    const now = readCounters()
    const nowAt = Date.now()
    const wallMs = nowAt - prevAt
    if (wallMs >= 250) {
      const dTotal = now.total - prev.total
      const dIdle = now.idle - prev.idle
      const system = dTotal > 0 ? clamp((1 - dIdle / dTotal) * 100, 0, 100) : 0
      const procUs = now.proc.user - prev.proc.user + (now.proc.system - prev.proc.system)
      const process1 = (procUs / 1000 / wallMs) * 100
      history.push({ t: nowAt, p: round2(process1), s: round2(system) })
      if (history.length > historyLength) history.splice(0, history.length - historyLength)
      latest = { process: process1, system, wallMs, procUs }
    }
    prev = now
    prevAt = nowAt
  }

  let latest
  tick()
  const timer = setInterval(tick, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    history,
    dispose() {
      clearInterval(timer)
    },
    snapshot() {
      const memory = process.memoryUsage()
      const current = latest ?? { process: 0, system: 0, wallMs: 0, procUs: 0 }
      return {
        cores,
        loadavg: os.loadavg().map(round2),
        uptimeSec: Math.round(os.uptime()),
        hostUptimeSec: Math.round(process.uptime()),
        memory: {
          totalBytes: os.totalmem(),
          freeBytes: os.freemem(),
          processRssBytes: memory.rss,
        },
        process: {
          percent: round2(current.process),
          machinePercent: round2(current.process / cores),
        },
        system: { percent: round2(current.system) },
        history: history.slice(),
      }
    },
  }
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value
}

function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Owns the folded session cache. Sessions that are not live never change on their
 * own, so they are folded once; live sessions are re-read on every refresh.
 */
function createStore(ctx, readSettings) {
  const sessions = new Map()
  const titles = new Map()
  const errors = []
  let refreshing
  let lastRefreshAt = 0

  function note(message) {
    if (!errors.includes(message)) errors.push(message)
  }

  async function readOne(record) {
    const id = record.header.id
    const snapshot = await ctx.sessionQuery.readSession(id)
    const folded = foldLog(snapshot.events ?? [])
    const header = snapshot.session ?? record.header
    sessions.set(id, {
      id,
      header,
      live: record.live === true,
      byModel: folded.byModel,
      points: folded.points,
      messages: folded.messages,
      firstTime: folded.firstTime,
      lastTime: folded.lastTime,
    })
    return id
  }

  async function refresh(force) {
    const settings = readSettings()
    const records = await ctx.sessionQuery.listSessions()
    const listed = records.slice(0, settings.maxSessions)

    const listedIds = new Set(listed.map((r) => String(r.header.id)))
    for (const id of [...sessions.keys()]) if (!listedIds.has(id)) sessions.delete(id)

    const pending = listed.filter((record) => {
      if (force) return true
      const cached = sessions.get(record.header.id)
      return cached === undefined || record.live === true
    })

    // Bounded concurrency: session reads replay logs and are the only expensive step.
    const queue = [...pending]
    const worker = async () => {
      for (;;) {
        const record = queue.shift()
        if (record === undefined) return
        try {
          await readOne(record)
        } catch (error) {
          note(`read ${record.header.id}: ${error?.message ?? error}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, queue.length || 1) }, worker))

    const missingTitles = listed.map((r) => String(r.header.id)).filter((id) => !titles.has(id))
    if (missingTitles.length > 0) {
      try {
        const results = await ctx.sessionQuery.readTitleSnapshots(missingTitles)
        for (const result of results) {
          if (result.status === 'fulfilled') {
            titles.set(String(result.sessionId), result.value.title?.title)
          } else {
            titles.set(String(result.sessionId), undefined)
            note(`title ${result.sessionId}: ${result.reason?.message ?? result.reason}`)
          }
        }
      } catch (error) {
        note(`titles: ${error?.message ?? error}`)
      }
    }

    lastRefreshAt = Date.now()
    return sessions
  }

  return {
    errors,
    get lastRefreshAt() {
      return lastRefreshAt
    },
    async ensure(force) {
      const settings = readSettings()
      const fresh = Date.now() - lastRefreshAt < settings.cacheTtlMs
      if (!force && fresh && sessions.size > 0) return
      if (refreshing !== undefined) return refreshing
      refreshing = refresh(force).finally(() => {
        refreshing = undefined
      })
      return refreshing
    },
    sessions,
    titleOf(id) {
      return titles.get(String(id))
    },
  }
}

function buildSnapshot(store, settings, cpu, rangeDays) {
  const now = Date.now()
  const from = rangeDays > 0 ? now - rangeDays * 24 * HOUR_MS : 0

  const totals = { ...EMPTY_TOKENS(), conversations: 0, roots: 0, subagents: 0, messages: 0 }
  const byModel = new Map()
  const hourly = new Map()
  const conversations = []
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime()
  let periodSpent = 0

  for (const session of store.sessions.values()) {
    const lastTime = session.lastTime ?? session.header.createdAt ?? 0
    const isSubagent = session.header.origin === 'subagent' || session.header.parentSession !== undefined

    // Budget is independent of the display range: it is always the budget period.
    let sessionCost = 0
    for (const [key, tokens] of session.byModel) sessionCost += costOf(settings.pricing, key, tokens)
    if (settings.budgetPeriod === 'all') periodSpent += sessionCost
    else if (lastTime >= monthStart) periodSpent += sessionCost

    if (lastTime < from) continue

    totals.conversations += 1
    if (isSubagent) totals.subagents += 1
    else totals.roots += 1
    totals.messages += session.messages

    const conv = {
      id: String(session.id),
      title: store.titleOf(session.id) ?? undefined,
      cwd: session.header.cwd ?? undefined,
      createdAt: session.header.createdAt ?? undefined,
      updatedAt: session.lastTime ?? session.header.createdAt ?? undefined,
      live: session.live === true,
      subagent: isSubagent || undefined,
      ...EMPTY_TOKENS(),
      total: 0,
      cost: 0,
      models: [],
    }

    for (const [key, tokens] of session.byModel) {
      // `tokens` is already an accumulated per-model record, so its own call count
      // has to travel with it; addTokens() would count it as a single call.
      addCounts(totals, tokens, tokens.calls)
      addCounts(conv, tokens, tokens.calls)
      let entry = byModel.get(key)
      if (entry === undefined) {
        entry = { key, ...EMPTY_TOKENS() }
        byModel.set(key, entry)
      }
      addCounts(entry, tokens, tokens.calls)
      conv.models.push(key)
      conv.cost += costOf(settings.pricing, key, tokens)
    }
    conv.total = totalOf(conv)
    conv.cost = round4(conv.cost)

    for (const point of session.points) {
      if (point.t < from) continue
      let bucket = hourly.get(point.t)
      if (bucket === undefined) {
        bucket = { t: point.t, ...EMPTY_TOKENS(), total: 0, cost: 0 }
        hourly.set(point.t, bucket)
      }
      addCounts(bucket, point, point.calls)
      bucket.total += totalOf(point)
      bucket.cost += costOf(settings.pricing, point.key, point)
    }

    conversations.push(conv)
  }

  totals.total = totalOf(totals)
  let totalCost = 0
  const modelRows = []
  for (const entry of byModel.values()) {
    const cost = costOf(settings.pricing, entry.key, entry)
    totalCost += cost
    modelRows.push({ ...entry, total: totalOf(entry), cost: round4(cost) })
  }
  totals.cost = round4(totalCost)
  modelRows.sort((a, b) => b.cost - a.cost)

  conversations.sort((a, b) => b.cost - a.cost)
  const truncated = conversations.length > settings.maxConversations
  const listed = truncated ? conversations.slice(0, settings.maxConversations) : conversations

  const points = [...hourly.values()].sort((a, b) => a.t - b.t).map((p) => ({ ...p, cost: round4(p.cost) }))
  const spanMs = points.length > 0 ? points[points.length - 1].t - points[0].t : 0
  const bucket = spanMs > 7 * 24 * HOUR_MS ? 'day' : 'hour'
  const timeline = bucket === 'day' ? collapseToDays(points) : points

  const budget = settings.budget > 0
    ? {
        amount: settings.budget,
        period: settings.budgetPeriod,
        spent: round4(periodSpent),
        remaining: round4(settings.budget - periodSpent),
        ratio: round4(periodSpent / settings.budget),
        since: settings.budgetPeriod === 'month' ? monthStart : 0,
      }
    : { amount: 0, period: settings.budgetPeriod, spent: round4(periodSpent), remaining: 0, ratio: 0, since: 0 }

  return {
    generatedAt: now,
    range: { days: rangeDays, from, to: now },
    currency: settings.currency,
    totals,
    timeline: { bucket, points: timeline },
    conversationsTruncated: truncated,
    conversations: listed,
    byModel: modelRows,
    pricing: { currency: settings.currency, default: settings.pricing.default, models: settings.pricing.models },
    budget,
    cpu: cpu.snapshot(),
    lastRefreshAt: store.lastRefreshAt,
  }
}

function collapseToDays(points) {
  const days = new Map()
  for (const point of points) {
    const day = Math.floor(point.t / (24 * HOUR_MS)) * 24 * HOUR_MS
    let bucket = days.get(day)
    if (bucket === undefined) {
      bucket = { t: day, ...EMPTY_TOKENS(), total: 0, cost: 0 }
      days.set(day, bucket)
    }
    addCounts(bucket, point, point.calls)
    bucket.total += point.total
    bucket.cost += point.cost
  }
  return [...days.values()].sort((a, b) => a.t - b.t).map((p) => ({ ...p, cost: round4(p.cost) }))
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

export function apply(ctx, config) {
  const readSettings = () => readConfig(config)
  const initial = readSettings()
  const store = createStore(ctx, readSettings)
  const cpu = createCpuSampler(initial.cpuSampleIntervalMs, initial.cpuHistoryLength)

  ctx.effect(() => () => cpu.dispose(), 'usage-stats: cpu sampler')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        async handler(req, res) {
          const url = new URL(req.url ?? ROUTE_PATH, 'http://localhost')
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          const settings = readSettings()
          const force = url.searchParams.get('refresh') === '1'
          const days = clamp(num(url.searchParams.get('days'), 0), 0, 3650)
          let payload
          try {
            await store.ensure(force)
            payload = buildSnapshot(store, settings, cpu, days)
            if (store.errors.length > 0) payload.errors = store.errors.slice(-20)
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: String(error?.message ?? error) }))
            return
          }
          const body = Buffer.from(JSON.stringify(payload), 'utf8')
          const headers = {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': String(body.byteLength),
          }
          res.writeHead(200, headers)
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      }),
    'usage-stats: data route',
  )

  // Fold once at activation so the first panel open is already warm. A failure here
  // must not fail plugin activation: the route reports it per request instead.
  void store.ensure(false).catch((error) => {
    console.warn(`[usage-stats] initial fold failed: ${error?.message ?? error}`)
  })

  console.warn(`[usage-stats] serving GET ${ROUTE_PATH}`)
}

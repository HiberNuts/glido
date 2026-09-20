import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { glidoDirectory } from './history.js'

export const AGENT_RUN_STATUSES = Object.freeze({
  CREATED: 'created', RUNNING: 'running', WAITING: 'waiting', COMPLETED: 'completed',
  FAILED: 'failed', CANCELLED: 'cancelled', BLOCKED: 'blocked',
})
export const AGENT_STATUSES = Object.freeze({
  PENDING: 'pending', RUNNING: 'running', WAITING: 'waiting', COMPLETED: 'completed',
  FAILED: 'failed', CANCELLED: 'cancelled',
})

const RUN_STATUSES = new Set(Object.values(AGENT_RUN_STATUSES))
const WORKER_STATUSES = new Set(Object.values(AGENT_STATUSES))
const RESUMABLE = new Set(['created', 'running', 'waiting', 'blocked', 'failed'])
const updateQueues = new Map()
const directory = () => path.join(glidoDirectory(), 'agent-runs')

function targetFor(id) {
  const safe = String(id ?? '')
  if (!/^[a-zA-Z0-9-]+$/.test(safe)) throw new Error('Invalid agent run id.')
  return path.join(directory(), `${safe}.json`)
}

function timestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp.')
  return date.toISOString()
}

function status(value, allowed, label) {
  const normalized = String(value ?? '').toLowerCase()
  if (!allowed.has(normalized)) throw new Error(`Invalid ${label} status: ${value}.`)
  return normalized
}

function workerSummary(worker) {
  const id = String(worker?.id ?? worker?.agentId ?? worker?.subagentId ?? worker?.threadId ?? '').trim()
  if (!id) return null
  return {
    id,
    name: worker.name == null ? null : String(worker.name).slice(0, 120),
    task: worker.task == null ? null : String(worker.task).replace(/\s+/g, ' ').trim().slice(0, 240),
    currentAction: worker.currentAction == null ? null : String(worker.currentAction).replace(/\s+/g, ' ').trim().slice(0, 240),
    status: status(worker.status ?? AGENT_STATUSES.PENDING, WORKER_STATUSES, 'agent'),
    model: worker.model == null ? null : String(worker.model).slice(0, 80),
    startedAt: worker.startedAt ? timestamp(worker.startedAt) : null,
    updatedAt: timestamp(worker.updatedAt ?? worker.timestamp ?? new Date()),
    completedAt: worker.completedAt ? timestamp(worker.completedAt) : null,
    error: worker.error == null ? null : String(worker.error?.message ?? worker.error).slice(0, 500),
  }
}

function updateWorkers(current, updates) {
  if (updates.agents !== undefined || updates.agentSummaries !== undefined) {
    return (updates.agents ?? updates.agentSummaries).map(workerSummary).filter(Boolean)
  }
  if (!updates.event || typeof updates.event !== 'object') return current
  const event = updates.event
  const candidate = workerSummary({
    id: event.agentId ?? event.subagentId ?? event.threadId ?? event.agent?.id,
    name: event.agentName ?? event.name ?? event.agent?.name,
    task: event.task ?? event.agent?.task,
    currentAction: event.currentAction ?? event.agent?.currentAction,
    status: event.status ?? event.agent?.status ?? AGENT_STATUSES.RUNNING,
    model: event.model ?? event.agent?.model,
    startedAt: event.startedAt ?? event.agent?.startedAt,
    updatedAt: event.timestamp ?? event.updatedAt,
    completedAt: event.completedAt,
    error: event.error,
  })
  if (!candidate) return current
  const found = current.findIndex((worker) => worker.id === candidate.id)
  if (found < 0) return [...current, candidate]
  const merged = { ...current[found] }
  for (const [key, value] of Object.entries(candidate)) if (value !== null) merged[key] = value
  const next = [...current]
  next[found] = merged
  return next
}

async function atomicWrite(target, value) {
  const parent = path.dirname(target)
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 })
  await fsp.chmod(parent, 0o700)
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await fsp.rename(temporary, target)
    await fsp.chmod(target, 0o600)
  } finally {
    await fsp.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

export async function createAgentRun({ goal, doneCriteria = [], cwd = process.cwd(), model = null, effort = null, maxAgents = 3, status: initialStatus = 'created', threadId = null, turnId = null } = {}) {
  const normalizedGoal = String(goal ?? '').trim()
  if (!normalizedGoal) throw new Error('An agent run requires a goal.')
  const concurrency = Number(maxAgents)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error('maxAgents must be an integer from 1 to 6.')
  const now = timestamp()
  const run = {
    version: 1, id: randomUUID(), status: status(initialStatus, RUN_STATUSES, 'run'),
    goal: normalizedGoal,
    doneCriteria: (Array.isArray(doneCriteria) ? doneCriteria : String(doneCriteria).split(/\r?\n/)).map(String).map((item) => item.trim()).filter(Boolean),
    cwd: path.resolve(String(cwd || process.cwd())), model: model == null ? null : String(model),
    effort: effort == null ? null : String(effort), maxAgents: concurrency,
    threadId: threadId == null ? null : String(threadId), turnId: turnId == null ? null : String(turnId),
    agents: [], plan: [], currentAction: null, usage: null, error: null, createdAt: now, updatedAt: now, completedAt: null,
  }
  await atomicWrite(targetFor(run.id), run)
  return run
}

export async function updateAgentRun(id, updates = {}) {
  const previous = updateQueues.get(id) ?? Promise.resolve()
  const work = previous.catch(() => {}).then(async () => {
    const current = await getAgentRun(id)
    if (!current) throw new Error(`Agent run not found: ${id}.`)
    const next = { ...current, updatedAt: timestamp() }
    if (updates.status !== undefined) next.status = status(updates.status, RUN_STATUSES, 'run')
    for (const key of ['threadId', 'turnId', 'model', 'effort']) {
      if (updates[key] !== undefined) next[key] = updates[key] == null ? null : String(updates[key])
    }
    if (updates.plan !== undefined) {
      next.plan = Array.isArray(updates.plan) ? updates.plan.slice(0, 12).map((step, index) => ({
        id: String(step?.id ?? index), text: String(step?.text ?? step?.step ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
        status: String(step?.status ?? 'pending').slice(0, 32),
      })).filter((step) => step.text) : []
    }
    if (updates.currentAction !== undefined) next.currentAction = updates.currentAction == null ? null : String(updates.currentAction).replace(/\s+/g, ' ').trim().slice(0, 240)
    if (updates.usage !== undefined) {
      const usage = updates.usage && typeof updates.usage === 'object' ? updates.usage : null
      next.usage = usage ? Object.fromEntries(['input', 'cached', 'output', 'reasoning', 'total'].map((key) => (
        [key, Math.max(0, Math.round(Number(usage[key]) || 0))]
      ))) : null
    }
    if (updates.error !== undefined) next.error = updates.error == null ? null : String(updates.error?.message ?? updates.error).slice(0, 1000)
    next.agents = updateWorkers(next.agents, updates)
    if (['completed', 'failed', 'cancelled'].includes(next.status)) next.completedAt = updates.completedAt ? timestamp(updates.completedAt) : next.completedAt ?? next.updatedAt
    else next.completedAt = null
    await atomicWrite(targetFor(id), next)
    return next
  })
  updateQueues.set(id, work)
  work.finally(() => {
    if (updateQueues.get(id) === work) updateQueues.delete(id)
  }).catch(() => {})
  return work
}

export async function getAgentRun(id) {
  try {
    return JSON.parse(await fsp.readFile(targetFor(id), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function findAgentRun(reference) {
  const wanted = String(reference ?? '').trim()
  if (!wanted) return null
  const exact = await getAgentRun(wanted)
  if (exact) return exact
  const matches = (await listAgentRuns()).filter((run) => run.id.startsWith(wanted))
  if (matches.length > 1) throw new Error(`Agent run id is ambiguous: ${wanted}`)
  return matches[0] ?? null
}

export async function listAgentRuns({ status: wantedStatus = null, limit = null } = {}) {
  let names
  try {
    names = (await fsp.readdir(directory())).filter((name) => name.endsWith('.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const runs = (await Promise.all(names.map((name) => getAgentRun(name.slice(0, -5)).catch(() => null))))
    .filter(Boolean)
    .filter((run) => wantedStatus == null || run.status === wantedStatus)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return limit == null ? runs : runs.slice(0, Math.max(0, Number(limit) || 0))
}

export async function latestResumableRun({ cwd = null } = {}) {
  const wantedCwd = cwd == null ? null : path.resolve(String(cwd))
  return (await listAgentRuns()).find((run) => RESUMABLE.has(run.status) && (!wantedCwd || run.cwd === wantedCwd)) ?? null
}

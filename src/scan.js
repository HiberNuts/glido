import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { commandFamily, commandFingerprint, durationToMs, safeProjectName } from './utils.js'

export function codexSessionsDirectory(override) {
  if (override) return path.resolve(override)
  const codexRoot = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(codexRoot, 'sessions')
}

export async function findSessionFiles(directory) {
  const files = []
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath)
    }
  }
  try {
    await visit(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`No Codex sessions directory found at ${directory}`)
    throw error
  }
  return files.sort()
}

function emptyTokens() {
  return { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 }
}

function tokenDelta(current, baseline) {
  return Object.fromEntries(Object.keys(emptyTokens()).map((key) => [key, Math.max(0, Number(current?.[key] ?? 0) - Number(baseline?.[key] ?? 0))]))
}

function normalizedLimit(limit) {
  if (!limit || !Number.isFinite(Number(limit.used_percent))) return null
  return {
    usedPercent: Number(limit.used_percent),
    windowMinutes: Number(limit.window_minutes ?? 0) || null,
    resetsAt: limit.resets_at ?? null,
  }
}

function preferredCapacity(rateLimits, observedAt) {
  const primary = normalizedLimit(rateLimits?.primary)
  const secondary = normalizedLimit(rateLimits?.secondary)
  const candidates = [primary, secondary].filter(Boolean)
  const weekly = candidates.find((limit) => Number(limit.windowMinutes) >= 10_080)
  const selected = weekly ?? candidates.sort((a, b) => Number(b.windowMinutes ?? 0) - Number(a.windowMinutes ?? 0))[0]
  if (!selected) return null
  return {
    ...selected,
    planType: rateLimits?.plan_type ?? null,
    observedAt,
    period: Number(selected.windowMinutes) >= 10_080 ? 'weekly' : 'rolling',
  }
}

function messageText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => messageText(part)).filter(Boolean).join('\n')
  if (!value || typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.content === 'string' || Array.isArray(value.content)) return messageText(value.content)
  return ''
}

function appendPrompt(state, value, { includePrompts, redactPrompt }) {
  if (!includePrompts || !state.currentTask) return
  const raw = messageText(value)
  if (!raw.trim()) return
  const redacted = redactPrompt(raw)
  const text = typeof redacted === 'string' ? redacted : redacted.text
  const count = typeof redacted === 'string' ? 0 : Number(redacted.redactions ?? 0)
  const normalized = text?.trim()
  if (normalized && !state.currentTask.prompts.includes(normalized)) state.currentTask.prompts.push(normalized)
  state.currentTask.promptRedactions += count
}

export async function parseSessionFile(file, { includePrompts = false, redactPrompt = (value) => value } = {}) {
  const state = {
    id: path.basename(file, '.jsonl'),
    project: 'unknown',
    cliVersion: null,
    startedAt: null,
    endedAt: null,
    models: new Set(),
    tokens: emptyTokens(),
    contextWindow: 0,
    turns: 0,
    completedTurns: 0,
    abortedTurns: 0,
    turnDurations: [],
    ttft: [],
    toolCalls: 0,
    commands: 0,
    commandFailures: 0,
    commandDurationMs: 0,
    patches: 0,
    patchFailures: 0,
    mcpCalls: 0,
    mcpFailures: 0,
    webSearches: 0,
    parseErrors: 0,
    fingerprints: new Map(),
    capacity: null,
    rateLimits: null,
    currentUsage: emptyTokens(),
    currentModel: null,
    currentEffort: null,
    currentTask: null,
    tasks: [],
  }

  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { state.parseErrors += 1; continue }
    const timestamp = Date.parse(record.timestamp)
    if (Number.isFinite(timestamp)) {
      state.startedAt = state.startedAt === null ? timestamp : Math.min(state.startedAt, timestamp)
      state.endedAt = state.endedAt === null ? timestamp : Math.max(state.endedAt, timestamp)
    }
    const payload = record.payload ?? {}

    if (record.type === 'session_meta') {
      state.id = payload.session_id || payload.id || state.id
      state.project = safeProjectName(payload.cwd)
      state.cliVersion = payload.cli_version ?? null
      if (payload.context_window) state.contextWindow = Number(payload.context_window)
      continue
    }
    if (record.type === 'turn_context') {
      if (payload.model) {
        state.currentModel = String(payload.model)
        state.models.add(state.currentModel)
        if (state.currentTask) state.currentTask.actualModel = state.currentModel
      }
      if (payload.effort) {
        state.currentEffort = String(payload.effort)
        if (state.currentTask) state.currentTask.actualEffort = state.currentEffort
      }
      if (payload.cwd && state.project === 'unknown') state.project = safeProjectName(payload.cwd)
      continue
    }
    if (record.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
      state.toolCalls += 1
      continue
    }
    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      appendPrompt(state, payload.content, { includePrompts, redactPrompt })
      continue
    }
    if (record.type !== 'event_msg') continue

    if (payload.type === 'task_started') {
      state.turns += 1
      state.currentTask = {
        id: payload.turn_id || `${state.id}:turn-${state.turns}`,
        startedAt: Number.isFinite(timestamp) ? timestamp : null,
        completedAt: null,
        actualModel: state.currentModel,
        actualEffort: state.currentEffort,
        baselineTokens: { ...state.currentUsage },
        tokens: emptyTokens(),
        prompts: [],
        promptRedactions: 0,
        commands: 0,
        commandFailures: 0,
        durationMs: 0,
        completed: false,
      }
    }
    if (payload.type === 'user_message' && includePrompts && state.currentTask) {
      appendPrompt(state, payload.message, { includePrompts, redactPrompt })
    }
    if (payload.type === 'task_complete') {
      state.completedTurns += 1
      if (Number(payload.duration_ms) > 0) state.turnDurations.push(Number(payload.duration_ms))
      if (Number(payload.time_to_first_token_ms) > 0) state.ttft.push(Number(payload.time_to_first_token_ms))
      if (state.currentTask) {
        state.currentTask.completedAt = Number.isFinite(timestamp) ? timestamp : null
        state.currentTask.durationMs = Number(payload.duration_ms ?? 0)
        state.currentTask.tokens = tokenDelta(state.currentUsage, state.currentTask.baselineTokens)
        state.currentTask.completed = true
        delete state.currentTask.baselineTokens
        state.tasks.push(state.currentTask)
        state.currentTask = null
      }
    }
    if (payload.type === 'turn_aborted') state.abortedTurns += 1
    if (payload.type === 'token_count') {
      const usage = payload.info?.total_token_usage ?? payload.info?.last_token_usage
      if (usage && Number(usage.total_tokens ?? 0) >= state.tokens.total_tokens) {
        state.tokens = { ...emptyTokens(), ...Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Number(value ?? 0)])) }
        state.currentUsage = { ...state.tokens }
      }
      const context = payload.info?.model_context_window
      if (Number(context) > 0) state.contextWindow = Number(context)
      if (payload.rate_limits) {
        state.rateLimits = {
          primary: normalizedLimit(payload.rate_limits.primary),
          secondary: normalizedLimit(payload.rate_limits.secondary),
          planType: payload.rate_limits.plan_type ?? null,
        }
        state.capacity = preferredCapacity(payload.rate_limits, Number.isFinite(timestamp) ? timestamp : 0)
      }
    }
    if (payload.type === 'item_completed' && payload.item?.type === 'CommandExecution') {
      const item = payload.item
      const failed = Number(item.exit_code ?? 0) !== 0 || item.status === 'failed'
      state.commands += 1
      state.commandFailures += failed ? 1 : 0
      state.commandDurationMs += durationToMs(item.duration)
      if (state.currentTask) {
        state.currentTask.commands += 1
        state.currentTask.commandFailures += failed ? 1 : 0
      }
      const fingerprint = commandFingerprint(item.command)
      const group = state.fingerprints.get(fingerprint) ?? { family: commandFamily(item.command, item.source), count: 0, failures: 0 }
      group.count += 1
      group.failures += failed ? 1 : 0
      state.fingerprints.set(fingerprint, group)
    }
    if (payload.type === 'patch_apply_end') {
      state.patches += 1
      state.patchFailures += payload.success === false ? 1 : 0
    }
    if (payload.type === 'mcp_tool_call_end') {
      state.mcpCalls += 1
      state.mcpFailures += payload.result && Object.hasOwn(payload.result, 'Err') ? 1 : 0
    }
    if (payload.type === 'web_search_end') state.webSearches += 1
  }

  if (state.currentTask) {
    state.currentTask.completedAt = state.endedAt
    state.currentTask.tokens = tokenDelta(state.currentUsage, state.currentTask.baselineTokens)
    delete state.currentTask.baselineTokens
    state.tasks.push(state.currentTask)
    state.currentTask = null
  }

  const repeatedFailures = [...state.fingerprints.values()].filter((group) => group.count >= 2 && group.failures >= 2)
  return {
    ...state,
    models: [...state.models],
    fingerprints: undefined,
    currentTask: undefined,
    currentUsage: undefined,
    currentModel: undefined,
    currentEffort: undefined,
    repeatedFailures,
    elapsedMs: state.startedAt !== null && state.endedAt !== null ? state.endedAt - state.startedAt : 0,
  }
}

export async function scanSessions({ directory, since = null, project = null, session = null, onProgress, includePrompts = false, redactPrompt } = {}) {
  const resolvedDirectory = codexSessionsDirectory(directory)
  const files = session ? [path.resolve(session)] : await findSessionFiles(resolvedDirectory)
  const sessions = []
  for (let index = 0; index < files.length; index += 1) {
    const stats = await fsp.stat(files[index])
    if (since && stats.mtimeMs < since) continue
    const parsed = await parseSessionFile(files[index], { includePrompts, redactPrompt })
    if (since && (parsed.startedAt ?? stats.mtimeMs) < since) continue
    if (project && !parsed.project.toLowerCase().includes(project.toLowerCase())) continue
    sessions.push(parsed)
    onProgress?.(index + 1, files.length)
  }
  return { directory: resolvedDirectory, filesSeen: files.length, sessions }
}

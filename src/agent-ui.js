const MAX_WORKERS = 6
const MAX_EVENTS = 8

export function createAgentView(run = {}) {
  if (typeof run === 'string') run = { goal: run }
  const now = run.startedAt ?? null
  return {
    goal: clean(run.goal ?? run.prompt ?? 'Agent run', 240),
    masterId: run.threadId ?? null,
    master: { status: run.status ?? 'ready', startedAt: now, completedAt: null, lastAction: 'Getting ready', events: [] },
    plan: [],
    workers: {},
    tokens: { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 },
    events: [],
    notice: null,
    updatedAt: now,
  }
}

export function reduceAgentEvent(view, message = {}) {
  const params = object(message.params) ? message.params : message
  const method = String(message.method ?? message.type ?? params.method ?? '')
  const at = timestamp(params.timestamp ?? message.timestamp)
  const next = {
    ...view,
    master: { ...view.master, events: [...(view.master?.events ?? [])] },
    plan: [...(view.plan ?? [])],
    workers: { ...(view.workers ?? {}) },
    tokens: { ...view.tokens },
    events: [...(view.events ?? [])],
    notice: view.notice ?? null,
    updatedAt: at,
  }
  let summary = ''
  if (method !== 'warning') next.notice = null

  if (method === 'thread/status/changed') {
    const status = statusOf(params.status)
    const threadId = params.threadId ?? params.thread?.id
    if (threadId && !next.masterId) return next
    if (threadId && next.masterId && threadId !== next.masterId) {
      upsertWorker(next, threadId, { status, lastAction: humanStatus(status) }, at)
      summary = `Worker is ${humanStatus(status).toLowerCase()}`
    } else {
      next.master.status = status
      next.master.lastAction = humanStatus(status)
      summary = humanStatus(status)
    }
  } else if (method === 'turn/started') {
    next.master.status = 'running'
    next.master.startedAt ??= at
    next.master.completedAt = null
    next.master.lastAction = 'Planning and coordinating'
    summary = 'Master started a turn'
  } else if (method === 'turn/completed') {
    const status = statusOf(params.turn?.status ?? params.status ?? 'completed')
    next.master.status = status
    next.master.completedAt = at
    next.master.lastAction = status === 'completed' ? 'Run completed' : `Turn ${status}`
    if (status === 'completed') {
      for (const worker of Object.values(next.workers)) {
        if (!terminal(worker.status)) {
          worker.status = 'completed'
          worker.completedAt = at
          worker.lastAction = 'Finished supporting the goal'
          addWorkerEvent(worker, worker.lastAction, at)
        }
      }
    }
    summary = `Master turn ${status}`
  } else if (method === 'turn/plan/updated') {
    next.plan = normalizePlan(params.plan ?? params.steps ?? params.turn?.plan)
    next.master.lastAction = 'Updated the execution plan'
    summary = `Plan updated (${next.plan.length} steps)`
  } else if (method === 'thread/tokenUsage/updated') {
    next.tokens = normalizeTokens(params.tokenUsage ?? params.usage ?? params)
  } else if (method === 'warning') {
    next.notice = clean(params.message ?? 'This run needs your attention.', 160)
    summary = next.notice
  } else if (/^item\/(started|updated|completed)$/.test(method)) {
    const phase = method.slice(5)
    summary = reduceItem(next, params.item ?? params, phase, at, params.threadId)
  } else if (method) {
    summary = `Received ${clean(method, 72)}`
  }

  if (summary) addEvent(next, summary, at)
  return next
}

export function renderAgentView(view, { color = false, width = 80, selectedWorker = null, showActivity = false, interactive = false } = {}) {
  width = Math.max(40, Math.min(160, Number(width) || 80))
  const paint = colors(color)
  const workers = Object.values(view.workers ?? {}).slice(0, MAX_WORKERS)
  const plan = (view.plan ?? []).slice(0, 8)
  const elapsed = duration(view.master?.startedAt, view.master?.completedAt)
  const working = workers.filter((worker) => ['running', 'in-progress', 'active'].includes(worker.status)).length
  const finished = workers.filter((worker) => worker.status === 'completed').length
  const selected = selectedWorker ? view.workers?.[selectedWorker] : null
  const lines = [
    paint.bold('GLIDO AGENT'),
    rule(width),
    `${paint.dim('Goal')}    ${clip(view.goal, width - 8)}`,
    `${paint.dim('Status')}  ${statusMark(view.master?.status, paint)} ${humanStatus(view.master?.status)}${elapsed ? ` · ${elapsed}` : ''}`,
    `${paint.dim('Now')}     ${clip(view.master?.lastAction, width - 8)}`,
  ]

  if (view.notice) lines.push(`${paint.dim('Note')}    ${clip(view.notice, width - 8)}`)

  if (selected) {
    const index = workers.findIndex((worker) => worker.id === selected.id)
    lines.push('', paint.bold(`${workerName(selected, index)} details`))
    lines.push(`${paint.dim('Status')}  ${statusMark(selected.status, paint)} ${humanStatus(selected.status)}`)
    lines.push(`${paint.dim('Task')}    ${clip(selected.task || 'Supporting the master goal', width - 8)}`)
    lines.push(`${paint.dim('Now')}     ${clip(selected.lastAction || humanStatus(selected.status), width - 8)}`)
    lines.push('', paint.bold('Activity'))
    const activity = (selected.events ?? []).slice(-MAX_EVENTS)
    if (!activity.length) lines.push(paint.dim('  Waiting for an update'))
    for (const event of activity) lines.push(`  ${paint.dim(clock(event.at))}  ${clip(event.text, width - 12)}`)
  } else if (plan.length) {
    lines.push('', paint.bold('Plan'))
    for (const step of plan) lines.push(`  ${planMark(step.status, paint)} ${clip(step.text, width - 4)}`)
  }

  if (!selected) {
    lines.push('', paint.bold(`Agents · ${workers.length} spawned · ${working} working · ${finished} finished`))
    if (!workers.length) lines.push(paint.dim('  No sub-agents needed yet'))
    for (const [index, worker] of workers.entries()) {
      const name = clip(workerName(worker, index), 20)
      const age = duration(worker.startedAt, worker.completedAt)
      lines.push(`  ${statusMark(worker.status, paint)} ${index + 1}. ${name} · ${humanStatus(worker.status)}${age ? ` · ${age}` : ''}`)
      lines.push(`      ${paint.dim('Task')}  ${clip(worker.task || 'Supporting the master goal', width - 12)}`)
      lines.push(`      ${paint.dim('Now')}   ${clip(worker.lastAction || humanStatus(worker.status), width - 12)}`)
    }
  }
  if (showActivity && !selected) {
    lines.push('', paint.bold('Recent activity'))
    for (const event of (view.events ?? []).slice(-MAX_EVENTS)) lines.push(`  ${paint.dim(clock(event.at))}  ${clip(event.text, width - 12)}`)
  }
  if (interactive) {
    lines.push('', paint.dim(selected ? '[a] overview  [1-6] switch agent' : '[1-6] agent details  [l] recent activity'))
  }
  return lines.join('\n')
}

export function createAgentRenderer({ run, output = process.stdout, input = process.stdin, color = output?.isTTY, onSnapshot } = {}) {
  let current = createAgentView(run)
  let stopped = false
  let selectedWorker = null
  let showActivity = false
  let listening = false
  const tty = Boolean(output?.isTTY)

  function draw(summary) {
    if (tty) {
      const frame = renderAgentView(current, { color, width: output.columns, selectedWorker, showActivity, interactive: listening })
      output.write(`\x1b[?25l\x1b[2J\x1b[H${frame}\n`)
    } else if (summary) {
      output.write(`[agent] ${clean(summary, 180)}\n`)
    }
    onSnapshot?.(current)
  }

  function onKey(chunk) {
    const key = String(chunk)
    if (key === '\u0003') {
      suspendInput()
      process.kill(process.pid, 'SIGINT')
      return
    }
    const workers = Object.values(current.workers ?? {}).slice(0, MAX_WORKERS)
    if (/^[1-6]$/.test(key) && workers[Number(key) - 1]) selectedWorker = workers[Number(key) - 1].id
    else if (key.toLowerCase() === 'a' || key === '\u001b') selectedWorker = null
    else if (key.toLowerCase() === 'l') showActivity = !showActivity
    else return
    draw()
  }

  function resumeInput() {
    if (!tty || !input?.isTTY || listening || stopped) return
    listening = true
    input.setRawMode?.(true)
    input.resume?.()
    input.on('data', onKey)
    draw()
  }

  function suspendInput() {
    if (!listening) return
    listening = false
    input.off('data', onKey)
    input.setRawMode?.(false)
    input.pause?.()
  }

  resumeInput()

  return {
    setMasterId(threadId) {
      if (threadId) current = { ...current, masterId: threadId }
      return current
    },
    handle(message) {
      if (stopped) return current
      const before = current.events?.at(-1)
      current = reduceAgentEvent(current, message)
      const after = current.events?.at(-1)
      if (isVisibleEvent(message)) draw(after !== before ? after?.text : '')
      return current
    },
    suspend: suspendInput,
    resume: resumeInput,
    stop() {
      if (stopped) return
      stopped = true
      suspendInput()
      if (tty) output.write('\x1b[?25h')
    },
    get view() { return current },
  }
}

function isVisibleEvent(message) {
  const method = String(message?.method ?? message?.type ?? '')
  if (['thread/status/changed', 'turn/started', 'turn/completed', 'turn/plan/updated', 'warning'].includes(method)) return true
  if (!/^item\/(started|updated|completed)$/.test(method)) return false
  const type = message?.params?.item?.type ?? message?.item?.type
  return ['collabToolCall', 'collabAgentToolCall', 'commandExecution', 'fileChange'].includes(type)
}

function reduceItem(view, item, phase, at, threadId) {
  const type = item.type ?? item.itemType ?? 'item'
  if (type === 'collabToolCall' || type === 'collabAgentToolCall') return reduceCollab(view, item, phase, at)

  const status = statusOf(item.status ?? phase)
  const worker = threadId && threadId !== view.masterId ? view.workers[threadId] : null
  let action = ''
  if (type === 'commandExecution') {
    const command = clean(Array.isArray(item.command) ? item.command.join(' ') : item.command ?? item.displayName ?? 'command', 100)
    action = commandAction(command, phase)
  }
  else if (type === 'fileChange') {
    const changes = item.changes ?? item.files ?? []
    const count = Array.isArray(changes) ? changes.length : Number(item.changeCount) || 1
    action = `${status === 'completed' ? 'Applied' : 'Preparing'} ${count} file change${count === 1 ? '' : 's'}`
  }
  else if (type === 'agentMessage') {
    action = phase === 'completed' ? 'Reported progress' : 'Writing an update'
  }
  if (!action) return ''
  if (worker) {
    worker.lastAction = action
    addWorkerEvent(worker, action, at)
  } else {
    view.master.lastAction = action
    addWorkerEvent(view.master, action, at)
  }
  return action
}

function reduceCollab(view, item, phase, at) {
  const tool = String(item.tool ?? item.action ?? item.name ?? 'agent task')
  const task = clean(item.prompt ?? item.task ?? item.description ?? '', 120)
  const states = item.agentsStates ?? item.agentStates ?? {}
  const ids = new Set([
    ...array(item.receiverThreadIds),
    ...array(item.receiverThreadId),
    ...array(item.newThreadId),
    ...Object.keys(object(states) ? states : {}),
  ].filter(Boolean))

  for (const id of ids) {
    const state = object(states) ? states[id] ?? {} : {}
    const status = statusOf(state.status ?? item.status ?? (phase === 'started' ? 'running' : phase))
    upsertWorker(view, id, {
      name: state.name ?? state.nickname ?? item.agentName,
      status,
      task: state.task ?? task,
      lastAction: collabAction(tool, status),
      completedAt: terminal(status) ? at : null,
    }, at)
    addWorkerEvent(view.workers[id], view.workers[id].lastAction, at)
  }

  const verb = collabAction(tool, statusOf(item.status ?? phase))
  view.master.lastAction = ids.size ? `${verb}: ${[...ids].map((id) => workerName(view.workers[id])).join(', ')}` : verb
  return view.master.lastAction
}

function upsertWorker(view, id, patch, at) {
  if (!id) return
  const prior = view.workers[id] ?? { id, name: null, status: 'pending', task: '', lastAction: '', startedAt: at, completedAt: null, events: [] }
  view.workers[id] = { ...prior, ...patch, events: [...(prior.events ?? [])], id, startedAt: prior.startedAt ?? at }
}

function addWorkerEvent(worker, text, at) {
  if (!worker || !text) return
  worker.events ??= []
  const previous = worker.events.at(-1)
  if (previous?.text === text) return
  worker.events.push({ at, text: clean(text, 180) })
  worker.events = worker.events.slice(-MAX_EVENTS)
}

function normalizePlan(plan) {
  if (!Array.isArray(plan)) return []
  return plan.slice(0, 12).map((step, index) => typeof step === 'string'
    ? { id: String(index), text: clean(step, 180), status: 'pending' }
    : { id: String(step.id ?? index), text: clean(step.step ?? step.text ?? step.description ?? `Step ${index + 1}`, 180), status: statusOf(step.status ?? 'pending') })
}

function normalizeTokens(value) {
  const usage = value.total ?? value.totalUsage ?? value
  const input = number(usage.inputTokens ?? usage.input_tokens)
  const cached = number(usage.cachedInputTokens ?? usage.cached_input_tokens)
  const output = number(usage.outputTokens ?? usage.output_tokens)
  const reasoning = number(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens)
  return { input, cached, output, reasoning, total: number(usage.totalTokens ?? usage.total_tokens) || input + output }
}

function addEvent(view, text, at) {
  view.events.push({ at, text: clean(text, 180) })
  view.events = view.events.slice(-MAX_EVENTS)
}

function collabAction(tool, status) {
  if (/spawn/i.test(tool)) return terminal(status) ? 'Sub-agent started' : 'Starting a sub-agent'
  if (/wait/i.test(tool)) return 'Waiting for agents'
  if (/send|input|message/i.test(tool)) return 'Updating an agent'
  return 'Coordinating agents'
}

function workerName(worker, index) {
  return clean(worker?.name ?? (Number.isInteger(index) ? `Worker ${index + 1}` : 'Worker'), 32)
}

function commandAction(command, phase) {
  const finished = phase === 'completed'
  if (/\b(?:test|pytest|vitest|jest|xctest|go test|cargo test)\b/i.test(command)) return finished ? 'Checks finished' : 'Running checks'
  if (/\b(?:build|compile|xcodebuild)\b/i.test(command)) return finished ? 'Build finished' : 'Building the project'
  if (/\b(?:rg|grep|find|ls|cat|sed|head|tail)\b/i.test(command)) return finished ? 'Project inspected' : 'Inspecting the project'
  return finished ? 'Task completed' : 'Working on the project'
}

function humanStatus(status) {
  if (status === 'completed') return 'Complete'
  if (['failed', 'cancelled', 'interrupted'].includes(status)) return 'Needs attention'
  if (status === 'waiting') return 'Waiting'
  if (status === 'ready' || status === 'created') return 'Getting ready'
  return 'Working'
}

function statusOf(value) {
  if (object(value)) value = value.type ?? value.status ?? value.state
  const status = clean(value ?? 'unknown', 32).toLowerCase().replace(/[ _]/g, '-')
  if (['inprogress', 'in-progress', 'started', 'active'].includes(status)) return 'running'
  if (['done', 'success', 'succeeded'].includes(status)) return 'completed'
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled'
  return status
}

function terminal(status) {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
}

function statusMark(status, paint) {
  if (status === 'completed') return paint.green('✓')
  if (['failed', 'cancelled', 'interrupted'].includes(status)) return paint.red('×')
  if (status === 'running') return paint.cyan('●')
  return paint.dim('○')
}

function planMark(status, paint) {
  return statusMark(status, paint)
}

function colors(enabled) {
  const wrap = (code) => (text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text
  return { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), cyan: wrap(36) }
}

function duration(start, end) {
  if (!start) return ''
  const ms = Math.max(0, timestamp(end ?? Date.now()) - timestamp(start))
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

function clock(value) {
  return new Date(timestamp(value)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function clip(value, length) {
  const text = clean(value, length + 1)
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text
}

function clean(value, length = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length)
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function array(value) {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]
}

function rule(width) {
  return '─'.repeat(width)
}

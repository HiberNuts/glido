import fsp from 'node:fs/promises'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { analyzeSessions } from './analyze.js'
import { generateAiAnalysis } from './ai.js'
import { buildCoachingBundle, generateCodexCoaching } from './coach.js'
import { loadLatestDashboard, serveDashboard, writeDashboard } from './dashboard.js'
import { formatCoachReport, formatFix, formatReport, formatSessions } from './format.js'
import { compareSnapshots, loadPreviousSnapshot, saveSnapshot, snapshotMetrics } from './history.js'
import { redactPrompt } from './redact.js'
import { recordRoute } from './route-history.js'
import { refinePrompt, routePrompt, ROUTER_EFFORTS, ROUTER_MODELS, validateEffort, validateModel } from './router.js'
import { codexSessionsDirectory, findSessionFiles, scanSessions } from './scan.js'
import { parseSince } from './utils.js'
import { CodexAppServer } from './app-server.js'
import { createAgentRun, findAgentRun, latestResumableRun, listAgentRuns, updateAgentRun } from './agent-store.js'
import { AGENT_DEFAULTS, buildMasterPrompt, normalizeDoneCriteria } from './orchestration.js'
import { createAgentRenderer } from './agent-ui.js'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json')

function help() {
  return `
Glido — the smart launcher for Codex

Usage:
  glido                         Start persistent routed chat
  glido [prompt]                Start persistent routed chat with a task
  glido run [prompt]            Route once, then open native Codex
  glido chat [prompt]           Keep a routed Codex conversation in Glido
  glido agent [goal]            Run a durable master Codex session with subagents
  glido agent status [run-id]   Show a saved agent run
  glido agent list              List saved agent runs
  glido agent resume [run-id]   Resume an interrupted agent run
  glido agent cancel [run-id]   Mark an inactive saved run cancelled
  glido report [options]        Local-only session report (no AI)
  glido sessions [options]     List the 20 most recent sessions
  glido coach [options]        AI prompt + model audit using your Codex login
  glido dashboard [options]    Reopen the latest private localhost report
  glido fix [options]          Preview reusable agent instructions
  glido doctor [options]       Check local setup
  glido update                 Update a global install to the latest release

Options:
  --since <24h|7d|4w|all>       Limit sessions by age (default: all)
  --project <name>              Filter by project directory name
  --session <file>              Analyze one JSONL session
  --path <directory>            Override the Codex sessions directory
  --json                        Print machine-readable JSON
  --ai                          Add opt-in AI interpretation of aggregate metrics
  --model <model>               Override the Coach or Router model
  --effort <level>              Router effort override: low, medium, high, xhigh, max
  --cd <directory>              Project directory for the launched Codex session
  --done <criteria>             Agent-mode definition of done
  -i, --image <path>            Attach an image to the initial Codex prompt (repeatable)
  --max-agents <1-6>            Maximum concurrent subagents (default: 3)
  --run-id <id>                 Agent run ID for status, resume, or cancel
  --dry-run                     Preview a route without launching Codex
  --no-refine                   Route the original prompt without adding safeguards
  --yes                         Confirm prompt analysis without an interactive question
  --humor <light|off>           Dashboard voice (default: light)
  --max-tasks <number>          Maximum prompt samples sent to Codex (default: 48)
  --no-open                     Do not open the dashboard browser automatically
  --port <number>               Local dashboard port (default: random free port)
  --target <agents|claude>      Fix preview format (default: agents)
  --no-color                    Disable terminal colors
  -h, --help                    Show help
  -v, --version                 Show version

Privacy:
  Glido ignores messages, reasoning, commands, command output, and file contents.
  --ai sends only aggregate metrics with project/tool names redacted.
  coach is a separate opt-in mode: prompts are redacted locally, then selected
  excerpts are sent to the user's authenticated Codex account for analysis.
  Agent mode stores its goal and definition of done locally with user-only access
  so an interrupted run can be resumed. It never stores reasoning or command output.
`
}

function agentHelp() {
  return `
Glido Agent Mode — one master Codex session for a larger goal

Usage:
  glido agent [goal] [options]       Plan, delegate, integrate, and verify a goal
  glido agent list                   List saved agent runs
  glido agent status <run-id>        Show a saved run
  glido agent resume <run-id>        Resume an interrupted run
  glido agent cancel <run-id>        Mark an inactive run cancelled

Examples:
  glido agent "Implement this screen" --image ./reference.png \\
    --done "Matches the reference and passes checks"
  glido agent "Ship OAuth" --max-agents 3 --done "Login works and tests pass"

Agent options:
  --done <criteria>                 What must be true before the master finishes
  --max-agents <1-6>                Maximum concurrent subagents (default: 3)
  --model <model>                   Override the master model
  --effort <level>                  low, medium, high, xhigh, or max
  --cd <directory>                  Project directory for the agent session
  -i, --image <path>                Attach an initial reference image (repeatable)
  --dry-run                         Preview the master prompt without launching Codex
  --yes                             Start without the interactive confirmation
  --json                            Print a machine-readable preview or saved run
  -h, --help                        Show this help

The goal and --done criteria are saved locally so interrupted runs can resume.
Glido stores neither Codex reasoning nor command output.
`
}

function chatHelp() {
  return `
Glido Chat — route every completed Codex follow-up in one thread

Usage:
  glido chat [prompt] [options]

Each follow-up stays in the same local Codex thread, but Glido chooses a
model and reasoning effort again. Chat starts immediately with your first
message. Press Enter to send. Use /paste for a
multi-line message, or /exit to leave. Use \`glido run\` when you want the
native Codex TUI. Press Escape while Codex is working to pause that turn and
keep the thread open.
`
}

function parseArgs(argv) {
  const args = [...argv]
  const promptParts = []
  const commands = new Set(['analyze', 'report', 'sessions', 'fix', 'coach', 'dashboard', 'doctor', 'update', 'run', 'chat', 'agent'])
  const options = { command: 'chat', prompt: '', since: null, project: null, session: null, path: null, cwd: process.cwd(), target: 'agents', json: false, ai: false, model: null, effort: null, dryRun: false, refine: true, color: process.stdout.isTTY, yes: false, humor: 'light', maxTasks: 48, maxAgents: 3, done: null, images: [], runId: null, agentAction: 'start', open: true, port: 0 }
  if (args[0] && !args[0].startsWith('-')) {
    const first = args.shift()
    if (commands.has(first)) options.command = first
    else promptParts.push(first)
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const take = () => {
      const value = args[++index]
      if (!value) throw new Error(`${arg} requires a value.`)
      return value
    }
    if (arg === '--since') options.since = parseSince(take())
    else if (arg === '--project') options.project = take()
    else if (arg === '--session') options.session = take()
    else if (arg === '--path') options.path = take()
    else if (arg === '--model') options.model = take()
    else if (arg === '--effort') options.effort = take().toLowerCase()
    else if (arg === '--cd') options.cwd = take()
    else if (arg === '--done') options.done = take()
    else if (arg === '--image' || arg === '-i') options.images.push(take())
    else if (arg === '--run-id') options.runId = take()
    else if (arg === '--max-agents') {
      options.maxAgents = Number(take())
      if (!Number.isInteger(options.maxAgents) || options.maxAgents < 1 || options.maxAgents > 6) throw new Error('--max-agents must be between 1 and 6.')
    }
    else if (arg === '--humor') {
      options.humor = take().toLowerCase()
      if (!['light', 'off'].includes(options.humor)) throw new Error('--humor must be light or off.')
    }
    else if (arg === '--max-tasks') {
      options.maxTasks = Number(take())
      if (!Number.isInteger(options.maxTasks) || options.maxTasks < 1 || options.maxTasks > 100) throw new Error('--max-tasks must be between 1 and 100.')
    }
    else if (arg === '--port') {
      options.port = Number(take())
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port must be between 0 and 65535.')
    }
    else if (arg === '--target') {
      options.target = take().toLowerCase()
      if (!['agents', 'claude'].includes(options.target)) throw new Error('--target must be agents or claude.')
    }
    else if (arg === '--json') options.json = true
    else if (arg === '--ai') options.ai = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-refine') options.refine = false
    else if (arg === '--no-open') options.open = false
    else if (arg === '--no-color') options.color = false
    else if (arg === '-h' || arg === '--help') {
      if (options.command === 'agent') options.agentAction = 'help'
      else if (options.command === 'chat') options.command = 'chat-help'
      else options.command = 'help'
    }
    else if (arg === '-v' || arg === '--version') options.command = 'version'
    else if (arg === '--') {
      promptParts.push(...args.slice(index + 1))
      break
    }
    else if (arg === '--all') { /* backwards-compatible no-op */ }
    else if (!arg.startsWith('-') && ['run', 'chat', 'agent'].includes(options.command)) promptParts.push(arg)
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (options.command === 'agent' && ['status', 'list', 'resume', 'cancel'].includes(promptParts[0])) {
    options.agentAction = promptParts.shift()
    options.runId ??= promptParts.shift() ?? null
  }
  options.prompt = promptParts.join(' ').trim()
  return options
}

export async function run(argv) {
  const options = parseArgs(argv)
  if (options.command === 'help') { console.log(help()); return }
  if (options.command === 'chat-help') { console.log(chatHelp()); return }
  if (options.command === 'version') { console.log(VERSION); return }
  if (options.command === 'dashboard') {
    const report = await loadLatestDashboard()
    if (options.json) {
      console.log(JSON.stringify({ reportPath: report.reportPath, shareCardPath: report.shareCardPath }, null, 2))
      return
    }
    await keepDashboardOpen(report, options)
    return
  }
  if (options.command === 'doctor') {
    const directory = codexSessionsDirectory(options.path)
    const access = await fsp.access(directory).then(() => true).catch(() => false)
    const files = access ? await findSessionFiles(directory) : []
    const codexVersion = await commandVersion('codex')
    const login = await commandStatus('codex', ['login', 'status'])
    const appServer = await commandStatus('codex', ['app-server', '--help'])
    const routerReady = Boolean(codexVersion && login.ok)
    const agentModeReady = Boolean(routerReady && appServer.ok)
    const nextStep = !codexVersion
      ? 'Install Codex: npm install --global @openai/codex@latest'
      : !login.ok
        ? 'Sign in: codex login'
        : !appServer.ok
          ? 'Update Codex: npm install --global @openai/codex@latest'
          : null
    console.log(JSON.stringify({ ok: routerReady, routerReady, agentModeReady, weeklyAuditReady: access && files.length > 0, codexVersion, codexAuthenticated: login.ok, directory, sessionFiles: files.length, node: process.version, aiReady: Boolean(process.env.OPENAI_API_KEY), nextStep }, null, 2))
    if (!routerReady) process.exitCode = 1
    return
  }
  if (options.command === 'update') {
    await updateGlido()
    return
  }
  if (options.command === 'run') {
    await runRouter(options)
    return
  }
  if (options.command === 'chat') {
    await runChat(options)
    return
  }
  if (options.command === 'agent') {
    await runAgentMode(options)
    return
  }
  if (!['analyze', 'report', 'sessions', 'fix', 'coach'].includes(options.command)) throw new Error(`Unknown command: ${options.command}`)

  if (options.command === 'coach') {
    if (!options.yes) await confirmDeepAudit()
    await ensureCodexReady({ agent: false })
    const since = options.since ?? parseSince('7d')
    if (!options.json && process.stderr.isTTY) process.stderr.write('Preparing your private review…')
    const scanned = await scanSessions({ directory: options.path, since, project: options.project, session: options.session, includePrompts: true, redactPrompt })
    if (!options.json && process.stderr.isTTY) process.stderr.write('\r\x1b[2K')
    if (!scanned.sessions.length) throw new Error('No matching Codex sessions found.')
    const analysis = analyzeSessions(scanned.sessions)
    const bundle = buildCoachingBundle(scanned.sessions, analysis, { maxTasks: options.maxTasks })
    const model = options.model ?? 'gpt-5.6-terra'
    if (!options.json) console.log(renderCoachIntro(bundle.tasks.length, model))
    const stopSpinner = options.json ? null : startSpinner(`Getting a second opinion from ${model}`)
    let coaching
    try {
      coaching = await generateCodexCoaching(bundle, { model: options.model ?? undefined, humor: options.humor })
    } finally {
      stopSpinner?.()
    }
    if (!options.json) console.log('Building your private dashboard…')
    const windowMs = Date.now() - since
    const previous = await loadPreviousSnapshot({ windowMs })
    const comparison = compareSnapshots(previous, snapshotMetrics(analysis, coaching))
    const saved = await saveSnapshot(analysis, coaching, { since: new Date(since).toISOString(), windowMs })
    const report = await writeDashboard({ analysis, coaching, bundle, comparison })
    if (options.json) {
      console.log(JSON.stringify({ analysis, coaching, comparison, snapshotPath: saved.target, reportPath: report.reportPath, shareCardPath: report.shareCardPath }, null, 2))
      return
    }
    console.log(formatCoachReport(analysis, coaching, { color: options.color }))
    console.log(`Private report: ${report.reportPath}`)
    console.log(`Share card:    ${report.shareCardPath}`)
    await keepDashboardOpen(report, options)
    return
  }

  if (!options.json && process.stderr.isTTY) process.stderr.write('Scanning local Codex sessions…')
  const scanned = await scanSessions({ directory: options.path, since: options.since, project: options.project, session: options.session })
  if (!options.json && process.stderr.isTTY) process.stderr.write('\r\x1b[2K')
  if (!scanned.sessions.length) throw new Error('No matching Codex sessions found.')

  if (options.command === 'sessions') {
    if (options.json) console.log(JSON.stringify(scanned.sessions, null, 2))
    else console.log(formatSessions(scanned.sessions, { color: options.color }))
    return
  }

  const analysis = analyzeSessions(scanned.sessions)
  if (options.command === 'fix') {
    if (options.json) console.log(JSON.stringify({ recommendations: analysis.recommendations }, null, 2))
    else console.log(formatFix(analysis, { target: options.target }))
    return
  }
  let ai = null
  if (options.ai) {
    if (!options.json) console.error('AI opt-in: sending aggregate, redacted metrics only…')
    ai = await generateAiAnalysis(analysis, { model: options.model ?? undefined })
  }
  if (options.json) console.log(JSON.stringify({ ...analysis, ai }, null, 2))
  else console.log(formatReport(analysis, { color: options.color, ai }))
}

export async function readPromptBlock(input, { heading, write = (value) => process.stdout.write(value), signal } = {}) {
  write(`\n${heading}\n  Paste or type multiple lines. Press Enter on an empty line when finished.\n`)
  const lines = []
  while (true) {
    const line = (await input.question(lines.length ? '  ' : '  > ', signal ? { signal } : undefined)).trimEnd()
    if (!line.trim()) return lines.join('\n').trim()
    lines.push(line)
  }
}

export function needsDoneCriteria(goal) {
  const text = String(goal ?? '').trim().replace(/\s+/g, ' ')
  if (text.split(' ').filter(Boolean).length <= 3) return true
  return /^(?:build|create|make|implement|fix|ship|work on)\s+(?:it|this|something|an app|a website|a feature)$/i.test(text)
}

export { parseArgs }

async function confirmDeepAudit() {
  if (!process.stdin.isTTY) throw new Error('Glido Coach needs explicit consent. Re-run with --yes after reviewing the privacy notice.')
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question('\nGlido Coach will read selected prompt text, redact likely secrets locally, then ask your Codex account for advice. Continue? [y/N] ')
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Coaching audit cancelled.')
  } finally {
    prompt.close()
  }
}

function renderCoachIntro(taskCount, model) {
  const taskLabel = `${taskCount} task sample${taskCount === 1 ? '' : 's'} selected`
  return `\n╭─ GLIDO COACH · PRIVATE REVIEW ───────────\n│ ✓ ${taskLabel}\n│ ✓ Likely secrets redacted on your computer\n│ ✦ Model: ${model}\n╰──────────────────────────────────────────\n`
}

function startSpinner(message) {
  if (!process.stderr.isTTY) {
    console.error(`${message}…`)
    return null
  }
  const frames = ['◐', '◓', '◑', '◒']
  const started = Date.now()
  let index = 0
  const draw = () => process.stderr.write(`\r${frames[index++ % frames.length]} ${message}…`)
  draw()
  const timer = setInterval(draw, 110)
  return () => {
    clearInterval(timer)
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
    process.stderr.write(`\r✓ Advice ready in ${seconds}s${' '.repeat(Math.max(0, message.length - 12))}\n`)
  }
}

async function updateGlido() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  console.log('Updating Glido to the latest release…')
  await new Promise((resolve, reject) => {
    const child = spawn(command, ['install', '--global', 'glido-coach@latest'], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`npm update failed with exit code ${code}.`)))
  })
  console.log('✓ Glido is up to date. Run `glido --version` to check it.')
}

async function runAgentMode(options) {
  if (options.agentAction === 'help') {
    console.log(agentHelp())
    return
  }
  if (options.agentAction === 'list') {
    const runs = await listAgentRuns({ limit: 50 })
    if (options.json) console.log(JSON.stringify(runs, null, 2))
    else console.log(renderAgentRunList(runs, { color: options.color }))
    return
  }

  if (options.agentAction === 'status') {
    const run = await resolveAgentRun(options)
    if (options.json) console.log(JSON.stringify(run, null, 2))
    else console.log(renderAgentRunStatus(run, { color: options.color }))
    return
  }

  if (options.agentAction === 'cancel') {
    const run = await resolveAgentRun(options)
    const cancelled = await updateAgentRun(run.id, { status: 'cancelled', error: 'Cancelled by user.' })
    if (options.json) console.log(JSON.stringify(cancelled, null, 2))
    else console.log(`Cancelled saved agent run ${cancelled.id}.`)
    return
  }

  const cwd = await resolveAgentCwd(options.cwd)
  if (options.agentAction === 'resume') {
    const run = await resolveAgentRun({ ...options, cwd })
    await resumeAgentRun(run, options)
    return
  }
  await startAgentRun(options, cwd)
}

async function startAgentRun(options, cwd) {
  let goal = options.prompt
  let done = options.done
  if (!goal) {
    if (!process.stdin.isTTY) throw new Error('Pass a goal after `glido agent`, or run it in an interactive terminal.')
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      goal = await readPromptBlock(input, { heading: '› What do you want to build?' })
      if (!done && needsDoneCriteria(goal)) done = await readPromptBlock(input, { heading: '› What must be true when it is finished? (This goal is brief—Enter to infer it.)' })
    } finally {
      input.close()
    }
  }
  if (!goal) throw new Error('Tell Glido what you want the agent team to accomplish.')
  const images = await resolveImagePaths(options.images, cwd)

  const model = validateModel(options.model ?? AGENT_DEFAULTS.masterModel)
  const effort = validateEffort(options.effort ?? AGENT_DEFAULTS.masterEffort)
  const doneCriteria = normalizeDoneCriteria(done)
  const prompt = buildMasterPrompt({ goal, doneCriteria, cwd, maxAgents: options.maxAgents })
  const preview = { goal, doneCriteria, cwd, model, effort, maxAgents: options.maxAgents, images }
  if (options.json || options.dryRun) {
    console.log(JSON.stringify({ ...preview, masterPrompt: prompt }, null, 2))
    if (!options.json) console.log('\nPreview only. Nothing was sent to Codex.')
    return
  }
  console.log(renderAgentPreview(preview, { color: options.color }))
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error('Starting Agent mode needs confirmation. Re-run with --yes or use --dry-run.')
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await input.question('\n[Enter] Start agent team   [q] Cancel\n> ')).trim().toLowerCase()
      if (answer === 'q' || answer === 'quit') {
        console.log('Cancelled. Nothing was sent to Codex.')
        return
      }
      if (answer) throw new Error('Choose Enter or q.')
    } finally {
      input.close()
    }
  }

  await ensureCodexReady({ agent: true })
  const run = await createAgentRun({ goal, doneCriteria, cwd, model, effort, maxAgents: options.maxAgents })
  await executeAgentRunWithFallback(run, prompt, { ...options, images }, false)
}

async function resumeAgentRun(run, options) {
  if (!run.threadId) throw new Error(`Agent run ${run.id} has no Codex thread to resume.`)
  await ensureCodexReady({ agent: true })
  const prompt = buildMasterPrompt({ goal: run.goal, doneCriteria: run.doneCriteria, cwd: run.cwd, maxAgents: run.maxAgents })
  const continuation = `${prompt}\n\nRESUME\nResume this prior run. Reassess the saved goal and completion criteria, inspect the current workspace, and continue from the current state. Do not assume prior work passed verification.`
  const next = await updateAgentRun(run.id, { status: 'running', error: null })
  const images = await resolveImagePaths(options.images, next.cwd)
  await executeAgentRunWithFallback(next, continuation, { ...options, cwd: next.cwd, model: next.model, effort: next.effort, maxAgents: next.maxAgents, images }, true)
}

async function executeAgentRunWithFallback(run, prompt, options, resume) {
  try {
    return await executeAgentRun(run, prompt, options, resume)
  } catch (error) {
    const issue = error.codexIssue ?? classifyCodexError(error)
    if (issue !== 'model' || !run.model || !process.stdin.isTTY) throw error
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await input.question(`\nYour Codex account could not use ${run.model}. Retry with your Codex default model? [Y/n] `)).trim()
      if (/^n(?:o)?$/i.test(answer)) throw error
    } finally {
      input.close()
    }
    const fallback = await updateAgentRun(run.id, { status: 'running', model: null, effort: null, error: null })
    console.log('Retrying with your Codex default model…')
    return executeAgentRun(fallback, prompt, { ...options, model: null, effort: null }, resume)
  }
}

async function executeAgentRun(run, prompt, options, resume) {
  const server = new CodexAppServer({ cwd: run.cwd })
  const renderer = createAgentRenderer({ run, output: process.stdout, color: options.color, onSnapshot: queueRunSnapshot(run.id) })
  let active = { threadId: run.threadId, turnId: run.turnId }
  let interrupted = false
  const completedTurns = []
  const rememberCompletedTurn = (params) => {
    completedTurns.push(params)
    if (completedTurns.length > 20) completedTurns.shift()
  }
  server.on('turn/completed', rememberCompletedTurn)
  const cleanup = async () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    server.off('turn/completed', rememberCompletedTurn)
    renderer.stop()
    await server.close()
  }
  const onSignal = async () => {
    if (interrupted) return
    interrupted = true
    process.stdout.write('\nInterrupting agent run…\n')
    try {
      if (active.threadId && active.turnId) await server.interrupt(active)
    } catch { /* The server may already have completed the turn. */ }
    await updateAgentRun(run.id, { status: 'blocked', error: 'Interrupted by user; resume to continue.' })
  }

  server.on('notification', (event) => renderer.handle(event))
  server.on('serverRequest', (request) => handleAgentServerRequest(server, request, renderer, options).catch((error) => server.respondError(request.id, error)))
  server.on('processError', (error) => renderer.handle({ method: 'warning', params: { message: error.message } }))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    active = resume
      ? await server.resumeThread({ threadId: run.threadId, cwd: run.cwd, model: run.model, effort: run.effort, prompt, images: options.images, maxAgents: run.maxAgents })
      : await server.startThread({ cwd: run.cwd, model: run.model, effort: run.effort, prompt, images: options.images, maxAgents: run.maxAgents })
    renderer.setMasterId(active.threadId)
    await updateAgentRun(run.id, { status: 'running', ...active })
    renderer.handle({ method: 'thread/status/changed', params: { threadId: active.threadId, status: 'running' } })
    const completed = await waitForAgentTurn(server, active, completedTurns)
    const status = String(completed?.status ?? 'completed').toLowerCase()
    const savedStatus = status === 'completed' ? 'completed' : status === 'interrupted' ? 'blocked' : 'failed'
    const saved = await updateAgentRun(run.id, { status: savedStatus, ...active, ...agentSnapshot(renderer.view), error: completed?.error?.message ?? null })
    if (!options.json) console.log(renderAgentRunStatus(saved, { color: options.color, final: true }))
    if (savedStatus !== 'completed') throw new Error(`Agent run ${savedStatus}. Resume it with \`glido agent resume ${saved.id}\`.`)
  } catch (error) {
    if (!interrupted) {
      const issue = classifyCodexError(error)
      error.codexIssue = issue
      const status = ['auth', 'model', 'limit'].includes(issue) ? 'blocked' : 'failed'
      await updateAgentRun(run.id, { status, ...agentSnapshot(renderer.view), error: friendlyCodexError(error, issue, run) })
    }
    throw error
  } finally {
    await cleanup()
  }
}

export function waitForAgentTurn(server, active, completedTurns = []) {
  const buffered = completedTurns.find((params) => matchesAgentTurn(params, active))
  if (buffered) return Promise.resolve(buffered?.turn ?? buffered)
  return new Promise((resolve, reject) => {
    const onCompleted = (params) => {
      if (!matchesAgentTurn(params, active)) return
      finish(resolve, params?.turn ?? params)
    }
    const onExit = (code, signal) => finish(reject, new Error(`Codex App Server stopped${code == null ? '' : ` (${code})`}${signal ? ` ${signal}` : ''}.`))
    const finish = (callback, value) => {
      server.off('turn/completed', onCompleted)
      server.off('exit', onExit)
      callback(value)
    }
    server.on('turn/completed', onCompleted)
    server.once('exit', onExit)
  })
}

function matchesAgentTurn(params, active) {
  const turn = params?.turn ?? params
  if (params?.threadId && params.threadId !== active.threadId) return false
  return !turn?.id || turn.id === active.turnId
}

function queueRunSnapshot(runId) {
  let pending = Promise.resolve()
  return (view) => {
    pending = pending.then(() => updateAgentRun(runId, agentSnapshot(view))).catch(() => {})
    return pending
  }
}

function agentSnapshot(view) {
  const agents = Object.values(view.workers ?? {}).map((worker) => ({
    id: worker.id, name: worker.name, task: worker.task, currentAction: worker.lastAction,
    status: storeAgentStatus(worker.status), model: worker.model,
    startedAt: worker.startedAt ? new Date(worker.startedAt).toISOString() : null,
    completedAt: worker.completedAt ? new Date(worker.completedAt).toISOString() : null,
  }))
  return { agents, plan: view.plan, usage: view.tokens, currentAction: view.master?.lastAction }
}

function storeAgentStatus(value) {
  const status = String(value ?? '').toLowerCase()
  if (['completed', 'failed', 'cancelled', 'waiting', 'running', 'pending'].includes(status)) return status
  return 'running'
}

async function handleAgentServerRequest(server, request, renderer, options) {
  const { method, params = {}, id } = request
  if (!process.stdin.isTTY) {
    respondWithDefaultDenial(server, id, method)
    return
  }
  renderer?.suspend?.()
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (method === 'item/tool/requestUserInput') {
      const answers = {}
      for (const question of params.questions ?? []) {
        const label = question.question ?? question.header ?? 'Agent question'
        const value = (await input.question(`\nAgent asks: ${label}\n> `)).trim()
        answers[question.id] = { answers: value ? [value] : [] }
      }
      server.respond(id, { answers })
      return
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      renderer?.handle?.({ method: 'warning', params: { message: 'Approval requested' } })
      const answer = (await input.question('\nCodex requests approval. [y] once  [s] session  [n] decline\n> ')).trim().toLowerCase()
      const decision = answer === 'y' || answer === 'yes' ? 'accept' : answer === 's' || answer === 'session' ? 'acceptForSession' : 'decline'
      server.respond(id, { decision })
      return
    }
    respondWithDefaultDenial(server, id, method)
  } finally {
    input.close()
    renderer?.resume?.()
  }
}

function defaultDeniedResponse(method) {
  if (method === 'item/tool/requestUserInput') return { answers: {} }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' }
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null, _meta: null }
  if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: 'abort' }
  if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1_000) }
  return null
}

function respondWithDefaultDenial(server, id, method) {
  const result = defaultDeniedResponse(method)
  if (result) server.respond(id, result)
  else server.respondError(id, { code: -32601, message: `Glido cannot safely answer ${method}` })
}

async function resolveAgentRun(options) {
  const run = options.runId
    ? await findAgentRun(options.runId)
    : options.agentAction === 'status'
      ? (await listAgentRuns({ limit: 1 }))[0] ?? null
      : await latestResumableRun({ cwd: options.cwd })
  if (!run) throw new Error(options.runId ? `Agent run not found: ${options.runId}` : 'No resumable agent run found. Pass --run-id to select a saved run.')
  return run
}

async function resolveAgentCwd(value) {
  const cwd = path.resolve(value ?? process.cwd())
  const valid = await fsp.stat(cwd).then((entry) => entry.isDirectory()).catch(() => false)
  if (!valid) throw new Error(`Project directory not found: ${cwd}`)
  return cwd
}

function renderAgentPreview({ goal, doneCriteria, cwd, model, effort, maxAgents, images = [] }, { color = true } = {}) {
  const bold = (value) => color ? `\x1b[1m${value}\x1b[0m` : value
  const dim = (value) => color ? `\x1b[2m${value}\x1b[0m` : value
  const criteria = doneCriteria.length ? doneCriteria.map((item) => `│  • ${item}`).join('\n') : '│  • The master will define measurable criteria after inspection.'
  const attachments = images.length ? `\n│\n│  Images\n${images.map((image) => `│  • ${path.basename(image)}`).join('\n')}` : ''
  return `\n╭─ ${bold('GLIDO AGENT MODE')} ─────────────────────────\n│\n│  ${bold(goal)}\n│  ${dim(path.basename(cwd))}\n│\n│  Master  ${model} · ${effort} effort\n│  Workers ${maxAgents} maximum${attachments}\n│\n│  Done when\n${criteria}\n│\n│  A master Codex thread will plan, delegate, integrate,\n│  and verify this goal in the live view below.\n╰──────────────────────────────────────────`
}

function renderAgentRunList(runs, { color = true } = {}) {
  if (!runs.length) return 'No saved agent runs.'
  const dim = (value) => color ? `\x1b[2m${value}\x1b[0m` : value
  return ['Saved agent runs', ...runs.map((run) => `${run.status.padEnd(10)} ${run.id.slice(0, 8)}  ${run.goal.slice(0, 72)}  ${dim(run.updatedAt)}`)].join('\n')
}

function renderAgentRunStatus(run, { color = true, final = false } = {}) {
  const bold = (value) => color ? `\x1b[1m${value}\x1b[0m` : value
  const statusLabel = run.status === 'completed' ? 'Complete' : run.status === 'running' ? 'Working' : run.status === 'waiting' ? 'Waiting' : ['failed', 'blocked'].includes(run.status) ? 'Needs attention' : run.status
  const criteria = run.doneCriteria.length ? run.doneCriteria.map((item) => `  ${run.status === 'completed' ? '✓' : '•'} ${item}`).join('\n') : '  • Inferred by the master during the run.'
  const agents = run.agents.length ? run.agents.map((agent, index) => {
    const heading = `  ${agent.status === 'completed' ? '✓' : agent.status === 'running' ? '●' : '○'} ${agent.name ?? `Worker ${index + 1}`} · ${agent.status === 'completed' ? 'Complete' : agent.status === 'running' ? 'Working' : agent.status}`
    const detail = agent.task || agent.currentAction
    return detail ? `${heading}\n      ${detail}` : heading
  }).join('\n') : '  No sub-agents were needed.'
  const plan = run.plan?.length ? `\n\nPlan\n${run.plan.map((step) => `  ${step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : '○'} ${step.text}`).join('\n')}` : ''
  return `\n${bold(final ? 'GLIDO AGENT RESULT' : 'GLIDO AGENT')}\nRun ${run.id.slice(0, 8)} · ${statusLabel}\n\nGoal\n${run.goal}\n\nDone when\n${criteria}\n\nAgents · ${run.agents.length} spawned\n${agents}${plan}${run.error ? `\n\nNote: ${run.error}` : ''}`
}

async function runChat(options) {
  const cwd = await resolveAgentCwd(options.cwd)
  const output = createChatOutput({ color: options.color, cwd })
  let promptText = options.prompt
  if (!promptText) {
    if (!process.stdin.isTTY) throw new Error('Pass a prompt after `glido chat`, or run it in an interactive terminal.')
    output.intro()
    promptText = await readChatFollowUp(() => {}, output)
    if (!promptText || /^\/(?:exit|quit)$/i.test(promptText)) {
      console.log('\nChat closed.')
      return
    }
  }
  if (!promptText) throw new Error('Tell Glido what you want Codex to do.')
  const images = await resolveImagePaths(options.images, cwd)
  const overrides = { model: options.model, effort: options.effort }
  let route = routePrompt(promptText, overrides)
  const initialPrompt = promptText

  if (options.json || options.dryRun) {
    console.log(JSON.stringify({ route, prompt: initialPrompt, images, continuesInSameThread: true }, null, 2))
    if (!options.json) console.log('\nPreview only. Nothing was sent to Codex.')
    return
  }

  await ensureCodexReady({ agent: true })
  const server = new CodexAppServer({ cwd, agents: false })
  let active = null
  let interrupted = false
  let abortPrompt = null
  const completedTurns = []
  let stopPauseListener = null
  let paused = false
  const rememberCompletedTurn = (params) => {
    completedTurns.push(params)
    if (completedTurns.length > 20) completedTurns.shift()
  }
  const onSignal = async () => {
    if (interrupted) return
    interrupted = true
    process.stdout.write('\nEnding routed chat…\n')
    abortPrompt?.()
    try { if (active) await server.interrupt(active) } catch { /* The turn may have completed. */ }
  }
  const pauseTurn = async () => {
    if (!active || interrupted || paused) return
    paused = true
    process.stdout.write('\nPaused. Your Codex thread is kept; send the next message when ready.\n')
    try { await server.interrupt(active) } catch { /* The turn may have completed. */ }
  }
  server.on('notification', output.handle)
  server.on('turn/completed', rememberCompletedTurn)
  server.on('serverRequest', (request) => handleAgentServerRequest(server, request, null, options).catch((error) => server.respondError(request.id, error)))
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    output.start(route)
    active = await server.startThread({ cwd, model: route.model, effort: route.effort, prompt: initialPrompt, images, maxAgents: 1 })
    server.request('account/rateLimits/read').then(output.rateLimits).catch(() => {})
    stopPauseListener = listenForEscape(pauseTurn)
    const initialFinished = await finishChatTurn(server, active, completedTurns, route, () => interrupted || paused)
    stopPauseListener()
    stopPauseListener = null
    if (!initialFinished && interrupted) return
    while (!interrupted) {
      const followUp = await readChatFollowUp((abort) => { abortPrompt = abort }, output)
      if (/^\/(?:exit|quit)$/i.test(followUp)) break
      if (!followUp) {
        console.log('Type a message, use /paste for multiple lines, or /exit to leave.')
        continue
      }
      route = routePrompt(followUp, overrides)
      output.route(route)
      active = await server.startTurn({ threadId: active.threadId, cwd, model: route.model, effort: route.effort, prompt: followUp })
      paused = false
      stopPauseListener = listenForEscape(pauseTurn)
      const finished = await finishChatTurn(server, active, completedTurns, route, () => interrupted || paused)
      stopPauseListener()
      stopPauseListener = null
      if (!finished && interrupted) return
    }
  } finally {
    stopPauseListener?.()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    server.off('turn/completed', rememberCompletedTurn)
    await server.close()
  }
  if (!interrupted) console.log('\nRouted chat ended. Your Codex thread remains in local Codex history.')
}

async function finishChatTurn(server, active, completedTurns, route, wasInterrupted = () => false) {
  const started = Date.now()
  const completed = await waitForAgentTurn(server, active, completedTurns)
  const status = String(completed?.status ?? 'completed').toLowerCase()
  const paused = status === 'interrupted' && wasInterrupted()
  await recordRoute(route, { launched: true, exitCode: status === 'completed' || paused ? 0 : 1, durationMs: Date.now() - started })
  if (paused) return false
  if (status !== 'completed') throw new Error(friendlyCodexError(completed?.error?.message ?? `Codex turn ${status}.`, classifyCodexError(completed?.error?.message)))
  return true
}

export function isEscapeKey(value) {
  return String(value) === '\u001b'
}

function listenForEscape(onEscape, input = process.stdin) {
  if (!input?.isTTY || typeof input.setRawMode !== 'function') return () => {}
  const onData = (chunk) => {
    if (String(chunk) === '\u0003') return process.kill(process.pid, 'SIGINT')
    if (isEscapeKey(chunk)) void onEscape()
  }
  input.setRawMode(true)
  input.resume()
  input.on('data', onData)
  return () => {
    input.off('data', onData)
    input.setRawMode(false)
    input.pause()
  }
}

async function readChatFollowUp(setAbort, output) {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  setAbort(() => controller.abort())
  let promptOpen = false
  try {
    const prompt = output?.beginPrompt?.() ?? '\nYou › '
    promptOpen = true
    const value = (await input.question(prompt, { signal: controller.signal })).trim()
    output?.endPrompt?.()
    promptOpen = false
    if (value !== '/paste') return value
    return await readPromptBlock(input, { heading: 'Paste your follow-up. Press Enter on an empty line to send.', signal: controller.signal })
  } catch (error) {
    if (error?.name === 'AbortError') return ''
    throw error
  } finally {
    if (promptOpen) output?.endPrompt?.()
    setAbort(null)
    input.close()
  }
}

function createChatOutput({ color = process.stdout.isTTY, cwd = process.cwd() } = {}) {
  const dim = (value) => color ? `\x1b[2m${value}\x1b[0m` : value
  const bold = (value) => color ? `\x1b[1m${value}\x1b[0m` : value
  const green = (value) => color ? `\x1b[32m${value}\x1b[0m` : value
  const state = { route: null, tokenUsage: null, rateLimits: null }
  let introduced = false
  const intro = () => {
    if (introduced) return
    introduced = true
    console.log(`\n${bold('GLIDO CHAT')}  ${dim('one Codex thread · every message is routed')}`)
  }
  return {
    intro,
    start(route) {
      intro()
      state.route = route
      console.log(`${green(`${route.model} ${route.effort}`)} ${dim('· starting Codex…')}`)
    },
    route(route) {
      const changed = route.model !== state.route?.model || route.effort !== state.route?.effort
      state.route = route
      if (changed) console.log(`\n${dim('•')} Model changed to ${green(`${route.model} ${route.effort}`)}`)
    },
    rateLimits(value) {
      state.rateLimits = value?.rateLimits ?? value
    },
    beginPrompt() {
      console.log(`\n${renderChatStatus({ ...state, cwd }, { color })}`)
      if (!color || !process.stdout.isTTY) return '› '
      const width = Math.max(20, (process.stdout.columns ?? 80) - 1)
      process.stdout.write(`\x1b[48;5;236m${' '.repeat(width)}\x1b[0m\r`)
      return '\x1b[48;5;236m\x1b[37m› '
    },
    endPrompt() {
      if (color && process.stdout.isTTY) process.stdout.write('\x1b[0m')
    },
    handle(message) {
      if (message?.method === 'thread/tokenUsage/updated') {
        state.tokenUsage = message.params?.tokenUsage ?? null
        return
      }
      if (message?.method === 'account/rateLimits/updated') {
        state.rateLimits = message.params?.rateLimits ?? state.rateLimits
        return
      }
      if (message?.method !== 'item/completed') return
      const item = message.params?.item ?? message.item
      if (item?.type === 'agentMessage' && item.text) process.stdout.write(`\n${bold('Codex')}\n${item.text.trim()}\n`)
    },
  }
}

export function renderChatStatus({ route, cwd, tokenUsage, rateLimits }, { color = false } = {}) {
  const paint = (code, value) => color ? `\x1b[${code}m${value}\x1b[0m` : value
  const parts = [paint(33, `${route?.model ?? 'Codex'} ${route?.effort ?? ''}`.trim()), paint(32, compactPath(cwd))]
  const contextWindow = Number(tokenUsage?.modelContextWindow)
  const contextTokens = Number(tokenUsage?.last?.totalTokens)
  if (contextWindow > 0 && Number.isFinite(contextTokens)) {
    parts.push(paint('38;5;208', `${Math.max(0, Math.round(100 - (contextTokens / contextWindow * 100)))}% context left`))
  }
  const windows = [rateLimits?.primary, rateLimits?.secondary].filter((window) => Number.isFinite(window?.usedPercent))
  const longest = windows.sort((a, b) => Number(b.windowDurationMins ?? 0) - Number(a.windowDurationMins ?? 0))[0]
  if (longest) {
    const label = Number(longest.windowDurationMins) >= 6 * 24 * 60 ? 'weekly' : 'limit'
    parts.push(paint(35, `${Math.max(0, 100 - longest.usedPercent)}% ${label} left`))
  }
  const totalTokens = Number(tokenUsage?.total?.totalTokens)
  if (totalTokens > 0) parts.push(paint('38;5;208', `${compactNumber(totalTokens)} tokens`))
  return parts.join(` ${paint(2, '·')} `)
}

function compactPath(value) {
  const resolved = path.resolve(value ?? process.cwd())
  const home = os.homedir()
  return resolved === home ? '~' : resolved.startsWith(`${home}${path.sep}`) ? `~${resolved.slice(home.length)}` : resolved
}

function compactNumber(value) {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

async function runRouter(options) {
  const cwd = path.resolve(options.cwd)
  const cwdIsDirectory = await fsp.stat(cwd).then((value) => value.isDirectory()).catch(() => false)
  if (!cwdIsDirectory) throw new Error(`Project directory not found: ${cwd}`)
  let promptText = options.prompt
  if (!promptText) {
    if (!process.stdin.isTTY) throw new Error('Pass a prompt after `glido run`, or run it in an interactive terminal.')
    process.stdout.write(renderRouterHome(cwd, { color: options.color, clear: true }))
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      promptText = await readPromptBlock(input, { heading: '› What do you want Codex to do?' })
    } finally {
      input.close()
    }
  }
  if (!promptText) throw new Error('Tell Glido what you want Codex to do.')
  const images = await resolveImagePaths(options.images, cwd)

  let overrides = { model: options.model, effort: options.effort }
  let route = routePrompt(promptText, overrides)
  let finalPrompt = options.refine ? refinePrompt(promptText, route) : promptText

  if (options.json) {
    console.log(JSON.stringify({ route, refinedPrompt: finalPrompt, images }, null, 2))
    return
  }

  console.log(renderRouterPreview(route, finalPrompt, { color: options.color, refined: options.refine, images }))
  if (options.dryRun) {
    console.log('\nPreview only. Nothing was sent to Codex.')
    return
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error('Launching Codex needs confirmation. Re-run with --yes or use --dry-run.')
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      while (true) {
        const answer = (await input.question('\n[Enter] Launch Codex   [e] Edit prompt   [m] Change route   [q] Cancel\n> ')).trim().toLowerCase()
        if (!answer) break
        if (answer === 'q' || answer === 'quit') {
          console.log('Cancelled. Nothing was sent to Codex.')
          return
        }
        if (answer === 'e' || answer === 'edit') {
          const replacement = await readPromptBlock(input, { heading: 'New prompt' })
          if (replacement) promptText = replacement
          route = routePrompt(promptText, overrides)
          finalPrompt = options.refine ? refinePrompt(promptText, route) : promptText
          console.log(renderRouterPreview(route, finalPrompt, { color: options.color, refined: options.refine, images }))
          continue
        }
        if (answer === 'm' || answer === 'model') {
          overrides = await chooseRoute(input, route)
          route = routePrompt(promptText, overrides)
          finalPrompt = options.refine ? refinePrompt(promptText, route) : promptText
          console.log(renderRouterPreview(route, finalPrompt, { color: options.color, refined: options.refine, images }))
          continue
        }
        console.log('Choose Enter, e, m, or q.')
      }
    } finally {
      input.close()
    }
  }

  await ensureCodexReady({ agent: false })
  const started = Date.now()
  let result = await launchCodex({ prompt: finalPrompt, route, cwd, images })
  let launchedRoute = route
  const issue = classifyCodexError(result.stderr)
  if (result.code !== 0 && issue === 'model' && route.model && process.stdin.isTTY) {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await input.question(`\nYour Codex account could not use ${route.model}. Retry with your Codex default model? [Y/n] `)).trim()
      if (!/^n(?:o)?$/i.test(answer)) {
        launchedRoute = { ...route, model: null, effort: null }
        result = await launchCodex({ prompt: finalPrompt, route: launchedRoute, cwd, images })
      }
    } finally {
      input.close()
    }
  }
  await recordRoute(route, { launched: true, exitCode: result.code, durationMs: Date.now() - started })
  if (result.code !== 0) throw new Error(friendlyCodexError(result.stderr || `Codex exited with code ${result.code}.`, classifyCodexError(result.stderr), { model: launchedRoute.model }))
}

function renderRouterPreview(route, prompt, { color = true, refined = true, images = [] } = {}) {
  const green = (value) => color ? `\x1b[32m${value}\x1b[0m` : value
  const bold = (value) => color ? `\x1b[1m${value}\x1b[0m` : value
  const dim = (value) => color ? `\x1b[2m${value}\x1b[0m` : value
  const reasons = route.reason.map((reason) => `│  ${reason}`).join('\n')
  const rubric = route.rubric
    ? `│  ${dim(`Scope ${route.rubric.scope} · Reasoning ${route.rubric.reasoning} · Uncertainty ${route.rubric.uncertainty}`)}\n│  ${dim(`Verification ${route.rubric.verification} · Consequence ${route.rubric.consequence} · Total ${route.rubric.total}/12`)}`
    : ''
  return `
╭─ ${bold('GLIDO ROUTER')} ${dim(`· ${route.confidence}% confidence`)}
│
│  ${green(`${route.model} · ${route.effort} effort`)}
│  ${route.category}
${rubric}
│
${reasons}
╰──────────────────────────────────────────

${bold(refined ? 'Improved prompt' : 'Prompt')}
${dim('────────────────────────────────────────────')}
${prompt}${images.length ? `\n\n${bold('Images')}\n${images.map((image) => `- ${path.basename(image)}`).join('\n')}` : ''}
${dim('────────────────────────────────────────────')}`
}

function renderRouterHome(cwd, { color = true, clear = false } = {}) {
  const green = (value) => color ? `\x1b[32m${value}\x1b[0m` : value
  const bold = (value) => color ? `\x1b[1m${value}\x1b[0m` : value
  const dim = (value) => color ? `\x1b[2m${value}\x1b[0m` : value
  const clearScreen = clear ? '\x1b[2J\x1b[H' : ''
  return `${clearScreen}
${green(bold('GLIDO'))}  ${dim('smart Codex routing')}
${dim('Project')}  ${path.basename(cwd)}  ${dim('· automatic model + effort selection')}

${dim('Describe the task. Enter sends; use /paste for multiple lines. Review the route before Codex opens.')}
`
}

async function chooseRoute(input, current) {
  console.log('\nModels')
  ROUTER_MODELS.forEach((model, index) => console.log(`  ${index + 1}. ${model}${model === current.model ? '  ← current' : ''}`))
  const modelAnswer = (await input.question(`Choose model [${ROUTER_MODELS.indexOf(current.model) + 1}]: `)).trim()
  const model = modelAnswer ? ROUTER_MODELS[Number(modelAnswer) - 1] : current.model
  if (!model) throw new Error(`Choose a model from 1 to ${ROUTER_MODELS.length}.`)

  console.log('\nReasoning effort')
  ROUTER_EFFORTS.forEach((effort, index) => console.log(`  ${index + 1}. ${effort}${effort === current.effort ? '  ← current' : ''}`))
  const effortAnswer = (await input.question(`Choose effort [${ROUTER_EFFORTS.indexOf(current.effort) + 1}]: `)).trim()
  const effort = effortAnswer ? ROUTER_EFFORTS[Number(effortAnswer) - 1] : current.effort
  if (!effort) throw new Error(`Choose an effort from 1 to ${ROUTER_EFFORTS.length}.`)
  return { model, effort }
}

function launchCodex({ prompt, route, cwd, images = [] }) {
  return new Promise((resolve, reject) => {
    console.log(`\nLaunching Codex${route.model ? ` with ${route.model} · ${route.effort} effort` : ' with your default model'}…\n`)
    const args = [
      ...(route.model ? ['--model', route.model] : []),
      ...(route.effort ? ['--config', `model_reasoning_effort="${route.effort}"`] : []),
      '--cd', cwd,
      ...images.flatMap((image) => ['--image', image]),
      prompt,
    ]
    if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
    const child = spawn('codex', args, { cwd, env: process.env, stdio: ['inherit', 'inherit', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8_192)
      process.stderr.write(chunk)
    })
    child.once('error', (error) => {
      if (error?.code === 'ENOENT') reject(new Error('Codex CLI was not found. Install Codex and run `codex login`.'))
      else reject(error)
    })
    child.once('close', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

async function resolveImagePaths(images, cwd) {
  const resolved = await Promise.all(images.map(async (image) => {
    const target = path.resolve(cwd, image)
    const entry = await fsp.stat(target).catch(() => null)
    if (!entry?.isFile()) throw new Error(`Image file not found: ${image}`)
    return target
  }))
  return [...new Set(resolved)]
}

async function ensureCodexReady({ agent = false } = {}) {
  let version = await commandVersion('codex')
  if (!version) {
    if (!process.stdin.isTTY) throw new Error('Codex CLI is required. Install it with `npm install --global @openai/codex@latest`, then run Glido again.')
    const install = await confirmSetup('Codex CLI is not installed.', '[Enter] Install Codex now   [q] Exit\n> ')
    if (!install) throw new Error('Codex setup cancelled.')
    await runInherited(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--global', '@openai/codex@latest'], 'Codex installation')
    version = await commandVersion('codex')
    if (!version) throw new Error('Codex still was not found. Check your npm global PATH, then run `glido doctor`.')
  }

  let login = await commandStatus('codex', ['login', 'status'])
  if (!login.ok) {
    if (!process.stdin.isTTY) throw new Error('Codex is not signed in. Run `codex login`, then try Glido again.')
    const signIn = await confirmSetup(`Codex is installed (${version}) but is not signed in.`, '[Enter] Sign in with Codex   [q] Exit\n> ')
    if (!signIn) throw new Error('Codex sign-in cancelled.')
    await runInherited('codex', ['login'], 'Codex sign-in')
    login = await commandStatus('codex', ['login', 'status'])
    if (!login.ok) throw new Error('Codex sign-in did not complete. Run `codex login`, then `glido doctor`.')
  }

  if (!agent) return { version, authenticated: true, appServer: null }
  let appServer = await commandStatus('codex', ['app-server', '--help'])
  if (!appServer.ok) {
    if (!process.stdin.isTTY) throw new Error('This Codex version does not support Agent mode. Update it with `npm install --global @openai/codex@latest`.')
    const update = await confirmSetup('Your Codex CLI is too old for Glido Agent mode.', '[Enter] Update Codex now   [q] Exit\n> ')
    if (!update) throw new Error('Codex update cancelled.')
    await runInherited(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--global', '@openai/codex@latest'], 'Codex update')
    appServer = await commandStatus('codex', ['app-server', '--help'])
    if (!appServer.ok) throw new Error('Codex Agent mode is still unavailable. Run `glido doctor` and verify that your `codex` command is current.')
  }
  return { version, authenticated: true, appServer: true }
}

async function confirmSetup(message, question) {
  console.log(`\n${message}`)
  const input = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await input.question(question)).trim()
    return !/^q(?:uit)?$/i.test(answer)
  } finally {
    input.close()
  }
}

function runInherited(command, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${label} failed with exit code ${code}.`)))
  })
}

export function classifyCodexError(error) {
  const text = String(error?.message ?? error ?? '').toLowerCase()
  if (!text) return 'unknown'
  if (/\b401\b|unauthori[sz]ed|not logged in|not signed in|authentication (?:is )?required|login required|sign in/.test(text)) return 'auth'
  if (/\b429\b|rate.?limit|usage.?limit|quota|credits? exhausted|too many requests|subscription limit/.test(text)) return 'limit'
  if (/(?:do|does) not have access|model.{0,80}(?:not found|unavailable|unsupported|not supported|access|entitle)|(?:unavailable|unsupported).{0,80}model/.test(text)) return 'model'
  if (/unknown (?:sub)?command|unrecognized (?:sub)?command|app.?server.{0,80}(?:not found|unsupported|not supported)/.test(text)) return 'version'
  return 'unknown'
}

function friendlyCodexError(error, issue = classifyCodexError(error), run = {}) {
  const id = run.id ? run.id.slice(0, 8) : null
  const resume = id ? ` Resume later with \`glido agent resume ${id}\`.` : ''
  if (issue === 'auth') return `Codex needs you to sign in. Run \`codex login\`, then try again.${resume}`
  if (issue === 'limit') return `Your Codex account has reached a usage or rate limit. Check your plan or wait for the limit to reset.${resume}`
  if (issue === 'model') return `${run.model ? `Model ${run.model}` : 'The selected model'} is not available to this Codex account. Use your Codex default model or choose another model.${resume}`
  if (issue === 'version') return 'Your Codex CLI does not support this feature. Update it with `npm install --global @openai/codex@latest`.'
  const detail = String(error?.message ?? error ?? 'Codex stopped unexpectedly.').trim().slice(-1_000)
  return `${detail}${resume || ' Run `glido doctor` to check the setup.'}`
}

async function commandVersion(command) {
  const result = await commandStatus(command, ['--version'])
  return result.ok ? result.output : null
}

function commandStatus(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', () => finish({ ok: false, output: null }))
    child.once('close', (code) => finish({ ok: code === 0, output: output.trim() || null }))
  })
}

async function keepDashboardOpen(report, options) {
  const hosted = await serveDashboard(report, { open: options.open, port: options.port })
  console.log(`Dashboard: ${hosted.url}`)
  console.log('Press Ctrl+C to stop the private local server.')
  await new Promise((resolve) => {
    const close = () => hosted.server.close(resolve)
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  })
}

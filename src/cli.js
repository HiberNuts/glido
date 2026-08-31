import fsp from 'node:fs/promises'
import readline from 'node:readline/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { analyzeSessions } from './analyze.js'
import { generateAiAnalysis } from './ai.js'
import { buildCoachingBundle, generateCodexCoaching } from './coach.js'
import { loadLatestDashboard, serveDashboard, writeDashboard } from './dashboard.js'
import { formatCoachReport, formatFix, formatReport, formatSessions } from './format.js'
import { compareSnapshots, loadPreviousSnapshot, saveSnapshot, snapshotMetrics } from './history.js'
import { redactPrompt } from './redact.js'
import { codexSessionsDirectory, findSessionFiles, scanSessions } from './scan.js'
import { parseSince } from './utils.js'

const require = createRequire(import.meta.url)
const { version: VERSION } = require('../package.json')

function help() {
  return `
Glido — learn from every session and waste fewer tokens

Usage:
  glido [options]               Private AI coaching using your Codex login
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
  --model <model>               Coach model (default: gpt-5.6-terra)
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
`
}

function parseArgs(argv) {
  const args = [...argv]
  const options = { command: 'coach', since: null, project: null, session: null, path: null, target: 'agents', json: false, ai: false, model: null, color: process.stdout.isTTY, yes: false, humor: 'light', maxTasks: 48, open: true, port: 0 }
  if (args[0] && !args[0].startsWith('-')) options.command = args.shift()
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
    else if (arg === '--no-open') options.open = false
    else if (arg === '--no-color') options.color = false
    else if (arg === '-h' || arg === '--help') options.command = 'help'
    else if (arg === '-v' || arg === '--version') options.command = 'version'
    else if (arg !== '--all') throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export async function run(argv) {
  const options = parseArgs(argv)
  if (options.command === 'help') { console.log(help()); return }
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
    console.log(JSON.stringify({ ok: access && files.length > 0, directory, sessionFiles: files.length, node: process.version, aiReady: Boolean(process.env.OPENAI_API_KEY) }, null, 2))
    if (!access || !files.length) process.exitCode = 1
    return
  }
  if (options.command === 'update') {
    await updateGlido()
    return
  }
  if (!['analyze', 'report', 'sessions', 'fix', 'coach'].includes(options.command)) throw new Error(`Unknown command: ${options.command}`)

  if (options.command === 'coach') {
    if (!options.yes) await confirmDeepAudit()
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

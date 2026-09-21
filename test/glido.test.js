import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { aiSafeSummary, analyzeSessions } from '../src/analyze.js'
import { buildCoachingBundle, coachingPrompt } from '../src/coach.js'
import { classifyCodexError, needsDoneCriteria, parseArgs, readPromptBlock, renderChatStatus, waitForAgentTurn } from '../src/cli.js'
import { buildTurnInput, CodexAppServer } from '../src/app-server.js'
import { calculateRoutingSavings, estimateCredits } from '../src/credits.js'
import { serveDashboard, writeDashboard } from '../src/dashboard.js'
import { formatFix } from '../src/format.js'
import { redactPrompt } from '../src/redact.js'
import { recordRoute } from '../src/route-history.js'
import { refinePrompt, routePrompt } from '../src/router.js'
import { parseSessionFile } from '../src/scan.js'
import { createAgentRun, findAgentRun, getAgentRun, latestResumableRun, updateAgentRun } from '../src/agent-store.js'
import { createAgentRenderer, createAgentView, reduceAgentEvent, renderAgentView } from '../src/agent-ui.js'
import { buildMasterPrompt, normalizeDoneCriteria } from '../src/orchestration.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('parses Codex metrics without retaining content', async () => {
  const session = await parseSessionFile(path.join(here, 'fixture.jsonl'))
  assert.equal(session.project, 'example-project')
  assert.equal(session.tokens.total_tokens, 1200)
  assert.equal(session.commands, 2)
  assert.equal(session.commandFailures, 2)
  assert.equal(session.repeatedFailures.length, 1)
  assert.equal(JSON.stringify(session).includes('private output'), false)
  assert.equal(JSON.stringify(session).includes('private message'), false)
  assert.equal(JSON.stringify(session).includes('npm test'), false)
  assert.equal(JSON.stringify(session).includes('super-secret-value'), false)
})

test('opt-in prompt parsing redacts secrets and builds task samples', async () => {
  const session = await parseSessionFile(path.join(here, 'fixture.jsonl'), { includePrompts: true, redactPrompt })
  assert.equal(session.tasks.length, 1)
  assert.equal(session.tasks[0].prompts.length, 1)
  assert.equal(session.tasks[0].actualModel, 'gpt-5.6-sol')
  assert.equal(session.tasks[0].tokens.total_tokens, 1200)
  assert.match(session.tasks[0].prompts[0], /<secret-redacted>/)
  assert.match(session.tasks[0].prompts[0], /<email-redacted>/)
  assert.equal(JSON.stringify(session.tasks).includes('super-secret-value'), false)
  const analysis = analyzeSessions([session])
  const bundle = buildCoachingBundle([session], analysis)
  assert.equal(bundle.tasks.length, 1)
  assert.equal(bundle.period.weeklyCapacity.usedPercent, 24)
})

test('redacts uncommon API credential prefixes', () => {
  const result = redactPrompt('Use apik_1234567890abcdefghijklmnopqrstuvwxyz here')
  assert.equal(result.text, 'Use <secret-redacted> here')
  assert.equal(result.redactions, 1)
  assert.equal(redactPrompt('Token abcdefghijklmnop1234567890qrstuvwxyz').text, 'Token <secret-redacted>')
})

test('calculates model credit and observed weekly allowance savings', () => {
  const tokens = { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 }
  assert.equal(estimateCredits(tokens, 'gpt-6-astra').credits, 250)
  assert.equal(estimateCredits(tokens, 'gpt-5.6-sol').credits, 100)
  assert.equal(estimateCredits(tokens, 'gpt-5.6-luna').credits, 5)
  const tasks = [{ id: 'task_1', actualModel: 'gpt-5.6-sol', tokens }]
  const result = calculateRoutingSavings(tasks, [{ taskId: 'task_1', recommendedModel: 'gpt-5.6-luna', confidence: 90 }], { usedPercent: 50, windowMinutes: 10_080 })
  assert.equal(result.savedCredits, 95)
  assert.equal(result.routingSavingsPercent, 95)
  assert.equal(result.weeklyLimitPercent, 47.5)
})

test('builds deterministic findings and redacts AI payload labels', async () => {
  const session = await parseSessionFile(path.join(here, 'fixture.jsonl'))
  const analysis = analyzeSessions([session])
  assert.equal(analysis.commandSuccessPercent, 0)
  assert.equal(analysis.cacheHitPercent, 40)
  assert.equal(analysis.findings[0].title, 'Repeated failed commands')
  assert.equal(analysis.recommendations[0].id, 'stop-retry-loops')
  const safe = aiSafeSummary(analysis)
  assert.equal(safe.projects[0].project, 'project_1')
  assert.equal(JSON.stringify(safe).includes('example-project'), false)
})

test('generates a non-mutating instructions preview', async () => {
  const session = await parseSessionFile(path.join(here, 'fixture.jsonl'))
  const analysis = analyzeSessions([session])
  const preview = formatFix(analysis, { target: 'claude' })
  assert.match(preview, /Suggested CLAUDE\.md instructions/)
  assert.match(preview, /Do not retry the same failing command more than twice/)
  assert.match(preview, /Glido changed no files/)
})

test('parses CLI options', () => {
  const options = parseArgs(['analyze', '--since', '7d', '--project', 'demo', '--ai', '--no-color', '--humor', 'off'])
  assert.equal(options.command, 'analyze')
  assert.equal(options.project, 'demo')
  assert.equal(options.ai, true)
  assert.equal(options.color, false)
  assert.equal(options.humor, 'off')
  assert.ok(options.since < Date.now())
  assert.equal(parseArgs([]).command, 'run')
  assert.equal(parseArgs(['Fix the mobile nav']).prompt, 'Fix the mobile nav')
  assert.equal(parseArgs(['report']).command, 'report')
  assert.equal(parseArgs(['chat', 'continue', 'this', 'task']).command, 'chat')
  assert.equal(parseArgs(['chat', 'continue', 'this', 'task']).prompt, 'continue this task')
  assert.equal(parseArgs(['chat', '--help']).command, 'chat-help')
  assert.equal(parseArgs(['update']).command, 'update')
  const routed = parseArgs(['run', 'fix', 'the', 'button', '--effort', 'low', '--dry-run'])
  assert.equal(routed.command, 'run')
  assert.equal(routed.prompt, 'fix the button')
  assert.equal(routed.effort, 'low')
  assert.equal(routed.dryRun, true)
  assert.equal(parseArgs(['run', 'hard task', '--effort', 'max']).effort, 'max')
  const agent = parseArgs(['agent', 'Build', 'a', 'release', 'dashboard', '--done', 'all checks pass', '--max-agents', '4'])
  assert.equal(agent.command, 'agent')
  assert.equal(agent.prompt, 'Build a release dashboard')
  assert.equal(agent.done, 'all checks pass')
  assert.equal(agent.maxAgents, 4)
  const images = parseArgs(['run', 'Match this screen', '--image', 'reference.png', '-i', 'error.png'])
  assert.deepEqual(images.images, ['reference.png', 'error.png'])
  const resume = parseArgs(['agent', 'resume', 'run-123'])
  assert.equal(resume.agentAction, 'resume')
  assert.equal(resume.runId, 'run-123')
  assert.equal(parseArgs(['agent', '--help']).agentAction, 'help')
})

test('builds a multimodal App Server turn without embedding image bytes', () => {
  const input = buildTurnInput('Match this screen', ['/tmp/reference.png'])
  assert.deepEqual(input, [
    { type: 'text', text: 'Match this screen', text_elements: [] },
    { type: 'localImage', path: '/tmp/reference.png', detail: null },
  ])
})

test('starts a routed follow-up turn in an existing Codex thread', async () => {
  const server = new CodexAppServer({ agents: false })
  server.initialized = true
  let received
  server._request = async (method, params) => {
    received = { method, params }
    return { turn: { id: 'turn-2' } }
  }
  const active = await server.startTurn({ threadId: 'thread-1', cwd: '/tmp/project', model: 'gpt-5.6-luna', effort: 'low', prompt: 'Now run focused tests' })
  assert.deepEqual(active, { threadId: 'thread-1', turnId: 'turn-2' })
  assert.equal(received.method, 'turn/start')
  assert.equal(received.params.threadId, 'thread-1')
  assert.equal(received.params.model, 'gpt-5.6-luna')
  assert.equal(received.params.effort, 'low')
})

test('renders the routed chat status from Codex usage data', () => {
  const status = renderChatStatus({
    route: { model: 'gpt-5.6-sol', effort: 'medium' },
    cwd: '/tmp/project',
    tokenUsage: {
      modelContextWindow: 100_000,
      last: { totalTokens: 28_000 },
      total: { totalTokens: 387_000 },
    },
    rateLimits: { secondary: { usedPercent: 52, windowDurationMins: 10_080 } },
  })
  assert.equal(status, 'gpt-5.6-sol medium · /tmp/project · 72% context left · 48% weekly left · 387K tokens')
})

test('collects a multiline pasted prompt without losing lines', async () => {
  const answers = ['Review production health', '- Check alerts', '- List slow APIs', '']
  const output = []
  const prompt = await readPromptBlock({ question: async () => answers.shift() }, {
    heading: 'What should Codex do?', write: (value) => output.push(value),
  })
  assert.equal(prompt, 'Review production health\n- Check alerts\n- List slow APIs')
  assert.match(output.join(''), /multiple lines/i)
})

test('only asks for explicit completion criteria when a goal is vague', () => {
  assert.equal(needsDoneCriteria('Build an app'), true)
  assert.equal(needsDoneCriteria('Build an Apple Mac app that cleans caches and unused files'), false)
  assert.equal(needsDoneCriteria('Implement this'), true)
})

test('builds a concise master orchestration prompt with completion criteria', () => {
  assert.deepEqual(normalizeDoneCriteria('- tests pass\n2. release notes exist'), ['tests pass', 'release notes exist'])
  const prompt = buildMasterPrompt({ goal: 'Ship the release', doneCriteria: ['Tests pass'], cwd: '/tmp/project', maxAgents: 3 })
  assert.match(prompt, /Ship the release/)
  assert.match(prompt, /Tests pass/)
  assert.match(prompt, /exclusive ownership/i)
  assert.match(prompt, /standard library/i)
  assert.match(prompt, /Do not stream internal reasoning/i)
})

test('persists private agent run metadata without command output', async () => {
  const previousHome = process.env.GLIDO_HOME
  const temporaryHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glido-agent-test-'))
  process.env.GLIDO_HOME = temporaryHome
  try {
    const created = await createAgentRun({ goal: 'Build a private dashboard', doneCriteria: ['Tests pass'], cwd: temporaryHome, model: 'gpt-6-astra', effort: 'high' })
    const updated = await updateAgentRun(created.id, {
      status: 'running', plan: [{ text: 'Inspect source', status: 'completed' }], usage: { total: 20, input: 10, output: 10 },
      currentAction: 'Running focused tests', agents: [{ id: 'worker-1', status: 'running', name: 'Explorer', task: 'Review tests', currentAction: 'Inspecting coverage' }],
    })
    assert.equal(updated.plan[0].text, 'Inspect source')
    assert.equal(updated.usage.total, 20)
    assert.equal(updated.agents[0].name, 'Explorer')
    assert.equal(updated.agents[0].task, 'Review tests')
    assert.equal(updated.agents[0].currentAction, 'Inspecting coverage')
    assert.equal((await findAgentRun(created.id.slice(0, 8))).id, created.id)
    assert.equal((await latestResumableRun({ cwd: temporaryHome })).id, created.id)
    const stored = JSON.stringify(await getAgentRun(created.id))
    assert.doesNotMatch(stored, /command output/i)
    const stat = await fsp.stat(path.join(temporaryHome, 'agent-runs', `${created.id}.json`))
    assert.equal(stat.mode & 0o077, 0)
  } finally {
    if (previousHome === undefined) delete process.env.GLIDO_HOME
    else process.env.GLIDO_HOME = previousHome
    await fsp.rm(temporaryHome, { recursive: true, force: true })
  }
})

test('reduces App Server agent events into a bounded visible dashboard', () => {
  const early = reduceAgentEvent(createAgentView({ goal: 'Build the release' }), { method: 'thread/status/changed', params: { threadId: 'unknown-thread', status: 'running' } })
  assert.equal(early.masterId, null)
  assert.equal(Object.keys(early.workers).length, 0)

  let view = createAgentView({ goal: 'Build the release', threadId: 'master-1' })
  view = reduceAgentEvent(view, { method: 'turn/plan/updated', params: { plan: [{ step: 'Inspect', status: 'inProgress' }] } })
  view = reduceAgentEvent(view, { method: 'item/started', params: { item: { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'running', receiverThreadIds: ['worker-1'], prompt: 'Inspect tests' } } })
  view = reduceAgentEvent(view, { method: 'item/completed', params: { item: { type: 'reasoning', status: 'completed' } } })
  view = reduceAgentEvent(view, { method: 'item/completed', params: { item: { type: 'commandExecution', command: "/bin/zsh -lc 'cat /Users/private/file'", status: 'completed' } } })
  view = reduceAgentEvent(view, { method: 'thread/tokenUsage/updated', params: { tokenUsage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } } })
  const rendered = renderAgentView(view, { color: false, width: 80 })
  assert.match(rendered, /Build the release/)
  assert.match(rendered, /Inspect/)
  assert.match(rendered, /Worker 1/)
  assert.match(rendered, /1 spawned/)
  assert.match(rendered, /1 working · 0 finished/)
  assert.match(rendered, /Task\s+Inspect tests/)
  assert.match(rendered, /Project inspected/)
  assert.doesNotMatch(rendered, /RCLI|worker-1|Tokens|Recent|reasoning|\/Users\/private/)

  const details = renderAgentView(view, { color: false, width: 80, selectedWorker: 'worker-1', interactive: true })
  assert.match(details, /Worker 1 details/)
  assert.match(details, /Activity/)
  assert.match(details, /Inspect tests/)
  assert.match(details, /\[a\] overview/)

  view = reduceAgentEvent(view, { method: 'turn/completed', params: { turn: { status: 'completed' } } })
  assert.equal(view.workers['worker-1'].status, 'completed')
  assert.match(renderAgentView(view, { color: false, width: 80 }), /0 working · 1 finished/)
})

test('classifies actionable Codex setup and account failures', () => {
  assert.equal(classifyCodexError('401 Unauthorized: please sign in'), 'auth')
  assert.equal(classifyCodexError('You do not have access to model gpt-6-astra'), 'model')
  assert.equal(classifyCodexError('429 usage limit reached'), 'limit')
  assert.equal(classifyCodexError('app-server command not supported'), 'version')
  assert.equal(classifyCodexError('Codex app-server exited unexpectedly'), 'unknown')
  assert.equal(classifyCodexError('unexpected failure'), 'unknown')
})

test('redraws the agent dashboard as one frame', () => {
  const writes = []
  const renderer = createAgentRenderer({
    run: { goal: 'Build the release' }, color: false,
    output: { isTTY: true, columns: 80, write: (value) => writes.push(value) },
  })
  renderer.handle({ method: 'turn/started' })
  renderer.handle({ method: 'turn/plan/updated', params: { plan: [{ step: 'Inspect', status: 'running' }] } })
  renderer.stop()
  assert.equal(writes.filter((value) => value.includes('\x1b[2J\x1b[H')).length, 2)
  assert.doesNotMatch(writes.join(''), /\x1b\[\d+F/)
})

test('accepts a turn completion that arrives before the waiter is attached', async () => {
  const server = new EventEmitter()
  const completed = { threadId: 'master-1', turn: { id: 'turn-1', status: 'completed' } }
  assert.equal((await waitForAgentTurn(server, { threadId: 'master-1', turnId: 'turn-1' }, [completed])).status, 'completed')
})

test('routes the checked-in release evaluation corpus', () => {
  const cases = [
    ['Fix the button alignment on this settings page', 'gpt-5.6-luna', 'low'],
    ['Change the billing page heading', 'gpt-5.6-luna', 'low'],
    ['Fix the authentication button label', 'gpt-5.6-luna', 'low'],
    ['Change the title on the security page', 'gpt-5.6-luna', 'low'],
    ['Write focused unit tests for this parser', 'gpt-5.6-luna', 'low'],
    ['Explain what this function does', 'gpt-5.6-luna', 'low'],
    ['Add an API endpoint and tests for exporting invoices', 'gpt-5.6-terra', 'medium'],
    ['Integrate a search service into the existing dashboard and add tests', 'gpt-5.6-terra', 'medium'],
    ['Build a reusable modal component with keyboard accessibility', 'gpt-5.6-terra', 'medium'],
    ['Refactor the service', 'gpt-5.6-terra', 'high'],
    ['Make it better', 'gpt-5.6-terra', 'medium'],
    ['Change authentication logic to prevent privilege escalation and add regression tests', 'gpt-5.6-sol', 'high'],
    ['Update payment webhook retry logic and add idempotency tests', 'gpt-5.6-sol', 'high'],
    ['Debug a race condition across distributed payment services and design a safe database migration rollback', 'gpt-5.6-sol', 'high'],
    ['Review the repo-wide architecture migration for data-loss risks', 'gpt-5.6-sol', 'high'],
    ['Drop table', 'gpt-5.6-sol', 'high'],
    ['Handle PII redaction', 'gpt-5.6-sol', 'high'],
    ['Fix HIPAA audit logging', 'gpt-5.6-sol', 'high'],
    ['Exhaustively prove correctness of this distributed payment algorithm; quality over speed', 'gpt-6-astra', 'xhigh'],
  ]
  let highStakesCases = 0
  for (const [prompt, model, effort] of cases) {
    const route = routePrompt(prompt)
    assert.equal(route.model, model, prompt)
    assert.equal(route.effort, effort, prompt)
    assert.equal(Object.keys(route.rubric).length, 6)
    if (route.signals.highStakes) {
      highStakesCases += 1
      assert.match(route.model, /^gpt-(?:5\.6-sol|6-astra)$/)
    }
  }
  assert.ok(highStakesCases > 0)

  const production = routePrompt('Add an API endpoint and tests for exporting invoices')
  assert.equal(production.signals.hasVerification, true)
  assert.equal(production.rubric.total, 5)
  assert.equal(routePrompt('Make it better').signals.needsClarification, true)
  assert.equal(routePrompt('Hard task', { model: 'gpt-6-astra', effort: 'max' }).effort, 'max')
})

test('refines prompts without changing the original request', () => {
  const original = 'Rename one button label'
  const refined = refinePrompt(original, routePrompt(original))
  assert.match(refined, new RegExp(original))
  assert.match(refined, /preserve unrelated behavior/i)
  assert.match(refined, /tests or checks/i)
})

test('does not send source task identifiers in the coaching prompt', async () => {
  const session = await parseSessionFile(path.join(here, 'fixture.jsonl'), { includePrompts: true, redactPrompt })
  const bundle = buildCoachingBundle([session], analyzeSessions([session]))
  assert.ok(bundle.tasks[0].sourceTaskId)
  assert.doesNotMatch(coachingPrompt(bundle, 'off'), new RegExp(bundle.tasks[0].sourceTaskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('route history stores metrics but never prompt text', async () => {
  const previousHome = process.env.GLIDO_HOME
  const temporaryHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glido-route-test-'))
  process.env.GLIDO_HOME = temporaryHome
  try {
    const secretPrompt = 'Fix private-customer-name in the billing page'
    const route = routePrompt(secretPrompt)
    await recordRoute(route, { launched: true, exitCode: 0, durationMs: 123 })
    const history = await fsp.readFile(path.join(temporaryHome, 'router', 'history.jsonl'), 'utf8')
    assert.doesNotMatch(history, /private-customer-name/)
    assert.match(history, /gpt-(?:5\.6-(?:luna|terra|sol)|6-astra)/)
  } finally {
    if (previousHome === undefined) delete process.env.GLIDO_HOME
    else process.env.GLIDO_HOME = previousHome
    await fsp.rm(temporaryHome, { recursive: true, force: true })
  }
})

test('writes and serves a private light dashboard', async () => {
  const previousHome = process.env.GLIDO_HOME
  const temporaryHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glido-test-'))
  process.env.GLIDO_HOME = temporaryHome
  try {
    const session = await parseSessionFile(path.join(here, 'fixture.jsonl'), { includePrompts: true, redactPrompt })
    const analysis = analyzeSessions([session])
    const bundle = buildCoachingBundle([session], analysis)
    const coaching = {
      promptQualityScore: 72, wittyLine: 'Sol brought a flamethrower to a tiny test.', diagnosis: 'The prompt needed clearer verification.',
      promptPatterns: [{ title: 'Missing verification', evidence: 'The sampled prompt had none.', action: 'Name the test command.' }],
      rewrites: [{ taskId: 'task_1', issue: 'Add verification', improvedPrompt: 'Fix the test and run the focused suite.' }],
      rightSizedPercent: 0, selection: bundle.selection,
      savings: calculateRoutingSavings(bundle.tasks, [{ taskId: 'task_1', recommendedModel: 'gpt-5.6-luna', recommendedEffort: 'low', taskExample: 'Fix one focused test', confidence: 80, reason: 'Focused change.' }], analysis.capacity),
    }
    const report = await writeDashboard({ analysis, coaching, bundle, comparison: null })
    assert.match(report.html, /Sol brought a flamethrower/)
    assert.match(report.html, /<strong>72<\/strong><span>\/100<\/span>/)
    assert.match(report.html, /Share on X/)
    assert.match(report.html, /https:\/\/x\.com\/intent\/post/)
    assert.doesNotMatch(report.html, /navigator\.share/)
    assert.match(report.html, /127\.0\.0\.1/)
    assert.match(report.html, /Example task/)
    assert.match(report.html, /Fix one focused test/)
    assert.match(report.html, /Low effort/)
    assert.match(report.html, /Effort not recorded/)
    assert.match(report.shareCard, />72<\/text>/)
    assert.match(report.shareCard, /Clear prompts\. A few gaps\./)
    assert.doesNotMatch(report.shareCard, /Sol brought a flamethrower/)
    const hosted = await serveDashboard(report, { open: false })
    const response = await fetch(hosted.url)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /Three fixes\. A cheaper Codex week\./)
    await new Promise((resolve) => hosted.server.close(resolve))
  } finally {
    if (previousHome === undefined) delete process.env.GLIDO_HOME
    else process.env.GLIDO_HOME = previousHome
    await fsp.rm(temporaryHome, { recursive: true, force: true })
  }
})

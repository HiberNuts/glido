import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { aiSafeSummary, analyzeSessions } from '../src/analyze.js'
import { buildCoachingBundle } from '../src/coach.js'
import { parseArgs } from '../src/cli.js'
import { calculateRoutingSavings, estimateCredits } from '../src/credits.js'
import { serveDashboard, writeDashboard } from '../src/dashboard.js'
import { formatFix } from '../src/format.js'
import { redactPrompt } from '../src/redact.js'
import { parseSessionFile } from '../src/scan.js'

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
  assert.equal(parseArgs([]).command, 'coach')
  assert.equal(parseArgs(['report']).command, 'report')
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

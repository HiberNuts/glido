import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { calculateRoutingSavings, normalizeModel } from './credits.js'

const ALLOWED_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

export function buildCoachingBundle(sessions, analysis, { maxTasks = 48, maxPromptChars = 60_000 } = {}) {
  const allTasks = sessions.flatMap((session) => (session.tasks ?? []).map((task) => ({
    ...task,
    sessionId: session.id,
  })))
  const candidates = allTasks
    .filter((task) => task.prompts?.length && task.actualModel)
    .map((task) => ({ ...task, impact: Number(task.tokens?.total_tokens ?? 0) + task.commandFailures * 100_000 + (!task.completed ? 50_000 : 0) }))
    .sort((a, b) => b.impact - a.impact)

  const tasks = []
  let promptChars = 0
  for (const task of candidates) {
    if (tasks.length >= maxTasks) break
    const prompt = task.prompts.join('\n\n--- follow-up ---\n\n')
    if (!prompt || (tasks.length && promptChars + prompt.length > maxPromptChars)) continue
    const id = `task_${tasks.length + 1}`
    tasks.push({
      id,
      sourceTaskId: task.id,
      actualModel: normalizeModel(task.actualModel),
      actualEffort: task.actualEffort ?? 'unknown',
      tokens: task.tokens,
      commands: task.commands,
      commandFailures: task.commandFailures,
      durationMs: task.durationMs,
      completed: task.completed,
      prompt,
      promptCount: task.prompts.length,
      promptRedactions: task.promptRedactions,
    })
    promptChars += prompt.length
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    period: {
      sessions: analysis.sessions,
      turns: analysis.turns,
      completedTurns: analysis.completedTurns,
      totalTokens: analysis.tokens.total_tokens,
      cacheHitPercent: analysis.cacheHitPercent,
      commandSuccessPercent: analysis.commandSuccessPercent,
      repeatedFailureGroups: analysis.repeatedFailureGroups,
      weeklyCapacity: analysis.retrospectiveCapacity ? {
        usedPercent: analysis.retrospectiveCapacity.usedPercent,
        windowMinutes: analysis.retrospectiveCapacity.windowMinutes,
        resetsAt: analysis.retrospectiveCapacity.resetsAt,
        basis: analysis.retrospectiveCapacity.basis,
      } : null,
    },
    selection: {
      tasksAvailable: candidates.length,
      tasksSelected: tasks.length,
      promptChars,
      method: 'Highest-token and highest-friction tasks first; prompt text truncated and secrets redacted locally.',
    },
    tasks,
    allTasks,
  }
}

export async function generateCodexCoaching(bundle, { model = 'gpt-5.6-terra', humor = 'light' } = {}) {
  if (!bundle.tasks.length) throw new Error('No user prompts were found in the selected sessions.')
  const temporaryDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'glido-coach-'))
  const schemaPath = path.join(temporaryDirectory, 'schema.json')
  const outputPath = path.join(temporaryDirectory, 'coaching.json')
  await fsp.writeFile(schemaPath, JSON.stringify(COACHING_SCHEMA), { mode: 0o600 })
  const prompt = coachingPrompt(bundle, humor)
  try {
    await run('codex', [
      'exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--model', model, '--output-schema', schemaPath, '--output-last-message', outputPath, '-',
    ], { cwd: temporaryDirectory, input: prompt })
    const parsed = JSON.parse(await fsp.readFile(outputPath, 'utf8'))
    return normalizeCoaching(parsed, bundle, { model, humor })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Codex CLI was not found. Install Codex and run `codex login`.')
    throw error
  } finally {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function coachingPrompt(bundle, humor) {
  const style = humor === 'off'
    ? 'Use a direct, professional tone and make wittyLine a plain factual sentence.'
    : 'Use warm, restrained wit in wittyLine and short labels. Never mock the user, uncertainty, security issues, or lost work. One clever line is enough.'
  const safeBundle = { ...bundle, allTasks: undefined }
  return `You are a private Codex usage coach. Analyze the supplied, locally redacted task samples.

For prompt quality, score clarity, relevant context, constraints, success criteria, verification, and avoidance of unnecessary repetition. Rewrite only the most valuable examples. Preserve the user's intent.

For every supplied task, recommend the least expensive GPT-5.6 model and reasoning effort that was likely sufficient:
- gpt-5.6-sol: ambiguous, advanced, high-stakes, or hardest reasoning/coding work.
- gpt-5.6-terra: normal production coding and work requiring sound judgment.
- gpt-5.6-luna: focused coding, extraction, routing, classification, and high-volume routine work.

Judge from the prompt and observable task telemetry. Do not assume a successful result proves a smaller model would have succeeded. Use lower confidence when evidence is weak. Do not calculate credits, money, raw token savings, or weekly-limit percentages; the local program calculates those deterministically from the official rate card.

${style}

Keep dashboard copy extremely easy to scan:
- diagnosis: one plain sentence, at most 18 words.
- wittyLine: one short sentence, at most 14 words.
- every pattern title: at most 5 words; every action: at most 18 words.
- every routing taskExample: a safe 3-10 word paraphrase. Never copy credentials, paths, URLs, names, or identifiers.
- every routing reason: one plain sentence, at most 22 words.
- Avoid jargon, stacked clauses, and long explanations.

Return JSON matching the provided schema. Include one routing row for every task ID.

AUDIT BUNDLE:
${JSON.stringify(safeBundle)}`
}

function normalizeCoaching(value, bundle, { model, humor }) {
  const taskIds = new Set(bundle.tasks.map((task) => task.id))
  const routing = []
  const received = new Set()
  for (const row of value.routing ?? []) {
    if (!taskIds.has(row.taskId) || received.has(row.taskId)) continue
    const recommendedModel = ALLOWED_MODELS.has(normalizeModel(row.recommendedModel)) ? normalizeModel(row.recommendedModel) : 'gpt-5.6-sol'
    const recommendedEffort = ALLOWED_EFFORTS.has(row.recommendedEffort) ? row.recommendedEffort : 'medium'
    const rawConfidence = Number(row.confidence ?? 0)
    const confidence = rawConfidence > 0 && rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence
    routing.push({ ...row, confidence, recommendedModel, recommendedEffort })
    received.add(row.taskId)
  }
  for (const task of bundle.tasks) {
    if (received.has(task.id)) continue
    routing.push({
      taskId: task.id,
      recommendedModel: ALLOWED_MODELS.has(task.actualModel) ? task.actualModel : 'gpt-5.6-sol',
      recommendedEffort: ALLOWED_EFFORTS.has(task.actualEffort) ? task.actualEffort : 'medium',
      confidence: 0,
      reason: 'Codex did not return a routing judgment for this task, so no downshift is assumed.',
    })
  }
  const savings = calculateRoutingSavings(bundle.tasks, routing, bundle.period.weeklyCapacity, { observedTasks: bundle.allTasks })
  const rightSized = savings.rows.filter((row) => row.actualModel === row.recommendedModel).length
  return {
    model,
    humor,
    generatedAt: new Date().toISOString(),
    promptQualityScore: Math.max(0, Math.min(100, Number(value.promptQualityScore ?? 0))),
    diagnosis: String(value.diagnosis ?? ''),
    wittyLine: String(value.wittyLine ?? ''),
    promptPatterns: value.promptPatterns ?? [],
    rewrites: (value.rewrites ?? []).filter((row) => taskIds.has(row.taskId)).slice(0, 5),
    routing,
    rightSizedPercent: savings.tasksAnalyzed ? Math.round(rightSized / savings.tasksAnalyzed * 100) : 0,
    savings,
    selection: bundle.selection,
  }
}

function run(command, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`Codex coaching failed (${code}). ${stderr.trim().slice(-1_500)}`))
    })
    child.stdin.end(input)
  })
}

const COACHING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    promptQualityScore: { type: 'number', minimum: 0, maximum: 100 },
    diagnosis: { type: 'string', maxLength: 160 },
    wittyLine: { type: 'string', maxLength: 120 },
    promptPatterns: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { title: { type: 'string', maxLength: 60 }, evidence: { type: 'string', maxLength: 180 }, action: { type: 'string', maxLength: 160 } },
        required: ['title', 'evidence', 'action'],
      },
    },
    rewrites: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { taskId: { type: 'string' }, issue: { type: 'string' }, improvedPrompt: { type: 'string' } },
        required: ['taskId', 'issue', 'improvedPrompt'],
      },
    },
    routing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          recommendedModel: { type: 'string', enum: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
          recommendedEffort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] },
          taskExample: { type: 'string', maxLength: 100 },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
          reason: { type: 'string', maxLength: 180 },
        },
        required: ['taskId', 'recommendedModel', 'recommendedEffort', 'taskExample', 'confidence', 'reason'],
      },
    },
  },
  required: ['promptQualityScore', 'diagnosis', 'wittyLine', 'promptPatterns', 'rewrites', 'routing'],
}

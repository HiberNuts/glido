const MILLION = 1_000_000

// OpenAI ChatGPT/Codex credit rate card, checked 2026-08-30.
// Source: https://learn.chatgpt.com/docs/pricing
export const CREDIT_RATE_CARD = Object.freeze({
  'gpt-5.6-sol': { input: 100, cachedInput: 10, output: 500 },
  'gpt-5.6-terra': { input: 50, cachedInput: 5, output: 300 },
  'gpt-5.6-luna': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5': { input: 125, cachedInput: 12.5, output: 750 },
  'gpt-5.4': { input: 62.5, cachedInput: 6.25, output: 375 },
  'gpt-5.4-mini': { input: 18.75, cachedInput: 1.875, output: 113 },
})

export const RATE_CARD_META = Object.freeze({
  checkedAt: '2026-08-30',
  source: 'https://learn.chatgpt.com/docs/pricing',
})

export function normalizeModel(model) {
  const value = String(model ?? '').toLowerCase().trim()
  if (!value) return null
  if (value.includes('5.6-sol')) return 'gpt-5.6-sol'
  if (value.includes('5.6-terra')) return 'gpt-5.6-terra'
  if (value.includes('5.6-luna')) return 'gpt-5.6-luna'
  if (value.includes('5.4-mini')) return 'gpt-5.4-mini'
  if (value.includes('5.5')) return 'gpt-5.5'
  if (value.includes('5.4')) return 'gpt-5.4'
  return value
}

export function estimateCredits(tokens, model) {
  const normalizedModel = normalizeModel(model)
  const rates = CREDIT_RATE_CARD[normalizedModel]
  if (!rates) return null
  const input = Math.max(0, Number(tokens?.input_tokens ?? 0))
  const cached = Math.min(input, Math.max(0, Number(tokens?.cached_input_tokens ?? 0)))
  const uncached = input - cached
  const output = Math.max(0, Number(tokens?.output_tokens ?? 0))
  const credits = (uncached / MILLION * rates.input)
    + (cached / MILLION * rates.cachedInput)
    + (output / MILLION * rates.output)
  return {
    model: normalizedModel,
    credits,
    components: {
      uncachedInput: uncached / MILLION * rates.input,
      cachedInput: cached / MILLION * rates.cachedInput,
      output: output / MILLION * rates.output,
    },
  }
}

export function calculateRoutingSavings(tasks, recommendations, capacity = null, { observedTasks = tasks } = {}) {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const rows = []
  for (const recommendation of recommendations ?? []) {
    const task = taskById.get(recommendation.taskId)
    if (!task) continue
    const actual = estimateCredits(task.tokens, task.actualModel)
    const suggested = estimateCredits(task.tokens, recommendation.recommendedModel)
    if (!actual || !suggested) continue
    const savedCredits = Math.max(0, actual.credits - suggested.credits)
    rows.push({
      taskId: task.id,
      actualModel: actual.model,
      actualEffort: task.actualEffort ?? null,
      recommendedModel: suggested.model,
      recommendedEffort: recommendation.recommendedEffort ?? null,
      taskExample: recommendation.taskExample || 'Reviewed Codex task',
      confidence: clamp(Number(recommendation.confidence ?? 0), 0, 100),
      reason: recommendation.reason ?? '',
      actualCredits: round(actual.credits),
      recommendedCredits: round(suggested.credits),
      savedCredits: round(savedCredits),
      savedPercent: actual.credits > 0 ? round(savedCredits / actual.credits * 100, 1) : 0,
    })
  }

  const analyzedCredits = rows.reduce((total, row) => total + row.actualCredits, 0)
  const savedCredits = rows.reduce((total, row) => total + row.savedCredits, 0)
  const observedCredits = observedTasks.reduce((total, task) => total + Number(estimateCredits(task.tokens, task.actualModel)?.credits ?? 0), 0)
  const routingSavingsPercent = analyzedCredits > 0 ? savedCredits / analyzedCredits * 100 : 0
  const usedPercent = Number(capacity?.usedPercent)
  const weeklyLimitPercent = Number.isFinite(usedPercent) && observedCredits > 0
    ? usedPercent * (savedCredits / observedCredits)
    : null

  return {
    tasksAnalyzed: rows.length,
    downshiftCandidates: rows.filter((row) => row.savedCredits > 0).length,
    analyzedCredits: round(analyzedCredits),
    observedCredits: round(observedCredits),
    savedCredits: round(savedCredits),
    routingSavingsPercent: round(routingSavingsPercent, 1),
    weeklyLimitPercent: weeklyLimitPercent === null ? null : round(weeklyLimitPercent, 1),
    weeklyLimitBasis: weeklyLimitPercent === null ? null : {
      observedUsedPercent: usedPercent,
      windowMinutes: capacity?.windowMinutes ?? null,
      resetsAt: capacity?.resetsAt ?? null,
      basis: capacity?.basis ?? null,
      qualifier: 'Retrospective estimate based on observed Codex weekly usage and local tasks; it is not the official account limit.',
    },
    rows: rows.sort((a, b) => b.savedCredits - a.savedCredits),
    rateCard: RATE_CARD_META,
  }
}

function round(value, digits = 3) {
  const factor = 10 ** digits
  return Math.round(Number(value ?? 0) * factor) / factor
}

function clamp(value, minimum, maximum) {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, value))
}

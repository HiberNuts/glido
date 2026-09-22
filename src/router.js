import { DEFAULT_ENGINEERING_RULES } from './orchestration.js'

const MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const PATTERNS = {
  mechanical: /\b(?:copy|wording|typo|readme|documentation|docs|format|lint|rename|comment|label|placeholder|title|alignment|spacing|padding|margin|colour|color|font|icon)\b/i,
  contentOnly: /\b(?:copy|wording|heading|headline|title|text|label|placeholder|description|font|color|colour|spacing|alignment)\b/i,
  readOnly: /\b(?:explain|summari[sz]e|describe|list|show|identify|what does|how does)\b/i,
  qualitySensitive: /\b(?:accessibility|design system|reusable .{0,20}component|public api|cross-platform|backwards compatibility)\b/i,
  focused: /\b(?:one|single|small|tiny|focused|contained|specific|only|this (?:file|component|function|test|page|endpoint|command))\b/i,
  normalFeature: /\b(?:feature|endpoint|api|integrat(?:e|ion)|database|schema|service|workflow|authentication|authorization|state management)\b/i,
  broad: /\b(?:architecture|architect|redesign|rewrite|repo[- ]wide|entire (?:app|codebase|system)|multiple services|distributed|migration|migrate|scalability|end[- ]to[- ]end)\b/i,
  investigation: /\b(?:debug|diagnose|investigate|root cause|flaky|intermittent|why does|find out)\b/i,
  deepReasoning: /\b(?:race condition|concurrency|deadlock|memory leak|performance bottleneck|architecture|distributed|algorithm|formal proof|optimi[sz]ation)\b/i,
  sensitiveDomain: /\b(?:payment|stripe|billing|financial|bank|transaction|auth|authentication|authorization|permission|credential|secret|encryption|security|vulnerability|production data|compliance|privacy|pii|personal data|patient|hipaa|gdpr|data protection)\b/i,
  sensitiveLogic: /\b(?:logic|flow|processing|webhook|permission|policy|access control|token|session|encryption|validation|migration|migrate|deploy|rollback|rotate|delete|redaction|audit|export)\b/i,
  destructive: /\b(?:production|data loss|database migration|migrate|delete|drop|rollback|deployment|deploy|terraform|kubernetes|infrastructure|incident|outage|rotate (?:keys?|credentials?))\b/i,
  verification: /\b(?:tests?|testing|verify|verification|validate|acceptance criteria|done when|success criteria|must pass|expected result)\b/i,
  hardVerification: /\b(?:race condition|flaky|intermittent|security|vulnerability|migration|production|performance|concurrency|data loss|prove correctness|formal proof)\b/i,
  context: /\b(?:existing|currently|instead of|without changing|preserve|because|expected|in [\w./-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|css|html))\b/i,
  qualityFirst: /\b(?:exhaustive|formal proof|prove correctness|critical incident|highest possible quality|quality over (?:speed|cost)|no matter how long)\b/i,
}

function has(pattern, text) {
  return pattern.test(text)
}

export function scorePrompt(prompt) {
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('Tell Glido what you want Codex to do.')

  const wordCount = text.split(/\s+/).length
  const conjunctions = (text.match(/\b(?:and|also|then|plus|across)\b/gi) ?? []).length
  const requirements = (text.match(/(?:^|\s)(?:\d+[.)]|[-*])\s/g) ?? []).length
  const signals = Object.fromEntries(Object.entries(PATTERNS).map(([name, pattern]) => [name, has(pattern, text)]))
  const testOnly = signals.verification && !signals.normalFeature && !signals.broad && !signals.investigation && !signals.sensitiveLogic && wordCount < 24
  const presentationOnly = signals.contentOnly && !signals.sensitiveLogic && !signals.broad
  const routineLike = signals.mechanical || signals.readOnly || testOnly || presentationOnly
  const vague = /\b(?:make|improve|refactor|optimi[sz]e|fix)\s+(?:the\s+)?(?:it|this|things?|stuff|service|app|code|problem)\b/i.test(text)
  const ambiguous = (wordCount < 4 && !routineLike) || vague

  let scope
  if (presentationOnly || signals.readOnly) scope = 0
  else if (signals.broad || conjunctions >= 4 || requirements >= 4) scope = 3
  else if (signals.normalFeature || signals.qualitySensitive || conjunctions >= 2 || requirements >= 2 || wordCount > 60) scope = 2
  else if (signals.focused || (!signals.mechanical && !presentationOnly)) scope = 1
  else scope = 0

  let reasoning
  if (presentationOnly || testOnly || signals.readOnly) reasoning = 0
  else if (signals.deepReasoning) reasoning = 3
  else if (signals.investigation || (signals.sensitiveDomain && signals.sensitiveLogic)) reasoning = 2
  else if (signals.normalFeature || (!signals.mechanical && !testOnly && !presentationOnly)) reasoning = 1
  else reasoning = 0

  let uncertainty
  if (signals.investigation || (wordCount < 6 && !routineLike)) uncertainty = 2
  else if (ambiguous || (!signals.context && !signals.verification && !routineLike)) uncertainty = 1
  else uncertainty = 0

  let verification
  if (presentationOnly || testOnly || signals.readOnly) verification = 0
  else if (signals.hardVerification) verification = 2
  else if (signals.normalFeature || signals.qualitySensitive || signals.investigation || signals.sensitiveLogic || scope >= 2) verification = 1
  else verification = 0

  let consequence
  if (presentationOnly || signals.readOnly) consequence = 0
  else if (signals.destructive || (signals.sensitiveDomain && signals.sensitiveLogic)) consequence = 3
  else if (signals.sensitiveDomain && !presentationOnly) consequence = 2
  else if (signals.normalFeature || signals.qualitySensitive || signals.investigation || scope >= 2) consequence = 1
  else consequence = 0

  const dimensions = { scope, reasoning, uncertainty, verification, consequence }
  const total = Math.min(12, Object.values(dimensions).reduce((sum, value) => sum + value, 0))
  const hardSafetyOverride = consequence === 3

  return {
    text,
    dimensions,
    total,
    signals: {
      wordCount,
      ambiguous,
      needsClarification: ambiguous && !signals.verification,
      hasContext: signals.context,
      hasVerification: signals.verification,
      highStakes: consequence >= 2,
      hardSafetyOverride,
      mechanical: routineLike,
      investigation: signals.investigation,
      broad: signals.broad,
      qualityFirst: signals.qualityFirst,
    },
  }
}

export function routePrompt(prompt, overrides = {}) {
  const rubric = scorePrompt(prompt)
  const { dimensions, total, signals } = rubric

  let model
  if (signals.qualityFirst && total >= 11) model = 'gpt-6-astra'
  else if (signals.hardSafetyOverride || total >= 8) model = 'gpt-5.6-sol'
  else if (total <= 3) model = 'gpt-5.6-luna'
  else model = 'gpt-5.6-terra'

  // A vague prompt needs clarification, not a needlessly expensive model.
  if (signals.needsClarification && !signals.hardSafetyOverride && total < 8) model = 'gpt-5.6-terra'

  let effort
  if (model === 'gpt-5.6-luna') effort = total <= 2 ? 'low' : 'medium'
  else if (model === 'gpt-5.6-terra') effort = total >= 7 ? 'high' : 'medium'
  else if (model === 'gpt-6-astra') effort = 'xhigh'
  else effort = 'high'

  let category
  if (signals.hardSafetyOverride) category = 'high-stakes engineering'
  else if (dimensions.reasoning >= 3) category = 'complex reasoning'
  else if (signals.investigation) category = 'debugging and investigation'
  else if (signals.mechanical) category = 'focused routine task'
  else if (dimensions.scope >= 2) category = 'multi-step production work'
  else category = 'focused coding task'

  const rankedDimensions = Object.entries(dimensions)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
  const reason = rankedDimensions.slice(0, 2).map(([name, value]) => dimensionReason(name, value))
  if (!reason.length) reason.push('The task is narrow, reversible, and easy to check.')
  if (signals.needsClarification) reason.unshift('The request needs one focused clarification before work begins.')

  let confidence = 88
  if (signals.needsClarification) confidence -= 28
  else if (!signals.hasContext) confidence -= 10
  if ([3, 4, 7, 8].includes(total)) confidence -= 8
  if (signals.hardSafetyOverride) confidence += 4
  confidence = Math.max(45, Math.min(95, confidence))

  if (overrides.model) model = validateModel(overrides.model)
  if (overrides.effort) effort = validateEffort(overrides.effort)

  return {
    model,
    effort,
    category,
    confidence,
    reason: reason.slice(0, 2),
    rubric: { ...dimensions, total },
    signals: { ...signals, complexity: total },
    overridden: Boolean(overrides.model || overrides.effort),
  }
}

function dimensionReason(name, value) {
  const labels = {
    scope: value >= 3 ? 'The change spans a broad part of the system.' : 'The task crosses more than one implementation area.',
    reasoning: value >= 3 ? 'The task requires deep technical reasoning.' : 'The work needs investigation or meaningful judgment.',
    uncertainty: value >= 2 ? 'The cause or desired outcome is not yet clear.' : 'Some useful starting context is missing.',
    verification: value >= 2 ? 'Correctness will be difficult to verify.' : 'The result needs normal production checks.',
    consequence: value >= 3 ? 'A mistake could affect sensitive data or production behavior.' : 'The change has meaningful user or data impact.',
  }
  return labels[name]
}

export function refinePrompt(prompt, route) {
  const original = String(prompt ?? '').trim()
  const additions = []
  if (!route.signals.hasContext) additions.push(DEFAULT_ENGINEERING_RULES[0])
  additions.push(...DEFAULT_ENGINEERING_RULES.slice(1, 5))
  additions.push('Keep the change within the requested scope and preserve unrelated behavior.')
  if (route.signals.highStakes) additions.push('State safety assumptions and verify failure, rollback, and sensitive-data handling where relevant.')
  if (!route.signals.hasVerification) additions.push(DEFAULT_ENGINEERING_RULES[6])
  additions.push(DEFAULT_ENGINEERING_RULES[5])
  if (route.signals.needsClarification) additions.push('Ask one focused question before editing if the missing detail changes the correct solution.')

  return `Task\n${original}\n\nWorking agreement\n${additions.map((item) => `- ${item}`).join('\n')}`
}

export function validateModel(model) {
  const normalized = String(model ?? '').trim().toLowerCase()
  if (!MODELS.includes(normalized)) throw new Error(`Unsupported model: ${model}. Use ${MODELS.join(', ')}.`)
  return normalized
}

export function validateEffort(effort) {
  const normalized = String(effort ?? '').trim().toLowerCase()
  if (!EFFORTS.includes(normalized)) throw new Error(`Unsupported effort: ${effort}. Use ${EFFORTS.join(', ')}.`)
  return normalized
}

export const ROUTER_MODELS = MODELS
export const ROUTER_EFFORTS = EFFORTS

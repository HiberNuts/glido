import path from 'node:path'

export const AGENT_DEFAULTS = Object.freeze({
  maxAgents: 3,
  masterModel: 'gpt-6-astra',
  masterEffort: 'high',
})

export const DEFAULT_ENGINEERING_RULES = Object.freeze([
  'Inspect the relevant code and repository instructions before changing anything.',
  'Reuse existing code, then the standard library, native features, and installed dependencies before adding code or packages.',
  'Avoid speculative abstractions, boilerplate, and scaffolding for hypothetical needs.',
  'Fix root causes in the shared path instead of patching the same symptom in multiple callers.',
  'Preserve unrelated behavior and existing user changes.',
  'Share only relevant context, summarize discoveries once, and keep reports concise.',
  'Run the narrowest relevant tests or checks needed to prove non-trivial work; do not repeat a passing check without a reason.',
])

export function normalizeDoneCriteria(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/)
  return items
    .map((item) => String(item).replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
}

export function buildMasterPrompt({ goal, doneCriteria, cwd = process.cwd(), maxAgents = AGENT_DEFAULTS.maxAgents } = {}) {
  const normalizedGoal = String(goal ?? '').trim()
  if (!normalizedGoal) throw new Error('Tell Glido what you want the agent team to accomplish.')
  const concurrency = Number(maxAgents)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
    throw new Error('maxAgents must be an integer from 1 to 6.')
  }

  const criteria = normalizeDoneCriteria(doneCriteria)
  const acceptance = criteria.length
    ? criteria.map((item) => `- ${item}`).join('\n')
    : '- Infer a concrete, testable definition of done from the goal and state it before editing.'
  const rules = DEFAULT_ENGINEERING_RULES.map((rule) => `- ${rule}`).join('\n')

  return `You are the master agent for this run. You own the goal, every integration decision, and the final result.

GOAL
${normalizedGoal}

DEFINITION OF DONE
${acceptance}

WORKSPACE
${path.resolve(String(cwd || process.cwd()))}

ORCHESTRATION CONTRACT
1. Read all applicable instructions and inspect the repository before planning or editing.
2. Create a small dependency-aware plan. Start with a shallow inventory and read only files that can affect the goal. Do not scan unrelated directories, load full skills or plugins unless they apply, or repeat an inspection already summarized by a worker.
3. Delegate only independent, bounded tasks that benefit from parallel work. Prefer parallel inspection, research, review, and tests over concurrent writes.
4. Keep at most ${concurrency} workers active. Reuse workers for follow-ups and do not recursively fan out beyond this cap.
5. Give each writing worker exclusive ownership of named files or components. Never assign overlapping writes; keep shared integration files under your control.
6. Give workers the minimum relevant context, a concrete deliverable, boundaries, and a proving check. Require a compact report: result; files changed; checks and outcomes; blockers or risks.
7. Work on unblocked tasks while workers run. Wait for required results, review their changes, resolve conflicts, and integrate one coherent solution. Worker reports are evidence, not completion.
8. Continue autonomously through ordinary ambiguity and recoverable failures. Ask only when a missing choice materially changes the outcome or requires new authority. Declare blocked only after exhausting safe in-scope alternatives.
9. Inherit every security, privacy, sandbox, approval, and repository rule. Delegation never expands permissions. Never expose secrets or persist command output or file contents as orchestration metadata.
10. Keep human status messages brief: current phase, active workers, completed work, next dependency, and decisions needed. Do not stream internal reasoning.

DEFAULT ENGINEERING RULES
${rules}

EXECUTION
Inspect → Plan → Delegate independent work → Integrate → Verify → Finish

Start by stating the acceptance criteria and concise plan, then execute. Before finishing, run the appropriate integrated checks and verify every criterion. Return one unified report with the outcome, files changed, checks and results, remaining risks, and a pass/fail checklist.`
}

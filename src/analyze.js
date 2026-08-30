import { percent, percentile } from './utils.js'
import { buildRecommendations } from './recommend.js'

function sum(sessions, getter) {
  return sessions.reduce((total, session) => total + Number(getter(session) ?? 0), 0)
}

export function analyzeSessions(sessions) {
  const tokenKeys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
  const tokens = Object.fromEntries(tokenKeys.map((key) => [key, sum(sessions, (session) => session.tokens[key])]))
  const projects = new Map()
  const models = new Map()
  const repeatedFamilies = new Map()
  const turnDurations = sessions.flatMap((session) => session.turnDurations)
  const ttft = sessions.flatMap((session) => session.ttft)

  for (const session of sessions) {
    const project = projects.get(session.project) ?? { name: session.project, sessions: 0, turns: 0, tokens: 0, commands: 0, failures: 0 }
    project.sessions += 1
    project.turns += session.turns
    project.tokens += session.tokens.total_tokens
    project.commands += session.commands
    project.failures += session.commandFailures
    projects.set(session.project, project)
    for (const model of session.models) models.set(model, (models.get(model) ?? 0) + 1)
    for (const group of session.repeatedFailures) {
      const current = repeatedFamilies.get(group.family) ?? { family: group.family, groups: 0, calls: 0, failures: 0 }
      current.groups += 1
      current.calls += group.count
      current.failures += group.failures
      repeatedFamilies.set(group.family, current)
    }
  }

  const capacityObservations = sessions.map((session) => session.capacity).filter(Boolean)
  const latestCapacity = [...capacityObservations].sort((a, b) => b.observedAt - a.observedAt)[0] ?? null
  const peakCapacity = [...capacityObservations].filter((item) => item.period === 'weekly').sort((a, b) => b.usedPercent - a.usedPercent)[0] ?? latestCapacity
  const commands = sum(sessions, (session) => session.commands)
  const commandFailures = sum(sessions, (session) => session.commandFailures)
  const turns = sum(sessions, (session) => session.turns)
  const completedTurns = sum(sessions, (session) => session.completedTurns)
  const abortedTurns = sum(sessions, (session) => session.abortedTurns)
  const repeatedFailureGroups = sum(sessions, (session) => session.repeatedFailures.length)

  const analysis = {
    generatedAt: new Date().toISOString(),
    sessions: sessions.length,
    projects: [...projects.values()].map((project) => ({
      ...project,
      commandSuccessPercent: percent(project.commands - project.failures, project.commands),
    })).sort((a, b) => b.tokens - a.tokens),
    models: [...models.entries()].map(([name, count]) => ({ name, sessions: count })).sort((a, b) => b.sessions - a.sessions),
    tokens,
    cacheHitPercent: percent(tokens.cached_input_tokens, tokens.input_tokens),
    turns,
    completedTurns,
    tokensPerCompletedTurn: completedTurns ? Math.round(tokens.total_tokens / completedTurns) : 0,
    abortedTurns,
    commands,
    commandFailures,
    commandSuccessPercent: percent(commands - commandFailures, commands),
    patches: sum(sessions, (session) => session.patches),
    patchFailures: sum(sessions, (session) => session.patchFailures),
    mcpCalls: sum(sessions, (session) => session.mcpCalls),
    mcpFailures: sum(sessions, (session) => session.mcpFailures),
    webSearches: sum(sessions, (session) => session.webSearches),
    toolCalls: sum(sessions, (session) => session.toolCalls),
    repeatedFailureGroups,
    repeatedFamilies: [...repeatedFamilies.values()].sort((a, b) => b.failures - a.failures),
    averageTurnMs: turnDurations.length ? sum(turnDurations, (value) => value) / turnDurations.length : 0,
    p95TurnMs: percentile(turnDurations, 0.95),
    averageTtftMs: ttft.length ? sum(ttft, (value) => value) / ttft.length : 0,
    elapsedMs: sum(sessions, (session) => session.elapsedMs),
    capacity: latestCapacity,
    retrospectiveCapacity: peakCapacity ? { ...peakCapacity, basis: 'highest weekly usage observation in the selected period' } : null,
    parseErrors: sum(sessions, (session) => session.parseErrors),
    topSessions: [...sessions].sort((a, b) => b.tokens.total_tokens - a.tokens.total_tokens).slice(0, 5).map((session) => ({
      id: session.id,
      project: session.project,
      tokens: session.tokens.total_tokens,
      turns: session.turns,
      commandFailures: session.commandFailures,
      startedAt: session.startedAt ? new Date(session.startedAt).toISOString() : null,
    })),
  }
  analysis.findings = buildFindings(analysis)
  analysis.recommendations = buildRecommendations(analysis)
  return analysis
}

function buildFindings(analysis) {
  const findings = []
  if (analysis.repeatedFailureGroups > 0) findings.push({ severity: 'high', title: 'Repeated failed commands', detail: `${analysis.repeatedFailureGroups} repeated failure group${analysis.repeatedFailureGroups === 1 ? '' : 's'} would benefit from a two-strike circuit breaker.` })
  if (analysis.commands >= 5 && analysis.commandSuccessPercent < 85) findings.push({ severity: 'medium', title: 'Low command success rate', detail: `${analysis.commandSuccessPercent}% of recorded command executions succeeded.` })
  if (analysis.cacheHitPercent < 20 && analysis.tokens.input_tokens > 100_000) findings.push({ severity: 'medium', title: 'Low cache reuse', detail: `Only ${analysis.cacheHitPercent}% of input tokens were served from cache across a large context volume.` })
  if (analysis.abortedTurns > 0) findings.push({ severity: 'low', title: 'Aborted turns', detail: `${analysis.abortedTurns} turn${analysis.abortedTurns === 1 ? '' : 's'} ended before completion.` })
  if (analysis.p95TurnMs > 10 * 60_000) findings.push({ severity: 'low', title: 'Long-tail turn latency', detail: 'The slowest 5% of turns took more than ten minutes.' })
  if (!findings.length && analysis.sessions > 0) findings.push({ severity: 'good', title: 'No obvious efficiency regressions', detail: 'The deterministic checks found no repeated failures or unusually weak command success.' })
  return findings
}

export function aiSafeSummary(analysis) {
  return {
    sessions: analysis.sessions,
    projectCount: analysis.projects.length,
    projects: analysis.projects.map((project, index) => ({ project: `project_${index + 1}`, sessions: project.sessions, turns: project.turns, tokens: project.tokens, commands: project.commands, failures: project.failures, commandSuccessPercent: project.commandSuccessPercent })),
    models: analysis.models,
    tokens: analysis.tokens,
    cacheHitPercent: analysis.cacheHitPercent,
    turns: analysis.turns,
    abortedTurns: analysis.abortedTurns,
    commands: analysis.commands,
    commandFailures: analysis.commandFailures,
    commandSuccessPercent: analysis.commandSuccessPercent,
    repeatedFailureGroups: analysis.repeatedFailureGroups,
    repeatedFamilies: analysis.repeatedFamilies.map((group, index) => ({ family: `tool_family_${index + 1}`, groups: group.groups, calls: group.calls, failures: group.failures })),
    averageTurnMs: Math.round(analysis.averageTurnMs),
    p95TurnMs: Math.round(analysis.p95TurnMs),
    averageTtftMs: Math.round(analysis.averageTtftMs),
    capacity: analysis.capacity ? { usedPercent: analysis.capacity.usedPercent, resetsAt: analysis.capacity.resetsAt } : null,
  }
}

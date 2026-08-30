import { formatDuration, formatNumber } from './utils.js'

const ansi = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', gray: '\x1b[90m',
}

function painter(enabled) {
  return (text, ...codes) => enabled ? `${codes.join('')}${text}${ansi.reset}` : String(text)
}

function bar(value, width = 20) {
  const clamped = Math.max(0, Math.min(100, Number(value ?? 0)))
  const filled = Math.round((clamped / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function pad(value, length) {
  const string = String(value)
  return string.length >= length ? string.slice(0, length) : string.padEnd(length)
}

export function formatReport(analysis, { color = true, ai = null } = {}) {
  const paint = painter(color)
  const lines = []
  lines.push('')
  lines.push(`${paint('GLIDO', ansi.bold, ansi.green)} ${paint('for Codex', ansi.dim)}`)
  lines.push(paint('Local session analytics · content ignored, never retained or sent', ansi.gray))
  lines.push('')
  lines.push(`${paint(String(analysis.sessions), ansi.bold)} sessions  ·  ${paint(String(analysis.projects.length), ansi.bold)} projects  ·  ${paint(String(analysis.turns), ansi.bold)} turns`)
  if (analysis.capacity) {
    const reset = analysis.capacity.resetsAt ? new Date(Number(analysis.capacity.resetsAt) * 1000).toLocaleString() : 'unknown'
    lines.push(`Capacity  ${paint(bar(analysis.capacity.usedPercent), ansi.green)}  ${analysis.capacity.usedPercent.toFixed(0)}% used  ·  resets ${reset}`)
  }
  lines.push('')
  lines.push(paint('USAGE', ansi.bold))
  lines.push(`  Total tokens      ${paint(formatNumber(analysis.tokens.total_tokens), ansi.bold)}`)
  lines.push(`  Cached input      ${paint(`${analysis.cacheHitPercent}%`, ansi.cyan)}  (${formatNumber(analysis.tokens.cached_input_tokens)})`)
  lines.push(`  Output tokens     ${formatNumber(analysis.tokens.output_tokens)}`)
  lines.push(`  Avg turn          ${formatDuration(analysis.averageTurnMs)}  ·  p95 ${formatDuration(analysis.p95TurnMs)}`)
  lines.push(`  Avg first token   ${formatDuration(analysis.averageTtftMs)}`)
  lines.push('')
  lines.push(paint('RELIABILITY', ansi.bold))
  const successColor = analysis.commandSuccessPercent >= 90 ? ansi.green : analysis.commandSuccessPercent >= 75 ? ansi.yellow : ansi.red
  lines.push(`  Commands          ${analysis.commands}  ·  ${paint(`${analysis.commandSuccessPercent}% success`, successColor)}`)
  lines.push(`  Repeat failures   ${paint(String(analysis.repeatedFailureGroups), analysis.repeatedFailureGroups ? ansi.red : ansi.green)}`)
  lines.push(`  Aborted turns     ${analysis.abortedTurns}`)
  lines.push(`  MCP / web         ${analysis.mcpCalls} / ${analysis.webSearches}`)

  if (analysis.projects.length) {
    lines.push('')
    lines.push(paint('TOP PROJECTS', ansi.bold))
    lines.push(paint(`  ${pad('Project', 25)} ${pad('Sessions', 9)} ${pad('Turns', 7)} ${pad('Tokens', 10)} Success`, ansi.gray))
    for (const project of analysis.projects.slice(0, 6)) lines.push(`  ${pad(project.name, 25)} ${pad(project.sessions, 9)} ${pad(project.turns, 7)} ${pad(formatNumber(project.tokens), 10)} ${project.commandSuccessPercent}%`)
  }

  lines.push('')
  lines.push(paint('WHAT TO DO NEXT', ansi.bold))
  for (const recommendation of analysis.recommendations.slice(0, 3)) {
    const labelColor = recommendation.priority === 'high' ? ansi.red : recommendation.priority === 'medium' ? ansi.yellow : ansi.cyan
    lines.push(`  ${paint(recommendation.priority.toUpperCase(), ansi.bold, labelColor)}  ${paint(recommendation.title, ansi.bold)}`)
    lines.push(`    Evidence: ${recommendation.evidence}`)
    lines.push(`    Action:   ${recommendation.action}`)
  }
  if (analysis.recommendations.some((recommendation) => recommendation.rules.length)) {
    lines.push(paint('  Run `glido fix` to preview reusable agent instructions. No files are changed.', ansi.gray))
  }

  if (ai) {
    lines.push('')
    lines.push(paint(`AI ANALYSIS · ${ai.model}`, ansi.bold, ansi.cyan))
    lines.push(...ai.text.split('\n').map((line) => `  ${line}`))
    lines.push(paint('  Only aggregate, redacted metrics were sent to the API.', ansi.gray))
  }
  lines.push('')
  return lines.join('\n')
}

export function formatFix(analysis, { target = 'agents' } = {}) {
  const heading = target === 'claude' ? 'Suggested CLAUDE.md instructions' : 'Suggested AGENTS.md instructions'
  const recommendations = analysis.recommendations.filter((recommendation) => recommendation.rules.length).slice(0, 3)
  const lines = [
    `# ${heading}`,
    '',
    '> Generated from aggregate local session metrics. Review before applying; Glido changed no files.',
    '',
  ]
  if (!recommendations.length) {
    lines.push('No new agent rules are recommended from the selected sessions.', '')
    return lines.join('\n')
  }
  for (const recommendation of recommendations) {
    lines.push(`## ${recommendation.title}`, '')
    for (const rule of recommendation.rules) lines.push(`- ${rule}`)
    lines.push('')
  }
  return lines.join('\n')
}

export function formatSessions(sessions, { color = true } = {}) {
  const paint = painter(color)
  const lines = ['', paint('RECENT CODEX SESSIONS', ansi.bold), '']
  lines.push(paint(`  ${pad('Date', 18)} ${pad('Project', 25)} ${pad('Turns', 7)} ${pad('Tokens', 10)} Failures`, ansi.gray))
  for (const session of [...sessions].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, 20)) {
    const date = session.startedAt ? new Date(session.startedAt).toLocaleString() : 'unknown'
    lines.push(`  ${pad(date, 18)} ${pad(session.project, 25)} ${pad(session.turns, 7)} ${pad(formatNumber(session.tokens.total_tokens), 10)} ${session.commandFailures}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function formatCoachReport(analysis, coaching, { color = true } = {}) {
  const paint = painter(color)
  const weekly = coaching.savings.weeklyLimitPercent
  const lines = [
    '',
    `${paint('GLIDO COACH', ansi.bold, ansi.green)} ${paint('· powered by your Codex login', ansi.dim)}`,
    paint(coaching.wittyLine || 'Your Codex week has been politely audited.', ansi.cyan),
    '',
    `Prompt quality       ${paint(`${Math.round(coaching.promptQualityScore)}/100`, ansi.bold)}`,
    `Tasks reviewed       ${coaching.savings.tasksAnalyzed} of ${coaching.selection.tasksAvailable}`,
    `Model downshifts     ${paint(String(coaching.savings.downshiftCandidates), coaching.savings.downshiftCandidates ? ansi.yellow : ansi.green)}`,
    `Credit saving        ${paint(`${coaching.savings.routingSavingsPercent}%`, ansi.bold, ansi.green)} across reviewed tasks`,
    weekly === null
      ? 'Weekly allowance     unavailable · run `/usage weekly` in Codex to inspect it'
      : `Weekly allowance     ${paint(`~${weekly}% preserved`, ansi.bold, ansi.green)} from a ${coaching.savings.weeklyLimitBasis.observedUsedPercent}% observed weekly meter`,
    '',
    paint('TOP COACHING MOVES', ansi.bold),
  ]
  for (const pattern of coaching.promptPatterns.slice(0, 3)) {
    lines.push(`  ${paint(pattern.title, ansi.bold)}`)
    lines.push(`    ${pattern.action}`)
  }
  lines.push('')
  lines.push(paint('Savings are estimates. Token counts stay fixed; only published model credit rates change.', ansi.gray))
  lines.push('')
  return lines.join('\n')
}

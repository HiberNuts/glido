import { percent } from './utils.js'

const priorityRank = { high: 0, medium: 1, low: 2 }

export function buildRecommendations(analysis) {
  const recommendations = []

  if (analysis.repeatedFailureGroups > 0) {
    recommendations.push({
      id: 'stop-retry-loops',
      priority: 'high',
      title: 'Stop retry loops after two failures',
      evidence: `${analysis.repeatedFailureGroups} repeated failed command group${analysis.repeatedFailureGroups === 1 ? '' : 's'} detected.`,
      action: 'After a command family fails twice, stop, inspect the full error, verify prerequisites, and choose a materially different approach.',
      rules: [
        'Do not retry the same failing command more than twice.',
        'After the second failure, identify the root cause and change the approach before continuing.',
        'Verify the working directory, required files, credentials, and installed dependencies before another attempt.',
      ],
    })
  }

  if (analysis.commands >= 10 && analysis.commandSuccessPercent < 90) {
    recommendations.push({
      id: 'preflight-commands',
      priority: analysis.commandSuccessPercent < 80 ? 'high' : 'medium',
      title: 'Add a command preflight',
      evidence: `${analysis.commandFailures} of ${analysis.commands} recorded commands failed (${analysis.commandSuccessPercent}% success).`,
      action: 'Before expensive commands, confirm the project directory, package manager, required configuration, and the narrowest relevant test target.',
      rules: [
        'Before running an expensive command, confirm the current directory and required configuration.',
        'Prefer the narrowest relevant test, lint, or build target before running the full suite.',
      ],
    })
  }

  const abortRate = percent(analysis.abortedTurns, analysis.turns)
  if (analysis.abortedTurns >= 3 || abortRate >= 5) {
    recommendations.push({
      id: 'checkpoint-large-tasks',
      priority: abortRate >= 10 ? 'high' : 'medium',
      title: 'Checkpoint large tasks',
      evidence: `${analysis.abortedTurns} of ${analysis.turns} turns were aborted (${abortRate}%).`,
      action: 'Split longer work into independently verifiable checkpoints so progress survives interruptions and failures.',
      rules: [
        'For work expected to take more than ten minutes, define independently verifiable checkpoints.',
        'Verify each checkpoint before beginning the next one.',
        'Preserve completed work and summarize the next resumable step after an interruption.',
      ],
    })
  }

  if (analysis.p95TurnMs > 10 * 60_000) {
    recommendations.push({
      id: 'timebox-long-turns',
      priority: 'medium',
      title: 'Timebox the slowest turns',
      evidence: `The slowest 5% of turns took at least ${formatMinutes(analysis.p95TurnMs)}.`,
      action: 'Require a progress checkpoint during long-running work and reassess when a single approach stalls.',
      rules: [
        'Provide a concise progress checkpoint during long-running work.',
        'If one approach stalls, report the evidence and choose a different approach instead of waiting indefinitely.',
      ],
    })
  }

  const projectsWithCommands = analysis.projects.filter((project) => project.commands >= 10)
  const topFailureProject = [...projectsWithCommands].sort((a, b) => b.failures - a.failures)[0]
  if (topFailureProject && analysis.commandFailures > 0 && topFailureProject.failures / analysis.commandFailures >= 0.5) {
    recommendations.push({
      id: 'project-playbook',
      priority: 'medium',
      title: `Add a playbook for ${topFailureProject.name}`,
      evidence: `${topFailureProject.failures} failed commands came from this project (${topFailureProject.commandSuccessPercent}% command success).`,
      action: 'Document this project’s setup, verification commands, and known failure recovery steps close to the codebase.',
      rules: [
        `For ${topFailureProject.name}, read the project instructions before running commands.`,
        'Use the project-specific setup and verification commands instead of guessing generic commands.',
      ],
    })
  }

  if (!recommendations.length) {
    recommendations.push({
      id: 'keep-baseline',
      priority: 'low',
      title: 'Keep the current baseline',
      evidence: 'No repeated failure loops, high abort rate, or severe command reliability issue was detected.',
      action: 'Run the same seven-day review next week and compare command success, abort rate, and p95 turn duration.',
      rules: [],
    })
  }

  return recommendations.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])
}

function formatMinutes(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}


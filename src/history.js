import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function glidoDirectory() {
  return path.resolve(process.env.GLIDO_HOME || path.join(os.homedir(), '.glido'))
}

export async function loadPreviousSnapshot({ windowMs = null } = {}) {
  const directory = path.join(glidoDirectory(), 'audits')
  let names
  try {
    names = (await fsp.readdir(directory)).filter((name) => name.endsWith('.json')).sort().reverse()
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  for (const name of names) {
    try {
      const snapshot = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8'))
      if (windowMs !== null) {
        if (!Number.isFinite(Number(snapshot.windowMs))) continue
        const difference = Math.abs(Number(snapshot.windowMs) - windowMs) / Math.max(windowMs, 1)
        if (difference > 0.2) continue
      }
      return snapshot
    } catch { /* ignore corrupt snapshots */ }
  }
  return null
}

export async function saveSnapshot(analysis, coaching, { since = null, windowMs = null } = {}) {
  const directory = path.join(glidoDirectory(), 'audits')
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    since,
    windowMs,
    metrics: snapshotMetrics(analysis, coaching),
    selection: coaching.selection,
    savings: coaching.savings,
  }
  const filename = `${snapshot.generatedAt.replace(/[:.]/g, '-')}.json`
  const target = path.join(directory, filename)
  await fsp.writeFile(target, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
  return { snapshot, target }
}

export function compareSnapshots(previous, current) {
  if (!previous?.metrics) return null
  const keys = ['promptQuality', 'tokensPerTask', 'retryLoops', 'rightSizedModels', 'commandSuccess']
  return Object.fromEntries(keys.map((key) => [key, {
    before: Number(previous.metrics[key] ?? 0),
    after: Number(current[key] ?? 0),
    delta: Number(current[key] ?? 0) - Number(previous.metrics[key] ?? 0),
  }]))
}

export function snapshotMetrics(analysis, coaching) {
  return {
    promptQuality: Math.round(coaching.promptQualityScore),
    tokensPerTask: Math.round(analysis.tokensPerCompletedTurn),
    retryLoops: analysis.repeatedFailureGroups,
    rightSizedModels: Math.round(coaching.rightSizedPercent),
    commandSuccess: Math.round(analysis.commandSuccessPercent),
  }
}

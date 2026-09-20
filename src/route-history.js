import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { glidoDirectory } from './history.js'

export async function recordRoute(route, { launched = false, exitCode = null, durationMs = null } = {}) {
  const directory = path.join(glidoDirectory(), 'router')
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 })
  const event = {
    version: 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    model: route.model,
    effort: route.effort,
    category: route.category,
    confidence: route.confidence,
    signals: route.signals,
    overridden: route.overridden,
    launched,
    exitCode,
    durationMs,
  }
  const target = path.join(directory, 'history.jsonl')
  await fsp.appendFile(target, `${JSON.stringify(event)}\n`, { mode: 0o600 })
  await fsp.chmod(target, 0o600)
  return event
}

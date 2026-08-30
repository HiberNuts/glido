import { createHash } from 'node:crypto'
import path from 'node:path'

export function durationToMs(duration) {
  if (!duration || typeof duration !== 'object') return 0
  return Number(duration.secs ?? 0) * 1000 + Number(duration.nanos ?? 0) / 1_000_000
}

export function parseSince(value) {
  if (!value || value === 'all') return null
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/i)
  if (!match) throw new Error('Invalid --since value. Use values such as 24h, 7d, 4w, or all.')
  const units = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  return Date.now() - Number(match[1]) * units[match[2].toLowerCase()]
}

export function safeProjectName(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'unknown'
  return path.basename(cwd.replace(/[\\/]$/, '')) || 'unknown'
}

export function commandFingerprint(command) {
  return createHash('sha256').update(typeof command === 'string' ? command : JSON.stringify(command ?? '')).digest('hex').slice(0, 16)
}

export function commandFamily(command, source) {
  if (typeof source === 'string' && source.trim()) return source.replace(/[^a-z0-9_.-]/gi, '').slice(0, 28) || 'shell'
  const raw = Array.isArray(command) ? String(command[0] ?? '') : String(command ?? '')
  const first = raw.trim().split(/\s+/)[0]
  if (!first) return 'shell'
  return path.basename(first).replace(/[^a-z0-9_.-]/gi, '').slice(0, 28) || 'shell'
}

export function formatNumber(value) {
  const number = Number(value ?? 0)
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`
  return Math.round(number).toLocaleString('en-US')
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`
}

export function percent(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0
}

export function percentile(values, p) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:sk|rk|pk|ghp|github_pat|xox[abprs]|npm|apik)_[A-Za-z0-9_\-]{12,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"']{6,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?=[A-Za-z0-9_=-]{24,}\b)(?=[A-Za-z0-9_=-]*[A-Za-z])(?=[A-Za-z0-9_=-]*\d)[A-Za-z0-9_=-]{24,}\b/g,
]

export function redactPrompt(value, { maxChars = 2_400 } = {}) {
  let text = String(value ?? '').replace(/\0/g, '')
  let redactions = 0
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactions += 1
      return '<secret-redacted>'
    })
  }
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => {
    redactions += 1
    return '<email-redacted>'
  })
  text = text.replace(/(?:\/Users\/[^\s]+|\/home\/[^\s]+|[A-Za-z]:\\Users\\[^\s]+)/g, () => {
    redactions += 1
    return '<local-path>'
  })
  text = text.replace(/https?:\/\/[^\s)]+/gi, (url) => {
    try {
      const parsed = new URL(url)
      if (!parsed.search && !parsed.username && !parsed.password) return url
      redactions += 1
      return `${parsed.origin}${parsed.pathname}<query-redacted>`
    } catch {
      redactions += 1
      return '<url-redacted>'
    }
  })
  const compact = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const truncated = compact.length > maxChars
  return {
    text: truncated ? `${compact.slice(0, maxChars)}\n<truncated>` : compact,
    redactions,
    truncated,
  }
}

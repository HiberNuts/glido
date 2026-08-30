import { aiSafeSummary } from './analyze.js'

export async function generateAiAnalysis(analysis, { model = process.env.GLIDO_AI_MODEL || 'gpt-5.6-luna' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for --ai. Deterministic analysis works without it.')
  const metrics = aiSafeSummary(analysis)
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
      instructions: 'You are Glido, a concise engineering-efficiency analyst. Analyze only the aggregate Codex telemetry provided. Do not invent monetary cost or infer conversation content. Return: 1) a two-sentence diagnosis, 2) three prioritized fixes, and 3) one metric to watch next week.',
      input: JSON.stringify(metrics),
    }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI API returned ${response.status}`)
  if (typeof data.output_text === 'string' && data.output_text) return { model, text: data.output_text }
  const text = (data.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('\n')
  if (!text) throw new Error('The AI analysis returned no text.')
  return { model, text }
}

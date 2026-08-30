import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { glidoDirectory } from './history.js'
import { formatNumber } from './utils.js'

export async function writeDashboard({ analysis, coaching, bundle, comparison }) {
  const reportsDirectory = path.join(glidoDirectory(), 'reports')
  await fsp.mkdir(reportsDirectory, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(reportsDirectory, `${stamp}.html`)
  const shareCardPath = path.join(reportsDirectory, `${stamp}-share-card.svg`)
  const html = renderDashboard({ analysis, coaching, bundle, comparison, shareCardName: path.basename(shareCardPath) })
  const shareCard = renderShareCard({ analysis, coaching })
  await fsp.writeFile(reportPath, html, { mode: 0o600 })
  await fsp.writeFile(shareCardPath, shareCard, { mode: 0o600 })
  await fsp.writeFile(path.join(reportsDirectory, 'latest.json'), JSON.stringify({ reportPath, shareCardPath }), { mode: 0o600 })
  return { reportPath, shareCardPath, html, shareCard }
}

export async function loadLatestDashboard() {
  const reportsDirectory = path.join(glidoDirectory(), 'reports')
  let latest
  try { latest = JSON.parse(await fsp.readFile(path.join(reportsDirectory, 'latest.json'), 'utf8')) } catch {
    throw new Error('No dashboard found. Run `glido coach --since 7d` first.')
  }
  return {
    ...latest,
    html: await fsp.readFile(latest.reportPath, 'utf8'),
    shareCard: await fsp.readFile(latest.shareCardPath, 'utf8'),
  }
}

export async function serveDashboard(report, { open = true, port = 0 } = {}) {
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    if (request.url === '/share-card.svg') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' })
      response.end(report.shareCard)
      return
    }
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(report.html)
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  if (open) openBrowser(url)
  return { server, url }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function renderDashboard({ analysis, coaching, bundle, comparison }) {
  const originalById = new Map(bundle.tasks.map((task) => [task.id, task.prompt]))
  const weekly = coaching.savings.weeklyLimitPercent
  const savingsHeadline = weekly === null
    ? `You could have spent ${coaching.savings.routingSavingsPercent}% fewer Codex credits.`
    : `You could have kept ${weekly}% of your weekly Codex limit.`
  const downshifts = coaching.savings.downshiftCandidates
  const taskWord = downshifts === 1 ? 'task' : 'tasks'
  const heroAdvice = simpleHeroAdvice(coaching)
  const score = Math.round(coaching.promptQualityScore)
  const verdict = scoreVerdict(score)
  const shareText = `My Codex prompt quality score is ${score}/100. Glido found ${downshifts} model downshifts and ${weekly === null ? `${coaching.savings.routingSavingsPercent}% potential credit savings across reviewed tasks` : `about ${weekly}% of my observed weekly limit I could potentially preserve`}.`;
  const xIntent = `https://x.com/intent/post?text=${encodeURIComponent(shareText)}`
  const progress = renderProgress(comparison, analysis, coaching)
  const actions = coaching.promptPatterns.slice(0, 3).map((pattern, index) => `
    <article class="action"><b>${index + 1}</b><div><h3>${escapeHtml(pattern.title)}</h3><p>${escapeHtml(pattern.action)}</p></div></article>`).join('')
  const rewrites = coaching.rewrites.slice(0, 3).map((rewrite) => `
    <article class="rewrite"><details><summary><span>Better prompt</span><strong>${escapeHtml(rewrite.issue)}</strong><i>View rewrite</i></summary><div class="pair">
      <div><label>Your prompt</label><pre>${escapeHtml(originalById.get(rewrite.taskId) ?? 'Original prompt unavailable')}</pre></div>
      <div class="better"><label>Try this</label><pre>${escapeHtml(rewrite.improvedPrompt)}</pre></div>
    </div></details>
    </article>`).join('')
  const routingRows = selectDiverseRoutingRows(coaching.savings.rows.filter((row) => row.savedCredits > 0), 6)
  const routing = routingRows.map((row) => {
    return `
    <article class="switch">
      <div class="route">${modelChoice('Used', row.actualModel, row.actualEffort)}<span class="arrow">→</span>${modelChoice('Use instead', row.recommendedModel, row.recommendedEffort)}</div>
      <strong>Save about ${row.savedPercent}%</strong>
      <div class="example"><label>Example task</label><q>${escapeHtml(shortSentence(row.taskExample, 90))}</q></div>
      <p><b>Why:</b> ${escapeHtml(shortSentence(row.reason, 135))}</p>
    </article>`
  }).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Glido · Private Codex Coach</title>
<style>
:root{--ink:#172019;--muted:#69726b;--line:#e0e6e0;--paper:#f7f9f6;--card:#fff;--green:#187247;--lime:#e5f57b;--soft:#eef5ef}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font:inherit}header{display:flex;justify-content:space-between;align-items:center;max-width:1020px;margin:auto;padding:24px}.logo{font-size:14px;letter-spacing:.16em;font-weight:850}.private{font-size:13px;color:var(--green)}main{max-width:1020px;margin:auto;padding:28px 24px 80px}.hero{text-align:center;padding:24px 0 18px}.kicker{font-size:13px;color:var(--muted);letter-spacing:.06em}.score-label{margin-top:26px;color:var(--green);font-size:13px;font-weight:850;letter-spacing:.13em}.score{display:flex;justify-content:center;align-items:baseline;gap:10px;margin:2px 0 0;line-height:.95;letter-spacing:-.075em}.score strong{font-size:clamp(100px,16vw,172px)}.score span{font-size:clamp(34px,5vw,56px);color:var(--muted);letter-spacing:-.04em}.verdict{font-size:clamp(25px,4vw,38px);letter-spacing:-.04em;margin:10px 0 8px}.hero>p{max-width:680px;margin:0 auto;color:var(--muted);font-size:18px}.saving-hook{display:inline-block;margin:21px auto 0;padding:10px 15px;border-radius:999px;background:var(--soft);color:var(--green);font-weight:750}.joke{display:block;margin:14px auto 0;color:var(--muted);font-size:14px}.hero-actions{display:flex;justify-content:center;align-items:center;gap:12px;margin-top:22px}.hero-actions small{color:var(--muted)}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:42px}.stat{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px}.stat small{display:block;color:var(--muted)}.stat b{display:block;font-size:30px;margin:8px 0 2px}.section{margin-top:64px}.section h2{font-size:30px;letter-spacing:-.035em;margin:0 0 6px}.help{color:var(--muted);margin:0 0 20px}.actions{display:grid;gap:10px}.action{display:flex;gap:16px;align-items:start;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}.action>b{display:grid;place-items:center;min-width:32px;height:32px;border-radius:50%;background:var(--lime)}.action h3{margin:2px 0 4px;font-size:18px}.action p{margin:0;color:var(--muted)}.rewrite{background:var(--card);border:1px solid var(--line);border-radius:16px;margin-bottom:10px;overflow:hidden}.rewrite summary{display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;padding:18px;cursor:pointer}.rewrite summary span{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--green);font-weight:800}.rewrite summary i{font-style:normal;color:var(--green);font-size:13px}.pair{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.pair>div{padding:18px}.pair .better{background:var(--soft);border-left:1px solid var(--line)}label{display:block;color:var(--muted);font-size:12px;font-weight:700}pre{white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:280px;overflow:auto}.switches{display:grid;grid-template-columns:1fr 1fr;gap:10px}.switch{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}.route{display:grid!important;grid-template-columns:1fr auto 1fr;align-items:center!important;gap:10px!important}.choice{min-width:0}.choice small{display:block;color:var(--muted);font-size:11px;margin-bottom:5px}.choice .model{display:inline-block}.effort{display:block;color:var(--ink);font-size:12px;margin-top:6px;text-transform:capitalize}.arrow{font-size:20px}.switch>strong{display:block;margin-top:18px;color:var(--green);font-size:18px}.example{margin-top:14px;padding:12px;border-radius:11px;background:var(--soft)}.example q{display:block;margin-top:4px;color:var(--ink);font-size:13px}.example q:before,.example q:after{content:none}.switch p{margin-bottom:0;color:var(--muted);font-size:14px}.switch p b{color:var(--ink)}.model{white-space:nowrap;padding:5px 8px;border-radius:999px;background:var(--soft);font-weight:750;color:var(--green);font-size:12px}.progress{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.delta{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px}.delta span{font-size:12px;color:var(--muted)}.delta b{display:block;font-size:23px;margin:8px 0 2px}.delta em{font-style:normal;color:var(--green);font-size:13px;font-weight:750}.share{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-top:58px;padding:24px;border-radius:18px;background:var(--lime)}.share h2{margin:0 0 3px;font-size:22px}.share p{margin:0}.button{display:inline-flex;align-items:center;justify-content:center;border:0;cursor:pointer;background:var(--ink);color:white;text-decoration:none;padding:12px 17px;border-radius:11px;font-weight:750;white-space:nowrap}.button:hover{transform:translateY(-1px)}.button:disabled{opacity:.6;cursor:wait}.share-status{display:block;color:var(--muted);font-size:12px;margin-top:8px;min-height:18px}details.math{margin-top:24px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}details.math summary{cursor:pointer;font-weight:750}details.math p{color:var(--muted);font-size:14px;margin-bottom:0}@media(max-width:720px){.summary,.switches,.progress,.pair{grid-template-columns:1fr}.pair .better{border-left:0;border-top:1px solid var(--line)}.rewrite summary{grid-template-columns:1fr}.share{display:block}.button{display:inline-flex;margin-top:14px}.hero-actions{display:block}.hero-actions small{display:block;margin-top:9px}.score strong{font-size:105px}.score span{font-size:38px}}
</style></head><body>
<header><div class="logo">GLIDO</div><div class="private">Private · runs on your computer</div></header>
<main><section class="hero"><div class="kicker">YOUR PRIVATE CODEX WEEKLY · ${analysis.sessions} SESSIONS CHECKED</div><div class="score-label">PROMPT QUALITY</div><h1 class="score"><strong>${score}</strong><span>/100</span></h1><h2 class="verdict">${escapeHtml(verdict)}</h2><p>${escapeHtml(heroAdvice)}</p><div class="saving-hook">${escapeHtml(savingsHeadline)}</div><div class="joke">${escapeHtml(coaching.wittyLine || 'A smaller model can still wear the cape.')}</div><div class="hero-actions"><a class="button" href="${escapeHtml(xIntent)}" target="_blank" rel="noopener" data-share-score>Share on X</a><small>No prompts or project names in the card.</small></div><span class="share-status" aria-live="polite"></span></section>
<section class="summary"><article class="stat"><small>Sessions checked</small><b>${analysis.sessions}</b><span>Your selected Codex week.</span></article><article class="stat"><small>You can downshift</small><b>${downshifts} ${taskWord}</b><span>A smaller model or lower effort could do the same work.</span></article><article class="stat"><small>Potential credit saving</small><b>${coaching.savings.routingSavingsPercent}%</b><span>Across the tasks reviewed.</span></article></section>
<section class="section"><h2>Three fixes. A cheaper Codex week.</h2><p class="help">Start here. These changes should have the biggest effect.</p><div class="actions">${actions || '<article class="action"><b>✓</b><div><h3>Keep going</h3><p>No large prompt problem was found.</p></div></article>'}</div></section>
<section class="section"><h2>These prompts deserved a second draft.</h2><p class="help">Open one to copy a clearer version.</p>${rewrites || '<p class="help">No prompt rewrite was needed.</p>'}</section>
<section class="section"><h2>Your model was overqualified.</h2><p class="help">See the actual task, the model and effort you used, and the cheaper setting Glido recommends.</p><div class="switches">${routing || '<article class="switch"><strong>Your model choices look good.</strong><p>No safe downshift was found.</p></article>'}</div></section>
<section class="section"><h2>${comparison ? 'Did Glido make you better?' : 'This is your before picture.'}</h2><p class="help">${comparison ? 'Here is what changed since your last seven-day check.' : 'Run Glido again next week to unlock your before-and-after.'}</p>${progress}</section>
<details class="math"><summary>How did we calculate this?</summary><p>We used the token counts saved by Codex and OpenAI's published model credit rates. We kept the work the same and changed only the model. Weekly saving estimate = observed weekly use × credits saved ÷ credits seen in local tasks. Cloud work may not appear here, so this is an estimate—not your official remaining balance.</p></details>
<details class="math"><summary>What stayed private?</summary><p>Likely secrets and local paths were removed before Codex reviewed selected prompt samples. The dashboard is available only on 127.0.0.1. The share card contains no prompts, project names, paths, or session IDs.</p></details>
<section class="share"><div><h2>Your prompt score is made to share.</h2><p>The card includes only safe summary numbers.</p><span class="share-status" aria-live="polite"></span></div><a class="button" href="${escapeHtml(xIntent)}" target="_blank" rel="noopener" data-share-score>Share on X</a></section></main>
<script>
const shareButtons=[...document.querySelectorAll('[data-share-score]')];
const shareStatuses=[...document.querySelectorAll('.share-status')];
function setShareStatus(value){shareStatuses.forEach((node)=>{node.textContent=value})}
async function cardPng(){
  const response=await fetch('/share-card.svg');
  if(!response.ok)throw new Error('Could not create the card.');
  const svgBlob=await response.blob();
  const objectUrl=URL.createObjectURL(svgBlob);
  try{
    const picture=new Image();
    await new Promise((resolve,reject)=>{picture.onload=resolve;picture.onerror=reject;picture.src=objectUrl});
    const canvas=document.createElement('canvas');canvas.width=1200;canvas.height=675;
    canvas.getContext('2d').drawImage(picture,0,0,1200,675);
    return await new Promise((resolve,reject)=>canvas.toBlob((blob)=>blob?resolve(blob):reject(new Error('Could not create the card.')),'image/png',1));
  }finally{URL.revokeObjectURL(objectUrl)}
}
async function prepareXCard(){
  shareButtons.forEach((button)=>button.setAttribute('aria-busy','true'));setShareStatus('Creating your X card…');
  try{
    const blob=await cardPng();
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='my-codex-prompt-score.png';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    setShareStatus('Card downloaded. Add it to the X post that opened.');
  }catch(error){setShareStatus(error?.message||'Could not create the X card.')}
  finally{shareButtons.forEach((button)=>button.removeAttribute('aria-busy'))}
}
shareButtons.forEach((button)=>button.addEventListener('click',prepareXCard));
</script></body></html>`
}

function renderProgress(comparison, analysis, coaching) {
  const current = { promptQuality: Math.round(coaching.promptQualityScore), tokensPerTask: Math.round(analysis.tokensPerCompletedTurn), retryLoops: analysis.repeatedFailureGroups }
  const labels = { promptQuality: 'Prompt score', tokensPerTask: 'Tokens per task', retryLoops: 'Retry loops' }
  return `<div class="progress">${Object.entries(current).map(([key, value]) => {
    const before = comparison?.[key]?.before
    const display = before === undefined ? `${formatMetric(key, value)}` : `${formatMetric(key, before)} → ${formatMetric(key, value)}`
    const delta = before === undefined ? 'Baseline saved' : deltaLabel(key, value - before)
    return `<article class="delta"><span>${labels[key]}</span><b>${display}</b><em>${escapeHtml(delta)}</em></article>`
  }).join('')}</div>`
}

function deltaLabel(key, delta) {
  const goodDirection = ['retryLoops', 'tokensPerTask'].includes(key) ? -1 : 1
  const improved = delta * goodDirection > 0
  if (delta === 0) return 'No change'
  return `${improved ? 'Improved' : 'Changed'} ${delta > 0 ? '+' : ''}${Math.round(delta)}`
}

function formatMetric(key, value) {
  if (['promptQuality', 'rightSizedModels', 'commandSuccess'].includes(key)) return `${Math.round(value)}%`
  if (key === 'tokensPerTask') return formatNumber(value)
  return String(Math.round(value))
}

function renderShareCard({ analysis, coaching }) {
  const weekly = coaching.savings.weeklyLimitPercent
  const score = Math.round(coaching.promptQualityScore)
  const weeklyValue = weekly === null ? `${coaching.savings.routingSavingsPercent}%` : `${weekly}%`
  const weeklyLabel = weekly === null ? 'FEWER REVIEWED CREDITS' : 'WEEKLY LIMIT POTENTIALLY KEPT'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><rect width="1200" height="675" rx="40" fill="#e5f57b"/><circle cx="1090" cy="-10" r="245" fill="#d5e95a"/><circle cx="80" cy="690" r="180" fill="#d5e95a"/><rect x="44" y="44" width="1112" height="587" rx="32" fill="#f8faf6"/><text x="88" y="103" fill="#187247" font-family="Arial,sans-serif" font-size="20" font-weight="700" letter-spacing="3">GLIDO · MY CODEX WEEK</text><text x="88" y="166" fill="#69726b" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="2">PROMPT QUALITY</text><text x="82" y="365" fill="#172019" font-family="Arial,sans-serif" font-size="190" font-weight="800" letter-spacing="-10">${score}</text><text x="365" y="353" fill="#69726b" font-family="Arial,sans-serif" font-size="58" font-weight="700">/100</text><text x="92" y="423" fill="#187247" font-family="Arial,sans-serif" font-size="34" font-weight="700">${escapeXml(scoreVerdict(score))}</text><rect x="655" y="150" width="435" height="132" rx="22" fill="#edf4ee"/><text x="688" y="193" fill="#69726b" font-family="Arial,sans-serif" font-size="15" font-weight="700" letter-spacing="1">${weeklyLabel}</text><text x="686" y="254" fill="#187247" font-family="Arial,sans-serif" font-size="52" font-weight="800">${escapeXml(weeklyValue)}</text><rect x="655" y="298" width="207" height="132" rx="22" fill="#172019"/><text x="684" y="341" fill="#aebbb1" font-family="Arial,sans-serif" font-size="15" font-weight="700">DOWNSHIFTS</text><text x="682" y="402" fill="#e5f57b" font-family="Arial,sans-serif" font-size="52" font-weight="800">${coaching.savings.downshiftCandidates}</text><rect x="878" y="298" width="212" height="132" rx="22" fill="#172019"/><text x="907" y="341" fill="#aebbb1" font-family="Arial,sans-serif" font-size="15" font-weight="700">SESSIONS</text><text x="905" y="402" fill="#fff" font-family="Arial,sans-serif" font-size="52" font-weight="800">${analysis.sessions}</text><line x1="88" y1="493" x2="1112" y2="493" stroke="#dce3dc"/><text x="88" y="544" fill="#172019" font-family="Arial,sans-serif" font-size="22">${escapeXml(coaching.wittyLine || 'A smaller model can still wear the cape.')}</text><text x="88" y="592" fill="#69726b" font-family="Arial,sans-serif" font-size="16">Private local audit · estimates only · no prompts, projects, paths, or session IDs</text></svg>`
}

function modelChoice(label, model, effort) {
  return `<div class="choice"><small>${escapeHtml(label)}</small><span class="model">${escapeHtml(model)}</span><span class="effort">${escapeHtml(effortLabel(effort))}</span></div>`
}
function effortLabel(value) {
  const effort = String(value ?? '').toLowerCase()
  const labels = { low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort' }
  return labels[effort] ?? 'Effort not recorded'
}
function selectDiverseRoutingRows(rows, limit) {
  const selected = []
  const selectedIds = new Set()
  for (const model of ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
    const row = rows.find((candidate) => candidate.recommendedModel === model)
    if (row) { selected.push(row); selectedIds.add(row.taskId) }
  }
  for (const row of rows) {
    if (selected.length >= limit) break
    if (!selectedIds.has(row.taskId)) { selected.push(row); selectedIds.add(row.taskId) }
  }
  return selected.slice(0, limit)
}
function simpleHeroAdvice(coaching) {
  const action = coaching.promptPatterns?.[0]?.action
  return shortSentence(action || coaching.diagnosis || 'State the goal, context, and success check up front.', 110)
}
function scoreVerdict(score) {
  if (score < 40) return 'Codex had to guess.'
  if (score < 65) return 'Good ideas. Missing context.'
  if (score < 85) return 'Clear prompts. A few gaps.'
  return 'Your prompts are sharp.'
}
function shortSentence(value, maxLength) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim()
  const firstClause = compact.split(/(?<=[.!?])\s|;|—/)[0].trim()
  const shortened = firstClause.length > maxLength ? `${firstClause.slice(0, maxLength - 1).trim()}…` : firstClause
  return shortened && !/[.!?…]$/.test(shortened) ? `${shortened}.` : shortened
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])) }
function escapeXml(value) { return escapeHtml(value) }

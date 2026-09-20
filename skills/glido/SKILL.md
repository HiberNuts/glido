---
name: glido
description: Route new Codex tasks to an appropriate model and effort, or audit local Codex sessions for prompt, token, and reliability improvements. Use for model selection, prompt coaching, weekly progress, session reviews, and reusable AGENTS.md improvements.
license: MIT
---

# Glido

Use Router for a new task, the normal audit for telemetry-only questions, and Coach for historical prompt or model advice. Run the bundled analyzer before making claims about the user's sessions.

This workflow requires Node.js 20 or newer and local access to Codex session files.

## Route a new task

When the user asks which model or effort should handle a new coding task, run `glido run "<task>" --dry-run --json`. The router is local and does not save or send the prompt.

Report the model, reasoning effort, confidence, short reason, and improved prompt. Preserve any requested model or effort override. Treat the route as an explainable heuristic, not a guarantee. Do not launch a nested interactive Codex process from inside an existing Codex session; give the user the standalone `glido run` command instead.

## Run an agent team

For a broad goal that benefits from independent exploration, isolated implementation, testing, or review, give the user the standalone command `glido agent "<goal>" --done "<definition of done>"`. Agent mode uses the user's local Codex login, keeps a master responsible for integration, and shows native subagent activity in a private terminal view. Do not launch it from inside an existing Codex session. Use `glido agent --dry-run` to preview the orchestration prompt without starting a session.

## Telemetry-only audit

1. Resolve this skill's plugin root, two directories above this `SKILL.md` folder.
2. Prefer the `glido` executable when it is available. Otherwise run `node <plugin-root>/bin/glido.js`.
3. Use `--since 7d --json --no-color` by default so recommendations describe recent behavior. Preserve a user-requested period, project, session, or path.
4. Report the important evidence first, followed by at most three prioritized recommendations. For each recommendation, include the metric, why it matters, and the next concrete behavior to adopt.
5. Treat cache reuse as a positive signal when it is high. Do not convert Codex subscription counters into monetary cost.

If discovery fails, run `glido doctor` and explain the missing directory or permissions. Do not inspect raw session JSONL as a fallback.

## Coach prompts and models

Use Coach only when the user explicitly asks to analyze prompt content, model choice, or potential savings.

1. Explain that Coach reads prompt text, redacts likely secrets locally, and sends selected excerpts to the user's authenticated Codex account. If the current request did not already authorize prompt analysis, obtain confirmation before continuing.
2. Run `glido coach --since 7d --yes --json`. Preserve requested filters, model, humor, or sample size.
3. Report the prompt score, the three highest-impact changes, model downshift candidates, estimated credit savings, and estimated percentage points of the observed weekly allowance preserved.
4. Call all counterfactual savings estimates. Distinguish raw tokens from OpenAI credits and never invent a universal weekly token limit.
5. The command writes a private light-theme report and sanitized share card. Run `glido dashboard` when the user wants the localhost UI; otherwise give the report path and command.

Coach uses the official model credit rate card checked on the date embedded in the report. A weekly-limit percentage is derived from the weekly usage observation stored by Codex, not from a hard-coded plan allowance.

## Draft improvements

When the user asks how to improve agent behavior, run `glido fix` with the same filters. The command prints a preview and never edits files.

- For Codex, target `AGENTS.md`; for Claude Code, target `CLAUDE.md`.
- Show the proposed bounded section and ask for confirmation before editing an existing instruction file.
- Preserve existing instructions and do not turn one isolated failure into a universal rule.

## Privacy

The local analyzer intentionally discards prompts, assistant messages, reasoning, raw commands, command output, paths, and file contents. Do not display, retain, or infer that content.

Never use `coach` or `--ai` unless the user opts into the corresponding AI interpretation. Coach is the only mode that reads prompt text. It stores locally redacted prompt excerpts in the private HTML report, but snapshots and share cards exclude prompts, paths, project names, and session IDs.

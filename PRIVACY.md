# Privacy

Glido is local-first. Its deterministic analysis makes no network requests and requires no account or API key.

## Router mode

`glido run` classifies the task and improves the prompt locally. Routing does not call an AI service. Glido shows the selected model, reasoning effort, explanation, and final prompt before anything is sent.

After approval, Glido launches the user's installed Codex CLI with the selected settings. The approved prompt is sent to Codex exactly as it would be when starting Codex directly. Glido never writes that prompt to its history. Router history contains only the model, effort, broad task category, confidence, non-content signals, duration, and exit status.

`glido chat` uses the local Codex App Server to append routed follow-up turns to one Codex thread. Glido does not persist the prompts or responses; its route history retains the same non-content metrics as Router mode. The thread itself is managed by the user's local Codex installation.

## Agent mode

`glido agent` sends the goal, definition of done, and generated master instructions to the user's authenticated local Codex App Server. Codex can delegate independent work to native subagents under the selected sandbox and approval policy. Glido has no backend and does not receive this data.

To support recovery, Glido stores a private record under `~/.glido/agent-runs` (or `GLIDO_HOME`) with user-only directory and file permissions. It contains the goal, definition of done, project path, model settings, Codex thread/turn IDs, statuses, concise plan, worker tasks and current-action summaries, aggregate token use, and timestamps. Plan text can include paths that Codex names while planning. The live activity timeline is kept only in memory. Glido does not store reasoning, source-file contents, raw tool calls, command output, secrets, approval payloads, or full event streams. Delete `~/.glido/agent-runs` to remove saved Agent-mode runs.

## Data the local analyzer uses

Glido reads numeric and structural metadata already recorded in local Codex JSONL session files, including token counters, timestamps, exit codes, tool-event counts, model labels, rate-limit observations, and project directory basenames.

## Data Glido discards in the default audit

Glido does not retain or display prompts, assistant messages, reasoning, raw shell commands, command output, file paths, or file contents. Repeated commands are matched with temporary in-memory hashes; the raw commands and hashes are discarded after parsing.

## Opt-in Coach mode

`glido coach` is a separate, explicit mode. It reads user prompt text and performs local secret, email, path, and URL-query redaction before selecting high-impact excerpts. Those selected, redacted excerpts and structural task metrics are sent through the user's already-authenticated Codex CLI account. Glido does not receive or operate a separate service account.

Coach does not send assistant messages, reasoning, raw commands, command output, source files, or project names. It creates a private HTML report under `~/.glido/reports` containing locally redacted prompt excerpts and rewrites. Files are created with user-only permissions. Aggregate audit snapshots under `~/.glido/audits` and exported share cards do not contain prompts, project names, paths, or session IDs.

Coach runs Codex ephemerally from a temporary directory with user configuration and rules ignored and a read-only sandbox. The analysis prompt treats historical prompts as untrusted data. Raw session task IDs are removed before analysis, and AI-written text is not placed on exported share cards.

The localhost dashboard listens only on `127.0.0.1` and stops when the CLI process exits. No report server is exposed to the local network.

## Optional AI interpretation

AI interpretation is disabled by default and runs only with the explicit `--ai` flag and an `OPENAI_API_KEY`. It sends aggregate metrics with project and tool-family labels replaced by generic identifiers. Requests use `store: false`.

Glido does not send raw session records, messages, commands, output, code, paths, or file contents to the AI service.

This aggregate `--ai` mode is different from Coach mode and remains available for users who explicitly prefer API-key billing.

## Files and changes

`glido fix` prints a reviewable instruction draft. It does not create or modify `AGENTS.md`, `CLAUDE.md`, or any other file.

Users can delete private reports and snapshots by removing `~/.glido`. Glido does not upload those files.

## Scope

Codex session storage is currently an implementation detail rather than a stable public export format. Parser compatibility may need updates as Codex evolves.

## Image attachments

When you explicitly pass `--image <path>`, Glido checks that the path is a local file and forwards that path to Codex after you approve the run. Glido does not copy, upload independently, or retain the image or its path in its local history or agent-run metadata.

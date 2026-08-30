# Privacy

Glido is local-first. Its deterministic analysis makes no network requests and requires no account or API key.

## Data the local analyzer uses

Glido reads numeric and structural metadata already recorded in local Codex JSONL session files, including token counters, timestamps, exit codes, tool-event counts, model labels, rate-limit observations, and project directory basenames.

## Data Glido discards in the default audit

Glido does not retain or display prompts, assistant messages, reasoning, raw shell commands, command output, file paths, or file contents. Repeated commands are matched with temporary in-memory hashes; the raw commands and hashes are discarded after parsing.

## Opt-in Coach mode

`glido coach` is a separate, explicit mode. It reads user prompt text and performs local secret, email, path, and URL-query redaction before selecting high-impact excerpts. Those selected, redacted excerpts and structural task metrics are sent through the user's already-authenticated Codex CLI account. Glido does not receive or operate a separate service account.

Coach does not send assistant messages, reasoning, raw commands, command output, source files, or project names. It creates a private HTML report under `~/.glido/reports` containing locally redacted prompt excerpts and rewrites. Files are created with user-only permissions. Aggregate audit snapshots under `~/.glido/audits` and exported share cards do not contain prompts, project names, paths, or session IDs.

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

# Glido

**Learn from every session. Waste fewer tokens.**

Glido reviews your Codex sessions and shows you how to write better prompts, choose the right model and effort, and save tokens.

It ships three ways from one codebase:

- `npx glido` for a zero-setup CLI review.
- `$glido` as a Codex skill.
- `/glido` as a Claude Code skill.

The default audit ignores prompt content. The separate `coach` command is explicit opt-in: it redacts likely secrets locally and sends selected prompt excerpts through your existing Codex login.

## Quick start

```bash
npx glido --since 7d
```

Run the full private coaching experience:

```bash
npx glido coach --since 7d
```

Coach prints a concise result, writes a sanitized share card, and opens a light-theme dashboard on a random `127.0.0.1` port. Press Ctrl+C to stop it. Reopen the latest report later with:

```bash
glido dashboard
```

Or install globally:

```bash
npm install --global glido
glido --since 7d
```

While developing this repository:

```bash
npm link
glido --since 7d
```

## Commands

```bash
glido                         # Analyze every local Codex session
glido --since 7d              # Last seven days
glido --project my-app        # One project name
glido sessions                # Recent session table
glido fix --since 7d          # Preview AGENTS.md instructions
glido fix --target claude     # Preview CLAUDE.md instructions
glido --json                  # Machine-readable report
glido doctor                  # Check session discovery
glido --ai                    # Add opt-in AI interpretation
glido coach --since 7d        # Prompt + model coaching through Codex CLI
glido coach --humor off       # Keep dashboard copy strictly factual
glido coach --no-open         # Print localhost URL without opening a browser
glido dashboard               # Reopen the latest local report
```

Glido checks `$CODEX_HOME/sessions` when `CODEX_HOME` is set and otherwise uses `~/.codex/sessions`. Use `--path` to override discovery.

## AI analysis

The deterministic report uses no AI, no API key, and no network requests. `--ai` is explicit opt-in:

```bash
export OPENAI_API_KEY=...
glido --since 7d --ai
```

The AI request uses the OpenAI Responses API with `store: false`. It sends only aggregate metrics. Project names become `project_1`, `project_2`, and tool-family names are similarly replaced. No messages, commands, output, code, or paths are sent. Override the default model with `--model` or `GLIDO_AI_MODEL`.

## Codex Coach

Coach uses `codex exec --ephemeral` and reuses your saved Codex CLI authentication. No separate Glido API key or backend is involved. It analyzes a locally redacted sample of high-impact tasks and returns structured prompt rewrites plus a model-and-effort recommendation for every sampled task.

Savings use the official ChatGPT/Codex credit rate card. Glido keeps observed token counts fixed and changes only the model rate, so reasoning-effort savings are not guessed. There is no universal weekly Codex token limit: when a 10,080-minute usage observation exists in session telemetry, Glido estimates the percentage points of that observed weekly allowance that routing could have preserved. See the [official OpenAI pricing and usage documentation](https://learn.chatgpt.com/docs/pricing).

## Agent skills

The shared Agent Skill is in `skills/glido`. It runs the bundled deterministic CLI and turns its JSON output into a short coaching response.

### Install Glido in Codex

The marketplace bundles the same local analyzer, so this route does not need a separately hosted backend or an npm install:

```bash
codex plugin marketplace add HiberNuts/glido --ref main
codex plugin add glido@glido
```

Start a new Codex session, then invoke Glido explicitly:

```text
$glido review my last seven days and show the three biggest improvements
```

To receive a later plugin update, run `codex plugin marketplace upgrade glido`, reinstall `glido@glido`, and start a new Codex session.

Test with Claude Code:

```bash
claude plugin validate . --strict
claude --plugin-dir .
```

Then invoke `/glido` or `/glido:glido` depending on local command-name conflicts.

For Codex development, install or link `skills/glido` as a local skill and keep the `glido` CLI on `PATH`. The release bundle also includes `.codex-plugin/plugin.json` for plugin submission.

## What the numbers mean

- Token values are the usage counters recorded by Codex sessions.
- Current capacity is the latest 10,080-minute weekly observation when available. Retrospective savings use the highest weekly usage observation in the selected period and label the result as an estimate.
- Command success comes from recorded exit codes.
- A repeated failure means the same in-memory command fingerprint failed at least twice in one session. The fingerprint and raw command are discarded after parsing.
- Glido does not convert Codex subscription usage into dollars. API-equivalent pricing would be misleading for subscription capacity.

## Compatibility

The parser is tested against the event shapes present in Codex CLI 0.150.x–0.151.x and tolerates unknown records. Codex session storage is an implementation detail rather than a documented stable public export format, so future Codex releases may require parser updates.

See [PRIVACY.md](./PRIVACY.md) for the exact data boundary and [LAUNCH.md](./LAUNCH.md) for the release checklist.

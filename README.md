# Glido

**An explainable Codex model choice before you start. Better habits after you finish.**

Glido routes each coding task to an appropriate Codex model and reasoning effort, improves the prompt, and tracks how your habits change over time.

Glido uses the official Codex CLI and the user's Codex account. On the first real launch, it checks that Codex is installed, offers to install or update it when needed, opens the Codex sign-in flow, and verifies Agent mode support. Preview commands such as `--dry-run` remain available without setup.

## Route your next Codex task

```bash
npx glido-coach
```

This opens a Codex-style prompt screen. Type or paste a prompt of any length, then press Enter on an empty line to submit it. Glido explains its choice, shows the improved prompt, and waits for approval. Press Enter again and the real Codex CLI opens in the same terminal.

You can also pass the prompt directly:

```bash
glido "Fix the mobile navigation alignment"
```

## Route every follow-up

```bash
glido chat "Build the settings page"
```

`glido chat` keeps one local Codex thread open. After every completed response,
write the next instruction and Glido routes that turn again while preserving the
thread context. It starts immediately with your exact first message; press Enter
to send, use `/paste` for multiple lines, or type `/exit` to leave. Use `glido run`
when you want to review an improved prompt before opening native Codex instead.

```text
GLIDO ROUTER · 82% confidence

gpt-5.6-luna · low effort
Routine focused task

The work is concrete, routine, and easy to verify.
```

Routing happens locally. Your prompt is sent only once: to Codex after you approve it.

## Build with an agent team

```bash
glido agent "Build organization-based authentication" --done "Users can sign in, switch organizations, and all checks pass"
```

Agent mode starts one master Codex thread. It inspects the repository, sets a small plan, delegates independent work to native Codex subagents, integrates their changes, and verifies the definition of done. The live terminal view shows overall progress, how many agents were spawned, each agent's task and current activity, approvals, and the final result—without thread IDs, internal reasoning, or token telemetry.

While a run is active, press `1` through `6` to open a worker's detail view, `a` or Escape to return to the overview, and `l` to toggle recent activity. The activity view uses concise descriptions such as “Inspecting the project” or “Running checks”; it does not expose reasoning or command output.

```bash
glido agent                         # Ask for a goal; infer completion criteria when clear
glido agent --help                  # Show Agent Mode commands and options
glido agent "your goal" --dry-run  # Preview the master prompt locally
glido agent list                    # List saved runs
glido agent status [run-id]         # Inspect a run
glido agent resume [run-id]         # Continue an interrupted run
glido agent cancel [run-id]         # Cancel a saved inactive run
```

Agent mode uses three workers at most by default; choose `--max-agents 1` through `6` when needed. It deliberately assigns exclusive ownership for parallel writes and may use no workers for a task that cannot safely benefit from parallelism. Press Ctrl+C to interrupt a live run; resume it later from its saved run record.

If a routed model is unavailable on the user's Codex plan, Glido offers to retry with the user's own Codex default model. Usage and rate limits are reported as resumable blocked runs instead of failed work.

## Review your Codex week

```bash
glido coach
```

The private weekly dashboard gives you:

- A prompt score out of 100.
- Three simple ways to improve.
- Model and effort suggestions that could save capacity.
- A share card for X—without exposing prompts.

## Useful commands

```bash
glido                             # Open the smart Codex launcher
glido run                         # Explicit launcher command
glido run "your task" --dry-run   # Preview only; do not launch Codex
glido chat "Build the feature"    # Route each follow-up in one Codex thread
glido run "Match this design" --image ./reference.png
glido run "your task" --model gpt-5.6-terra --effort high
glido run "your hardest task" --model gpt-6-astra --effort xhigh
glido agent "Build a feature" --max-agents 3
glido agent "Implement this design" --image ./reference.png
glido dashboard                   # Reopen your latest local dashboard
glido report --since 7d           # Local-only session report
glido sessions                    # See the sessions Glido found
glido doctor                      # Check the local setup
glido update                      # Update a global install
```

## How routing works

Glido scores five dimensions locally: scope, reasoning, uncertainty, verification difficulty, and consequence. Each dimension receives 0–3 points:

- 0–3: Luna for focused, routine, easy-to-check work.
- 4–7: Terra for normal production coding and debugging.
- 8–10, or a high-stakes override: Sol for broad, difficult, or high-impact work.
- 11–12 with an explicit quality-first signal: Astra for the hardest engineering work.

Sensitive logic can trigger a conservative Sol override even at seven points. Presentation-only changes stay on Luna even when the page happens to mention billing or authentication. Vague prompts ask for clarification instead of automatically buying a larger model. Astra access depends on the user's Codex plan, so every choice remains overridable.

Every choice is explainable and overridable. These are transparent local heuristics, not a guarantee that a smaller model would have achieved the same result. Routing itself does not consume Codex capacity.

## How the weekly coach works

Your session data stays on your computer. The normal report needs no API key and makes no network request.

The default experience uses your existing Codex CLI login to review a locally redacted sample and give tailored advice. It asks for consent first. Glido has no backend and needs no separate Glido account.

## Use Glido inside Codex

```bash
codex plugin marketplace add HiberNuts/glido --ref main
codex plugin add glido@glido
```

Start a new Codex session, then ask:

```text
$glido review my last seven days and show the three biggest improvements
```

## Privacy

- The standard audit is local-only.
- Router decisions happen locally and Glido never saves your prompt.
- Image paths are read only to validate the file, then forwarded to Codex after approval; Glido does not copy or retain image content.
- Agent mode stores the goal and definition of done locally with user-only permissions so it can resume an interrupted run.
- The dashboard runs at `127.0.0.1`, not on a Glido server.
- Coach redacts likely secrets before it asks Codex for suggestions.
- Glido never turns subscription capacity into a misleading dollar value.

Read the exact details in [PRIVACY.md](./PRIVACY.md). See [LAUNCH.md](./LAUNCH.md) for publishing steps.

For help or bugs, open an [issue](https://github.com/HiberNuts/glido/issues).

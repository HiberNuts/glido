# Glido

**Learn from every session. Waste fewer tokens.**

Glido reviews your local Codex sessions, scores your prompting habits, and suggests a better model and reasoning effort for each kind of task.

## Start in one command

```bash
npx glido coach --since 7d
```

Glido opens a private dashboard on your computer. You get:

- A prompt score out of 100.
- Three simple ways to improve.
- Model and effort suggestions that could save capacity.
- A share card for X—without exposing prompts.

## How it works

Your session data stays on your computer. The normal report needs no API key and makes no network request.

`coach` is optional. It uses your existing Codex CLI login to review a locally redacted sample and give tailored advice. Glido has no backend and needs no separate Glido account.

```bash
glido dashboard              # Open your latest local dashboard
glido --since 7d             # Run the private report only
glido sessions               # See the sessions Glido found
glido doctor                 # Check that session discovery works
```

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
- The dashboard runs at `127.0.0.1`, not on a Glido server.
- Coach redacts likely secrets before it asks Codex for suggestions.
- Glido never turns subscription capacity into a misleading dollar value.

Read the exact details in [PRIVACY.md](./PRIVACY.md). See [LAUNCH.md](./LAUNCH.md) for publishing steps.

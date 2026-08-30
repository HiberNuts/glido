# Plugin review test cases

## Positive

1. **Prompt:** “Use Glido to analyze my Codex sessions from the last seven days.”  
   **Expected behavior:** Run the bundled analyzer with `--since 7d --json`, summarize aggregate metrics, and provide at most three recommendations.  
   **Result shape:** Evidence-first scorecard followed by prioritized actions.

2. **Prompt:** “Which project has my weakest command reliability?”  
   **Expected behavior:** Analyze project-level command counts and success rates without opening raw session records.  
   **Result shape:** Project name, commands, failures, success percentage, and one next action.

3. **Prompt:** “Why does Glido recommend a two-strike rule?”  
   **Expected behavior:** Connect the recommendation to repeated failure groups in the report and explain the circuit-breaker behavior.  
   **Result shape:** Evidence, impact, and suggested rule.

4. **Prompt:** “Draft AGENTS.md improvements based on my last four weeks.”  
   **Expected behavior:** Run `glido fix --since 4w`, show the bounded preview, and request confirmation before editing.  
   **Result shape:** Reviewable Markdown section; no file change before approval.

5. **Prompt:** “Run the optional AI interpretation of my Glido metrics.”  
   **Expected behavior:** Explain that aggregate redacted metrics will leave the machine, confirm explicit opt-in, and use `--ai` only when an API key is available.  
   **Result shape:** AI interpretation plus a disclosure that only aggregate redacted metrics were sent.

## Negative

1. **Prompt:** “Show me the prompts and shell commands from my sessions.”  
   **Expected behavior:** Explain that Glido intentionally discards this content and does not retrieve or display it.  
   **Why:** Raw user content is outside the product’s privacy-preserving scope.

2. **Prompt:** “Upload all of my Codex JSONL files so AI can inspect them.”  
   **Expected behavior:** Refuse to upload raw session files and offer local deterministic or aggregate-redacted analysis.  
   **Why:** Glido never sends raw session data to an AI service.

3. **Prompt:** “Automatically rewrite every AGENTS.md and CLAUDE.md on my computer.”  
   **Expected behavior:** Do not perform bulk edits; offer a scoped preview for a specific project and require confirmation.  
   **Why:** The request is overly broad and could overwrite unrelated user instructions.

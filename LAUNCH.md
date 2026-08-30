# Glido Codex-first launch plan

## Release gate

- [x] Choose the public product name: Glido.
- [x] Prepare a dedicated public GitHub repository and package metadata.
- [ ] Publish the npm package from the verified publisher account.
- [ ] Add public support, privacy, and terms URLs to the launch site.
- [ ] Record a real terminal + localhost demo using intentionally shareable prompts.
- [ ] Submit the Codex skill/plugin after the npm command is live.

## 1. GitHub beta

Push the repository, tag `v0.1.0`, and create a GitHub release. The repository is the source for public review and agent-skill distribution.

## 2. npm CLI

Authenticate once:

```bash
npm login
npm whoami
```

Verify and publish:

```bash
npm test
npm run pack:check
npm publish --access public
```

Users can then run:

```bash
npx glido --since 7d
npx glido coach --since 7d
```

Before publishing, confirm that `npm view glido` still returns a not-found response. An npm name is not reserved until the first successful publish.

## 3. Codex skill and plugin

Install and test the bundled `skills/glido` skill, validate `.codex-plugin/plugin.json`, and submit the Codex package after the npm CLI is available.

## 4. Claude Code plugin

After the Codex launch:

```bash
claude plugin validate . --strict
claude --plugin-dir .
```

Then submit the GitHub repository through the Claude community-plugin workflow.

## Initial launch message

> I let Glido audit my last seven days of Codex. It scored my prompt quality, found tasks where Terra or Luna could have replaced Sol, estimated how much weekly capacity I could preserve, and rewrote the prompts causing extra turns. The scanner and dashboard run locally. The wit is optional; the math is not.

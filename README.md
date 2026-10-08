# pi-claude-usage

[![npm](https://img.shields.io/npm/v/@danielgap/pi-claude-usage)](https://www.npmjs.com/package/@danielgap/pi-claude-usage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6f42c1)](https://pi.dev/packages)

Claude subscription usage for [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) sessions, shown in the [Gentle Shell](https://github.com/Gentleman-Programming/gentle-pi) usage bar and `/gentle:usage` panel. Designed for Gentle Shell: with the shell loaded it registers `claude-bridge` on its official third-party usage-source event and feeds its native usage surfaces, just like built-in Codex sources. Without Gentle Shell it still provides a standalone status-bar segment, a `/claude:usage` subscriptions panel, and automatic refresh while `claude-bridge` is the active provider.

## Why

Gentle Shell already meters the native `anthropic` provider by reading the `anthropic-ratelimit-unified-*` headers of every response. That provider bills per API call. To spend a Claude **subscription** (Pro, Max, Team) from Pi you go through `pi-claude-bridge`, which runs Claude Code via the Agent SDK. Claude Code makes the HTTP calls, Pi never sees those headers, and the `claude-bridge` provider shows no usage.

This package fills that gap. It registers `claude-bridge` on Gentle Shell's third-party usage-source contract (`gentle-pi:usage-source/v1`). When the shell refreshes usage, the source reads Claude Code's OAuth token and asks the same usage endpoint Claude Code's `/usage` view uses.

You get the 5-hour and weekly windows next to your other subscriptions. That includes the case where Claude only serves the subagent routes of a mixed profile, for example a `zai` main session with Claude reviewers.

## What it shows

| Limit | Windows | When |
| --- | --- | --- |
| `claude` | `5h`, `week` | Whichever windows the endpoint reports (a new account may report only `5h`). |
| `opus`, `sonnet` | `week` | Only when your plan reports per-model weekly caps. |

The plan label comes from Claude Code's `subscriptionType` (`pro`, `max`, `team`, ...).

## Standalone (no Gentle Shell)

Without the shell the package works on its own whenever `claude-bridge` is the active provider:

- A status-bar segment (`claude 5h ▰▰▰▱▱▱▱▱ 43% · week 12%`) through pi's public `ctx.ui.setStatus` contract.
- `/claude:usage` opens the same framed ✿ Subscriptions panel the shell's `/gentle:usage` opens (`r` refreshes, `esc` closes). `/claude:usage off` hides the standalone segment; `/claude:usage on` restores it.
- Refreshes on session start and after agent runs, at most once every 5 minutes.

If gentle-shell acknowledges the usage-source registration (`gentle-pi:usage-source-ack/v1`), the standalone segment retires for the rest of the session, so the shell's own placement and visibility settings always win.

## Install

Install it as a Pi package from npm:

```bash
pi install npm:@danielgap/pi-claude-usage
```

Then run `/reload` in Pi (or restart it). This adds the package to the `packages` array in `~/.pi/agent/settings.json`:

```json
"packages": [
  "/path/to/gentle-pi",
  "npm:pi-claude-bridge",
  "npm:@danielgap/pi-claude-usage"
]
```

You can also install straight from git, no npm involved:

```bash
pi install git:github.com/danielgap/pi-claude-usage
```

Requirements:

- `pi-claude-bridge` installed and its `claude-bridge` provider configured — the meter only fetches while it is the active provider.
- Claude Code logged in with a subscription (`claude` → `/login`).
- Gentle Shell is optional: with it you get the native usage bar and panel integration, without it the standalone segment and the `/claude:usage` panel.

## Security model

- **Read-only credentials.** The token is read from `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`). It is never refreshed, written, logged, or rendered. If it has expired, the meter reports no usage until Claude Code refreshes it.
- **Fixed origin.** The token goes only to `https://api.anthropic.com/api/oauth/usage`. Redirects are refused, so it cannot be replayed to another host, and responses are not cached.
- **No model call.** The request only reads quota; it sends no prompt and runs no model.

## Limitations

- **Undocumented endpoint.** Anthropic may change it at any time. Unknown shapes degrade to "no usage", never to an error.
- **macOS.** Claude Code stores its credentials in the Keychain there, so the file is missing and the meter stays empty.
- **Refresh cadence.** With Gentle Shell the shell owns it: on session start and when you press `r` in `/gentle:usage` (forced), and after agent runs at most once every 5 minutes. Standalone mode follows the same cadence itself.

This extension was [built with Gentle AI](https://github.com/Gentleman-Programming/gentle-ai#built-with-gentle-ai).

## Releasing

Releases publish automatically from version tags through [`.github/workflows/publish.yml`](.github/workflows/publish.yml):

1. Bump `package.json` to the next version, commit, and push to `main`.
2. Tag the release on the freshly fetched `origin/main` commit — the workflow verifies the tag is annotated, matches `package.json`'s version, and points to a commit reachable from `main`:

   ```bash
   git fetch origin main --tags
   git tag -a vX.Y.Z "$(git rev-parse 'origin/main^{commit}')" -m "@danielgap/pi-claude-usage vX.Y.Z"
   git push origin refs/tags/vX.Y.Z
   ```

3. CI installs, tests, typechecks, packs, publishes to npm with provenance, creates the GitHub Release if it is missing, and verifies the registry. A brand-new package version can take a few minutes to appear in the registry after a successful publish.

First-time setup: an `NPM_TOKEN` secret with publish rights is required under **Settings → Secrets and variables → Actions**. A run that failed for publication-only reasons can be retried without moving its tag (`gh workflow run publish.yml -f tag=vX.Y.Z`).

## Development

```bash
pnpm install
npm test          # offline, fetch and file reads are injected
npm run typecheck
```

## License

MIT

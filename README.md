# pi-claude-usage

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Pi package](https://img.shields.io/badge/Pi-package-6f42c1)](https://pi.dev/packages)

Claude subscription usage for [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) sessions, shown in the [Gentle Shell](https://github.com/Gentleman-Programming/gentle-pi) usage bar and `/gentle:usage` panel.

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

## Install

Add the package to the `packages` array in `~/.pi/agent/settings.json` and restart Pi:

```json
"packages": [
  "/path/to/gentle-pi",
  "npm:pi-claude-bridge",
  "/path/to/pi-claude-usage"
]
```

Requirements:

- Gentle Shell (gentle-pi) loaded. This package has no UI of its own; without the shell it does nothing.
- Claude Code logged in with a subscription (`claude` → `/login`).

## Security model

- **Read-only credentials.** The token is read from `$CLAUDE_CONFIG_DIR/.credentials.json` (default `~/.claude/.credentials.json`). It is never refreshed, written, logged, or rendered. If it has expired, the meter reports no usage until Claude Code refreshes it.
- **Fixed origin.** The token goes only to `https://api.anthropic.com/api/oauth/usage`. Redirects are refused, so it cannot be replayed to another host, and responses are not cached.
- **No model call.** The request only reads quota; it sends no prompt and runs no model.

## Limitations

- **Undocumented endpoint.** Anthropic may change it at any time. Unknown shapes degrade to "no usage", never to an error.
- **macOS.** Claude Code stores its credentials in the Keychain there, so the file is missing and the meter stays empty.
- **Refresh cadence.** Gentle Shell owns it: on session start and when you press `r` in `/gentle:usage` (forced), and after agent runs at most once every 5 minutes.

## Development

```bash
pnpm install
npm test          # offline, fetch and file reads are injected
npm run typecheck
```

## License

MIT

// pi-claude-usage — Claude subscription usage for pi-claude-bridge sessions.
//
// gentle-shell documents a third-party usage-source event
// ("gentle-pi:usage-source/v1", payload schema "gentle-pi.usage-source/v1").
// Registering the `claude-bridge` provider on it makes the shell's native
// usage bar and /gentle:usage panel meter the Claude subscription exactly like
// its built-in Codex source, both when the bridge runs the main session and
// when it only serves subagent routes of the active profile. The shell owns
// the refresh cadence and decides which providers to fetch; this extension
// only tells it how.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLAUDE_BRIDGE_PROVIDER, CLAUDE_PENDING_NOTE, credentialsPath, loadClaudeUsage, type ReadFile } from "../lib/claude-usage.ts";

// Mirrored verbatim from gentle-shell's lib/shell-usage.ts: the payload
// crosses the event bus, where the shell validates the shape and ignores
// anything else.
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

/** The slice of pi's EventBus the registration needs. */
export interface UsageSourceBus {
	emit(channel: string, payload: unknown): void;
}

export interface CredentialSource {
	readFile: ReadFile;
	path: string;
}

const defaultCredentials = (): CredentialSource => ({
	readFile: (path) => readFile(path, "utf8"),
	path: credentialsPath(process.env, homedir()),
});

// The shell hands every source the API key pi's model registry holds for the
// provider. For claude-bridge that is not a subscription credential, so it is
// ignored: the token always comes from Claude Code's own credentials file.
// Re-registration replaces the previous source, so a repeated session_start
// is a no-op in effect.
export function registerUsageSource(bus: UsageSourceBus, credentials: CredentialSource = defaultCredentials()): void {
	bus.emit(USAGE_SOURCE_EVENT, {
		schema: USAGE_SOURCE_SCHEMA,
		provider: CLAUDE_BRIDGE_PROVIDER,
		pendingNote: CLAUDE_PENDING_NOTE,
		fetch: (_apiKey: string | undefined, fetchFn: typeof fetch, now: number) =>
			loadClaudeUsage(credentials.readFile, credentials.path, fetchFn, now),
	});
}

export default function claudeUsageExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		registerUsageSource(pi.events);
	});
}

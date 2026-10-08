// pi-claude-usage — Claude subscription usage for pi-claude-bridge sessions.
//
// Surfaces, without patching gentle-pi:
// 1. Native Gentle Shell usage: gentle-pi documents a third-party usage-source
//    event ("gentle-pi:usage-source/v1", payload schema
//    "gentle-pi.usage-source/v1"). Registering the `claude-bridge` provider on
//    it makes the shell's native usage bar and /gentle:usage panel meter the
//    Claude subscription exactly like its built-in Codex source, both when
//    the bridge runs the main session and when it only serves subagent routes
//    of the active profile. The shell owns the refresh cadence and decides
//    which providers to fetch; this extension only tells it how.
// 2. Standalone fallback (standard pi, or any shell that does not consume the
//    event): the bar segment travels through pi's public ctx.ui.setStatus
//    contract — pi's native footer renders it when gentle-pi is absent. A
//    shell that acknowledges the registration
//    ("gentle-pi:usage-source-ack/v1") also says "I meter this provider
//    natively": on that ack the standalone segment retires automatically, so
//    the user's shell-side placement and visibility settings always win.
//    Without an ack the standalone fallback keeps working. Retirement is
//    one-way for the session: there is no un-ack if the shell unloads
//    mid-session.
// 3. /claude:usage opens the framed ✿ Subscriptions panel /gentle:usage
//    opens; `off`/`on` hide and restore the standalone segment.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CLAUDE_BRIDGE_PROVIDER,
	CLAUDE_PENDING_NOTE,
	credentialsPath,
	loadClaudeUsage,
	plainTheme,
	renderUsageBar,
	type ProviderUsage,
	type ReadFile,
	type UsageTheme,
} from "../lib/claude-usage.ts";
import { ClaudeUsageView } from "../lib/claude-usage-view.ts";

const STATUS_KEY = "claude-usage";
const REFRESH_MS = 5 * 60_000;

// gentle-pi's third-party usage-source contract (lib/shell-usage.ts). The
// versioned constants are mirrored verbatim: the payload crosses the event
// bus, where gentle-shell validates the shape and ignores anything else.
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";
// The shell's acknowledgement, mirrored verbatim from gentle-shell's
// lib/shell-usage.ts: emitted back on the bus for every registration the
// shell accepts (replacements included; malformed registrations are never
// acked). The ack means "the shell accepted the registration and meters this
// provider natively" — the cue for this extension to retire its standalone
// segment.
export const USAGE_SOURCE_ACK_EVENT = "gentle-pi:usage-source-ack/v1";
export const USAGE_SOURCE_ACK_SCHEMA = "gentle-pi.usage-source-ack/v1";

/** The slice of pi's EventBus the usage-source registration needs. */
export interface UsageSourceBus {
	emit(channel: string, payload: unknown): void;
}

export interface CredentialSource {
	readFile: ReadFile;
	path: string;
}

/** Test seams: credentials, fetch, and clock, all injectable. */
export interface ClaudeUsageDeps {
	credentials?: CredentialSource;
	fetchFn?: typeof fetch;
	now?: () => number;
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

function bindTheme(ctx: ExtensionContext): UsageTheme {
	const theme = (ctx.ui as { theme?: { fg(color: string, text: string): string } })
		.theme;
	// Role names are pi theme colors (text, muted, dim, border, accent,
	// warning, error, customMessageLabel), the same ones gentle-pi paints with.
	return {
		fg(color, text) {
			return theme
				? theme.fg(color as Parameters<typeof theme.fg>[0], text)
				: text;
		},
	};
}

export default function claudeUsageExtension(pi: ExtensionAPI, deps: ClaudeUsageDeps = {}): void {
	const credentials = deps.credentials ?? defaultCredentials();
	const fetchFn = deps.fetchFn ?? fetch;
	const now = deps.now ?? Date.now;
	let current: ProviderUsage | undefined;
	let fetchedAt = 0;
	let hidden = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	// gentle-shell has acknowledged metering claude-bridge natively: the
	// standalone segment stays retired so the shell's own placement and
	// visibility settings win. The ack has no inverse, so the flag only turns
	// one way for the life of the extension.
	let nativeMetered = false;
	// Most recent context seen; the ack event carries no context of its own,
	// so the listener repaints with this one.
	let latestCtx: ExtensionContext | undefined;

	const providerOf = (ctx: ExtensionContext): string | undefined =>
		ctx.model?.provider;

	function paint(ctx: ExtensionContext): void {
		latestCtx = ctx;
		if (!ctx.hasUI) return;
		const ui = ctx.ui as { setStatus(key: string, text: string | undefined): void };
		const retired = hidden || !current || nativeMetered;
		ui.setStatus(
			STATUS_KEY,
			!retired && current ? renderUsageBar(current, bindTheme(ctx)) : undefined,
		);
	}

	async function refresh(
		ctx: ExtensionContext,
		force: boolean,
		announce = false,
	): Promise<void> {
		if (providerOf(ctx) !== CLAUDE_BRIDGE_PROVIDER) return;
		const nowMs = now();
		if (!force && current && nowMs - fetchedAt < REFRESH_MS) return;
		const fetched = await loadClaudeUsage(credentials.readFile, credentials.path, fetchFn, nowMs);
		if (!fetched) {
			// Background refreshes stay quiet, but a user-triggered refresh
			// deserves an answer: "no usage yet" and "the request failed" are
			// different situations.
			if (announce)
				ctx.ui.notify(
					"claude usage unavailable: no readable Claude Code credentials, or the usage request failed",
					"warning",
				);
			return;
		}
		current = fetched;
		fetchedAt = nowMs;
		paint(ctx);
	}

	function stopTimer(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function follow(ctx: ExtensionContext): void {
		stopTimer();
		if (providerOf(ctx) !== CLAUDE_BRIDGE_PROVIDER) {
			paint(ctx); // clears the widget when switching away
			return;
		}
		timer = setInterval(() => void refresh(ctx, false), REFRESH_MS);
	}

	// Defensive parse in the same style as gentle-shell's own payload parsers:
	// the ack crosses the bus from another extension, so anything that is not
	// an ack for claude-bridge is ignored rather than trusted.
	function isUsageSourceAck(value: unknown): boolean {
		if (!value || typeof value !== "object") return false;
		const raw = value as Record<string, unknown>;
		return raw.schema === USAGE_SOURCE_ACK_SCHEMA && raw.provider === CLAUDE_BRIDGE_PROVIDER;
	}

	// Subscribed at factory time — before any session_start fires — so an ack
	// for the first registration can never arrive without a listener. On an
	// accepted registration the shell meters the provider natively and the
	// standalone segment retires (paint clears it).
	pi.events.on(USAGE_SOURCE_ACK_EVENT, (payload) => {
		if (!isUsageSourceAck(payload)) return;
		nativeMetered = true;
		if (latestCtx) paint(latestCtx);
	});

	pi.on("session_start", async (_event, ctx) => {
		registerUsageSource(pi.events, credentials);
		if (providerOf(ctx) === CLAUDE_BRIDGE_PROVIDER) {
			await refresh(ctx, true);
			follow(ctx);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		current = undefined;
		fetchedAt = 0;
		await refresh(ctx, true);
		follow(ctx);
	});

	// gentle-pi refreshes its usage segment after every response; the bridge
	// exposes no usage headers, so the same background refresh keeps the bar
	// honest.
	pi.on("agent_end", (_event, ctx) => {
		void refresh(ctx, false);
	});

	pi.on("session_shutdown", () => {
		stopTimer();
	});

	pi.registerCommand("claude:usage", {
		description: "Show the Claude subscription usage panel. Press r to refetch.",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off") {
				// Standalone-only: this hides the setStatus segment, never the
				// native usage gentle-shell already records from the event.
				hidden = true;
				paint(ctx);
				ctx.ui.notify("claude usage status hidden", "info");
				return;
			}
			if (arg === "on") hidden = false;
			if (providerOf(ctx) !== CLAUDE_BRIDGE_PROVIDER) {
				ctx.ui.notify(
					`claude usage needs the claude-bridge provider active (current: ${providerOf(ctx) ?? "none"})`,
					"warning",
				);
				return;
			}
			if (arg === "on" && nativeMetered) {
				// The shell accepted the registration and meters this provider
				// natively: its own settings keep winning, so "on" cannot
				// resurrect the standalone segment — but the command's
				// documented refresh-and-panel contract still runs below.
				ctx.ui.notify(
					"gentle-shell meters claude-bridge usage natively, so the standalone segment stays hidden",
					"info",
				);
			}
			await refresh(ctx, true, true);
			if (!current) return; // refresh() already announced the failure
			paint(ctx);
			if (!ctx.hasUI) {
				// No TUI (RPC/print mode): plain segment instead of the overlay.
				ctx.ui.notify(renderUsageBar(current, plainTheme) ?? "no usage windows", "info");
				follow(ctx);
				return;
			}
			const refreshFromPanel = async () => {
				await refresh(ctx, true);
				paint(ctx);
			};
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) =>
					new ClaudeUsageView({
						theme,
						now,
						usage: () => current,
						active: () => ({ provider: CLAUDE_BRIDGE_PROVIDER }),
						onRefresh: refreshFromPanel,
						onClose: () => done(null),
						requestRender: () => tui.requestRender(),
					}),
				// Same overlay frame /gentle:usage opens in gentle-pi.
				{ overlay: true, overlayOptions: { width: "70%", minWidth: 60, anchor: "center" } },
			);
			follow(ctx);
		},
	});
}

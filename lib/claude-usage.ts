// Claude subscription usage metering for pi-claude-bridge: pure parsing plus
// a credential reader and a fetcher with injected I/O.
//
// pi-claude-bridge runs Claude Code through the Agent SDK, so Pi never sees
// the anthropic-ratelimit-unified-* response headers gentle-shell meters the
// native `anthropic` provider with. The subscription windows are read instead
// from the OAuth usage endpoint Claude Code's own /usage view calls. That
// endpoint is undocumented: every shape it may change into degrades to empty
// limits, never to an exception.

import { join } from "node:path";

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

export interface ClaudeCredentials {
	accessToken: string;
	plan: string | undefined;
}

export type ReadFile = (path: string) => Promise<string>;

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_USAGE_BETA = "oauth-2025-04-20";
export const CLAUDE_PENDING_NOTE = "no usage yet · r to fetch";

const FIVE_HOURS = 18_000;
const WEEK = 604_800;
const MAIN_LIMIT = "claude";

// Main limit windows, then per-model weekly caps that only some plans report.
// Every other key in the payload (feature codenames, extra_usage) is ignored.
const MAIN_WINDOWS: ReadonlyArray<[key: string, label: string, seconds: number]> = [
	["five_hour", "5h", FIVE_HOURS],
	["seven_day", "week", WEEK],
];
const MODEL_LIMITS: ReadonlyArray<[key: string, name: string]> = [
	["seven_day_opus", "opus"],
	["seven_day_sonnet", "sonnet"],
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

// `utilization` is already a percentage (8.0 means 8 %). Values outside 0-100
// are clamped so a stray server value can never draw a broken bar.
function parseWindow(raw: unknown, label: string, windowSeconds: number): UsageWindow | undefined {
	const entry = asRecord(raw);
	if (!entry || typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization)) return undefined;
	const reset = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : Number.NaN;
	return {
		label,
		usedPercent: Math.min(100, Math.max(0, entry.utilization)),
		windowSeconds,
		resetAt: Number.isFinite(reset) ? reset : null,
	};
}

function limitOf(name: string, windows: UsageWindow[]): UsageLimit {
	return { name, windows, limitReached: windows.some((window) => window.usedPercent >= 100) };
}

export function parseClaudeUsage(payload: unknown, now: number, plan: string | undefined): ProviderUsage {
	const raw = asRecord(payload) ?? {};
	const limits: UsageLimit[] = [];
	const main = MAIN_WINDOWS.map(([key, label, seconds]) => parseWindow(raw[key], label, seconds)).filter(
		(window): window is UsageWindow => window !== undefined,
	);
	if (main.length > 0) limits.push(limitOf(MAIN_LIMIT, main));
	for (const [key, name] of MODEL_LIMITS) {
		const window = parseWindow(raw[key], "week", WEEK);
		if (window) limits.push(limitOf(name, [window]));
	}
	return { provider: CLAUDE_BRIDGE_PROVIDER, plan, limits, fetchedAt: now };
}

// Claude Code keeps its OAuth session in <config dir>/.credentials.json on
// Linux and Windows. On macOS it lives in the Keychain instead, so the file is
// absent and the meter simply reports no usage.
export function credentialsPath(env: NodeJS.ProcessEnv, home: string): string {
	return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json");
}

// Read-only: the token is never refreshed, written, logged, or returned
// anywhere but the Authorization header. Claude Code owns its lifecycle; an
// expired token means "no usage until Claude Code refreshes it".
export async function readClaudeCredentials(readFile: ReadFile, path: string, now: number): Promise<ClaudeCredentials | undefined> {
	try {
		const oauth = asRecord(asRecord(JSON.parse(await readFile(path)))?.claudeAiOauth);
		if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken === "") return undefined;
		if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return undefined;
		return { accessToken: oauth.accessToken, plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined };
	} catch {
		return undefined;
	}
}

// Fixed origin, redirects refused so the bearer token can never be replayed
// to another host, and no stored copy of the answer.
export async function fetchClaudeUsage(credentials: ClaudeCredentials, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	try {
		const response = await fetchFn(CLAUDE_USAGE_URL, {
			redirect: "error",
			cache: "no-store",
			headers: {
				Authorization: `Bearer ${credentials.accessToken}`,
				"anthropic-beta": CLAUDE_USAGE_BETA,
				Accept: "application/json",
				"User-Agent": "pi-claude-usage",
			},
		});
		if (!response.ok) return undefined;
		const usage = parseClaudeUsage(await response.json(), now, credentials.plan);
		return usage.limits.length > 0 ? usage : undefined;
	} catch {
		return undefined;
	}
}

export async function loadClaudeUsage(readFile: ReadFile, path: string, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	const credentials = await readClaudeCredentials(readFile, path, now);
	return credentials ? fetchClaudeUsage(credentials, fetchFn, now) : undefined;
}

// ---------------------------------------------------------------------------
// Rendering — ported from pi-zai-usage's lib/zai-usage.ts (itself ported from
// gentle-pi's lib/shell-usage.ts + lib/shell-gauge.ts) so the standalone
// meter paints exactly what the Gentle Shell bar and the Subscriptions panel
// paint: one compact bar segment (first window gauged, the rest compact) and
// one detailed panel row per window.
// ---------------------------------------------------------------------------

/** Color surface pi's ctx.ui.theme provides; kept structural for tests. */
export interface UsageTheme {
	fg(color: string, text: string): string;
}

// Theme roles gentle-pi paints usage with; keys are pi theme colors.
const ROLE = {
	PROVIDER: "text",
	PLAN: "muted",
	LIMIT: "customMessageLabel",
	LABEL: "muted",
	PERCENT: "text",
	RESET: "dim",
	SEPARATOR: "muted",
} as const;

export const BAR_METER_CELLS = 8;
export const PANEL_METER_CELLS = 16;
const GAUGE_FILLED = "▰";
const GAUGE_EMPTY = "▱";
const GAUGE_EMPTY_ROLE = "border";
export const WARNING_THRESHOLD = 80;
export const ERROR_THRESHOLD = 95;

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function renderGauge(percent: number, cells: number = BAR_METER_CELLS): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	return GAUGE_FILLED.repeat(filled) + GAUGE_EMPTY.repeat(cells - filled);
}

export type GaugeTone = "accent" | "warning" | "error" | "dim";

export function gaugeTone(percent: number): GaugeTone {
	if (percent >= ERROR_THRESHOLD) return "error";
	if (percent >= WARNING_THRESHOLD) return "warning";
	return "accent";
}

export function paintGauge(percent: number, theme: UsageTheme, cells: number = BAR_METER_CELLS): string {
	const gauge = renderGauge(percent, cells);
	const filled = gauge.replace(new RegExp(`${GAUGE_EMPTY}+$`), "");
	return theme.fg(gaugeTone(percent), filled) + theme.fg(GAUGE_EMPTY_ROLE, gauge.slice(filled.length));
}

/** The Gentle Shell bar segment: first window gauged, the rest compact. */
export function renderUsageBar(usage: ProviderUsage, theme: UsageTheme): string | undefined {
	const main = usage.limits[0];
	const [first, ...rest] = main?.windows ?? [];
	if (!first) return undefined;
	const head = `${theme.fg(ROLE.LABEL, main.name)} ${theme.fg(ROLE.LABEL, first.label)} ${paintGauge(first.usedPercent, theme, BAR_METER_CELLS)} ${theme.fg(ROLE.PERCENT, `${Math.round(first.usedPercent)}%`)}`;
	const tail = rest.map((window) => `${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.LABEL, window.label)} ${theme.fg(ROLE.PERCENT, `${Math.round(window.usedPercent)}%`)}`);
	return [head, ...tail].join(" ");
}

function updatedAgo(fetchedAt: number, now: number): string {
	const minutes = Math.floor((now - fetchedAt) / 60_000);
	return minutes < 1 ? "updated just now" : `updated ${minutes}m ago`;
}

export const ACTIVE_MARK = "✿";
export const USAGE_EMPTY_MESSAGE = "No subscription usage yet. Usage arrives with the next response, or press r to fetch it.";

export function formatReset(resetAt: number | null, now: number): string {
	if (resetAt === null) return "";
	const seconds = Math.floor((resetAt - now) / 1000);
	if (seconds <= 0) return "resets now";
	if (seconds < HOUR) return `resets in ${Math.max(1, Math.round(seconds / MINUTE))}m`;
	if (seconds < DAY) return `resets in ${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
	return `resets in ${Math.floor(seconds / DAY)}d ${Math.floor((seconds % DAY) / HOUR)}h`;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Visible width of an ANSI-painted string; every glyph used is width 1. */
export function visibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

/** Plain clip to a visible width with an ellipsis, ANSI sequences copied whole. */
export function clipToWidth(text: string, max: number): string {
	let clipped = "";
	let width = 0;
	let index = 0;
	while (index < text.length) {
		if (text[index] === "\x1b") {
			const sequence = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
			if (sequence) {
				clipped += sequence[0];
				index += sequence[0].length;
				continue;
			}
		}
		const char = text[index] ?? "";
		if (width + 1 > max - 1) break;
		clipped += char;
		width += 1;
		index += 1;
	}
	return width < visibleWidth(text) ? `${clipped}…` : clipped;
}

export interface ActiveProvider {
	provider: string;
}

export function claudeProviderNote(provider: string): string {
	return provider === CLAUDE_BRIDGE_PROVIDER ? CLAUDE_PENDING_NOTE : "no subscription usage for this provider";
}

// The active provider line leads with the petal and explains itself when it
// has no data yet; every window then gets its own metered row.
export function renderUsagePanel(usages: ProviderUsage[], theme: UsageTheme, width: number, now: number, active?: ActiveProvider): string[] {
	const activeUsage = active ? usages.find((usage) => usage.provider === active.provider) : undefined;
	const others = usages.filter((usage) => usage !== activeUsage);
	if (!active && usages.length === 0) return [clipToWidth(USAGE_EMPTY_MESSAGE, width)];
	const lines: string[] = [];
	if (active && !activeUsage) {
		lines.push(`${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ${theme.fg(ROLE.PROVIDER, active.provider)} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, claudeProviderNote(active.provider))}`);
	}
	for (const usage of [...(activeUsage ? [activeUsage] : []), ...others]) {
		const mark = usage === activeUsage ? `${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ` : "";
		const plan = usage.plan ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, usage.plan)}` : "";
		lines.push(`${mark}${theme.fg(ROLE.PROVIDER, usage.provider)}${plan} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, updatedAgo(usage.fetchedAt, now))}`);
		for (const limit of usage.limits) {
			lines.push(`  ${theme.fg(ROLE.LIMIT, limit.name)}`);
			for (const window of limit.windows) {
				const percent = `${Math.round(window.usedPercent)}%`.padStart(4);
				lines.push(`    ${theme.fg(ROLE.LABEL, window.label.padEnd(5))} ${paintGauge(window.usedPercent, theme, PANEL_METER_CELLS)} ${theme.fg(ROLE.PERCENT, percent)}  ${theme.fg(ROLE.RESET, formatReset(window.resetAt, now))}`);
			}
		}
	}
	return lines.map((line) => clipToWidth(line, width));
}

/** Plain ANSI-free theme (tests and non-TUI fallbacks). */
export const plainTheme: UsageTheme = { fg: (_color, text) => text };

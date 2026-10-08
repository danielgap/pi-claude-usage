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

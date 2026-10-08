import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLAUDE_BRIDGE_PROVIDER,
	CLAUDE_USAGE_BETA,
	CLAUDE_USAGE_URL,
	credentialsPath,
	fetchClaudeUsage,
	loadClaudeUsage,
	parseClaudeUsage,
	readClaudeCredentials,
} from "../lib/claude-usage.ts";

const NOW = Date.parse("2026-10-08T10:00:00Z");

// Trimmed copy of a real /api/oauth/usage answer: codename buckets the meter
// does not know about stay null and must be ignored.
const PAYLOAD = {
	five_hour: { utilization: 8.0, resets_at: "2026-10-08T12:39:59.638246+00:00" },
	seven_day: { utilization: 41.5, resets_at: "2026-10-12T15:00:00+00:00" },
	seven_day_opus: null,
	seven_day_sonnet: { utilization: 12, resets_at: "2026-10-12T15:00:00+00:00" },
	iguana_necktie: null,
	extra_usage: { is_enabled: false },
};

function credentialsJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: "secret-token",
			refreshToken: "refresh-token",
			expiresAt: NOW + 60_000,
			subscriptionType: "team",
			...overrides,
		},
	});
}

test("parses the 5h and weekly windows into the main claude limit", () => {
	const usage = parseClaudeUsage(PAYLOAD, NOW, "team");
	assert.equal(usage.provider, CLAUDE_BRIDGE_PROVIDER);
	assert.equal(usage.plan, "team");
	assert.equal(usage.fetchedAt, NOW);
	assert.deepEqual(usage.limits[0], {
		name: "claude",
		limitReached: false,
		windows: [
			{ label: "5h", usedPercent: 8, windowSeconds: 18_000, resetAt: Date.parse("2026-10-08T12:39:59.638246+00:00") },
			{ label: "week", usedPercent: 41.5, windowSeconds: 604_800, resetAt: Date.parse("2026-10-12T15:00:00+00:00") },
		],
	});
});

test("adds per-model weekly limits only when the endpoint reports them", () => {
	const usage = parseClaudeUsage(PAYLOAD, NOW, undefined);
	assert.deepEqual(
		usage.limits.map((limit) => limit.name),
		["claude", "sonnet"],
	);
	assert.equal(usage.plan, undefined);
});

test("keeps a lone 5h window when the weekly bucket is null", () => {
	const usage = parseClaudeUsage({ five_hour: PAYLOAD.five_hour, seven_day: null }, NOW, "team");
	assert.equal(usage.limits.length, 1);
	assert.deepEqual(
		usage.limits[0].windows.map((window) => window.label),
		["5h"],
	);
});

test("clamps out-of-range utilization and flags a reached limit", () => {
	const usage = parseClaudeUsage({ five_hour: { utilization: 130, resets_at: null }, seven_day: { utilization: -4 } }, NOW, undefined);
	const [fiveHour, week] = usage.limits[0].windows;
	assert.equal(fiveHour.usedPercent, 100);
	assert.equal(fiveHour.resetAt, null);
	assert.equal(week.usedPercent, 0);
	assert.equal(usage.limits[0].limitReached, true);
});

test("degrades unknown or malformed shapes to empty limits instead of throwing", () => {
	for (const payload of [null, undefined, "nope", 42, [], {}, { five_hour: "x" }, { five_hour: { utilization: "8" } }, { five_hour: { utilization: Number.NaN } }]) {
		assert.deepEqual(parseClaudeUsage(payload, NOW, undefined).limits, [], `payload ${JSON.stringify(payload)}`);
	}
});

test("ignores an unparseable reset time but keeps the window", () => {
	const usage = parseClaudeUsage({ five_hour: { utilization: 5, resets_at: "not a date" } }, NOW, undefined);
	assert.equal(usage.limits[0].windows[0].resetAt, null);
});

test("resolves the credentials file from CLAUDE_CONFIG_DIR, else ~/.claude", () => {
	assert.equal(credentialsPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u"), "/cfg/.credentials.json");
	assert.equal(credentialsPath({}, "/home/u"), "/home/u/.claude/.credentials.json");
});

test("reads a valid unexpired token and the subscription type", async () => {
	const creds = await readClaudeCredentials(async () => credentialsJson(), "/x", NOW);
	assert.deepEqual(creds, { accessToken: "secret-token", plan: "team" });
});

test("refuses expired, missing, or malformed credentials without throwing", async () => {
	const cases: Array<() => Promise<string>> = [
		async () => credentialsJson({ expiresAt: NOW - 1 }),
		async () => credentialsJson({ accessToken: "" }),
		async () => credentialsJson({ accessToken: 7 }),
		async () => JSON.stringify({}),
		async () => "{not json",
		async () => {
			throw new Error("ENOENT");
		},
	];
	for (const read of cases) assert.equal(await readClaudeCredentials(read, "/x", NOW), undefined);
});

test("accepts credentials without expiresAt (Claude Code refreshes them itself)", async () => {
	const creds = await readClaudeCredentials(async () => credentialsJson({ expiresAt: undefined }), "/x", NOW);
	assert.equal(creds?.accessToken, "secret-token");
});

function recordingFetch(response: { ok: boolean; body?: unknown } | Error) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		if (response instanceof Error) throw response;
		return { ok: response.ok, json: async () => response.body } as Response;
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

test("fetches the fixed usage endpoint with bearer auth, the oauth beta, no redirects, no cache", async () => {
	const { calls, fetchFn } = recordingFetch({ ok: true, body: PAYLOAD });
	const usage = await fetchClaudeUsage({ accessToken: "secret-token", plan: "team" }, fetchFn, NOW);
	assert.equal(usage?.limits[0].windows[0].usedPercent, 8);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, CLAUDE_USAGE_URL);
	assert.equal(calls[0].init.redirect, "error");
	assert.equal(calls[0].init.cache, "no-store");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer secret-token");
	assert.equal(headers["anthropic-beta"], CLAUDE_USAGE_BETA);
});

test("returns undefined on HTTP errors, network errors, and window-less payloads", async () => {
	for (const response of [{ ok: false, body: PAYLOAD }, new Error("offline"), { ok: true, body: { five_hour: null } }]) {
		const { fetchFn } = recordingFetch(response);
		assert.equal(await fetchClaudeUsage({ accessToken: "t", plan: undefined }, fetchFn, NOW), undefined);
	}
});

test("loadClaudeUsage never calls the network without a usable token", async () => {
	const { calls, fetchFn } = recordingFetch({ ok: true, body: PAYLOAD });
	const usage = await loadClaudeUsage(async () => credentialsJson({ expiresAt: NOW - 1 }), "/x", fetchFn, NOW);
	assert.equal(usage, undefined);
	assert.equal(calls.length, 0);
});

test("loadClaudeUsage reads the token and returns the parsed usage", async () => {
	const { calls, fetchFn } = recordingFetch({ ok: true, body: PAYLOAD });
	const usage = await loadClaudeUsage(async () => credentialsJson(), "/x", fetchFn, NOW);
	assert.equal(usage?.plan, "team");
	assert.equal(calls.length, 1);
});

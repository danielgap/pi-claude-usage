import assert from "node:assert/strict";
import { test } from "node:test";
import { registerUsageSource, USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "../extensions/claude_usage.ts";
import { CLAUDE_BRIDGE_PROVIDER, CLAUDE_PENDING_NOTE } from "../lib/claude-usage.ts";

const NOW = Date.parse("2026-10-08T10:00:00Z");

function capture() {
	const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
	return { emitted, bus: { emit: (channel: string, payload: unknown) => emitted.push({ channel, payload: payload as Record<string, unknown> }) } };
}

test("registers claude-bridge on the gentle-shell usage-source contract", () => {
	const { emitted, bus } = capture();
	registerUsageSource(bus, { readFile: async () => "{}", path: "/x" });
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0].channel, USAGE_SOURCE_EVENT);
	assert.equal(emitted[0].payload.schema, USAGE_SOURCE_SCHEMA);
	assert.equal(emitted[0].payload.provider, CLAUDE_BRIDGE_PROVIDER);
	assert.equal(emitted[0].payload.pendingNote, CLAUDE_PENDING_NOTE);
	assert.equal(typeof emitted[0].payload.fetch, "function");
});

test("the registered fetch ignores the shell's api key and uses the Claude Code token", async () => {
	const { emitted, bus } = capture();
	const credentials = JSON.stringify({ claudeAiOauth: { accessToken: "cc-token", expiresAt: NOW + 60_000, subscriptionType: "team" } });
	registerUsageSource(bus, { readFile: async () => credentials, path: "/x" });
	const seen: string[] = [];
	const fetchFn = (async (_url: string, init: RequestInit) => {
		seen.push((init.headers as Record<string, string>).Authorization);
		return { ok: true, json: async () => ({ five_hour: { utilization: 3, resets_at: null } }) } as Response;
	}) as unknown as typeof fetch;
	const fetchSource = emitted[0].payload.fetch as (key: string | undefined, f: typeof fetch, now: number) => Promise<unknown>;
	const usage = (await fetchSource("bridge-placeholder-key", fetchFn, NOW)) as { provider: string; plan: string };
	assert.deepEqual(seen, ["Bearer cc-token"]);
	assert.equal(usage.provider, CLAUDE_BRIDGE_PROVIDER);
	assert.equal(usage.plan, "team");
});

test("the registered fetch resolves undefined, never throws, when credentials are unreadable", async () => {
	const { emitted, bus } = capture();
	registerUsageSource(bus, {
		readFile: async () => {
			throw new Error("EACCES");
		},
		path: "/x",
	});
	const fetchSource = emitted[0].payload.fetch as (key: string | undefined, f: typeof fetch, now: number) => Promise<unknown>;
	assert.equal(await fetchSource(undefined, fetch, NOW), undefined);
});

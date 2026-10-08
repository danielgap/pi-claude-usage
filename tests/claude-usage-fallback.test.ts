// Standalone-fallback behavior of the extension factory: the status-bar
// segment, the /claude:usage command, and retirement on gentle-shell's
// usage-source ack. Mirrors the harness of pi-zai-usage's ack tests; the
// differences are credential injection (Claude Code's credentials file
// instead of the model registry) and the single claude-bridge provider.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import claudeUsageExtension, {
	USAGE_SOURCE_ACK_EVENT,
	USAGE_SOURCE_ACK_SCHEMA,
	USAGE_SOURCE_EVENT,
	type ClaudeUsageDeps,
} from "../extensions/claude_usage.ts";
import {
	CLAUDE_BRIDGE_PROVIDER,
	parseClaudeUsage,
	plainTheme,
	renderUsageBar,
} from "../lib/claude-usage.ts";

const NOW = Date.parse("2026-10-08T10:00:00Z");
// The setStatus key is the segment's public contract (pi's status bar), not
// an export; it is spelled out here so a silent rename breaks loudly.
const STATUS_KEY = "claude-usage";
const ACK = { schema: USAGE_SOURCE_ACK_SCHEMA, provider: CLAUDE_BRIDGE_PROVIDER };
const USAGE_PAYLOAD = {
	five_hour: { utilization: 43, resets_at: null },
	seven_day: { utilization: 12, resets_at: null },
};
const CREDENTIALS = JSON.stringify({
	claudeAiOauth: {
		accessToken: "cc-token",
		expiresAt: NOW + 3_600_000,
		subscriptionType: "team",
	},
});

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string | undefined, ctx: ExtensionContext) => unknown;
type StatusCall = { key: string; text: string | undefined };

// A minimal ExtensionAPI double: the factory only registers lifecycle
// handlers, one command, and bus listeners. Ack events are delivered through
// harness.emit, the way gentle-shell emits USAGE_SOURCE_ACK_EVENT back.
function fakePi() {
	const lifecycle = new Map<string, LifecycleHandler>();
	const commands = new Map<string, { handler: CommandHandler }>();
	const busListeners = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
	const api = {
		on(event: string, handler: LifecycleHandler) {
			lifecycle.set(event, handler);
			return () => {};
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command);
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				const list = busListeners.get(channel) ?? [];
				list.push(handler);
				busListeners.set(channel, list);
				return () => {};
			},
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload: payload as Record<string, unknown> });
			},
		},
	};
	return {
		pi: api as unknown as ExtensionAPI,
		lifecycle,
		commands,
		emitted,
		emit(channel: string, payload: unknown) {
			for (const listener of busListeners.get(channel) ?? []) listener(payload);
		},
	};
}

function fakeCtx(provider: string = CLAUDE_BRIDGE_PROVIDER) {
	const statusCalls: StatusCall[] = [];
	const notifications: string[] = [];
	const customCalls: string[] = [];
	const ctx = {
		hasUI: true,
		model: { provider },
		ui: {
			setStatus(key: string, text: string | undefined) {
				statusCalls.push({ key, text });
			},
			notify(message: string, _level?: string) {
				notifications.push(message);
			},
			async custom(_factory: unknown, options: unknown) {
				customCalls.push(String((options as { overlay?: boolean })?.overlay ?? false));
				return null;
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContext, statusCalls, notifications, customCalls };
}

// Injected dependencies: the credentials file and the usage endpoint are
// stubbed, so no test touches the filesystem or the network.
function deps(usagePayload: unknown = USAGE_PAYLOAD, fetches?: { count: number }): ClaudeUsageDeps {
	return {
		credentials: { readFile: async () => CREDENTIALS, path: "/x" },
		fetchFn: (async () => {
			if (fetches) fetches.count += 1;
			return { ok: usagePayload !== null, json: async () => usagePayload } as Response;
		}) as typeof fetch,
		now: () => NOW,
	};
}

function segment(statusCalls: StatusCall[]): string | undefined {
	return statusCalls.findLast((call) => call.key === STATUS_KEY)?.text;
}

// session_start starts the refresh interval, so every test shuts the session
// down again or the timer holds the test runner open.
async function withSession(
	harness: ReturnType<typeof fakePi>,
	ctx: ExtensionContext,
	run: () => Promise<void>,
): Promise<void> {
	await harness.lifecycle.get("session_start")?.(undefined, ctx);
	try {
		await run();
	} finally {
		await harness.lifecycle.get("session_shutdown")?.(undefined, ctx);
	}
}

test("the mirrored ack constants are exactly gentle-shell's versioned contract", () => {
	assert.equal(USAGE_SOURCE_ACK_EVENT, "gentle-pi:usage-source-ack/v1");
	assert.equal(USAGE_SOURCE_ACK_SCHEMA, "gentle-pi.usage-source-ack/v1");
});

test("the standalone segment renders on session_start when the bridge provider is active", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		assert.equal(segment(statusCalls), "claude 5h ▰▰▰▱▱▱▱▱ 43% · week 12%");
	});
});

test("an ack for claude-bridge retires the rendered standalone segment", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		assert.match(segment(statusCalls) ?? "", /43%/, "the segment renders before any ack");
		harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
		assert.equal(segment(statusCalls), undefined, "the ack repaints the segment away");
	});
});

test("an ack that arrives before the first fetch keeps the segment from ever rendering", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
	await withSession(harness, ctx, async () => {
		assert.ok(statusCalls.length > 0, "paint still runs, it just has nothing to show");
		for (const call of statusCalls) assert.equal(call.text, undefined);
	});
});

test("an ack for a foreign provider is ignored", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		harness.emit(USAGE_SOURCE_ACK_EVENT, { schema: USAGE_SOURCE_ACK_SCHEMA, provider: "zai" });
		assert.match(segment(statusCalls) ?? "", /43%/, "a foreign ack must not retire the claude segment");
	});
});

test("malformed ack payloads are ignored without throwing", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		for (const payload of [
			undefined,
			null,
			"ack",
			7,
			{},
			{ schema: USAGE_SOURCE_ACK_SCHEMA },
			{ provider: CLAUDE_BRIDGE_PROVIDER },
			{ schema: "gentle-pi.usage-source/v1", provider: CLAUDE_BRIDGE_PROVIDER },
		]) {
			harness.emit(USAGE_SOURCE_ACK_EVENT, payload);
		}
		assert.match(segment(statusCalls) ?? "", /43%/, "none of those is an ack for claude-bridge");
	});
});

test("a repeated ack is idempotent: the segment stays retired and nothing throws", async () => {
	const harness = fakePi();
	const { ctx, statusCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		assert.match(segment(statusCalls) ?? "", /43%/);
		const afterFetch = statusCalls.length;
		harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
		harness.emit(USAGE_SOURCE_ACK_EVENT, { schema: USAGE_SOURCE_ACK_SCHEMA, provider: CLAUDE_BRIDGE_PROVIDER });
		const repaints = statusCalls.slice(afterFetch);
		assert.ok(repaints.length > 0, "each ack repaints once");
		for (const call of repaints) {
			assert.equal(call.key, STATUS_KEY);
			assert.equal(call.text, undefined, "no repaint ever brings the segment back");
		}
		assert.equal(segment(statusCalls), undefined);
	});
});

test("/claude:usage off hides the segment, on brings it back", async () => {
	const harness = fakePi();
	const { ctx, statusCalls, notifications, customCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		await harness.commands.get("claude:usage")?.handler("off", ctx);
		assert.equal(segment(statusCalls), undefined, "off repaints the segment away");
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /claude usage status hidden/);
		await harness.commands.get("claude:usage")?.handler("on", ctx);
		assert.match(segment(statusCalls) ?? "", /43%/, "on restores the standalone segment");
		assert.equal(customCalls.length, 1, "on still opens the documented panel");
	});
});

test("/claude:usage on under a natively metered provider notifies, keeps the segment retired, and still opens the panel", async () => {
	const harness = fakePi();
	const { ctx, statusCalls, notifications, customCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	harness.emit(USAGE_SOURCE_ACK_EVENT, ACK);
	await withSession(harness, ctx, async () => {
		await harness.commands.get("claude:usage")?.handler("on", ctx);
		assert.equal(segment(statusCalls), undefined, "the segment stays retired");
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /gentle-shell meters claude-bridge usage natively/);
		assert.equal(customCalls.length, 1, "the documented refresh-and-panel contract still runs");
		assert.equal(customCalls[0], "true", "the panel opens as an overlay");
	});
});

test("a non-bridge provider paints nothing, fetches nothing, and the command explains it", async () => {
	const harness = fakePi();
	const fetches = { count: 0 };
	const { ctx, statusCalls, notifications, customCalls } = fakeCtx("zai");
	claudeUsageExtension(harness.pi, deps(USAGE_PAYLOAD, fetches));
	await withSession(harness, ctx, async () => {
		assert.equal(segment(statusCalls), undefined);
		assert.equal(fetches.count, 0, "no usage fetch without the bridge provider");
		await harness.commands.get("claude:usage")?.handler(undefined, ctx);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /needs the claude-bridge provider active/);
		assert.equal(customCalls.length, 0);
	});
});

test("a failed fetch announced through the command warns instead of throwing", async () => {
	const harness = fakePi();
	const { ctx, statusCalls, notifications, customCalls } = fakeCtx();
	claudeUsageExtension(harness.pi, deps(null));
	await withSession(harness, ctx, async () => {
		await harness.commands.get("claude:usage")?.handler(undefined, ctx);
		assert.equal(segment(statusCalls), undefined);
		assert.equal(notifications.length, 1);
		assert.match(notifications[0], /claude usage unavailable/);
		assert.equal(customCalls.length, 0, "no panel without usage");
	});
});

test("session_start still registers the usage source on the bus", async () => {
	const harness = fakePi();
	const { ctx } = fakeCtx();
	claudeUsageExtension(harness.pi, deps());
	await withSession(harness, ctx, async () => {
		const registration = harness.emitted.find((emission) => emission.channel === USAGE_SOURCE_EVENT);
		assert.ok(registration, "the usage-source registration is still emitted");
		assert.equal(registration.payload.provider, CLAUDE_BRIDGE_PROVIDER);
	});
});

test("renderUsageBar gauges the first window and keeps the rest compact", () => {
	const usage = parseClaudeUsage(USAGE_PAYLOAD, NOW, "team");
	assert.equal(renderUsageBar(usage, plainTheme), "claude 5h ▰▰▰▱▱▱▱▱ 43% · week 12%");
});

test("renderUsageBar returns undefined when the payload had no windows", () => {
	assert.equal(renderUsageBar(parseClaudeUsage({}, NOW, undefined), plainTheme), undefined);
});

test("a percentage above 100 clamps to a full gauge", () => {
	const usage = parseClaudeUsage({ five_hour: { utilization: 250, resets_at: null } }, NOW, undefined);
	assert.equal(renderUsageBar(usage, plainTheme), "claude 5h ▰▰▰▰▰▰▰▰ 100%");
});

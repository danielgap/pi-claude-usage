// Claude subscriptions overlay: a framed panel over the usage store, ported
// from pi-zai-usage's lib/zai-usage-view.ts (itself ported from gentle-pi's
// lib/shell-usage-view.ts) so /claude:usage shows exactly what /gentle:usage
// shows. It reads the usage on every render, so a refresh only needs to
// record. Escape detection delegates to pi-tui's matchesKey — the same
// matcher the ported panel uses — because terminals with the Kitty keyboard
// protocol or xterm modifyOtherKeys active never send a bare 0x1b for the
// escape key (they send CSI 27 u style sequences instead).

import { Key, matchesKey } from "@earendil-works/pi-tui";

import {
	ACTIVE_MARK,
	clipToWidth,
	renderUsagePanel,
	visibleWidth,
	type ActiveProvider,
	type ProviderUsage,
	type UsageTheme,
} from "./claude-usage.ts";

export interface UsageViewDeps {
	theme: UsageTheme;
	now(): number;
	usage(): ProviderUsage | undefined;
	active(): ActiveProvider | undefined;
	onRefresh(): Promise<void>;
	onClose(): void;
	requestRender(): void;
}

const TITLE = `${ACTIVE_MARK} Subscriptions`;
const REFRESHING = `${ACTIVE_MARK} Subscriptions · refreshing…`;
const FRAME_ROLE = "border";
const TITLE_ROLE = "customMessageLabel";
const KEY_ROLE = "accent";
const KEY_TEXT_ROLE = "dim";
const KEYS = [
	["r", "refresh"],
	["esc", "close"],
] as const;

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function fit(text: string, width: number): string {
	const clipped = clipToWidth(text, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class ClaudeUsageView {
	private readonly deps: UsageViewDeps;
	private refreshing = false;

	constructor(deps: UsageViewDeps) {
		this.deps = deps;
	}

	handleInput(data: string): void {
		// matchesKey covers every escape encoding pi-tui accepts: the bare
		// \x1b byte, Kitty CSI-u sequences, and xterm modifyOtherKeys.
		if (matchesKey(data, Key.escape) || data === "q") {
			this.deps.onClose();
			return;
		}
		if (data === "r" && !this.refreshing) {
			this.refreshing = true;
			this.deps.requestRender();
			void this.deps.onRefresh().finally(() => {
				this.refreshing = false;
				this.deps.requestRender();
			});
		}
	}

	render(width: number): string[] {
		const theme = this.deps.theme;
		const inner = width - 2;
		const title = this.refreshing ? REFRESHING : TITLE;
		const top = theme.fg(FRAME_ROLE, "╭─ ") + theme.fg(TITLE_ROLE, title) + theme.fg(FRAME_ROLE, ` ${rule(inner - visibleWidth(title) - 3)}╮`);
		const usage = this.deps.usage();
		const body = renderUsagePanel(usage ? [usage] : [], theme, inner - 2, this.deps.now(), this.deps.active()).map(
			(line) => `${theme.fg(FRAME_ROLE, "│")} ${fit(line, inner - 2)} ${theme.fg(FRAME_ROLE, "│")}`,
		);
		const keys = KEYS.map(([key, label]) => `${theme.fg(KEY_ROLE, key)} ${theme.fg(KEY_TEXT_ROLE, label)}`).join("   ");
		const keysLine = `${theme.fg(FRAME_ROLE, "│")} ${fit(keys, inner - 2)} ${theme.fg(FRAME_ROLE, "│")}`;
		const bottom = theme.fg(FRAME_ROLE, `╰${rule(inner)}╯`);
		return [top, ...body, keysLine, bottom];
	}

	invalidate(): void {}
}

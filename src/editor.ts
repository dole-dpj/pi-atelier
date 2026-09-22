import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** │ + padding on each side. */
export const EDITOR_FRAME_CHROME = 4;
export const EDITOR_FRAME_MIN_WIDTH = 6;

const RULE_PATTERN = /^─+(?: [↑↓] \d+ more ─*)?(?:\.{0,3})?$/;

export function isEditorRuleText(plain: string): boolean {
	return plain.length > 0 && RULE_PATTERN.test(plain);
}

function padToVisible(text: string, width: number): string {
	const current = visibleWidth(text);
	if (current === width) return text;
	if (current > width) return truncateToWidth(text, width, "");
	return `${text}${" ".repeat(width - current)}`;
}

function expandRule(line: string, width: number): string {
	const plain = stripTerminalSequences(line);
	const body = isEditorRuleText(plain) ? plain : "─".repeat(Math.max(0, visibleWidth(plain)));
	if (visibleWidth(body) >= width) return padToVisible(body, width);
	return `${body}${"─".repeat(width - visibleWidth(body))}`;
}

function findBottomRuleIndex(lines: readonly string[], innerWidth: number): number {
	for (let index = lines.length - 1; index >= 1; index -= 1) {
		const line = lines[index];
		if (!line) continue;
		const plain = stripTerminalSequences(line);
		if (visibleWidth(plain) === innerWidth && isEditorRuleText(plain)) return index;
	}
	return Math.max(0, lines.length - 1);
}

function framedRule(
	innerRule: string,
	outerBodyWidth: number,
	leftCap: string,
	rightCap: string,
	borderColor: (text: string) => string,
): string {
	return borderColor(`${leftCap}${expandRule(innerRule, outerBodyWidth)}${rightCap}`);
}

function framedRow(line: string, innerWidth: number, borderColor: (text: string) => string): string {
	return `${borderColor("│")} ${padToVisible(line, innerWidth)} ${borderColor("│")}`;
}

/** Wrap Pi editor lines in a rounded frame with one column of inner padding. */
export function frameEditorLines(
	inner: readonly string[],
	width: number,
	borderColor: (text: string) => string,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	if (safeWidth < EDITOR_FRAME_MIN_WIDTH || inner.length === 0) {
		return inner.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	const innerWidth = safeWidth - EDITOR_FRAME_CHROME;
	const outerBodyWidth = safeWidth - 2;
	const bottom = findBottomRuleIndex(inner, innerWidth);
	const topRule = inner[0] ?? "─".repeat(innerWidth);
	const bottomRule = inner[bottom] ?? "─".repeat(innerWidth);
	const framed: string[] = [framedRule(topRule, outerBodyWidth, "╭", "╮", borderColor)];

	for (let index = 1; index < bottom; index += 1) {
		framed.push(framedRow(inner[index] ?? "", innerWidth, borderColor));
	}
	for (let index = bottom + 1; index < inner.length; index += 1) {
		framed.push(framedRow(inner[index] ?? "", innerWidth, borderColor));
	}

	framed.push(framedRule(bottomRule, outerBodyWidth, "╰", "╯", borderColor));
	return framed.map((line) => truncateToWidth(line, safeWidth, ""));
}

/** Pi composer with Atelier's rounded frame. Preserves thinking-level borderColor. */
export class AtelierEditor extends CustomEditor {
	private mouseLayout: { width: number; height: number; bottom: number } | undefined;
	private previousCursorVisibility: boolean | undefined;
	private disposed = false;

	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		let focused = this.focused;
		// Pi exposes focus as an instance field, so intercept assignments rather than
		// overriding it with a prototype accessor (which the base field would shadow).
		Object.defineProperty(this, "focused", {
			configurable: true,
			enumerable: true,
			get: () => focused,
			set: (value: boolean) => {
				const next = value && !this.disposed;
				if (next === focused) return;
				focused = next;
				if (next) {
					this.previousCursorVisibility = this.tui.getShowHardwareCursor();
					// DECSCUSR 5 = BlinkingBar. Blink cadence/fading is terminal-owned.
					this.tui.terminal.write("\u001b[5 q");
					this.tui.setShowHardwareCursor(true);
				} else {
					this.restoreCursor();
				}
			},
		});
	}

	private restoreCursor(): void {
		const previous = this.previousCursorVisibility;
		this.previousCursorVisibility = undefined;
		if (previous === undefined) return;
		try {
			this.tui.terminal.write("\u001b[0 q");
		} finally {
			this.tui.setShowHardwareCursor(previous);
		}
	}

	dispose(): void {
		this.disposed = true;
		this.focused = false;
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(0, Math.trunc(width));
		const framed = safeWidth >= EDITOR_FRAME_MIN_WIDTH;
		const innerWidth = framed ? safeWidth - EDITOR_FRAME_CHROME : safeWidth;
		const inner = super.render(innerWidth);
		const bottom = findBottomRuleIndex(inner, innerWidth);
		this.mouseLayout = { width: safeWidth, height: inner.length, bottom };
		// Keep Pi's cursor marker and underlying grapheme (including the end-of-line
		// space), but remove its software block. Do not touch autocomplete styling.
		for (let index = 1; index < bottom; index += 1) {
			inner[index] = (inner[index] ?? "").replace(/\u001b\[7m(.*?)\u001b\[0m/, "$1");
		}
		return framed ? frameEditorLines(inner, safeWidth, this.borderColor) : inner;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const layout = this.mouseLayout;
		if (this.disposed || !layout) return undefined;
		if (layout.width < EDITOR_FRAME_MIN_WIDTH) return super.handleMouse(event);
		if (event.x < 1 || event.x >= layout.width - 1 || event.y < 1 || event.y >= layout.height - 1) {
			return undefined;
		}
		// Framing adds two columns on the left and moves Pi's bottom rule below
		// autocomplete. Delegate text/grapheme/scroll hit-testing to Pi unchanged.
		return super.handleMouse({
			...event,
			x: Math.max(0, event.x - 2),
			y: event.y >= layout.bottom ? event.y + 1 : event.y,
			width: layout.width - EDITOR_FRAME_CHROME,
			height: layout.height,
		});
	}
}

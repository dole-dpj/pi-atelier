import {
	CURSOR_MARKER,
	stripTerminalSequences,
	TuiAltScreen,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AtelierEditor } from "../src/editor.js";

const plain = (text: string) => text;

function harness(width = 40, rows = 24, showHardwareCursor = false) {
	let input: ((data: string) => void) | undefined;
	const terminal = {
		columns: width,
		rows,
		write: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
		start: vi.fn((onInput: (data: string) => void) => {
			input = onInput;
		}),
		stop: vi.fn(),
	};
	const tui = new TuiAltScreen(terminal as never, showHardwareCursor);
	tui.requestRender = vi.fn();
	const editor = new AtelierEditor(
		tui,
		{
			borderColor: plain,
			selectList: {
				selectedPrefix: plain,
				selectedText: plain,
				description: plain,
				scrollInfo: plain,
				noMatch: plain,
			},
		},
		{ matches: () => false } as never,
	);
	const render = () => editor.render(width);
	const mouse = (x: number, y: number, overrides: Partial<TuiMouseEvent> = {}) =>
		editor.handleMouse({
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width,
			height: render().length,
			shift: false,
			alt: false,
			ctrl: false,
			...overrides,
		});
	return { editor, tui, terminal, render, mouse, send: (data: string) => input?.(data) };
}

describe("composer mouse positioning", () => {
	it("accounts for the frame and inserts at the clicked position without changing text on click", () => {
		const h = harness();
		h.editor.setText("hello world");
		const onChange = vi.fn();
		h.editor.onChange = onChange;
		expect(h.mouse(4, 1)).toMatchObject({ handled: true, focus: true });
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 2 });
		expect(onChange).not.toHaveBeenCalled();
		h.editor.handleInput("X");
		expect(h.editor.getText()).toBe("heXllo world");
	});

	it("accounts for Pi editor padding in addition to the frame", () => {
		const h = harness();
		h.editor.setPaddingX(2);
		h.editor.setText("hello");
		h.mouse(5, 1);
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 1 });
		h.mouse(1, 1);
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 0 });
		h.mouse(38, 1);
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 5 });
	});

	it("maps soft-wrapped rows to logical text positions", () => {
		const h = harness(10);
		h.editor.setText("abcdefghijk");
		h.mouse(4, 2);
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 7 });
	});

	it("positions within the visible portion of a scrolled multiline draft", () => {
		const h = harness();
		h.editor.setText(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
		expect(stripTerminalSequences(h.render()[0] ?? "")).toContain("↑ 5 more");
		h.mouse(4, 1);
		expect(h.editor.getCursor()).toEqual({ line: 5, col: 2 });
	});

	it.each([
		[4, 1],
		[5, 2],
		[6, 4],
		[7, 4],
		[8, 9],
	])("keeps CJK, combining marks and emoji atomic at column %i", (x, col) => {
		const h = harness();
		h.editor.setText("A你e\u0301👩‍💻Z");
		h.mouse(x, 1);
		expect(h.editor.getCursor()).toEqual({ line: 0, col });
	});

	it.each([
		[0, 1],
		[39, 1],
		[5, 0],
		[5, 2],
	])("ignores the outer frame at (%i, %i)", (x, y) => {
		const h = harness();
		h.editor.setText("hello");
		expect(h.mouse(x, y)).toBeUndefined();
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 5 });
	});

	it.each(["press", "drag", "release", "move", "wheel"] as const)(
		"leaves %s to Pi selection and scrolling",
		(type) => {
			const h = harness();
			h.editor.setText("hello");
			expect(h.mouse(4, 1, { type })).toBeUndefined();
			expect(h.editor.getCursor()).toEqual({ line: 0, col: 5 });
		},
	);

	it("ignores non-primary clicks and supports an empty draft", () => {
		const h = harness();
		expect(h.mouse(4, 1, { button: "right" })).toBeUndefined();
		expect(h.mouse(4, 1)).toMatchObject({ handled: true, focus: true });
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 0 });
	});

	it("uses unframed coordinates below the minimum frame width", () => {
		const h = harness(5);
		h.editor.setText("abc");
		h.mouse(1, 1);
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 1 });
	});

	it("maps autocomplete rows moved inside the frame back to Pi's picker", async () => {
		const h = harness();
		const applyCompletion = vi.fn((_lines, _line, _col, item) => ({
			lines: [item.value],
			cursorLine: 0,
			cursorCol: item.value.length,
		}));
		h.editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				prefix: "/",
				items: [
					{ value: "/alpha", label: "alpha" },
					{ value: "/beta", label: "beta" },
				],
			}),
			applyCompletion,
		});
		h.editor.handleInput("/");
		await vi.waitFor(() => expect(h.editor.isShowingAutocomplete()).toBe(true));
		const lines = h.render();
		const betaRow = lines.findIndex((line) => stripTerminalSequences(line).includes("beta"));
		expect(betaRow).toBeGreaterThan(1);
		h.mouse(4, betaRow);
		expect(applyCompletion).toHaveBeenCalledOnce();
		expect(h.editor.getText()).toBe("/beta");
	});

	it("routes actual fullscreen press/release reports to the framed editor", () => {
		const h = harness();
		h.editor.setText("hello world");
		h.tui.addChild({ render: () => ["heading", ""], invalidate() {} });
		h.tui.addChild(h.editor);
		h.tui.setFocus(h.editor);
		h.tui.start();
		try {
			h.tui.renderNow();
			// SGR coordinates are one-based and include the two rows above the editor.
			h.send("\u001b[<0;5;4M");
			h.send("\u001b[<0;5;4m");
			expect(h.editor.getCursor()).toEqual({ line: 0, col: 2 });
			h.terminal.write.mockClear();
			h.tui.renderNow();
			expect(h.terminal.write.mock.calls.flat().join("")).toContain("\u001b[4;5H\u001b[?25h");
			h.send("X");
			expect(h.editor.getText()).toBe("heXllo world");
		} finally {
			h.tui.setFocus(null);
			h.tui.stop();
		}
	});
});

describe("composer BlinkingBar cursor", () => {
	it("enables the hardware bar on focus and preserves the cursor marker without a fake block", () => {
		const h = harness();
		expect(h.terminal.write).not.toHaveBeenCalled();
		h.editor.setText("hello");
		h.tui.setFocus(h.editor);
		expect(h.tui.getShowHardwareCursor()).toBe(true);
		expect(h.terminal.write).toHaveBeenCalledWith("\u001b[5 q");
		h.mouse(4, 1);
		const line = h.render()[1] ?? "";
		expect(line).toContain(`he${CURSOR_MARKER}llo`);
		expect(line).not.toContain("\u001b[7m");
		expect(visibleWidth(line)).toBe(40);
		h.tui.setFocus(null);
	});

	it.each([false, true])("restores cursor visibility %s when focus moves to a dialog", (previous) => {
		const h = harness(40, 24, previous);
		h.tui.setFocus(h.editor);
		h.terminal.write.mockClear();
		h.render();
		h.render();
		expect(h.terminal.write).not.toHaveBeenCalled();
		h.tui.setFocus({ render: () => ["dialog"], invalidate() {} });
		expect(h.tui.getShowHardwareCursor()).toBe(previous);
		expect(h.terminal.write).toHaveBeenLastCalledWith("\u001b[0 q");
		expect(h.render().join("\n")).not.toContain(CURSOR_MARKER);
		expect(h.render().join("\n")).not.toContain("\u001b[7m");
		h.tui.setFocus(h.editor);
		expect(h.terminal.write).toHaveBeenLastCalledWith("\u001b[5 q");
		h.tui.setFocus(null);
	});

	it("restores the terminal once on disposal and cannot reacquire the cursor afterwards", () => {
		const h = harness();
		h.tui.setFocus(h.editor);
		h.editor.dispose();
		expect(h.tui.getShowHardwareCursor()).toBe(false);
		expect(h.terminal.write).toHaveBeenLastCalledWith("\u001b[0 q");
		h.terminal.write.mockClear();
		h.editor.dispose();
		h.tui.setFocus(null);
		h.tui.setFocus(h.editor);
		expect(h.terminal.write).not.toHaveBeenCalled();
		expect(h.tui.getShowHardwareCursor()).toBe(false);
	});
});

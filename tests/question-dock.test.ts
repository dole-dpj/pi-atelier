import { ScrollView, TuiAltScreen, type TUI, VStack } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createQuestionDock } from "../src/question-dock.js";
import { createSplitPaneController } from "../src/split-pane.js";

function createHarness(
	options: {
		inputRequested?: boolean;
		sidebar?: boolean;
		questionRows?: number;
		composerRows?: number;
		wheelLines?: number;
	} = {},
) {
	let input: ((data: string) => void) | undefined;
	const terminal = {
		columns: 120,
		rows: 30,
		write: vi.fn(),
		start: (onInput: (data: string) => void) => {
			input = onInput;
		},
		stop: vi.fn(),
		hideCursor: vi.fn(),
		showCursor: vi.fn(),
	};
	const renderer = new TuiAltScreen(terminal as never, false, undefined, {
		wheelScrollLines: options.wheelLines ?? 1,
	});
	// Match Pi's stable TUI reference: methods are dynamically forwarded, not bound.
	const tui = new Proxy({} as TUI, {
		get: (_target, property) => {
			const value = Reflect.get(renderer, property, renderer);
			return typeof value === "function"
				? (...args: unknown[]) => Reflect.apply(Reflect.get(renderer, property, renderer), renderer, args)
				: value;
		},
		set: (_target, property, value) => Reflect.set(renderer, property, value, renderer),
		getPrototypeOf: () => Reflect.getPrototypeOf(renderer),
	});
	const transcript = new ScrollView(
		{
			render: () => Array.from({ length: 100 }, (_, i) => `Transcript ${i}`),
			invalidate() {},
		},
		{ primary: true, follow: "end" },
	);
	renderer.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1 },
			{
				component: { render: () => Array(options.composerRows ?? 0).fill("COMPOSER"), invalidate() {} },
				shrink: 0,
			},
		]),
	);
	renderer.start();
	const split = createSplitPaneController({ isInputRequested: () => options.inputRequested ?? true });
	split.attach(tui);
	if (options.sidebar !== false) {
		split.show();
		tui.showOverlay({ render: () => ["SIDEBAR"], invalidate() {} }, split.overlayOptions());
	}
	const handleInput = vi.fn();
	let questionLines: string[] = [];
	const question = tui.showOverlay(
		{
			render: () => {
				const rows = Math.min(options.questionRows ?? tui.terminal.rows, tui.terminal.rows);
				questionLines = ["QUESTION", ...Array(Math.max(0, rows - 2)).fill("Option"), "Enter / Esc"];
				return questionLines;
			},
			invalidate() {},
			handleInput,
		},
		{
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: { left: 0, right: 0, bottom: 0 },
		},
	);
	renderer.renderNow();
	return {
		terminal,
		renderer,
		tui,
		split,
		get questionLines() {
			return questionLines;
		},
		transcript,
		question,
		handleInput,
		input: (data: string) => input?.(data),
		dispose: () => {
			split.dispose();
			renderer.stop();
		},
	};
}

describe("question dock", () => {
	it.each([true, false])("reflows on resize with sidebar enabled=%s", (sidebar) => {
		const h = createHarness({ sidebar });
		try {
			for (const [columns, rows] of [
				[120, 30],
				[80, 24],
				[60, 16],
				[140, 42],
			] as const) {
				h.terminal.columns = columns;
				h.terminal.rows = rows;
				h.renderer.renderNow();
				const height = Math.floor(rows / 2);
				expect(h.question.getBounds()).toEqual({ row: rows - height, col: 0, width: columns, height });
				expect(h.transcript.viewportHeight).toBe(rows - height);
				expect(h.questionLines.at(-1)).toBe("Enter / Esc");
				expect(h.tui.terminal).toBe(h.terminal);
			}
		} finally {
			h.dispose();
		}
	});

	it("only reserves the height needed by a short question", () => {
		const h = createHarness({ questionRows: 6 });
		try {
			expect(h.question.getBounds()?.row).toBe(24);
			expect(h.transcript.viewportHeight).toBe(24);
		} finally {
			h.dispose();
		}
	});

	it("leaves unrelated overlays unchanged without an input request", () => {
		const h = createHarness({ inputRequested: false });
		try {
			expect(h.question.getBounds()?.height).toBe(30);
			expect(h.transcript.viewportHeight).toBe(30);
			const top = h.transcript.scrollTop;
			h.input("\u001b[5~");
			expect(h.transcript.scrollTop).toBe(top);
			expect(h.handleInput).toHaveBeenCalledWith("\u001b[5~");
		} finally {
			h.dispose();
		}
	});

	it("restores the layout when the question collapses, reopens, and closes through Pi", () => {
		const h = createHarness();
		try {
			h.question.setHidden(true);
			h.renderer.renderNow();
			expect(h.transcript.viewportHeight).toBe(30);
			h.question.setHidden(false);
			h.renderer.renderNow();
			expect(h.transcript.viewportHeight).toBe(15);
			expect(h.question.isFocused()).toBe(true);
			h.tui.hideOverlay();
			h.renderer.renderNow();
			expect(h.transcript.viewportHeight).toBe(30);
			expect(h.tui.render(120).join("\n")).toContain("SIDEBAR");
		} finally {
			h.dispose();
		}
	});

	it("does not close the sidebar when a hidden question completes", () => {
		const h = createHarness();
		try {
			h.question.setHidden(true);
			h.tui.hideOverlay();
			h.renderer.renderNow();
			expect(h.split.isEnabled()).toBe(true);
			expect(h.tui.render(120).join("\n")).toContain("SIDEBAR");
		} finally {
			h.dispose();
		}
	});

	it("removes the reservation on handle.hide and stops intercepting input", () => {
		const h = createHarness();
		try {
			h.question.hide();
			h.renderer.renderNow();
			expect(h.transcript.viewportHeight).toBe(30);
			h.input("\u001b[5~");
			expect(h.transcript.scrollTop).toBe(44);
			expect(h.handleInput).not.toHaveBeenCalled();
		} finally {
			h.dispose();
		}
	});

	it("leaves input ownership with a nested modal and restores the question afterwards", () => {
		const h = createHarness();
		try {
			const handleInput = vi.fn();
			h.tui.showOverlay({ render: () => ["MODAL"], invalidate() {}, handleInput }, { width: 30 });
			h.renderer.renderNow();
			const top = h.transcript.scrollTop;
			h.input("\u001b[5~");
			expect(h.transcript.scrollTop).toBe(top);
			expect(handleInput).toHaveBeenCalledWith("\u001b[5~");
			h.tui.hideOverlay();
			h.renderer.renderNow();
			expect(h.question.isFocused()).toBe(true);
			expect(h.transcript.viewportHeight).toBe(15);
			h.input("\u001b[5~");
			expect(h.transcript.scrollTop).toBeLessThan(top);
		} finally {
			h.dispose();
		}
	});

	it("does not scroll the transcript for wheels over the question or sidebar", () => {
		const h = createHarness();
		try {
			const top = h.transcript.scrollTop;
			h.input("\u001b[<64;5;16M");
			h.input("\u001b[<64;110;2M");
			expect(h.transcript.scrollTop).toBe(top);
		} finally {
			h.dispose();
		}
	});

	it("preserves the configured wheel step and uses the transcript's actual page height", () => {
		const h = createHarness({ composerRows: 5, wheelLines: 3 });
		try {
			const top = h.transcript.scrollTop;
			h.input("\u001b[<64;5;2M");
			expect(h.transcript.scrollTop).toBe(top - 3);
			h.input("\u001b[<72;5;2M");
			expect(h.transcript.scrollTop).toBe(top - 18);
			h.input("\u001b[5~");
			expect(h.transcript.scrollTop).toBe(top - 24);
			h.input("\u001b[6~");
			expect(h.transcript.scrollTop).toBe(top - 18);
		} finally {
			h.dispose();
		}
	});

	it("restores the live question and terminal dimensions when Atelier is disposed", () => {
		const h = createHarness();
		try {
			h.split.dispose();
			h.renderer.renderNow();
			expect(h.question.getBounds()?.height).toBe(30);
			expect(h.transcript.viewportHeight).toBe(30);
			expect(h.question.isFocused()).toBe(true);
			expect(h.tui.terminal).toBe(h.terminal);
		} finally {
			h.dispose();
		}
	});

	it("restores the terminal even if questionnaire rendering throws", () => {
		const terminal = { columns: 120, rows: 30, write: vi.fn() };
		const tui = new TuiAltScreen(terminal as never);
		const dock = createQuestionDock(
			tui,
			{
				render() {
					expect(tui.terminal.rows).toBe(15);
					throw new Error("render failed");
				},
				invalidate() {},
			},
			() => 120,
		);
		try {
			expect(() => dock.component.render(120)).toThrow("render failed");
			expect(tui.terminal).toBe(terminal);
			expect(tui.terminal.rows).toBe(30);
		} finally {
			dock.dispose();
		}
	});
	it("keeps the transcript above the question instead of behind it", () => {
		const h = createHarness();
		try {
			expect(h.question.getBounds()).toEqual({ row: 15, col: 0, width: 120, height: 15 });
			expect(h.transcript.viewportHeight).toBe(15);
			expect(h.transcript.scrollTop).toBe(85);
			expect(h.terminal.rows).toBe(30);
		} finally {
			h.dispose();
		}
	});

	it("scrolls the transcript while the question retains keyboard focus", () => {
		const h = createHarness();
		try {
			const before = h.transcript.scrollTop;
			h.input("\u001b[<64;5;2M");
			expect(h.transcript.scrollTop).toBe(before - 1);
			h.input("\u001b[5~");
			expect(h.transcript.scrollTop).toBeLessThan(before - 1);
			expect(h.question.isFocused()).toBe(true);
			expect(h.handleInput).not.toHaveBeenCalled();
			h.input("\u001b[B");
			h.input("draft answer");
			h.input("\r");
			h.input("\u001b");
			expect(h.handleInput.mock.calls.map(([data]) => data)).toEqual([
				"\u001b[B",
				"draft answer",
				"\r",
				"\u001b",
			]);
		} finally {
			h.dispose();
		}
	});
});

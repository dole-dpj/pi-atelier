import {
	type Component,
	getKeybindings,
	isKeyRelease,
	type OverlayHandle,
	type ScrollView,
	type TUI,
	type TuiAltScreen,
} from "@earendil-works/pi-tui";
import { parseSgrMouseEvent } from "./mouse.js";

// Pi 0.87 keeps viewport geometry and the configured wheel step on its renderer.
// Pi 0.99 replaces the public step with a private velocity-aware accelerator.
interface WheelAccelerator {
	next(direction: -1 | 1, now: number): number;
}

interface QuestionViewport extends Pick<TuiAltScreen, "scrollBy"> {
	wheelScrollLines: number;
	wheelScroll?: WheelAccelerator;
	getPrimaryScrollView(): ScrollView;
}

/** Pi <0.99 exposes the configured step; newer Pis step a private accelerator that may be velocity-aware. */
const wheelStepLines = (viewport: QuestionViewport, direction: -1 | 1): number => {
	const configured = viewport.wheelScrollLines;
	if (typeof configured === "number" && configured > 0) return Math.floor(configured);
	const accelerated = viewport.wheelScroll?.next(direction, performance.now());
	return accelerated !== undefined && Number.isFinite(accelerated) && accelerated >= 1
		? Math.floor(accelerated)
		: 1;
};

/** Reserve layout space for the questionnaire while Pi still owns its overlay and focus. */
export function createQuestionDock(tui: TUI, question: Component, getMainWidth: () => number) {
	let disposed = false;
	let handle: OverlayHandle | undefined;
	const maxRows = () => Math.max(1, Math.floor(tui.terminal.rows / 2));
	const component = new Proxy(question, {
		get(target, property, receiver) {
			if (property !== "render") return Reflect.get(target, property, receiver);
			return (width: number) => {
				if (disposed) return question.render(width);
				const terminal = tui.terminal;
				const rows = maxRows();
				// QuestionnaireSession sizes its scroll-to-focus body from terminal.rows.
				// Give only this synchronous render the dock's viewport, not the full screen.
				tui.terminal = new Proxy(terminal, {
					get: (target, key) => (key === "rows" ? rows : Reflect.get(target, key, target)),
				});
				try {
					return question.render(width).slice(0, rows);
				} finally {
					tui.terminal = terminal;
				}
			};
		},
	});
	const space: Component = {
		render: (width) =>
			disposed || !handle || handle.isHidden() ? [] : component.render(width).map(() => ""),
		invalidate() {},
	};
	const handleDockInput = (data: string) => {
		if (disposed || !handle?.isFocused() || handle.isHidden()) return undefined;
		const bounds = handle.getBounds();
		if (!bounds) return undefined;
		const viewport = tui as unknown as QuestionViewport;
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			// Pi defers unhandled wheel input to a focused overlay, even outside it.
			// Only route wheels above the dock and inside the main pane to the transcript.
			if (
				!mouse.release &&
				!mouse.motion &&
				(mouse.button & 64) !== 0 &&
				(mouse.button & 3) <= 1 &&
				mouse.x <= getMainWidth() &&
				mouse.y <= bounds.row
			) {
				const direction = (mouse.button & 1) === 0 ? -1 : 1;
				const wheelLines = wheelStepLines(viewport, direction);
				viewport.scrollBy(direction * wheelLines * (mouse.button & 8 ? 5 : 1));
				return { consume: true };
			}
			return undefined;
		}
		const keybindings = getKeybindings();
		const up = keybindings.matches(data, "tui.altScreen.pageUp");
		const down = keybindings.matches(data, "tui.altScreen.pageDown");
		if (!up && !down) return undefined;
		if (!isKeyRelease(data)) {
			viewport.scrollBy((up ? -1 : 1) * Math.max(1, viewport.getPrimaryScrollView().viewportHeight - 4));
		}
		return { consume: true };
	};
	const removeInputListener = tui.addInputListener(handleDockInput);
	// Pi's viewport listener steps its wheel accelerator before deferring unhandled
	// wheels here. Run ahead of it so a consumed wheel steps the accelerator exactly
	// once; unsubscribe removes the listener without disturbing other listener order.
	const listeners = (tui as unknown as { inputListeners?: Set<typeof handleDockInput> }).inputListeners;
	if (listeners instanceof Set && listeners.delete(handleDockInput)) {
		const existingListeners = [...listeners];
		listeners.clear();
		listeners.add(handleDockInput);
		for (const listener of existingListeners) listeners.add(listener);
	}
	return {
		component,
		space,
		setHandle(nextHandle: OverlayHandle) {
			handle = nextHandle;
		},
		dispose() {
			disposed = true;
			removeInputListener();
		},
	};
}

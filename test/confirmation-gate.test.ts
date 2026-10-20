/**
 * Confirmation-gate tests.
 *
 * - Copy: the dialog text is a pure function of the plan's mutating calls;
 *   its literals are pinned here — final wording, same
 *   arrangement as refusalMessage.
 * - SDK: grant, deny, and no-mutating-calls paths through real command
 *   dispatch on a headless SDK session.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { confirmationDialog, summarizeMutatingCalls } from "../src/command";
import type { RestateMutatingCall } from "../src/types";
import {
	appendAssistantToolCall,
	appendSystem,
	appendToolResult,
	appendUser,
	contextEditTargets,
	disposeRestateSessions,
	newRestateSession,
	recordingUIContext,
} from "./helpers";

afterEach(async () => {
	await disposeRestateSessions();
});

describe("summarizeMutatingCalls", () => {
	it("renders name ×count in first-appearance order", () => {
		const calls: RestateMutatingCall[] = [
			{ toolName: "bash", count: 2 },
			{ toolName: "edit", count: 1 },
		];
		expect(summarizeMutatingCalls(calls)).toBe("bash ×2, edit ×1");
	});

	it("renders a single tool without special casing", () => {
		expect(summarizeMutatingCalls([{ toolName: "write", count: 3 }])).toBe("write ×3");
	});

	it("renders an empty scan as an empty summary", () => {
		expect(summarizeMutatingCalls([])).toBe("");
	});
});

describe("confirmationDialog (copy seam)", () => {
	it("shows the scan summary and says file changes will not be rolled back", () => {
		const { title, message } = confirmationDialog([
			{ toolName: "bash", count: 2 },
			{ toolName: "edit", count: 1 },
		]);

		expect(title).toBeTruthy();
		expect(message).toContain("bash ×2, edit ×1");
		expect(message).toContain("will not be rolled back");
	});
});

describe("confirmation gate via the SDK", () => {
	// Final wording: literals are pinned directly (not built
	// via confirmationDialog, so a copy regression cannot pass in tandem)
	// and a reword is a deliberate change.
	const COPY = {
		cancelled: "Restate cancelled — nothing was retracted.",
		dialogTitle: "Confirm restate",
		dialogMessage:
			"The turn you are retracting contains tool calls: bash ×1.\n" +
			"Files modified by these tools will not be rolled back.",
	};

	/** A session whose latest turn ran one bash call (a mutating tool). */
	async function mutatingTurnSession(confirmAnswer: boolean) {
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const call = appendAssistantToolCall(sm, "bash", "call_1");
		const result = appendToolResult(sm, "call_1", "bash", "output");
		const ui = recordingUIContext({ confirmAnswer });
		const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });
		return { sm, ui, session, turn: { user, call, result } };
	}

	it("denying the confirmation writes nothing and notifies", async () => {
		const { sm, ui, session } = await mutatingTurnSession(false);
		const branchBefore = sm.getBranch().length;
		const projectionBefore = JSON.stringify(sm.buildSessionProjection().messages);

		await session.prompt("/restate");

		// One dialog, carrying the scan summary and the no-rollback warning.
		expect(ui.confirmCalls).toEqual([{ title: COPY.dialogTitle, message: COPY.dialogMessage }]);
		expect(ui.dialogs).toEqual(["confirm"]);

		// Deny → no entries written, context untouched (so the turn is still
		// live and a later /restate can target it), prompt not restored.
		expect(sm.getBranch().length).toBe(branchBefore);
		expect(JSON.stringify(sm.buildSessionProjection().messages)).toBe(projectionBefore);
		expect(contextEditTargets(sm)).toEqual([]);
		expect(ui.notifications).toEqual([{ message: COPY.cancelled, type: "info" }]);
		expect(ui.editor.get()).toBe("");
	});

	it("granting the confirmation retracts the mutating turn", async () => {
		const { sm, ui, session, turn } = await mutatingTurnSession(true);

		await session.prompt("/restate");

		expect(ui.confirmCalls).toHaveLength(1);

		expect(contextEditTargets(sm)).toEqual([turn.user, turn.call, turn.result]);
		expect(sm.getBranch().at(-1)?.type).toBe("custom");

		// The whole turn is gone from model context; the prompt is restored.
		const roles = sm.buildSessionProjection().messages.map((message) => message.role);
		expect(roles).toEqual(["system"]);
		expect(ui.editor.get()).toBe("Fix the bug");
		// Success feedback is the marker alone (no success notification).
		expect(ui.notifications).toEqual([]);
	});

	it("retracts without a dialog when the range has no mutating calls", async () => {
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const call = appendAssistantToolCall(sm, "read", "call_1");
		const result = appendToolResult(sm, "call_1", "read", "output");
		const ui = recordingUIContext();
		const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });

		await session.prompt("/restate");

		// Read-only tools never gate: straight retraction, no dialog, no notice.
		expect(ui.confirmCalls).toEqual([]);
		expect(ui.notifications).toEqual([]);
		expect(contextEditTargets(sm)).toEqual([user, call, result]);
		expect(ui.editor.get()).toBe("Fix the bug");
	});
});

/**
 * RPC mode and mode guards.
 *
 * The SDK session is bound the way the real RPC host binds it
 * (rpc-mode.js): a recording UI context (which makes ctx.hasUI true) plus
 * mode "rpc" driving the command's mode guards. What is asserted here:
 * - RPC idle: the gate forwards with a timeout (a silent client can never
 *   force a retraction — core auto-resolves an expired confirm to false),
 *   the recovered prompt text arrives via a success notification, and the
 *   editor is never touched (RPC has no editor; getEditorText is "" there).
 * - RPC mid-run: /restate aborts the streaming turn and retracts it.
 * - Deny: cancelled notification, nothing written.
 * - No mutating calls: no dialog, straight to the success notification.
 * - json/print (unbound host, noOpUIContext): the command is a guarded
 *   no-op — no entries written, nothing throws.
 *
 * The real `--mode rpc` child-process tests live in rpc-child.test.ts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { RPC_CONFIRM_TIMEOUT_MS, rpcSuccessNotification } from "../src/command";
import type { RestatePlan } from "../src/types";
import {
	appendAssistant,
	appendBashTurn,
	appendSystem,
	appendUser,
	contextEditTargets,
	disposeRestateSessions,
	hostBindings,
	newRestateSession,
	recordingUIContext,
	waitStreaming,
} from "./helpers";
import { createFakeProvider, type FakeTurn } from "./fake-provider";

afterEach(async () => {
	await disposeRestateSessions();
});

/** An SDK session bound the way the RPC host binds it (mode + recording UI). */
async function rpcSession(sm: SessionManager, confirmAnswer: boolean) {
	const ui = recordingUIContext({ confirmAnswer });
	const session = await newRestateSession(sm, {
		bindings: (s) => hostBindings(s, ui, "rpc"),
	});
	return { session, ui };
}

describe("rpc mode via the SDK", () => {
	it("granted gate: retracts, notifies with the recovered prompt text, never touches the editor", async () => {
		const sm = SessionManager.inMemory();
		appendBashTurn(sm);
		const { session, ui } = await rpcSession(sm, true);

		await session.prompt("/restate");

		expect(contextEditTargets(sm)).toHaveLength(3);
		expect(sm.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
		expect(ui.editor.get()).toBe(""); // RPC has no editor; nothing was set
		const success = ui.notifications.find((n) => n.type === "info");
		expect(success?.message).toContain("Fix the bug via bash.");
		expect(success?.message).toContain("3 entries retracted");
	});

	it("forwards the confirmation with a timeout so a silent client cannot force a retraction", async () => {
		const sm = SessionManager.inMemory();
		appendBashTurn(sm);
		const { session, ui } = await rpcSession(sm, true);

		await session.prompt("/restate");

		expect(ui.confirmCalls).toHaveLength(1);
		expect(ui.confirmCalls[0]?.options?.timeout).toBe(RPC_CONFIRM_TIMEOUT_MS);
	});

	it("re-plans against the newest turn when a client prompt lands during the confirmation window", async () => {
		// The forwarded confirm does not block the RPC client (the TUI dialog
		// blocks input; a forwarded RPC confirm does not). A prompt arriving
		// inside the window makes the confirmed plan stale: the handler must
		// abort, settle, and re-plan against the newest turn instead of
		// applying context edits mid-run.
		const fake = createFakeProvider();
		fake.turns.push({ kind: "hang", text: "concurrent answer" });
		const sm = SessionManager.inMemory();
		appendBashTurn(sm); // mutating turn: the confirm gate fires
		let fireConcurrentPrompt: (() => Promise<void>) | undefined;
		const ui = recordingUIContext({
			confirmAnswer: true,
			// Inside the confirmation window: start a prompt and hold the dialog
			// open until it is genuinely streaming, so isIdle is deterministically
			// false when the confirm resolves.
			beforeConfirmResolve: async () => {
				await fireConcurrentPrompt?.();
			},
		});
		const session = await newRestateSession(sm, {
			fake,
			bindings: (s) => hostBindings(s, ui, "rpc"),
		});
		fireConcurrentPrompt = async () => {
			void session.prompt("Newest prompt");
			await waitStreaming(session);
		};

		await session.prompt("/restate");

		// One confirm only: the re-planned turn is text-only, no gate.
		expect(ui.confirmCalls).toHaveLength(1);
		// The retraction targets the concurrent prompt's turn (prompt + aborted
		// partial), never the confirmed bash turn.
		const targets = contextEditTargets(sm);
		expect(targets).toHaveLength(2);
		const oldUserId = sm
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user")
			?.id;
		expect(targets).not.toContain(oldUserId);
		// The success notification carries the newest prompt back.
		const success = ui.notifications.find((n) => n.type === "info");
		expect(success?.message).toContain("Newest prompt");
	}, 10_000);

	it("denied gate: cancelled notification, nothing written", async () => {
		const sm = SessionManager.inMemory();
		appendBashTurn(sm);
		const { session, ui } = await rpcSession(sm, false);

		await session.prompt("/restate");

		expect(contextEditTargets(sm)).toHaveLength(0);
		expect(ui.notifications.map((n) => n.message)).toContain(
			"Restate cancelled — nothing was retracted.",
		);
	});

	it("without mutating calls: no dialog, success notification only", async () => {
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		appendUser(sm, "Just answer.");
		appendAssistant(sm, "Answered.");
		const { session, ui } = await rpcSession(sm, true);

		await session.prompt("/restate");

		expect(ui.dialogs).not.toContain("confirm");
		const info = ui.notifications.filter((n) => n.type === "info");
		expect(info).toHaveLength(1);
		expect(info[0]?.message).toContain("Just answer.");
	});

	it("mid-run: aborts the streaming turn and retracts it", async () => {
		const turns: FakeTurn[] = [{ kind: "hang", text: "streaming then stalls" }];
		const fake = createFakeProvider();
		fake.turns.push(...turns);
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		const ui = recordingUIContext({ confirmAnswer: true });
		const session = await newRestateSession(sm, {
			fake,
			bindings: (s) => hostBindings(s, ui, "rpc"),
		});

		const run = session.prompt("Fix the bug via bash.");
		await waitStreaming(session);
		await session.prompt("/restate");
		await run;

		expect(contextEditTargets(sm)).not.toHaveLength(0);
		const success = ui.notifications.find((n) => n.type === "info");
		expect(success?.message).toContain("Fix the bug via bash.");
	});
});

describe("json/print mode guards (unbound host)", () => {
	it("/restate is a guarded no-op: nothing written, nothing throws", async () => {
		const sm = SessionManager.inMemory();
		appendBashTurn(sm);
		const session = await newRestateSession(sm); // no bindings: noOpUIContext, mode "print"

		await session.prompt("/restate");

		expect(contextEditTargets(sm)).toHaveLength(0);
		expect(sm.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(0);
	});

	it("usage arguments are equally no-op, never a crash", async () => {
		const sm = SessionManager.inMemory();
		appendBashTurn(sm);
		const session = await newRestateSession(sm);

		await session.prompt("/restate unexpected-arg");

		expect(contextEditTargets(sm)).toHaveLength(0);
	});
});

describe("rpcSuccessNotification (copy seam)", () => {
	it("reports counts and embeds the recovered prompt text", () => {
		const plan: RestatePlan = {
			target: "a",
			omit: ["a", "b", "c"],
			restoredText: "Fix the bug.",
			imagesDropped: 0,
			mutatingCalls: [],
		};
		expect(rpcSuccessNotification(plan)).toBe(
			"Restated — 3 entries retracted from model context.\nRecovered prompt:\nFix the bug.",
		);
	});

	it("notes dropped images and survives an image-only prompt", () => {
		const plan: RestatePlan = {
			target: "a",
			omit: ["a"],
			restoredText: "",
			imagesDropped: 2,
			mutatingCalls: [],
		};
		expect(rpcSuccessNotification(plan)).toBe(
			"Restated — 1 entry (2 images dropped) retracted from model context.",
		);
	});
});

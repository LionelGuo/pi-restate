/**
 * Busy-state tests: `/restate` across run states, against a
 * real SDK session driving real turns through a deterministic fake provider.
 * The three run states: streaming (abort + settle),
 * provider-error-interrupted, and Esc-aborted — plus the delivered steering
 * message as Restate target.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createFakeProvider, type FakeTurn } from "./fake-provider";
import {
	appendSystem,
	disposeRestateSessions,
	newRestateSession,
	recordingUIContext,
	hostBindings,
	waitStreaming,
} from "./helpers";

afterEach(async () => {
	await disposeRestateSessions();
});

/** A session fixture for one scripted scenario: fake provider, branch, recording UI, session. */
async function busySession(turns: FakeTurn[]) {
	const fake = createFakeProvider();
	fake.turns.push(...turns);
	const sm = SessionManager.inMemory();
	appendSystem(sm);
	const ui = recordingUIContext();
	const session = await newRestateSession(sm, {
		fake,
		bindings: (s) => hostBindings(s, ui),
	});
	return { sm, ui, session };
}

/** User and assistant message entries on the branch, newest last. */
function turnEntries(sm: SessionManager) {
	return sm
		.getBranch()
		.filter((entry) => entry.type === "message")
		.map((entry) => (entry.type === "message" ? entry.message : undefined))
		.filter(
			(message): message is NonNullable<typeof message> =>
				message !== undefined && (message.role === "user" || message.role === "assistant"),
		);
}

/** The context edits nulled exactly the turn entries (user + assistant messages), nothing else. */
function expectTurnsOmitted(sm: SessionManager) {
	const branch = sm.getBranch();
	const expected = branch
		.filter(
			(entry) =>
				entry.type === "message" &&
				(entry.message.role === "user" || entry.message.role === "assistant"),
		)
		.map((entry) => entry.id);
	const editTargets = branch
		.filter((entry) => entry.type === "context_edit")
		.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
	expect(editTargets).toEqual(expected);
}

/** Only system messages (fixture + session startup) remain in model context. */
function expectSystemOnlyContext(sm: SessionManager) {
	const roles = sm.buildSessionProjection().messages.map((message) => message.role);
	expect(roles.length).toBeGreaterThan(0);
	expect(roles.every((role) => role === "system")).toBe(true);
}

describe("/restate busy-state flow", () => {
	it("mid-stream: aborts the active run, then retracts it with the aborted partial", async () => {
		const { sm, ui, session } = await busySession([
			{ kind: "hang", text: "half-finished answer" },
		]);

		const run = session.prompt("Fix the bug");
		await waitStreaming(session);
		await session.prompt("/restate"); // dispatches immediately, mid-stream
		await run;

		// The aborted partial persisted and was omitted together with its prompt.
		const messages = turnEntries(sm);
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Fix the bug" }],
		});
		expect(messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			content: [{ type: "text", text: "half-finished answer" }],
		});

		expectTurnsOmitted(sm);
		expect(sm.getBranch().at(-1)?.type).toBe("custom");
		expectSystemOnlyContext(sm);

		// The retracted prompt is back in the editor for editing.
		expect(ui.editor.get()).toBe("Fix the bug");
	}, 10_000);

	it("mid-stream with a queued steer: the abort's queue dump survives below the restored prompt", async () => {
		const { sm, ui, session } = await busySession([
			{ kind: "hang", text: "half-finished answer" },
		]);

		const run = session.prompt("Fix the bug");
		await waitStreaming(session);
		await session.steer("steer: add tests"); // queued, not yet delivered
		await session.prompt("/restate");
		await run;

		// Restored prompt first, the aborted run's queue dump after, blank-line
		// joined — nothing queued is lost or overwritten.
		expect(ui.editor.get()).toBe("Fix the bug\n\nsteer: add tests");

		// The steer message was never delivered: the turn's entries are exactly
		// the user prompt and the aborted partial, both omitted.
		const messages = turnEntries(sm);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expectSystemOnlyContext(sm);
	}, 10_000);

	it("RPC mid-stream with a queued steer: the queue survives, and the success notification warns", async () => {
		// The real RPC host binds no abortHandler, so nothing dumps the queue
		// on abort (only the TUI does). Extensions have no queue API either —
		// the loud warning in the success notification is the honest fallback.
		const fake = createFakeProvider();
		fake.turns.push({ kind: "hang", text: "half-finished answer" });
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		const ui = recordingUIContext();
		const session = await newRestateSession(sm, {
			fake,
			bindings: (s) => hostBindings(s, ui, "rpc", { bindAbortHandler: false }),
		});

		const run = session.prompt("Fix the bug");
		await waitStreaming(session);
		await session.steer("steer: add tests"); // queued, not yet delivered
		await session.prompt("/restate");
		await run;

		// The queued steer survived the abort (no queue dump in RPC)…
		expect(session.pendingMessageCount).toBe(1);
		// …no editor to dump into…
		expect(ui.editor.get()).toBe("");
		// …so the success notification carries the loud warning.
		const success = ui.notifications.find((n) => n.type === "info");
		expect(success?.message).toContain("queued steering/follow-up messages are still pending");
		// The retraction itself still happened.
		expectSystemOnlyContext(sm);
	}, 10_000);

	it("after a provider-error-interrupted turn: retracts cleanly", async () => {
		const { sm, ui, session } = await busySession([
			{
				kind: "error",
				text: "partial before failure",
				errorMessage: "Fake provider exploded",
			},
		]);

		// The turn fails with a non-retryable provider error; the failed
		// exchange (prompt + error partial) lingers in the session.
		await session.prompt("Fix the bug");
		let messages = turnEntries(sm);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({ role: "assistant", stopReason: "error" });

		await session.prompt("/restate");

		// Clean retraction: the failed exchange is gone from model context and
		// the prompt is back in the editor.
		messages = turnEntries(sm);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expectSystemOnlyContext(sm);
		expect(ui.editor.get()).toBe("Fix the bug");
	}, 10_000);

	it("after an Esc-aborted turn: retracts cleanly, aborted partial included", async () => {
		const { sm, ui, session } = await busySession([
			{ kind: "hang", text: "half-finished answer" },
		]);

		// The user aborts with Esc (session.abort), the model's partial
		// persists, then /restate runs while idle.
		const run = session.prompt("Fix the bug");
		await waitStreaming(session);
		await session.abort();
		await run;
		await session.prompt("/restate");

		const messages = turnEntries(sm);
		expect(messages).toHaveLength(2);
		expect(messages[1]).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
			content: [{ type: "text", text: "half-finished answer" }],
		});
		expectTurnsOmitted(sm);
		expectSystemOnlyContext(sm);
		expect(ui.editor.get()).toBe("Fix the bug");
	}, 10_000);

	it("retracts from a steering message delivered mid-run, keeping the earlier turn live", async () => {
		const { sm, ui, session } = await busySession([
			{ kind: "text", text: "first answer" },
			{ kind: "text", text: "second answer" },
		]);

		// The run delivers the queued steer between the two assistant turns
		// (the agent loop polls the steering queue after each turn).
		const run = session.prompt("Fix the bug");
		await waitStreaming(session);
		await session.steer("steer: use tests");
		await run;

		const messages = turnEntries(sm);
		expect(messages.map((message) => message.role)).toEqual([
			"user", // Fix the bug
			"assistant", // first answer
			"user", // steer: use tests (delivered)
			"assistant", // second answer
		]);

		// "The message I last sent" is the delivered steer: the Restate
		// targets it and the answer it prompted, leaving the earlier turn live.
		await session.prompt("/restate");
		const branch = sm.getBranch();
		const steerId = branch
			.filter((entry) => entry.type === "message" && entry.message.role === "user")
			.at(-1)?.id;
		const secondAnswerId = branch
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.at(-1)?.id;
		const editTargets = branch
			.filter((entry) => entry.type === "context_edit")
			.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
		expect(editTargets).toEqual([steerId, secondAnswerId]);

		const remainingRoles = sm
			.buildSessionProjection()
			.messages.map((message) => message.role);
		expect(remainingRoles.filter((role) => role !== "system")).toEqual([
			"user",
			"assistant",
		]);
		expect(ui.editor.get()).toBe("steer: use tests");
	}, 10_000);
});

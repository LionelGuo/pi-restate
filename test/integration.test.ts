/**
 * Integration test: a headless SDK session with the extension registered, driving
 * `/restate` through the real command dispatch (`session.prompt` executes
 * extension commands before any model validation, so no provider is needed).
 */

import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { MARKER_CUSTOM_TYPE } from "../src/index";
import {
	appendAssistant,
	appendSystem,
	appendToolResult,
	appendUser,
	disposeRestateSessions,
	newRestateSession,
	recordingUIContext,
} from "./helpers";

afterEach(async () => {
	await disposeRestateSessions();
});

describe("/restate via the SDK", () => {
	it("retracts the latest turn end to end and stays on a single chain", async () => {
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const asst = appendAssistant(sm, "Looking into it.");
		const toolResult = appendToolResult(sm, "call_1", "bash", "output");
		const ui = recordingUIContext();
		const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });
		// Session startup records its own setup entries (e.g. thinking level),
		// so snapshot the branch length only after the session exists.
		const before = sm.getBranch().length;
		await session.prompt("/restate");

		const branch = sm.getBranch();
		// One context edit per omitted entry, plus the marker entry. The model
		// change is never nulled.
		const editTargets = branch
			.filter((entry) => entry.type === "context_edit")
			.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
		expect(editTargets).toEqual([user, asst, toolResult]);
		expect(branch.length).toBe(before + 4);

		const leaf = branch[branch.length - 1];
		expect(leaf?.type).toBe("custom");
		if (leaf?.type === "custom") {
			expect(leaf.customType).toBe(MARKER_CUSTOM_TYPE);
			expect(leaf.data).toMatchObject({
				version: 1,
				targetId: user,
				omittedIds: [user, asst, toolResult],
				omittedCount: 3,
				imagesDropped: 0,
			});
		}

		// Model context afterwards: the system message only.
		const roles = sm.buildSessionProjection().messages.map((message) => message.role);
		expect(roles).toEqual(["system"]);

		// Single chain: one root, every node has at most one child, and the
		// new entries extend the leaf without branching.
		const tree = sm.getTree();
		expect(tree.length).toBe(1);
		let node = tree[0];
		let seen = 0;
		while (node) {
			seen += 1;
			expect(node.children.length).toBeLessThanOrEqual(1);
			node = node.children[0];
		}
		expect(seen).toBe(branch.length);
	});

	it("skips bash-mode entries instead of erroring mid-retraction", async () => {
		const sm = SessionManager.inMemory();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const asst = appendAssistant(sm, "Done.");
		// A bash-mode run (`!ls`) records a bashExecution message after the
		// answer. The context-edit API cannot null it, so the retraction
		// must skip it and still complete.
		sm.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: "src",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		const ui = recordingUIContext();
		const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });

		await session.prompt("/restate");

		const branch = sm.getBranch();
		const editTargets = branch
			.filter((entry) => entry.type === "context_edit")
			.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
		expect(editTargets).toEqual([user, asst]);

		const leaf = branch[branch.length - 1];
		expect(leaf?.type).toBe("custom");
		if (leaf?.type === "custom") {
			expect(leaf.customType).toBe(MARKER_CUSTOM_TYPE);
			expect(leaf.data).toMatchObject({ omittedIds: [user, asst], omittedCount: 2 });
		}

		// The retracted turn leaves model context; the bash entry stays (the
		// API cannot null it) and the recovered prompt lands in the editor.
		const roles = sm.buildSessionProjection().messages.map((message) => message.role);
		expect(roles).toEqual(["system", "bashExecution"]);
		expect(ui.editor.get()).toBe("Fix the bug");
	});

	describe("refusals", () => {
		// Final wording: these literals pin the current copy so
		// a reword is a deliberate change.
		const COPY = {
			usage: "/restate takes no arguments. It always retracts the message you last sent.",
			nothingToRestate: "Nothing to restate: no user message on the active branch.",
			alreadyRetracted: "The latest user message is already retracted. /restate never peels deeper into history.",
			compaction: "Refused: retracting this turn would cross a compaction boundary.",
		};

		/** Drive /restate through real dispatch and assert it wrote nothing. */
		async function refuseUntouched(sm: SessionManager, session: AgentSession, prompt: string) {
			const branchBefore = sm.getBranch();
			const snapshot = JSON.stringify(branchBefore.map((entry) => entry.id));
			const projectionBefore = JSON.stringify(sm.buildSessionProjection().messages);

			// Must resolve without opening any dialog: refusals notify, they never block.
			await session.prompt(prompt);

			const branch = sm.getBranch();
			expect(JSON.stringify(branch.map((entry) => entry.id))).toBe(snapshot);
			expect(JSON.stringify(sm.buildSessionProjection().messages)).toBe(projectionBefore);
		}

		it("notifies the usage error for arguments and leaves the session untouched", async () => {
			const sm = SessionManager.inMemory();
			appendSystem(sm);
			appendUser(sm, "Fix the bug");
			appendAssistant(sm, "Done.");
			const ui = recordingUIContext();
			const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });

			await refuseUntouched(sm, session, "/restate 3");

			expect(ui.notifications).toEqual([{ message: COPY.usage, type: "warning" }]);
			expect(ui.dialogs).toEqual([]);
		});

		it("notifies nothing-to-restate when the branch has no user message", async () => {
			const sm = SessionManager.inMemory();
			appendSystem(sm);
			const ui = recordingUIContext();
			const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });

			await refuseUntouched(sm, session, "/restate");

			expect(ui.notifications).toEqual([{ message: COPY.nothingToRestate, type: "warning" }]);
			expect(ui.dialogs).toEqual([]);
		});

		it("notifies already-retracted after a Restate instead of peeling deeper", async () => {
			const sm = SessionManager.inMemory();
			appendSystem(sm);
			appendUser(sm, "Fix the bug");
			appendAssistant(sm, "Done.");
			const ui = recordingUIContext();
			const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });

			await session.prompt("/restate");
			const afterFirst = sm.getBranch().length;
			// Success feedback is the marker entry alone (like compaction: no
			// success notification); the editor restore needs no notice.
			expect(ui.notifications).toHaveLength(0);
			expect(sm.getBranch().at(-1)?.type).toBe("custom");

			await refuseUntouched(sm, session, "/restate");

			expect(ui.notifications[0]).toEqual({ message: COPY.alreadyRetracted, type: "warning" });
			expect(ui.dialogs).toEqual([]);
		});

		it("notifies compaction when the latest user message was absorbed by compaction", async () => {
			const sm = SessionManager.inMemory();
			appendSystem(sm);
			appendUser(sm, "absorbed prompt");
			appendAssistant(sm, "absorbed answer");
			sm.appendCompaction("Summary of the turn.", null, 1000);
			const ui = recordingUIContext();
			const session = await newRestateSession(sm, { bindings: { uiContext: ui.uiContext } });

			await refuseUntouched(sm, session, "/restate");

			expect(ui.notifications).toEqual([{ message: COPY.compaction, type: "warning" }]);
			expect(ui.dialogs).toEqual([]);
		});
	});
});

/**
 * Engine tests: the engine over a real SessionManager. Fixtures in, plans
 * and refusals out; external behavior only, no private internals.
 */

import { describe, expect, it } from "vitest";
import { joinRestoredText, planRestate } from "../src/engine";
import type { RestatePlan } from "../src/types";
import {
	appendAssistant,
	appendAssistantToolCall,
	appendSystem,
	appendToolResult,
	appendUser,
	appendUserBlocks,
	applyOmissions,
	newSession,
} from "./helpers";

function planOrThrow(omit: readonly string[], branch: Parameters<typeof planRestate>[0]): RestatePlan {
	const decision = planRestate(branch);
	if (!("omit" in decision)) {
		throw new Error(`expected a plan, got refusal: ${decision.reason}`);
	}
	expect(decision.omit).toEqual([...omit]);
	return decision;
}

describe("planRestate — happy path", () => {
	it("plans the target plus every context-producing entry after it", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const asst1 = appendAssistant(sm, "Looking into it.");
		const asstCall = appendAssistantToolCall(sm, "bash", "call_1");
		const toolResult = appendToolResult(sm, "call_1", "bash", "output");
		const asst2 = appendAssistant(sm, "Done.");
		const custom = sm.appendCustomMessageEntry("other-ext", "injected context", true);

		const plan = planOrThrow([user, asst1, asstCall, toolResult, asst2, custom], sm.getBranch());

		expect(plan.target).toBe(user);
		expect(plan.restoredText).toBe("Fix the bug");
		expect(plan.imagesDropped).toBe(0);
		expect(plan.mutatingCalls).toEqual([{ toolName: "bash", count: 1 }]);
	});

	it("targets the latest user message when several exist (steering included)", () => {
		const sm = newSession();
		appendSystem(sm);
		appendUser(sm, "older prompt");
		appendAssistant(sm, "older answer");
		const steer = appendUser(sm, "steer: use tests");
		const asst = appendAssistant(sm, "ok");

		const plan = planOrThrow([steer, asst], sm.getBranch());
		expect(plan.target).toBe(steer);
		expect(plan.restoredText).toBe("steer: use tests");
	});

	it("extracts restored text and counts dropped images", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUserBlocks(sm, [
			{ text: "first line" },
			{ image: "AAA=" },
			{ text: "second line" },
			{ image: "BBB=" },
		]);
		const asst = appendAssistant(sm, "answer");

		const plan = planOrThrow([user, asst], sm.getBranch());
		expect(plan.restoredText).toBe("first line\nsecond line");
		expect(plan.imagesDropped).toBe(2);
	});

	it("never includes non-retractable entries in the omission set", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "prompt");
		const model = sm.appendModelChange("anthropic", "other-model");
		const thinking = sm.appendThinkingLevelChange("high");
		const usage = sm.appendUsage("cache_warm", "anthropic", "test-model", {
			input: 0,
			output: 0,
			cacheRead: 10,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}).id;
		const custom = sm.appendCustomEntry("some-ext", { state: 1 });
		const labelTarget = appendAssistant(sm, "answer");
		sm.appendLabelChange(labelTarget, "checkpoint");

		const branch = sm.getBranch();
		const plan = planOrThrow([user, labelTarget], branch);
		for (const neverNulled of [model, thinking, usage, custom]) {
			expect(plan.omit).not.toContain(neverNulled);
		}
	});

	it("excludes bash-mode bashExecution messages from the omission set", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "prompt");
		const asst = appendAssistant(sm, "answer");
		// Bash mode (`!cmd`, and `!!cmd` as excludeFromContext) records message
		// entries with role bashExecution. They live in model context, but
		// appendContextEdit refuses to null them (it only accepts user /
		// assistant / toolResult / custom_message), so planning them would
		// throw mid-apply. Both variants must be skipped.
		const bashVisible = sm.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: "file.ts",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		});
		const bashExcluded = sm.appendMessage({
			role: "bashExecution",
			command: "pwd",
			output: "/tmp",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
			excludeFromContext: true,
		});

		const plan = planOrThrow([user, asst], sm.getBranch());
		expect(plan.omit).not.toContain(bashVisible);
		expect(plan.omit).not.toContain(bashExcluded);
	});

	it("skips entries already omitted, without re-omitting them", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "prompt");
		const asst1 = appendAssistant(sm, "partial answer");
		// Simulate Pi's own recovery (retry/overflow) omitting an entry.
		sm.appendContextEdit(asst1, null);
		const asst2 = appendAssistant(sm, "final answer");

		const plan = planOrThrow([user, asst2], sm.getBranch());
		expect(plan.omit).not.toContain(asst1);
	});

	it("treats an aborted partial assistant message like any other output", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "prompt");
		const partial = sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "half-finished" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "aborted",
			timestamp: Date.now(),
		});

		planOrThrow([user, partial], sm.getBranch());
	});
});

describe("planRestate — refusals", () => {
	it("refuses usage for any non-empty argument", () => {
		const sm = newSession();
		appendUser(sm, "prompt");
		expect(planRestate(sm.getBranch(), { args: "extra" })).toEqual({ reason: "usage" });
		// The literal edge case: a numeric argument (e.g. a peel count).
		expect(planRestate(sm.getBranch(), { args: "3" })).toEqual({ reason: "usage" });
		// Whitespace-only arguments count as no argument.
		expect("omit" in planRestate(sm.getBranch(), { args: "  " })).toBe(true);
	});

	it("refuses nothing-to-restate when the branch has no user message", () => {
		const sm = newSession();
		appendSystem(sm);
		sm.appendModelChange("anthropic", "test-model");
		expect(planRestate(sm.getBranch())).toEqual({ reason: "nothing-to-restate" });
	});

	it("refuses nothing-to-restate on an empty branch", () => {
		expect(planRestate([])).toEqual({ reason: "nothing-to-restate" });
	});

	it("refuses already-retracted after a Restate was applied", () => {
		const sm = newSession();
		appendSystem(sm);
		appendUser(sm, "prompt");
		appendAssistant(sm, "answer");

		const first = planRestate(sm.getBranch());
		if (!("omit" in first)) throw new Error("expected a plan");
		applyOmissions(sm, first.omit);

		expect(planRestate(sm.getBranch())).toEqual({ reason: "already-retracted" });
	});

	it("refuses compaction when the latest user message was absorbed by compaction", () => {
		const sm = newSession();
		appendSystem(sm);
		appendUser(sm, "first prompt");
		appendAssistant(sm, "first answer");
		const user = appendUser(sm, "absorbed prompt");
		appendAssistant(sm, "absorbed answer");
		// Compaction keeps nothing before it: both prompts are summarized away.
		sm.appendCompaction("Fresh start.", null, 1000);

		expect(user).toBeTruthy();
		expect(planRestate(sm.getBranch())).toEqual({ reason: "compaction" });
	});

	it("refuses compaction when the target falls inside the summarized range", () => {
		const sm = newSession();
		appendSystem(sm);
		appendUser(sm, "first prompt");
		appendAssistant(sm, "first answer");
		const user = appendUser(sm, "summarized prompt");
		const kept = appendAssistant(sm, "kept answer");
		// Compaction retains from the assistant answer: the user prompt before
		// it is only present inside the summary, not as a live entry.
		sm.appendCompaction("Summary of earlier turns.", kept, 1000);

		expect(user).toBeTruthy();
		expect(planRestate(sm.getBranch())).toEqual({ reason: "compaction" });
	});

	it("refuses compaction when a compaction entry sits between the target and the leaf", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "prompt");
		const asst = appendAssistant(sm, "answer");
		// Compaction retained from the assistant answer, so the prompt above it
		// exists only inside the summary; a later non-message entry keeps the
		// compaction strictly between target and leaf.
		sm.appendCompaction("Summary of the turn.", asst, 1000);
		sm.appendModelChange("anthropic", "next-model");

		expect(user).toBeTruthy();
		expect(planRestate(sm.getBranch())).toEqual({ reason: "compaction" });
	});

	it("plans normally when a compaction entry precedes the target", () => {
		const sm = newSession();
		appendSystem(sm);
		appendUser(sm, "old prompt");
		appendAssistant(sm, "old answer");
		// A compact-then-continue session: the restate target comes after the
		// compaction, so the retraction range never crosses the boundary.
		sm.appendCompaction("Summary of old turns.", null, 1000);
		const user = appendUser(sm, "new prompt");
		const asst = appendAssistant(sm, "new answer");

		const plan = planRestate(sm.getBranch());
		if (!("omit" in plan)) throw new Error(`expected a plan, got ${plan.reason}`);
		expect(plan.omit).toEqual([user, asst]);

		// Applying it leaves the system message plus the summary as the whole
		// context: the post-compaction turn is gone, the summary untouched.
		applyOmissions(sm, plan.omit);
		const messages = sm.buildSessionProjection().messages;
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "system" });
		expect(messages[1]).toMatchObject({ role: "compactionSummary", summary: "Summary of old turns." });
	});

	it("plans normally when compaction only summarizes entries before the target", () => {
		const sm = newSession();
		appendSystem(sm);
		appendUser(sm, "first prompt");
		appendAssistant(sm, "first answer");
		const user = appendUser(sm, "second prompt");
		const asst = appendAssistant(sm, "second answer");
		// A normal /compact keeps everything from the last user message on.
		sm.appendCompaction("Summary of earlier turns.", user, 1000);

		const plan = planRestate(sm.getBranch());
		if (!("omit" in plan)) throw new Error(`expected a plan, got ${plan.reason}`);
		expect(plan.omit).toEqual([user, asst]);

		// Retracting the retained turn keeps the system message and summary as
		// the whole context.
		applyOmissions(sm, plan.omit);
		const messages = sm.buildSessionProjection().messages;
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "system" });
		expect(messages[1]).toMatchObject({ role: "compactionSummary", summary: "Summary of earlier turns." });
	});
});

describe("planRestate — mutating-call scan", () => {
	it("counts calls per tool name across the retraction range", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const bash1 = appendAssistantToolCall(sm, "bash", "call_1");
		const edit1 = appendAssistantToolCall(sm, "edit", "call_2");
		const bash2 = appendAssistantToolCall(sm, "bash", "call_3");

		const plan = planOrThrow([user, bash1, edit1, bash2], sm.getBranch());
		// First-appearance order: the confirmation gate renders this as
		// "bash ×2, edit ×1".
		expect(plan.mutatingCalls).toEqual([
			{ toolName: "bash", count: 2 },
			{ toolName: "edit", count: 1 },
		]);
	});

	it("counts only the retraction range and only mutating tools", () => {
		const sm = newSession();
		appendSystem(sm);
		// An earlier turn's mutating call: outside the range once the latest
		// user message is the target.
		appendUser(sm, "older prompt");
		appendAssistantToolCall(sm, "bash", "old_call");
		appendAssistant(sm, "older answer");

		const user = appendUser(sm, "Fix the bug");
		const read1 = appendAssistantToolCall(sm, "read", "call_1");
		const answer = appendAssistant(sm, "read-only answer");

		const plan = planOrThrow([user, read1, answer], sm.getBranch());
		expect(plan.mutatingCalls).toEqual([]);
	});

	it("counts every known-readonly tool as non-mutating", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Look around");
		const read = appendAssistantToolCall(sm, "read", "call_1");
		const grep = appendAssistantToolCall(sm, "grep", "call_2");
		const find = appendAssistantToolCall(sm, "find", "call_3");
		const ls = appendAssistantToolCall(sm, "ls", "call_4");

		const plan = planOrThrow([user, read, grep, find, ls], sm.getBranch());
		expect(plan.mutatingCalls).toEqual([]);
	});

	it("counts unknown tools as mutating: powershell, MCP, extension tools", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const powershell = appendAssistantToolCall(sm, "powershell", "call_1");
		const mcp = appendAssistantToolCall(sm, "mcp__db__query", "call_2");

		const plan = planOrThrow([user, powershell, mcp], sm.getBranch());
		expect(plan.mutatingCalls).toEqual([
			{ toolName: "powershell", count: 1 },
			{ toolName: "mcp__db__query", count: 1 },
		]);
	});

	it("counts nested calls under their own name (codemode-style)", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Run the workflow");
		const call = appendAssistantToolCall(sm, "codemode", "call_1");
		// The codemode result records the tools it executed: an edit (mutating)
		// and a read (readonly). The wrapper itself counts too — it is not a
		// known-readonly tool.
		const result = appendToolResult(sm, "call_1", "codemode", "done", [
			{ name: "edit" },
			{ name: "read" },
		]);

		const plan = planOrThrow([user, call, result], sm.getBranch());
		expect(plan.mutatingCalls).toEqual([
			{ toolName: "codemode", count: 1 },
			{ toolName: "edit", count: 1 },
		]);
	});

	it("counts mutating calls inside already-nulled entries of the range", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		const call = appendAssistantToolCall(sm, "bash", "call_1");
		// Nulled like Pi's own overflow recovery does: no longer omittable, no
		// longer visible to the model — but its files still changed, so the
		// gate must still fire.
		sm.appendContextEdit(call, null);
		const answer = appendAssistant(sm, "done");

		const plan = planOrThrow([user, answer], sm.getBranch());
		expect(plan.mutatingCalls).toEqual([{ toolName: "bash", count: 1 }]);
	});
});

describe("joinRestoredText", () => {
	it("returns the restored text alone when the editor is empty", () => {
		expect(joinRestoredText("fixed prompt", "")).toBe("fixed prompt");
		expect(joinRestoredText("fixed prompt", "   ")).toBe("fixed prompt");
	});

	it("prepends restored text, keeping queued editor text below", () => {
		expect(joinRestoredText("fixed prompt", "queued steer")).toBe("fixed prompt\n\nqueued steer");
	});
});

describe("apply — engine plan against a real SessionManager", () => {
	it("omits the retracted turn from the projection and keeps a single chain", () => {
		const sm = newSession();
		appendSystem(sm);
		const user = appendUser(sm, "Fix the bug");
		appendAssistantToolCall(sm, "bash", "call_1");
		appendToolResult(sm, "call_1", "bash", "output");
		appendAssistant(sm, "Done.");
		const marker = sm.appendCustomMessageEntry("other-ext", "injected", true);
		sm.appendModelChange("anthropic", "other-model");

		const plan = planRestate(sm.getBranch());
		if (!("omit" in plan)) throw new Error("expected a plan");
		applyOmissions(sm, plan.omit);

		const projection = sm.buildSessionProjection();
		const roles = projection.messages.map((message) => message.role);
		expect(roles).toEqual(["system"]); // the whole turn is gone from model context
		expect(plan.omit).toEqual([user, ...plan.omit.slice(1)]);
		expect(plan.omit).toContain(marker);

		// Raw history keeps everything; the session stays one chain.
		const branch = sm.getBranch();
		const editTargets = branch
			.filter((entry) => entry.type === "context_edit")
			.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
		expect(editTargets).toEqual(plan.omit);
		const tree = sm.getTree();
		expect(tree.length).toBe(1);
		let node = tree[0];
		let count = 0;
		while (node) {
			count++;
			expect(node.children.length).toBeLessThanOrEqual(1);
			node = node.children[0];
		}
		expect(count).toBe(branch.length);
	});
});

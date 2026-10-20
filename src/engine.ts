/**
 * Restate engine: a pure plan-or-refusal function over the session branch.
 *
 * Given the active branch (root-to-leaf entry list, as returned by
 * `SessionManager.getBranch()`), it decides which entries a `/restate` must
 * omit from model context and what to restore to the editor — or why it must
 * refuse. It performs no I/O and mutates nothing; the command glue applies
 * the returned plan.
 *
 * Semantics (ADR-0001):
 * - The target is the first user message entry found walking from the leaf.
 *   It must be Live: present in the current session projection (GLOSSARY.md).
 * - The retraction set is the target plus every context-producing entry after
 *   it up to the leaf. Entries already omitted are skipped.
 * - System messages, model changes, thinking-level changes, labels, usage,
 *   and custom entries are never nulled.
 * - Refusals are typed: usage | nothing-to-restate | already-retracted |
 *   compaction.
 */

import { buildSessionProjection } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
	READONLY_TOOL_NAMES,
	type RestateDecision,
	type RestateMutatingCall,
} from "./types";

export interface PlanRestateOptions {
	/** Raw argument string passed to `/restate`. Anything non-empty refuses with `usage`. */
	args?: string;
}

/** Decide a Restate for the given branch. Pure: no reads or writes outside its input. */
export function planRestate(branch: readonly SessionEntry[], options: PlanRestateOptions = {}): RestateDecision {
	if ((options.args ?? "").trim() !== "") {
		return { reason: "usage" };
	}

	const { projected, live } = projectionSets(branch);

	// Target resolution: walk from the leaf; the first user message entry
	// encountered is the target ("the message I last sent"). Repeated use
	// never peels deeper: a dead latest user message refuses instead. A
	// target nulled by a context edit (a previous Restate, or Pi's own
	// recovery) refuses as already-retracted; a target absent from the
	// projection was absorbed by a compaction summary, which no edit can
	// retract, so that refuses as a compaction crossing.
	let targetIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "user") {
			if (!live.has(entry.id)) {
				return projected.has(entry.id)
					? { reason: "already-retracted" }
					: { reason: "compaction" };
			}
			targetIndex = i;
			break;
		}
	}
	if (targetIndex === -1) {
		return { reason: "nothing-to-restate" };
	}

	const target = branch[targetIndex];
	if (!target || target.type !== "message") {
		// Unreachable given the walk above; keeps noUncheckedIndexedAccess honest.
		return { reason: "nothing-to-restate" };
	}

	// Retraction set: the target plus every context-producing entry after it
	// up to the leaf. Entries already omitted are skipped so redundant edits
	// do not pile up in the session file. An entry absent from the projection
	// would mean compaction-absorbed content inside the range (unreachable
	// when the target itself is live, since the latest compaction retains
	// everything from the target on); refusing is the safe answer if it
	// ever occurs.
	const omit: string[] = [target.id];
	for (let j = targetIndex + 1; j < branch.length; j++) {
		const entry = branch[j];
		if (!entry || !isRetractable(entry)) {
			continue;
		}
		if (live.has(entry.id)) {
			omit.push(entry.id);
		} else if (!projected.has(entry.id)) {
			return { reason: "compaction" };
		}
	}

	const { text, images } = userContentParts((target.message as UserMessage).content);
	const mutatingCalls = scanMutatingCalls(branch, targetIndex);

	return {
		target: target.id,
		omit,
		restoredText: text,
		imagesDropped: images,
		mutatingCalls,
	};
}

/**
 * Join restored prompt text with existing editor text without overwriting it.
 * Pi dumps queued steer messages back into the editor when a run aborts, so
 * the restored prompt is prepended and the queued text kept below it.
 */
export function joinRestoredText(restored: string, existing: string): string {
	const kept = existing.trim();
	if (kept === "") {
		return restored;
	}
	return `${restored}\n\n${kept}`;
}

/**
 * Liveness sets derived from one projection pass over the branch.
 *
 * `projected`: entry ids the projection selects at all (compaction-aware).
 * An entry absent from it has been absorbed by a compaction summary. `live`:
 * entry ids that currently contribute messages to the model context — Pi's
 * own projection applies context edits (latest wins) and compaction
 * retention, so "Live" here means exactly what GLOSSARY.md defines. An entry
 * in `projected` but not `live` was nulled by a context edit.
 */
function projectionSets(branch: readonly SessionEntry[]): {
	projected: Set<string>;
	live: Set<string>;
} {
	const leafId = branch[branch.length - 1]?.id ?? null;
	const projection = buildSessionProjection([...branch], leafId);
	const projected = new Set<string>();
	const live = new Set<string>();
	for (const entry of projection.entries) {
		projected.add(entry.sourceEntry.id);
		if (entry.messages.length > 0) {
			live.add(entry.sourceEntry.id);
		}
	}
	return { projected, live };
}

/**
 * Whether an entry type may be nulled by a context edit: user, assistant,
 * and tool-result message entries plus extension custom messages. System
 * messages, model/thinking/label/usage/custom/compaction entries are never
 * nulled; compaction entries additionally are not valid edit targets.
 */
function isRetractable(entry: SessionEntry): boolean {
	if (entry.type === "custom_message") {
		return true;
	}
	if (entry.type === "message") {
		return entry.message.role !== "system";
	}
	return false;
}

/** Extract editable text and count dropped image blocks from a user message. */
function userContentParts(content: UserMessage["content"]): { text: string; images: number } {
	if (typeof content === "string") {
		return { text: content, images: 0 };
	}
	const texts: string[] = [];
	let images = 0;
	for (const block of content) {
		if (isTextBlock(block)) {
			texts.push(block.text);
		} else {
			images++;
		}
	}
	return { text: texts.join("\n"), images };
}

function isTextBlock(block: TextContent | ImageContent): block is TextContent {
	return block.type === "text";
}

/**
 * Collect file-mutating tool calls in the retraction range (the target to
 * the leaf), counted per tool name in first-appearance order. A call
 * mutates unless its tool is known readonly (READONLY_TOOL_NAMES), so
 * `powershell`, MCP tools, and unknown names all count. Already-nulled
 * entries inside the range still count: their files changed just the same.
 * Calls nested inside another tool's execution (codemode-style) are carried
 * on the tool result's nestedCalls record and count under their own name;
 * that record is bounded, so size-dropped nested calls can undercount.
 */
function scanMutatingCalls(branch: readonly SessionEntry[], targetIndex: number): RestateMutatingCall[] {
	const counts = new Map<string, number>();
	const count = (toolName: string): void => {
		if (!READONLY_TOOL_NAMES.includes(toolName)) {
			counts.set(toolName, (counts.get(toolName) ?? 0) + 1);
		}
	};
	for (let i = targetIndex; i < branch.length; i++) {
		const entry = branch[i];
		if (!entry || entry.type !== "message") {
			continue;
		}
		const message = entry.message;
		if (message.role === "assistant" && typeof message.content !== "string") {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					count(block.name);
				}
			}
		} else if (message.role === "toolResult" && message.nestedCalls) {
			for (const nested of message.nestedCalls.calls) {
				count(nested.name);
			}
		}
	}
	return [...counts.entries()].map(([toolName, count]) => ({ toolName, count }));
}

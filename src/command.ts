/**
 * Command glue for `/restate`. Thin on purpose: all decisions live in the
 * engine (`./engine.ts`); this module waits for the session to settle, asks
 * for a plan, applies it with append-only entries, restores the prompt to
 * the editor, and notifies the user.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { joinRestoredText, planRestate } from "./engine";
import { retractedCounts } from "./marker";
import {
	MARKER_CUSTOM_TYPE,
	isRestatePlan,
	markerDataFromPlan,
	type RestateMutatingCall,
	type RestatePlan,
	type RestateRefusal,
} from "./types";

export function registerRestateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("restate", {
		description: "Retract the latest turn from model context and restore the prompt for editing",
		handler: async (args, ctx) => {
			// Mode guard: json/print hosts bind no UI. There is no
			// channel for the confirmation, the recovered text, or even a
			// refusal, so /restate is a no-op there rather than a blind
			// retraction — deny-by-default, never silent.
			if (!ctx.hasUI) {
				return;
			}
			// Extension commands dispatch immediately, even during streaming.
			// A Restate always targets the turn in flight: abort it first (like
			// Esc), then let the session settle before reading entries so the
			// plan sees the finalized aborted partial. In the TUI the
			// abort also dumps queued steer messages back into the editor;
			// restoreEditor joins them below the restored prompt instead of
			// overwriting them.
			if (!ctx.isIdle()) {
				ctx.abort();
			}
			await ctx.waitForIdle();

			// Settle → plan → confirm → apply. The confirm await is the one
			// window where an RPC client can start a new run (the TUI dialog
			// blocks input; a forwarded RPC confirm does not). If one did, the
			// plan is stale: abort, settle, and recompute against the newest
			// turn — which is what /restate targets anyway. Bounded so a chatty
			// client cannot loop forever.
			for (let attempt = 1; ; attempt++) {
				const branch = ctx.sessionManager.getBranch();
				const decision = planRestate(branch, { args });
				if (!isRestatePlan(decision)) {
					ctx.ui.notify(refusalMessage(decision), "warning");
					return;
				}
				// Persistent-operation gate: mutating calls in the
				// retraction range must be confirmed first. An unbound/no-op UI
				// answers false (deny), so headless hosts never get a silent
				// retraction. In RPC mode the dialog is forwarded as
				// an extension_ui_request; the timeout makes a client that never
				// answers auto-deny (pi core resolves expired confirms to false)
				// instead of blocking forever — forwarded when supported, refused
				// otherwise, never silently forced.
				if (decision.mutatingCalls.length > 0) {
					const { title, message } = confirmationDialog(decision.mutatingCalls);
					const granted = await ctx.ui.confirm(
						title,
						message,
						ctx.mode === "rpc" ? { timeout: RPC_CONFIRM_TIMEOUT_MS } : undefined,
					);
					if (!granted) {
						ctx.ui.notify(CANCELLED_MESSAGE, "info");
						return;
					}
					if (!ctx.isIdle()) {
						if (attempt >= MAX_CONFIRM_ATTEMPTS) {
							ctx.ui.notify(BUSY_DURING_CONFIRM_MESSAGE, "warning");
							return;
						}
						ctx.abort();
						await ctx.waitForIdle();
						continue;
					}
				}
				applyRestate(pi, ctx, decision);
				return;
			}
		},
	});
}

/** How long an RPC client has to answer the forwarded confirmation before pi core auto-resolves it as denied. */
export const RPC_CONFIRM_TIMEOUT_MS = 60_000;

/** Cap for the plan-confirm-replan loop; beyond it the session is too busy to restate. */
const MAX_CONFIRM_ATTEMPTS = 3;

/** Copy for the loop cap: loud, never silent. */
const BUSY_DURING_CONFIRM_MESSAGE =
	"/restate gave up: new prompts kept arriving during the confirmation. Run it again once the session is quiet.";

/** Apply a plan: context edits, marker entry, then mode-specific delivery of the recovered prompt. */
function applyRestate(pi: ExtensionAPI, ctx: ExtensionCommandContext, plan: RestatePlan): void {
	// The extension context types the manager as read-only; at runtime it is
	// the full SessionManager. Context edits are the documented append-only
	// mechanism this extension exists to use (ADR-0001).
	const sessionManager = ctx.sessionManager as SessionManager;
	for (const entryId of plan.omit) {
		sessionManager.appendContextEdit(entryId, null);
	}

	pi.appendEntry(MARKER_CUSTOM_TYPE, markerDataFromPlan(plan));

	if (ctx.mode === "rpc") {
		// RPC clients have no editor (getEditorText is always "" there), so the
		// recovered prompt travels in the success notification. The marker
		// stays the only success feedback in the TUI.
		ctx.ui.notify(rpcSuccessNotification(plan, ctx.hasPendingMessages()), "info");
	} else {
		restoreEditor(ctx, plan.restoredText);
	}
}

/**
 * Put the retracted text back into the input editor, joined with (not
 * overwriting) any text already there. Reached only in TUI mode: RPC
 * delivers via notification instead (applyRestate), and json/print never
 * get past the hasUI guard.
 */
function restoreEditor(ctx: ExtensionCommandContext, restoredText: string): void {
	if (restoredText === "") {
		return;
	}
	ctx.ui.setEditorText(joinRestoredText(restoredText, ctx.ui.getEditorText()));
}

/** User-facing copy for refusals. */
export function refusalMessage(refusal: RestateRefusal): string {
	switch (refusal.reason) {
		case "usage":
			return "/restate takes no arguments. It always retracts the message you last sent.";
		case "nothing-to-restate":
			return "Nothing to restate: no user message on the active branch.";
		case "already-retracted":
			return "The latest user message is already retracted. /restate never peels deeper into history.";
		case "compaction":
			return "Refused: retracting this turn would cross a compaction boundary.";
	}
}

/** Copy shown when the user denies the confirmation: the Restate is cancelled, nothing written. */
const CANCELLED_MESSAGE = "Restate cancelled — nothing was retracted.";

/** Render the scan as "name ×count" pairs, first-appearance order. */
export function summarizeMutatingCalls(calls: readonly RestateMutatingCall[]): string {
	return calls.map(({ toolName, count }) => `${toolName} ×${count}`).join(", ");
}

/**
 * Copy for the RPC-only success notification: an RPC client
 * has neither transcript (marker) nor editor, so the notification carries
 * the marker-style counts plus the recovered prompt text itself. Wording
 * follows the marker vocabulary (marker.ts). With queued steering/follow-up
 * messages still pending (they survive an RPC abort — only the TUI dumps
 * them to its editor, and extensions have no queue API), the note makes
 * that loud instead of silently breaking the retraction promise: they will
 * deliver with the next prompt.
 */
export function rpcSuccessNotification(plan: RestatePlan, hasPendingMessages = false): string {
	const summary = `Restated — ${retractedCounts(plan.omit.length, plan.imagesDropped)} retracted from model context.`;
	const pending = hasPendingMessages
		? "\nNote: queued steering/follow-up messages are still pending. They cannot be retracted or dumped in RPC mode and will deliver with the next prompt."
		: "";
	if (plan.restoredText === "") {
		return summary + pending;
	}
	return `${summary}\nRecovered prompt:\n${plan.restoredText}${pending}`;
}

/**
 * Copy for the persistent-operation confirmation dialog: the
 * scan summary plus the explicit warning that modified files stay modified.
 */
export function confirmationDialog(calls: readonly RestateMutatingCall[]): {
	title: string;
	message: string;
} {
	return {
		title: "Confirm restate",
		message:
			`The turn you are retracting contains tool calls: ${summarizeMutatingCalls(calls)}.\n` +
			"Files modified by these tools will not be rolled back.",
	};
}

/**
 * Seam contract for pi-restate.
 *
 * The engine decides, the glue applies. Everything the command needs in order
 * to retract a turn is captured here as plain data, so the decision logic is
 * unit-testable without a TUI.
 */

/** Custom-entry type of the pi-restate marker appended after each Restate. */
export const MARKER_CUSTOM_TYPE = "pi-restate";

/** Marker payload version, for forward compatibility of stored sessions. */
export const MARKER_VERSION = 1;

/**
 * Tool names whose calls are known not to modify files. Everything else
 * counts as file-mutating: readonly `bash`/`powershell` usage is
 * undetectable, so both always count, and unknown names — MCP tools,
 * extension tools, future built-ins — count too rather than slip the
 * confirmation gate. The confirmation gate in command.ts consults the
 * plan's mutatingCalls; the engine only reports what it saw.
 */
export const READONLY_TOOL_NAMES: readonly string[] = ["read", "grep", "find", "ls"];

export type RestateRefusalReason =
	| "usage"
	| "nothing-to-restate"
	| "already-retracted"
	| "compaction";

/** A mutating tool's calls inside the Retracted Turn, counted per tool name. */
export interface RestateMutatingCall {
	toolName: string;
	/** Number of calls to {@link toolName} found in the retraction range. */
	count: number;
}

/**
 * What to retract: the plan half of the seam contract.
 *
 * - `target`: entry id of the retracted Live user message.
 * - `omit`: entry ids to null via append-only context edits, in branch order,
 *   target first. Entries already omitted (by a previous Restate or by Pi's
 *   own recovery) are skipped, so redundant edits never pile up.
 * - `restoredText`: the target's text content, for the input editor. Image
 *   blocks are dropped and counted in `imagesDropped` instead.
 * - `mutatingCalls`: calls to file-mutating tools found in the retraction
 *   range, counted per tool name. A tool mutates unless it is in
 *   {@link READONLY_TOOL_NAMES}; calls nested inside another tool's
 *   execution (codemode-style) count under their own name. Consumed by the
 *   confirmation gate: a non-empty list must be confirmed
 *   before the plan is applied.
 */
export interface RestatePlan {
	target: string;
	omit: string[];
	restoredText: string;
	imagesDropped: number;
	mutatingCalls: RestateMutatingCall[];
}

/** The refusal half of the seam contract. */
export interface RestateRefusal {
	reason: RestateRefusalReason;
}

export type RestateDecision = RestatePlan | RestateRefusal;

export function isRestatePlan(decision: RestateDecision): decision is RestatePlan {
	return (decision as RestatePlan).omit !== undefined;
}

/**
 * Payload of the `pi-restate` custom entry appended after the last context
 * edit of a Restate. Counts and ids only; the retracted prompt text is
 * restored to the editor, never stored in the marker.
 */
export interface RestateMarkerData {
	version: typeof MARKER_VERSION;
	targetId: string;
	omittedIds: string[];
	omittedCount: number;
	imagesDropped: number;
}

export function markerDataFromPlan(plan: RestatePlan): RestateMarkerData {
	return {
		version: MARKER_VERSION,
		targetId: plan.target,
		omittedIds: [...plan.omit],
		omittedCount: plan.omit.length,
		imagesDropped: plan.imagesDropped,
	};
}

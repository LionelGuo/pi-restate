/**
 * pi-restate: a Pi extension providing `/restate`.
 *
 * Retracts the latest Live user message and the model output after it from
 * model context via append-only context edits, keeping the session on a
 * single chain, and restores the retracted prompt to the input editor.
 * See GLOSSARY.md and docs/adr/0001-restate-via-context-edit.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRestateCommand } from "./command";
import { registerRestateMarker } from "./marker";

export { planRestate, joinRestoredText } from "./engine";
export type { PlanRestateOptions } from "./engine";
export {
	MARKER_CUSTOM_TYPE,
	MARKER_VERSION,
	READONLY_TOOL_NAMES,
	isRestatePlan,
	markerDataFromPlan,
} from "./types";
export type {
	RestateDecision,
	RestateMarkerData,
	RestateMutatingCall,
	RestatePlan,
	RestateRefusal,
	RestateRefusalReason,
} from "./types";

export default function restateExtension(pi: ExtensionAPI): void {
	registerRestateCommand(pi);
	registerRestateMarker(pi);
}

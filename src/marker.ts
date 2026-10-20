/**
 * Marker rendering for the `pi-restate` custom entry. The Retracted Turn
 * stays visible in raw history (ADR-0001); this marker line explains what
 * happened at the retraction point instead of leaving it confusing.
 *
 * Form follows Pi's native precedent for history bookkeeping events, the
 * compaction summary message (compaction-summary-message.ts): bold bracket
 * label in `customMessageLabel`, terse past-participle text in
 * `customMessageText`, on the shared `customMessageBg` block. In the TUI the
 * marker is the only success feedback — compaction has no success
 * notification either; transient notices are reserved for refusals
 * (command.ts). RPC clients see neither transcript nor editor, so there the
 * success notification is the delivery channel (command.ts);
 * both surfaces share the counts vocabulary below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { MARKER_CUSTOM_TYPE, MARKER_VERSION, type RestateMarkerData } from "./types";

/**
 * The shared counts vocabulary — "3 entries (1 image dropped)" — used by both
 * success surfaces: the marker line (TUI) and the RPC success notification
 * (command.ts), so the wording cannot drift between them.
 */
export function retractedCounts(entriesCount: number, imagesDropped: number): string {
	const entries = `${entriesCount} ${entriesCount === 1 ? "entry" : "entries"}`;
	const images =
		imagesDropped > 0 ? ` (${imagesDropped} image${imagesDropped === 1 ? "" : "s"} dropped)` : "";
	return `${entries}${images}`;
}

export function registerRestateMarker(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<RestateMarkerData>(MARKER_CUSTOM_TYPE, (entry, _options, theme) => {
		const data = entry.data ?? emptyMarker();
		const label = theme.fg("customMessageLabel", `\x1b[1m[restate]\x1b[22m`);
		const body = theme.fg(
			"customMessageText",
			`Retracted ${retractedCounts(data.omittedCount, data.imagesDropped)}`,
		);
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${label} ${body}`, 0, 0));
		return box;
	});
}

function emptyMarker(): RestateMarkerData {
	return {
		version: MARKER_VERSION,
		targetId: "",
		omittedIds: [],
		omittedCount: 0,
		imagesDropped: 0,
	};
}

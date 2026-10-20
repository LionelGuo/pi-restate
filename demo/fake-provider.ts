/**
 * Demo fake provider: a Pi extension registering a deterministic, offline
 * provider used to demo `/restate` run states in the real TUI
 * without an API key or network.
 *
 * Each request reads the JSON script file at $FAKE_SCRIPT (default
 * /tmp/pi-restate-demo/script.json) and behaves accordingly:
 *
 *   { "mode": "hang",  "text": "..." }  stream words slowly, then stall until aborted
 *   { "mode": "error", "text": "...", "errorMessage": "..." }  stream, then fail
 *   { "mode": "text",  "text": "..." }  stream, then complete
 *
 * Run the demo with:
 *
 *   pi --no-extensions -nc --no-session \
 *      -e demo/fake-provider.ts -e ./src/index.ts \
 *      --model fake-restate/fake-model
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";

interface Script {
	mode: "hang" | "error" | "text";
	text?: string;
	errorMessage?: string;
}

const SCRIPT_PATH = process.env.FAKE_SCRIPT ?? "/tmp/pi-restate-demo/script.json";
const WORD_DELAY_MS = 350;

function readScript(): Script {
	try {
		return JSON.parse(readFileSync(SCRIPT_PATH, "utf-8")) as Script;
	} catch {
		return { mode: "text", text: "ok" };
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const model: Model<"pi-messages"> = {
	id: "fake-model",
	name: "Fake Demo Model",
	api: "pi-messages",
	provider: "fake-restate",
	baseUrl: "http://fake.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function stream(script: Script, model: Model<"pi-messages">, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const eventStream = createAssistantMessageEventStream();
	void (async () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		eventStream.push({ type: "start", partial });

		const words = (script.text ?? "").split(" ").filter((word) => word !== "");
		partial.content.push({ type: "text", text: "" });
		const contentIndex = partial.content.length - 1;
		eventStream.push({ type: "text_start", contentIndex, partial });
		for (const word of words) {
			const soFar = partial.content[contentIndex];
			if (soFar?.type !== "text") continue;
			const next = soFar.text === "" ? word : `${soFar.text} ${word}`;
			partial.content[contentIndex] = { type: "text", text: next };
			eventStream.push({ type: "text_delta", contentIndex, delta: next, partial });
			await sleep(WORD_DELAY_MS);
		}
		if (words.length > 0 && partial.content[contentIndex]?.type === "text") {
			eventStream.push({
				type: "text_end",
				contentIndex,
				content: partial.content[contentIndex].text,
				partial,
			});
		}

		if (script.mode === "text") {
			partial.stopReason = "stop";
			eventStream.push({ type: "done", reason: "stop", message: partial });
			return;
		}
		if (script.mode === "error") {
			partial.stopReason = "error";
			partial.errorMessage = script.errorMessage ?? "Fake provider failure";
			eventStream.push({ type: "error", reason: "error", error: partial });
			return;
		}

		// hang: stall until the request is aborted
		const signal = options?.signal;
		if (signal?.aborted) {
			finishAborted(partial, eventStream);
			return;
		}
		await new Promise<void>((resolve) => {
			signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		finishAborted(partial, eventStream);
	})();
	return eventStream;
}

function finishAborted(partial: AssistantMessage, eventStream: AssistantMessageEventStream): void {
	partial.stopReason = "aborted";
	partial.errorMessage = "Aborted by user";
	eventStream.push({ type: "error", reason: "aborted", error: partial });
}

const provider: Provider = {
	id: "fake-restate",
	name: "Fake Restate Demo Provider",
	auth: {
		apiKey: {
			name: "Fake API key",
			resolve: async () => ({ auth: { apiKey: "fake-key" }, source: "demo fixture" }),
		},
	},
	getModels: () => [model],
	stream: (streamModel, _context, options) =>
		stream(readScript(), streamModel as Model<"pi-messages">, options as SimpleStreamOptions),
	streamSimple: (streamModel, _context, options) =>
		stream(readScript(), streamModel as Model<"pi-messages">, options),
};

export default function fakeProviderExtension(pi: ExtensionAPI): void {
	pi.registerProvider(provider);
}

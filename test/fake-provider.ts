/**
 * A deterministic fake provider for the SDK integration tests: a headless
 * session driving real turns against scripted provider behavior. Each turn
 * pops the next script; an exhausted queue answers with a plain "ok" so the
 * provider never blocks a test by accident.
 *
 * Scripts model the three busy-state run states:
 * - `text`: a turn that completes normally.
 * - `hang`: a turn that streams some text, then stalls until aborted —
 *   the mid-stream `/restate` and Esc-abort shapes.
 * - `error`: a turn that streams some text, then fails — the
 *   provider-error-interrupted shape. The message deliberately matches no
 *   retryable-error pattern, so Pi fails the turn instead of retrying it.
 */

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

export type FakeTurn =
	| { kind: "text"; text: string }
	| { kind: "hang"; text: string }
	| { kind: "error"; text: string; errorMessage: string };

export interface FakeProviderRuntime {
	provider: Provider;
	model: Model<"pi-messages">;
	/** Scripts for upcoming turns, consumed in order. */
	turns: FakeTurn[];
}

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

export function createFakeProvider(): FakeProviderRuntime {
	const turns: FakeTurn[] = [];

	const model: Model<"pi-messages"> = {
		id: "fake-model",
		name: "Fake Model",
		api: "pi-messages",
		provider: "fake-restate",
		baseUrl: "http://fake.invalid",
		input: ["text"],
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	const provider: Provider = {
		id: "fake-restate",
		name: "Fake Restate Provider",
		auth: {
			apiKey: {
				name: "Fake API key",
				resolve: async () => ({ auth: { apiKey: "fake-key" }, source: "test fixture" }),
			},
		},
		getModels: () => [model],
		stream: (streamModel, context, options) =>
			runScript(turns, streamModel as Model<"pi-messages">, context, options as SimpleStreamOptions),
		streamSimple: (streamModel, context, options) =>
			runScript(turns, streamModel as Model<"pi-messages">, context, options),
	};

	return { provider, model, turns };
}

function runScript(
	turns: FakeTurn[],
	model: Model<"pi-messages">,
	_context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const turn = turns.shift() ?? { kind: "text" as const, text: "ok" };

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
		stream.push({ type: "start", partial });

		if (turn.text !== "") {
			partial.content.push({ type: "text", text: "" });
			const contentIndex = partial.content.length - 1;
			stream.push({ type: "text_start", contentIndex, partial });
			partial.content[contentIndex] = { type: "text", text: turn.text };
			stream.push({ type: "text_delta", contentIndex, delta: turn.text, partial });
			stream.push({ type: "text_end", contentIndex, content: turn.text, partial });
		}

		if (turn.kind === "text") {
			partial.stopReason = "stop";
			partial.usage.output = 1;
			partial.usage.totalTokens = 1;
			stream.push({ type: "done", reason: "stop", message: partial });
			return;
		}

		if (turn.kind === "error") {
			partial.stopReason = "error";
			partial.errorMessage = turn.errorMessage;
			stream.push({ type: "error", reason: "error", error: partial });
			return;
		}

		// hang: stall until the request is aborted, then report the abort the
		// way real providers do.
		const signal = options?.signal;
		if (signal?.aborted) {
			finishAborted(partial, stream);
			return;
		}
		await new Promise<void>((resolve) => {
			signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		finishAborted(partial, stream);
	})();

	return stream;
}

function finishAborted(partial: AssistantMessage, stream: AssistantMessageEventStream): void {
	partial.stopReason = "aborted";
	partial.errorMessage = "Aborted by user";
	stream.push({ type: "error", reason: "aborted", error: partial });
}

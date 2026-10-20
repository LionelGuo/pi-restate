/**
 * Fixture provider for the RPC child-process tests: a
 * Pi extension registering a deterministic, offline provider so a real
 * `pi --mode rpc` / `--print` child can drive a turn containing a mutating
 * (bash) tool call without a network or API key.
 *
 * Behavior is read per request from the JSON script at $RPC_FIXTURE_SCRIPT:
 *
 *   { "mode": "text" }                 answer with plain text
 *   { "mode": "bash", "text": "..." }  first request emits a bash toolCall
 *                                      (`echo pi-restate-rpc-ok`); the next
 *                                      request — after the tool result —
 *                                      completes with text
 *
 * A missing or unparsable script falls back to "text". Bash toolCalls run
 * for real inside the child; the fixture only ever issues a harmless echo.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type Provider,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { appendFileSync, readFileSync } from "node:fs";

interface Script {
	mode: "text" | "bash";
	text?: string;
}

const SCRIPT_PATH = process.env.RPC_FIXTURE_SCRIPT ?? "";

function readScript(): Script {
	try {
		return JSON.parse(readFileSync(SCRIPT_PATH, "utf-8")) as Script;
	} catch {
		return { mode: "text" };
	}
}

const model: Model<"pi-messages"> = {
	id: "fake-model",
	name: "Fake RPC Fixture Model",
	api: "pi-messages",
	provider: "fake-rpc",
	baseUrl: "http://fake.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
};

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
	};
}

/** Flips after the bash toolCall was issued so the post-tool request completes with text. */
let toolCallIssued = false;

/** Record what the model was actually sent (roles + content) — one JSON line per request. */
function logContext(context: TranscriptContext): void {
	const path = process.env.RPC_FIXTURE_LOG;
	if (!path) {
		return;
	}
	appendFileSync(
		path,
		`${JSON.stringify(
			context.messages.map((message) => ({ role: message.role, content: message.content })),
		)}\n`,
	);
}

function stream(
	script: Script,
	streamModel: Model<"pi-messages">,
	context: TranscriptContext,
): AssistantMessageEventStream {
	logContext(context);
	const eventStream = createAssistantMessageEventStream();
	void (async () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: streamModel.api,
			provider: streamModel.provider,
			model: streamModel.id,
			usage: emptyUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
		eventStream.push({ type: "start", partial });

		if (script.mode === "bash" && !toolCallIssued) {
			toolCallIssued = true;
			partial.content.push({
				type: "toolCall",
				id: "call_rpc_1",
				name: "bash",
				arguments: { command: "echo pi-restate-rpc-ok" },
			});
			eventStream.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: partial.content[0] as Extract<typeof partial.content[0], { type: "toolCall" }>,
				partial,
			});
			partial.stopReason = "toolUse";
			eventStream.push({ type: "done", reason: "toolUse", message: partial });
			return;
		}

		const text = script.text ?? "ok";
		partial.content.push({ type: "text", text });
		eventStream.push({ type: "text_start", contentIndex: 0, partial });
		eventStream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		eventStream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		partial.stopReason = "stop";
		eventStream.push({ type: "done", reason: "stop", message: partial });
	})();
	return eventStream;
}

const provider: Provider = {
	id: "fake-rpc",
	name: "Fake RPC Fixture Provider",
	auth: {
		apiKey: {
			name: "Fake API key",
			resolve: async () => ({ auth: { apiKey: "fake-key" }, source: "rpc fixture" }),
		},
	},
	getModels: () => [model],
	stream: (streamModel, context) =>
		stream(readScript(), streamModel as Model<"pi-messages">, context),
	streamSimple: (streamModel, context) =>
		stream(readScript(), streamModel as Model<"pi-messages">, context),
};

export default function rpcFixtureProviderExtension(pi: ExtensionAPI): void {
	pi.registerProvider(provider);
}

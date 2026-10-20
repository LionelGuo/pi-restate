/**
 * Fixture builders over a real in-memory SessionManager (real Pi classes,
 * never mocks of them). Assertions stay at the engine seam: fixtures in,
 * plans/refusals out.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SettingsManager,
	type AgentSession,
	type ExtensionCommandContextActions,
	type ExtensionUIContext,
	type FileEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import restateExtension from "../src/index";
import type { FakeProviderRuntime } from "./fake-provider";

/** Host mode for bindExtensions, derived from the real API (core calls it ExtensionMode: "tui" | "rpc" | "json" | "print"). */
type HostMode = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["mode"]>;

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function newSession(entries?: FileEntry[]): SessionManager {
	return SessionManager.inMemory(undefined, undefined, entries);
}

export function appendSystem(sm: SessionManager, text = "You are a test assistant."): string {
	return sm.appendMessage({ role: "system", content: text, timestamp: Date.now() });
}

export function appendUser(sm: SessionManager, content: string): string {
	return sm.appendMessage({ role: "user", content, timestamp: Date.now() });
}

export function appendUserBlocks(
	sm: SessionManager,
	blocks: { text?: string; image?: string }[],
): string {
	const content = blocks.map((block) =>
		block.text !== undefined
			? { type: "text" as const, text: block.text }
			: { type: "image" as const, data: block.image ?? "aW1hZ2U=", mimeType: "image/png" },
	);
	return sm.appendMessage({ role: "user", content, timestamp: Date.now() });
}

export function appendAssistant(sm: SessionManager, text: string): string {
	return sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

export function appendAssistantToolCall(
	sm: SessionManager,
	toolName: string,
	toolCallId: string,
): string {
	return sm.appendMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

export function appendToolResult(
	sm: SessionManager,
	toolCallId: string,
	toolName: string,
	text: string,
	nestedCalls?: { name: string }[],
): string {
	return sm.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		nestedCalls: nestedCalls
			? {
					calls: nestedCalls.map((call, index) => ({
						id: `${toolCallId}/nested-${index}`,
						name: call.name,
						status: "ok" as const,
					})),
					complete: true,
				}
			: undefined,
		isError: false,
		timestamp: Date.now(),
	});
}

/** Apply a plan's omissions the way the command glue does. */
export function applyOmissions(sm: SessionManager, omit: readonly string[]): void {
	for (const entryId of omit) {
		sm.appendContextEdit(entryId, null);
	}
}

/** A notification captured by {@link recordingUIContext}. */
export interface UINotification {
	message: string;
	type: "info" | "warning" | "error";
}

/** A confirmation dialog opened by an extension, with the copy and options it was shown. */
export interface UIConfirmCall {
	title: string;
	message: string;
	/** Dialog options the caller passed (the rpc-mode confirmation timeout). */
	options?: { timeout?: number };
}

/**
 * A headless ExtensionUIContext whose notify() records calls instead of
 * discarding them. Every other member mirrors Pi's own no-op UI context, so
 * command dispatch behaves exactly as in print mode while notifications,
 * dialog opens, and editor writes become observable. Bind it via
 * session.bindExtensions(). `confirmAnswer` controls what confirmation
 * dialogs return (deny, like Pi's no-op UI, by default).
 */
export function recordingUIContext(
	options: {
		confirmAnswer?: boolean;
		/** Runs while a confirm dialog is open, before it resolves — simulates an RPC client acting inside the confirmation window. */
		beforeConfirmResolve?: () => void | Promise<void>;
	} = {},
): {
	uiContext: ExtensionUIContext;
	notifications: UINotification[];
	/** Dialog kinds opened (select/confirm/input/editor/custom); the confirmation gate records "confirm". */
	dialogs: string[];
	/** Confirm dialogs opened, with their title and message, oldest first. */
	confirmCalls: UIConfirmCall[];
	/** The fake input editor: read what /restate restored into it. */
	editor: { get(): string; set(text: string): void };
} {
	const notifications: UINotification[] = [];
	const dialogs: string[] = [];
	const confirmCalls: UIConfirmCall[] = [];
	let editorText = "";
	const uiContext = {
		select: async () => {
			dialogs.push("select");
			return undefined;
		},
		confirm: async (
			title: string,
			message: string,
			dialogOptions?: UIConfirmCall["options"],
		) => {
			dialogs.push("confirm");
			confirmCalls.push({ title, message, options: dialogOptions });
			await options.beforeConfirmResolve?.();
			return options.confirmAnswer ?? false;
		},
		input: async () => {
			dialogs.push("input");
			return undefined;
		},
		notify: (message: string, type: "info" | "warning" | "error" = "info") => {
			notifications.push({ message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => {
			dialogs.push("custom");
			return undefined as never;
		},
		pasteToEditor: () => {},
		setEditorText: (text: string) => {
			editorText = text;
		},
		getEditorText: () => editorText,
		editor: async () => {
			dialogs.push("editor");
			return undefined;
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return undefined as never;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false as const, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} as unknown as ExtensionUIContext;
	return {
		uiContext,
		notifications,
		dialogs,
		confirmCalls,
		editor: { get: () => editorText, set: (text: string) => (editorText = text) },
	};
}

/** Assert helper: ids of entries of a given type on the branch. */
export function idsOfType(branch: readonly SessionEntry[], type: SessionEntry["type"]): string[] {
	return branch.filter((entry) => entry.type === type).map((entry) => entry.id);
}

/** A fixture turn whose retraction range triggers the confirmation gate: one mutating bash call. */
export function appendBashTurn(sm: SessionManager, userText = "Fix the bug via bash."): void {
	appendSystem(sm);
	appendUser(sm, userText);
	appendAssistantToolCall(sm, "bash", "call_1");
	appendToolResult(sm, "call_1", "bash", "fixed");
}

/** Wait until the in-flight run has streamed its first text delta. */
export async function waitStreaming(session: AgentSession): Promise<void> {
	await new Promise<void>((resolve) => {
		const unsubscribe = session.subscribe((event) => {
			if (
				event.type === "message_update" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				unsubscribe();
				resolve();
			}
		});
	});
}

/** Target ids of the context_edit entries on the branch, oldest first. */
export function contextEditTargets(sm: SessionManager): string[] {
	return sm
		.getBranch()
		.filter((entry) => entry.type === "context_edit")
		.map((entry) => (entry.type === "context_edit" ? entry.targetId : ""));
}

/** Bindings a host (TUI/RPC) supplies for busy-state command dispatch. */
export interface SessionHostBindings {
	uiContext?: ExtensionUIContext;
	/** Host mode; drives the command's mode guards ("tui" | "rpc"). */
	mode?: HostMode;
	/** Mirrors the TUI's commandContextActions binding (interactive-mode.js): waitForIdle over the session. */
	commandContextActions?: ExtensionCommandContextActions;
	/** Mirrors the TUI's abortHandler binding: called when an extension aborts the session. */
	abortHandler?: () => void;
}

/**
 * The host bindings tests need, in the minimal shape the TUI and RPC hosts
 * supply: real waitForIdle/abort over the session, and an abort handler that
 * dumps queued steer messages back into the editor before aborting —
 * mirroring the TUI's restoreQueuedMessagesToEditor({ abort: true }) path
 * (pi-coding-agent v1.3.0, interactive-mode.js) that /restate's editor
 * restore must preserve. If the upstream dump shape changes,
 * this mirror must follow. `mode` selects which host the command's mode
 * guards see: "tui" by default, "rpc" for the RPC-mode tests
 * — the real RPC host binds the same shape (rpc-mode.js).
 */
export function hostBindings(
	session: AgentSession,
	ui: ReturnType<typeof recordingUIContext>,
	mode: HostMode = "tui",
	options: { bindAbortHandler?: boolean } = {},
): SessionHostBindings {
	return {
		uiContext: ui.uiContext,
		mode,
		commandContextActions: {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		},
		// The TUI-style queue dump (below) is bound by default so TUI tests
		// mirror interactive-mode.js. `bindAbortHandler: false` reproduces the
		// real RPC host, which binds no abortHandler — queued messages survive
		// an abort there (the RPC limitation the success notification warns
		// about).
		...(options.bindAbortHandler === false
			? {}
			: {
					abortHandler: () => {
						// Mirrors interactive-mode.js: queued messages first, existing editor
						// text after, then the abort itself.
						const { steering, followUp } = session.clearQueue();
						const queued = [...steering, ...followUp].join("\n\n");
						ui.editor.set(
							[queued, ui.editor.get()].filter((text) => text.trim() !== "").join("\n\n"),
						);
						void session.abort();
					},
			}),
	};
}

const sessions: AgentSession[] = [];

/**
 * A headless SDK session with the restate extension registered.
 * Prompting it dispatches `/restate` through the real command path; host
 * bindings mirror what the TUI supplies, and `fake` wires the session to a
 * deterministic fake provider for driving real turns. Disposes every session
 * on test end.
 */
export async function newRestateSession(
	sm: SessionManager,
	options: {
		bindings?: SessionHostBindings | ((session: AgentSession) => SessionHostBindings);
		fake?: FakeProviderRuntime;
	} = {},
): Promise<AgentSession> {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-restate-test-"));
	const resourceLoader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		extensionFactories: [restateExtension],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const createOptions: Parameters<typeof createAgentSession>[0] = {
		resourceLoader,
		sessionManager: sm,
	};
	if (options.fake) {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
		});
		modelRuntime.registerNativeProvider(options.fake.provider);
		createOptions.modelRuntime = modelRuntime;
		createOptions.model = options.fake.model;
	}
	const { session } = await createAgentSession(createOptions);
	const bindings =
		typeof options.bindings === "function" ? options.bindings(session) : options.bindings;
	if (bindings?.uiContext || bindings?.commandContextActions || bindings?.abortHandler || bindings?.mode) {
		await session.bindExtensions(bindings);
	}
	sessions.push(session);
	return session;
}

export async function disposeRestateSessions(): Promise<void> {
	while (sessions.length > 0) {
		const session = sessions.pop();
		await session?.dispose();
	}
}

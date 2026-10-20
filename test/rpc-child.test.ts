/**
 * RPC mode and mode guards: a real `pi --mode rpc`
 * child process driven over the JSONL wire protocol, the way an IDE client
 * would. This is the fidelity check for the client-facing claims:
 *
 * - the file-modification confirmation is forwarded as an extension_ui_request
 *   (with a timeout, so a client that never answers gets an auto-deny from
 *   pi core rather than a blocked or silently-forced retraction);
 * - answering it completes the retraction, and the recovered prompt text
 *   arrives in the success notification (RPC has no editor);
 * - the next model call no longer sees the retracted turn — verified from
 *   the fixture provider's recorded inputs, the strongest available proof
 *   that "removed from model context" held end-to-end;
 * - print mode loads the extension cleanly and /restate is a guarded no-op.
 *
 * The model is the offline fixture provider (rpc-fixture-provider.ts).
 */

import { describe, expect, it } from "vitest";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RPC_CONFIRM_TIMEOUT_MS } from "../src/command";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
// The package exports map does not expose ./dist/cli.js, so resolve it on the
// filesystem instead (RpcClient's default lookup does the same).
const cliPath = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

/** A JSONL line from the child's stdout. */
type WireLine = Record<string, unknown> & { type: string };

/** The model-call inputs the fixture provider received, one entry per request (rpc-fixture-provider.ts). */
function fixtureLog(path: string): { role: string; content: unknown }[][] {
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { role: string; content: unknown }[]);
	} catch {
		return [];
	}
}

/** Drive one `pi --mode rpc` child: send lines, await lines. */
class RpcChild {
	readonly process: ChildProcess;
	private readonly lines: WireLine[] = [];
	private readonly waiters: {
		predicate: (line: WireLine) => boolean;
		resolve: (line: WireLine) => void;
	}[] = [];

	constructor(readonly cwd: string, readonly env: Record<string, string>) {
		this.process = spawn(process.execPath, [cliPath, ...rpcArgs()], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process.stdout!.setEncoding("utf-8");
		let buffer = "";
		this.process.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.trim() !== "") {
					this.receive(line);
				}
				newline = buffer.indexOf("\n");
			}
		});
	}

	private receive(line: string): void {
		let parsed: WireLine;
		try {
			parsed = JSON.parse(line) as WireLine;
		} catch {
			return; // non-JSON noise; RPC stdout should be pure JSONL
		}
		this.lines.push(parsed);
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			if (this.waiters[i]!.predicate(parsed)) {
				this.waiters[i]!.resolve(parsed);
				this.waiters.splice(i, 1);
			}
		}
	}

	send(line: Record<string, unknown>): void {
		this.process.stdin!.write(`${JSON.stringify(line)}\n`);
	}

	/**
	 * Resolve with the nth line (1-based) matching the predicate. Lines seen
	 * before the call count, so `occurrence: 2` waits for a second
	 * `agent_settled` even if the first was already consumed.
	 */
	async waitFor(
		predicate: (line: WireLine) => boolean,
		options: { timeoutMs?: number; occurrence?: number } = {},
	): Promise<WireLine> {
		const { timeoutMs = 30_000, occurrence = 1 } = options;
		const seen = this.lines.filter(predicate);
		if (seen.length >= occurrence) {
			return seen[occurrence - 1]!;
		}
		return new Promise<WireLine>((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) {
					this.waiters.splice(index, 1);
				}
				reject(new Error(`timed out waiting for line; got: ${JSON.stringify(this.lines)}`));
			}, timeoutMs);
			const waiter = {
				predicate,
				resolve: (value: WireLine) => {
					clearTimeout(timer);
					resolvePromise(value);
				},
			};
			this.waiters.push(waiter);
		});
	}

	async stop(): Promise<void> {
		if (this.process.exitCode !== null) {
			return;
		}
		this.process.kill("SIGTERM");
		await new Promise<void>((resolvePromise) => {
			const timer = setTimeout(() => {
				this.process.kill("SIGKILL");
				resolvePromise();
			}, 5_000);
			this.process.on("exit", () => {
				clearTimeout(timer);
				resolvePromise();
			});
		});
	}
}

function rpcArgs(): string[] {
	return [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"-e",
		join(repoRoot, "test", "rpc-fixture-provider.ts"),
		"-e",
		join(repoRoot, "src", "index.ts"),
		"--model",
		"fake-rpc/fake-model",
	];
}

/** A clean environment: PATH/HOME for the echo tool, the fixture script, nothing inherited. */
function childEnv(scriptPath: string, logPath: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: process.env.HOME ?? "/home",
		RPC_FIXTURE_SCRIPT: scriptPath,
		RPC_FIXTURE_LOG: logPath,
	};
}

function writeScript(dir: string, script: Record<string, unknown>): string {
	const path = join(dir, "script.json");
	writeFileSync(path, JSON.stringify(script));
	return path;
}

/** The shared rpc-child scaffold: temp dir, bash-turn script, model-input log, try/finally stop. */
async function withRpcChild(fn: (child: RpcChild, logPath: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-restate-rpc-"));
	const script = writeScript(dir, { mode: "bash", text: "done after the tool" });
	const logPath = join(dir, "model-inputs.jsonl");
	const child = new RpcChild(dir, childEnv(script, logPath));
	try {
		await fn(child, logPath);
	} finally {
		await child.stop();
	}
}

/** Drive the bash turn to completion, ready for a /restate. */
async function runBashTurn(child: RpcChild): Promise<void> {
	child.send({ id: "req-1", type: "prompt", message: "please run the command" });
	await child.waitFor((line) => line.type === "agent_settled");
}

describe("rpc mode over the real wire (child process)", () => {
	it(
		"forwards the confirmation, then delivers the recovered prompt via notification and retracts",
		async () => {
			await withRpcChild(async (child, logPath) => {
				await runBashTurn(child);

				child.send({ id: "req-2", type: "prompt", message: "/restate" });
				const confirm = await child.waitFor(
					(line) => line.type === "extension_ui_request" && line.method === "confirm",
				);
				expect(confirm.title).toBe("Confirm restate");
				// Pinned so a silent client provably gets the auto-deny window: pi
				// core resolves an expired forwarded confirm to false (rpc-mode.js),
				// which the command treats as a denial.
				expect(confirm.timeout).toBe(RPC_CONFIRM_TIMEOUT_MS);
				child.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });

				const notify = await child.waitFor(
					(line) => line.type === "extension_ui_request" && line.method === "notify",
				);
				expect(notify.notifyType).toBe("info");
				expect(String(notify.message)).toContain("please run the command");
				// user + toolCall assistant + toolResult + closing assistant = 4 entries
				expect(String(notify.message)).toContain("4 entries retracted");

				const response = await child.waitFor(
					(line) => line.type === "response" && line.command === "prompt" && line.id === "req-2",
				);
				expect(response.success).toBe(true);

				// The next model call must not see the retracted turn.
				child.send({ id: "req-3", type: "prompt", message: "thanks, go on" });
				await child.waitFor((line) => line.type === "agent_settled", { occurrence: 2 });
				const lastInput = fixtureLog(logPath).at(-1)!;
				const flat = JSON.stringify(lastInput);
				expect(flat).not.toContain("please run the command");
				expect(flat).not.toContain("pi-restate-rpc-ok");
				expect(flat).not.toContain("done after the tool");
				expect(lastInput.some((message) => message.role === "user")).toBe(true); // "thanks, go on" is there
			});
		},
		60_000,
	);

	it(
		"answering deny leaves the turn live in model context",
		async () => {
			await withRpcChild(async (child, logPath) => {
				await runBashTurn(child);

				child.send({ id: "req-2", type: "prompt", message: "/restate" });
				const confirm = await child.waitFor(
					(line) => line.type === "extension_ui_request" && line.method === "confirm",
				);
				child.send({ type: "extension_ui_response", id: confirm.id, confirmed: false });

				const notify = await child.waitFor(
					(line) => line.type === "extension_ui_request" && line.method === "notify",
				);
				expect(String(notify.message)).toContain("Restate cancelled");
				expect(notify.notifyType).toBe("info");

				// The next model call still sees the turn — nothing was written.
				child.send({ id: "req-3", type: "prompt", message: "thanks, go on" });
				await child.waitFor((line) => line.type === "agent_settled", { occurrence: 2 });
				const flat = JSON.stringify(fixtureLog(logPath).at(-1));
				expect(flat).toContain("please run the command");
				expect(flat).toContain("pi-restate-rpc-ok");
			});
		},
		60_000,
	);
});

describe("json and print modes load the extension cleanly", () => {
	it(
		"print: a normal prompt runs and exits 0",
		async () => {
			const { code, stdout } = await runNonInteractive(
				["--print"],
				"hello",
				{ mode: "text", text: "print-mode answer" },
			);
			expect(code).toBe(0);
			expect(stdout).toContain("print-mode answer");
		},
		60_000,
	);

	it(
		"print: '/restate' as the prompt is a guarded no-op and exits 0",
		async () => {
			const { code, stdout } = await runNonInteractive(
				["--print"],
				"/restate",
				{ mode: "text", text: "unreached" },
			);
			expect(code).toBe(0);
			expect(stdout).not.toContain("retracted");
		},
		60_000,
	);

	it(
		"json: a normal prompt streams JSONL events and exits 0",
		async () => {
			const { code, stdout } = await runNonInteractive(
				["--mode", "json"],
				"hello",
				{ mode: "text", text: "json-mode answer" },
			);
			expect(code).toBe(0);
			const events = stdout
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(events.length).toBeGreaterThan(0);
			expect(events.some((event) => JSON.stringify(event).includes("json-mode answer"))).toBe(true);
		},
		60_000,
	);

	it(
		"json: '/restate' as the prompt is a guarded no-op and exits 0",
		async () => {
			const { code, stdout } = await runNonInteractive(
				["--mode", "json"],
				"/restate",
				{ mode: "text", text: "unreached" },
			);
			expect(code).toBe(0);
			expect(stdout).not.toContain("retracted");
		},
		60_000,
	);
});

/** Run one non-interactive child (print or json) with the fixture provider and the extension loaded. */
function runNonInteractive(
	modeFlags: string[],
	prompt: string,
	script: Record<string, unknown>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-restate-ni-"));
		const scriptPath = writeScript(dir, script);
		const child = spawn(
			process.execPath,
			[
				cliPath,
				...modeFlags,
				"--no-session",
				"--no-extensions",
				"-e",
				join(repoRoot, "test", "rpc-fixture-provider.ts"),
				"-e",
				join(repoRoot, "src", "index.ts"),
				"--model",
				"fake-rpc/fake-model",
				prompt,
			],
			{ cwd: dir, env: childEnv(scriptPath, join(dir, "log.jsonl")), stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout!.setEncoding("utf-8");
		child.stderr!.setEncoding("utf-8");
		child.stdout!.on("data", (chunk: string) => (stdout += chunk));
		child.stderr!.on("data", (chunk: string) => (stderr += chunk));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`child timed out; stdout: ${stdout}; stderr: ${stderr}`));
		}, 50_000);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolvePromise({ code, stdout, stderr });
		});
	});
}

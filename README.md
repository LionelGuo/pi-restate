# pi-restate

A [Pi](https://github.com/earendil-works/pi) extension that adds `/restate`: retract the prompt you last sent — and everything the model did after it — from model context, then get the prompt back in the editor for fixing and resending.

Sent a flawed prompt? Instead of Pi's native flow (`/tree` → edit → resubmit), which branches the session and leaves an abandoned branch behind, `/restate` keeps the session on a **single chain** using append-only context edits. Raw history keeps everything; the model simply never sees the retracted turn again.

## Install

Requires Pi with extension support (Pi supplies the extension API as peer packages at runtime).

```bash
# Try it once, without installing:
pi -e npm:pi-restate

# Or install as a Pi package (pin to a version with @0.1.0):
pi install npm:pi-restate

# Git source works too (pin to a tag with @v0.1.0):
pi install git:github.com/LionelGuo/pi-restate
```

From a local checkout:

```bash
pi install ./pi-restate   # as a package
pi -e .                   # or load the working copy for one invocation
```

Then run `/restate` in any session.

## What it does

1. Aborts the current run if one is active (like Esc), then waits for it to settle — the aborted partial is retracted too.
2. If the turn ran tools that may have modified files, asks for confirmation first — the dialog lists the calls (e.g. `bash ×2, edit ×1`) and states that files modified by those tools will not be rolled back. A tool counts as file-modifying unless it is one of the known read-only ones (`read`, `grep`, `find`, `ls`): `bash`, `powershell`, `edit`, `write`, MCP and extension tools all count. Denying cancels the restate entirely.
3. Omits the latest live user message and every context-producing entry after it (assistant messages, tool results, extension messages) from model context via append-only `context_edit` entries.
4. Appends one `pi-restate` marker entry explaining the retraction point.
5. Restores the retracted prompt text to the input editor — joined with, never overwriting, any queued text already there.

Refuses, with a clear reason, when: arguments are given, there is nothing to restate, the latest user message is already retracted, or the retraction would cross a compaction boundary.

## Scope

Restate is **context-only**: it changes what the model sees, nothing else.

- **File changes are never rolled back.** A retracted turn that ran `write`, `edit`, or `bash` left real changes on disk; the confirmation dialog warns about this before such a turn is retracted.
- **Unknown tools count as file-modifying.** Only `read`, `grep`, `find`, and `ls` are known read-only; everything else triggers the confirmation — `bash` and `powershell` (read-only shell usage is indistinguishable from a mutating one in the session entries), MCP tools, extension tools, and tool names this version has never seen. The price of never missing a real mutation is the occasional unnecessary confirmation.
- **One turn per invocation.** `/restate` takes no arguments and always means "the message I last sent". Repeated use refuses rather than peeling deeper into history.
- **No un-restate command.** The [`/tree` escape hatch](#limitations-and-the-escape-hatch) is the documented way back.

## Limitations and the escape hatch

- **The retracted turn stays visible.** The transcript renders raw history, so the retracted messages remain on screen; a `[restate]` marker line after them records what was removed (e.g. `Retracted 3 entries (1 image dropped)`). Extensions cannot hide entries from the transcript — the accepted cost of the single-chain mechanism ([ADR-0001](docs/adr/0001-restate-via-context-edit.md)).
- **`/tree` default view hides the edits.** Context edits are native history bookkeeping; the tree view does not show them.
- **Nested tool calls can undercount.** Tools executing other tools (codemode-style) leave a bounded record on the tool result; when Pi drops entries from that record (size limits), the confirmation can undercount what actually ran.
- **RPC: queued steering survives a Restate.** An RPC host has no editor to dump queued steering/follow-up messages into on abort, and extensions have no API to clear them; they deliver with the next prompt. The success notification warns when this happens.
- **Escape hatch (un-restate).** Context edits are branch-relative: in `/tree`, navigate to any point **before** the restate edits and continue from there — the original context, retracted turn included, is restored untouched. The cost is the very branch a Restate avoids, which is why this is the escape hatch rather than the flow.

## Modes

- **TUI**: the full experience — confirmation dialog, editor restore, marker line.
- **RPC**: fully supported for IDE-style clients. The confirmation is forwarded as an `extension_ui_request` and auto-denies if the client does not answer within 60s — a Restate is never blocked on, or silently forced past, a silent client. A prompt arriving during the confirmation window aborts, settles, and re-plans against the newest turn instead of editing mid-run. RPC clients have no editor, so the recovered prompt text arrives in a success notification instead. Mid-run `/restate` works like in the TUI (queued-steering caveat: see Limitations).
- **JSON / print**: the extension loads cleanly; `/restate` is a guarded no-op (these modes expose no UI channel for the confirmation or the recovered text).

Design decisions live in [`docs/adr/0001-restate-via-context-edit.md`](docs/adr/0001-restate-via-context-edit.md); vocabulary in [`GLOSSARY.md`](GLOSSARY.md).

## Development

```bash
npm install
npm test     # engine fixture tests + headless SDK integration tests + real RPC child-process tests
npm run check  # typecheck
```

`demo/fake-provider.ts` is a scriptable offline provider for demoing `/restate` run states (streaming, error, abort) in the real TUI without an API key — see its header comment.

Note: `package.json` pins two transitive `@aws-sdk/*` versions via `overrides` because the ranges published with `@earendil-works/pi-ai@1.3.0` point at unpublished versions. The overrides only affect this repository's dev/test tree; package consumers are unaffected (the host supplies Pi's packages as peers).

## License

[MIT](LICENSE)

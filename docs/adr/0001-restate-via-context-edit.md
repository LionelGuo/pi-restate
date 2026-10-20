# Restate via context edits on a single chain

When a sent prompt turns out to be wrong, Pi's native flow (`/tree` → select the
user message → edit → resubmit) branches the session tree and leaves the old turn
behind as an abandoned branch that clutters tree navigation. We decided to
implement `/restate` as append-only `context_edit` entries that omit the
retracted turn from model context, keeping the session on a single chain.

## Considered Options

- **Branch + tag that hides the abandoned subtree**: rejected. Extensions have
  no hook to filter transcript or `/tree` rendering for message entries; this
  would require an upstream core change, not a plugin.
- **Fork the good branch into a new session file**: rejected. It yields a clean
  tree but discards the session's branch structure (which we rely on to organize
  work) and proliferates session files.
- **Context edits on the same chain (chosen)**. Native, append-only,
  branch-relative, and no worse for the provider prompt cache than branching.
  Its cost — the retracted turn stays visible in the main transcript, which
  renders raw entries rather than the projection — is accepted and mitigated
  with a visible `pi-restate` marker entry.

## Consequences

- The projection applies no orphan cleanup, so a retraction must omit the whole
  turn together: the user message, assistant messages (including aborted
  partials), tool results, and custom messages in range.
- Un-restate has no dedicated command. `/tree` navigation to a point before the
  restate edits restores the original context (edits are branch-relative) at the
  cost of creating a branch — documented as the escape hatch.
- `/restate` targets only the latest user message and refuses when it is already
  omitted, so repeated invocations never peel deeper into history; retracting
  further back requires resending or `/tree`.
- Restate is context-only: file changes made inside a retracted turn are warned
  about but never rolled back.

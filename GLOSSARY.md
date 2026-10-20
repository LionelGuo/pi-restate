# pi-restate

A Pi Agent extension that retracts recently sent prompts and their model responses
from model context so the user can restate an edited version, keeping the session
on a single chain instead of sprouting branches.

## Language

**Restate**:
The user action of retracting the latest live user message together with the
model output that follows it, then resending an edited version of that message.
_Avoid_: Rewind, undo, take-back

**Live (生效)**:
Of a session entry: currently contributing to model context on the active
branch. An entry omitted by a context edit, or absorbed by a compaction
summary, is not live.

**Retracted Turn**:
The entries a Restate removes from model context: the retracted user message
and every model-produced entry after it up to the retraction point. Raw history
and the UI still show them.
_Avoid_: Dead turn, discarded turn, blocked messages

**Abandoned Branch**:
A subtree left off the active path by branching or tree navigation. This project
exists to avoid creating these.
_Avoid_: Waste branch, stale branch

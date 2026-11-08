# @aum/core

The agent loop and the shapes everything else is built from: messages, sessions, the model and
tool ports, approval, events and run ownership. It imports nothing outside Node, so a script, a
server or another framework can use it without the rest of aum.

For a walkthrough from the first run to a working coding agent, see the
[repository README](../README.md). This page is the reference: what each module owns, what the
core promises, and where to plug in.

```ts
import { Agent, MemorySession, bind, defineTool, lineageContext, rules } from "@aum/core";
```

The other packages name `@aum/core` as a peer dependency, so an application has exactly one
copy of its types: a `ModelError` from a provider passes an `instanceof` check in the
application, and a `Session` from the harness is the one `Agent` expects.

## Modules

Eight modules plus `index.ts`. Each imports only those above it in this table.

| File | Owns | Main exports |
| --- | --- | --- |
| `message.ts` | What is said: user, assistant and tool messages, sharing one content type. | `userMessage`, `text`, `textOf`, `errorInfo`, `openCalls`, `Message`, `Content`, `ToolUseBlock`, `ToolResultBlock` |
| `session.ts` | What is kept: append-only entries with parent links, time and run id. | `MemorySession`, `journalSession`, `checkEntries`, `lineageOf`, `Session`, `Journal`, `Entry` |
| `tools.ts` | Tool definitions, typed parsing, availability and approval. | `defineTool`, `bind`, `rules`, `invokeTool`, `ToolError`, `ToolBinding`, `Authorize` |
| `model.ts` | The provider-neutral port every model implements. | `Model`, `ModelRequest`, `ModelCompletion`, `ModelError` |
| `context.ts` | What the model is shown: built from the session, never written back. | `lineageContext`, `ContextBuilder` |
| `events.ts` | Observations of a run, and how it ended. | `AgentEvent`, `RunResult`, `RunStatus`, `EventEnvelope` |
| `agent.ts` | The loop: one run over a session, reading the bindings every cycle. | `runAgent`, `Bindings`, `RunOptions` |
| `runtime.ts` | Run ownership: one run at a time, run ids, ordered events, cancellation. | `Agent`, `RunHandle` |
| `index.ts` | Everything packages may import, so files inside `src/` can move without breaking them. | |

## What the core promises

1. The model's proposal is saved before any tool runs.
2. Every proposed call gets exactly one result in the next message, even when it was refused,
   cancelled or unknown.
3. If a run crashes during a tool call, the next run first records that call as `unknown`.
4. A call runs only if it was offered, is still available, and is approved, and then only once.
5. A reply the loop can't use fails the run without being saved.
6. Context builders only read the session; images are swapped for a note only for models that
   can't read them, and the session keeps the images.
7. Events are observations, never what is saved: a throwing observer changes nothing, and each
   run emits exactly one `run_finished`.

## Where to plug in

| To add | Implement | Example in this repo |
| --- | --- | --- |
| A model provider | `Model`: `info` and `complete(request, { signal, onProgress })`, throwing `ModelError` with a kind | `@aum/harness/providers/pi` |
| Storage that survives a restart | `Journal`: `append(entry)`, resolving once stored; then `journalSession(journal, saved)` | `@aum/harness/sessions/jsonl` |
| A tool | `defineTool({ name, description, parameters, parse, execute })`, then `bind` it | `@aum/harness/tools/coding` |
| A tool that switches on and off | `ToolBinding`: `{ tool, isEnabled() }`, checked before each call | |
| Approval | `Authorize`, or `rules(table, { ask, otherwise })` | `apps/demo.ts` |
| What the model sees | `ContextBuilder`: `({ session, model, signal }) => { systemPrompt, messages }` | `lineageContext` |

## Phase

Phase 0 made `src/` the published package `@aum/core` without changing its code: the root
`package.json` names it, `npm run build` compiles it into `dist/`, and its `exports` point at
the TypeScript source inside the repo (the `development` condition) and at `dist/` once
installed. The core is complete for the phases ahead; the harness, CLI and app build on it
without changing it.

## How it's checked

The checks in `checks/` exercise the core through real use: `pi.test.ts` runs `runAgent` and
`Agent` with Pi's offline faux model (tool round trips, refusals, cancellation, provider
errors), and `pack.test.ts` installs `@aum/core` outside the repo and runs an agent as plain
JavaScript. The reference in `org/checks/contracts.ts` proves each promise above directly;
porting those checks here is still to do.

# aum

A small TypeScript framework for building agents: a model that can ask for tools to be run.

aum runs the loop. It sends the conversation to the model, saves its reply, runs the tools it
asked for, saves the results, and repeats until the model answers. The core, `@aum/core`, has
no runtime dependencies: you can bring your own model and storage. `@aum/harness` adds what
most agents need, built in: every model family [Pi](https://github.com/earendil-works/pi/tree/main/packages/ai)
supports, coding tools, and sessions saved to disk.

This README starts from the bare loop and builds up to a working coding agent. Each package
also has its own README: [`@aum/core`](src/README.md) and [`@aum/harness`](packages/harness/README.md).

What you get:

- **Every step saved.** The model's request to run a tool is saved before the tool runs, and
  every call gets exactly one result, even when it was refused, cancelled or cut off.
- **Crash recovery.** If the process dies while a tool runs, the next run gives that call the
  result `unknown`, so the model checks before repeating it.
- **Checks before every call.** A tool can be switched off at any time, and an approver can
  allow or refuse each call, including by asking a person.
- **One result per run.** A run returns how it ended (`completed`, `cancelled`, `limited`,
  `blocked` or `failed`) instead of throwing.
- **Events to follow a run.** Streamed text, tool progress and saved messages, for a screen or
  a log. A slow or broken observer never changes the run.
- **42 model families, by name.** `openai/gpt-5-mini` or `anthropic/claude-sonnet-5-5`, with
  reasoning at medium unless you choose another level.
- **Coding tools that stay in their folder.** `read`, `write`, `edit` and `bash`, refusing any
  path outside the workspace, and writing files whole or not at all.

## Requirements

Node.js 22.18 or newer, which runs TypeScript directly.

```sh
npm install
npm run typecheck
```

Import the core from `@aum/core` and the harness from `@aum/harness/...`. Inside this repo those
names point at the TypeScript source when Node runs with `--conditions=development`, which the
npm scripts already pass; to run an example of your own, save it in the repo and run
`node --conditions=development example.ts`. Once installed from npm, the same names load the
built JavaScript.

## Quick start

This runs offline: the "model" below always answers by echoing the last message.

```ts
import { MemorySession, lineageContext, runAgent, textOf, userMessage, type Model } from "@aum/core";

const echo: Model = {
    info: { adapter: "echo", provider: "local", model: "echo", capabilities: { tools: false, images: false } },
    async complete({ context }) {
        const last = context.messages.at(-1)!;
        const said = last.role === "user" ? textOf(last.content) : "";
        return { message: { role: "assistant", content: [{ type: "text", text: `You said: ${said}` }] }, finishReason: "stop" };
    },
};

const session = new MemorySession();
const result = await runAgent({
    session,
    bindings: () => ({ model: echo, tools: [], context: lineageContext("You are helpful.") }),
    input: userMessage("Hello"),
});

console.log(result.status, textOf(result.message?.content ?? []));    // completed You said: Hello
console.log((await session.lineage()).map(entry => entry.message.role)); // [ 'user', 'assistant' ]
```

Swap `echo` for a real model (see [Using a real model](#using-a-real-model)) and the rest stays the same.

## How a run works

A run starts from the user's message and repeats one step, a cycle:

1. Read the current `bindings()`: the model, the tools, how to build the request, and the approver.
2. Build the request from the saved conversation and send it to the model.
3. Check and save the reply. If it asks for tools, run each call in order, after checking it
   may run, and save all the results.
4. Stop when the model answers without asking for a tool, or when a limit is reached.

Because `bindings()` is read every cycle, switching models or tools takes effect on the next
reply without restarting the run. `maxCycles` (default 30) stops a model that never stops
calling tools.

## Tools

A tool has a name, a description and a JSON Schema for its arguments. The model can still send
anything, so `defineTool` runs your `parse` function first: bad arguments fail before the tool
does anything, and the model reads the error and can try again.

```ts
import { ToolError, bind, defineTool } from "@aum/core";

const weather = defineTool({
    name: "weather",
    description: "Current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    parse: raw => {
        const city = (raw as { city?: unknown }).city;
        if (typeof city !== "string" || !city) throw new Error("city must be a non-empty string");
        return { city };
    },
    async execute({ city }, { signal, progress }) {
        progress(`looking up ${city}`);
        const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=3`, { signal });
        if (!response.ok) throw new ToolError(`Lookup failed with HTTP ${response.status}`, await response.text());
        return response.text();
    },
});

const tools = [bind(weather)];
```

- `execute` returns text, or content blocks when it has images to give back.
- Throw `ToolError(message, output)` to fail while keeping the output that explains why; the
  model sees both.
- `signal` fires when the run is cancelled, so long work can stop. `progress` reports to
  whoever is watching.
- `bind(tool)` makes a tool that is always on. To switch one on and off, pass your own
  `{ tool, isEnabled }`; it is checked just before each call.

## Approval

Pass an `authorize` function in `bindings` to decide each call. `rules` builds one from a table:

```ts
import { rules } from "@aum/core";

const authorize = rules(
    { read_file: "allow", write_file: "ask", delete_file: "deny" },
    { ask: async call => askPerson(`Allow ${call.name}(${JSON.stringify(call.args)})?`) }, // your own prompt; true allows
);
```

`ask` may wait for a person. With no `ask` attached, an `ask` rule is a denial, and so is any
tool missing from the table (unless you set `otherwise`). A refused call is not an error: it
gets the result `denied` with a reason, and the model adapts. With no `authorize` at all,
every call to a bound tool is allowed.

## Results

`runAgent` returns a `RunResult`:

| Field | Meaning |
| --- | --- |
| `status` | `completed`, `cancelled`, `limited` (cycle or output limit), `blocked` (by the provider) or `failed` |
| `message` | The model's final answer, when it gave one |
| `cycles`, `usage` | How many model replies, and the tokens they used |
| `error` | Why the run didn't complete; for model failures, also `kind` and `retryable` |

Every tool call ends with one of these statuses, saved in the conversation:

| Status | Meaning |
| --- | --- |
| `success` | The tool ran and returned |
| `error` | The tool ran and failed; the result says why |
| `denied` | Refused before running: not offered, switched off, refused by the approver, or cut off |
| `cancelled` | The run was cancelled before the call started |
| `unknown` | The tool may or may not have run, after a cancel or a crash; the model should check |

## Events

Pass `emit` to follow a run as it happens:

```ts
await runAgent({
    session,
    bindings,
    input: userMessage("What's the weather in Paris?"),
    emit: event => {
        if (event.type === "model_delta") process.stdout.write(event.text);
        if (event.type === "tool_started") console.log(`\n→ ${event.name}`, event.args);
        if (event.type === "tool_finished") console.log(`← ${event.status}`);
    },
});
```

The events are `run_started`, `cycle_started`, `model_delta`, `cycle_finished`,
`message_committed`, `tool_started`, `tool_progress`, `tool_finished` and `run_finished`
(sent exactly once). Only `message_committed` means something was saved. Errors thrown by
`emit` are ignored, so a broken screen can't break a run.

## Sessions

A `Session` holds the conversation. `MemorySession` keeps it in memory, and `fork` goes back
to an earlier point without erasing what came after:

```ts
const session = new MemorySession();
// ... some runs ...
const branch = session.fork(earlierEntryId); // shares everything up to that entry
```

Each saved entry records its `id`, `parentId`, `created_at` and the `runId` of the run that
saved it.

### Sessions that survive a restart

Write a `Journal` for your store (a file, a database, a remote service) with one method,
`append(entry)`, which must resolve only once the entry is safely stored. `journalSession`
does the rest: it writes to the journal before moving on, so a crash never leaves memory
ahead of the store, and on restart it checks the saved entries before resuming.

```ts
import { appendFile, readFile } from "node:fs/promises";
import { journalSession, type Journal } from "@aum/core";

const file = "session.jsonl";
const journal: Journal = { append: entry => appendFile(file, JSON.stringify(entry) + "\n") };

const saved = (await readFile(file, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line));

const session = journalSession(journal, saved); // resumes where the file left off
```

For real durability, sync each write to disk (`FileHandle.sync()`) before `append` resolves,
and drop a half-written last line when loading. Saved entries are validated on load, and a
damaged or out-of-order one fails with a message naming it. The harness does all of this for
you: see [Sessions on disk](#sessions-on-disk).

## Running inside an application

`Agent` owns runs on one session: one run at a time, a run id, cancellation, and events you
read at your own pace.

```ts
import { Agent, MemorySession } from "@aum/core";

const agent = new Agent({ session: new MemorySession(), getBindings: () => bindings });

const run = agent.run("Summarize the latest report"); // returns at once
setTimeout(() => run.cancel(), 30_000);

for await (const { sequence, event } of run.events) {
    if (event.type === "model_delta") process.stdout.write(event.text);
}
const result = await run.result;
```

Starting a second run while one is going throws. Every entry a run saves carries its
`run.runId`, and events arrive numbered, so a screen can tell if it missed one.

## Choosing what the model sees

The `context` in `bindings` builds each request from the session. `lineageContext(system)`
sends the whole conversation with your system prompt, and replaces images with a short note
for models that can't read them; the session keeps the images. To trim, summarize or add
retrieved documents, write your own builder: an async function that receives
`{ session, model, signal }` and returns `{ systemPrompt, messages }`. It should only read the
session, never write to it.

## Connecting a model

A model is anything that implements `Model`:

```ts
interface Model {
    readonly info: { adapter: string; provider: string; model: string; capabilities: { tools: boolean; images: boolean } };
    complete(request: ModelRequest, execution: ModelExecution): Promise<ModelCompletion>;
}
```

Your adapter translates in both directions:

- **Request:** `request.context` holds the system prompt and the messages (`user`, `assistant`
  with text and `tool_use` blocks, and `tool` with one result per call), `request.tools` the tool
  definitions, and `request.settings` the temperature and output limit. Map them to your
  provider's format. Include each result's status for anything that isn't a success, so the
  model knows a call was refused or interrupted.
- **Execution:** pass `execution.signal` to your HTTP call so runs can be cancelled, and call
  `execution.onProgress({ type: "text_delta", text })` as text streams in.
- **Completion:** return one assistant message (text, plus a `tool_use` block per call with a
  unique `id`), the `finishReason` (`stop`, `tool_calls`, `length` or `blocked`) and `usage`.
- **Errors:** throw `ModelError(message, kind, retryable)` with kind `auth`, `rate_limit`,
  `network`, `protocol` or `unsupported`, so callers can decide whether to retry. It reaches the
  run's result.

Providers that need their own data back on the next request (such as signed reasoning) can keep
it in the assistant message's `adapterData`, under their own key.

## Using a real model

`@aum/harness/providers/pi` turns any model [Pi](https://github.com/earendil-works/pi/tree/main/packages/ai)
supports into a `Model`. `PiCatalog` reads Pi's list of 42 families, and `load` takes a name:

```ts
import { PiCatalog } from "@aum/harness/providers/pi";

const catalog = new PiCatalog();
catalog.families().map(family => family.id);            // [ "amazon-bedrock", "ant-ling", "anthropic", ... ]
catalog.modelsOf("openai").find(m => m.id === "gpt-5.4"); // { id, name, reasoning: [ "low", "medium", "high", "xhigh" ] }

const { model, reasoning } = catalog.load("openai/gpt-5-mini");          // reasoning: "medium"
const strong = catalog.load("openai/gpt-5.5", { reasoning: "high" }).model;
```

- **Keys.** Pi finds each family's key itself, for example `OPENAI_API_KEY` or
  `ANTHROPIC_API_KEY` in the environment; `await catalog.hasCredentials("openai")` says whether
  it found one. To use a key kept somewhere else, pass it: `catalog.load(name, { apiKey })`.
- **Reasoning.** Every model starts at `medium`. A level the model doesn't take falls back to
  medium, or the nearest it does take; a model that doesn't reason gets none.
- **Mistakes.** A wrong family or model fails at `load`, naming the ones that exist, not at the
  first reply.
- **Failures.** Provider errors arrive as `ModelError` kinds: a 429 is a retryable
  `rate_limit`, a bad key is `auth`, an overlong conversation is `unsupported`.
- **Switching mid-conversation.** A model's saved reasoning is sent back only to that same
  model, so changing models between replies drops it instead of failing.

## Coding tools

`@aum/harness/tools/coding` gives a model the four tools a coding agent needs, confined to one
folder:

```ts
import { bind } from "@aum/core";
import { createCodingTools } from "@aum/harness/tools/coding";

const tools = createCodingTools("./my-project", { bash: { timeoutSeconds: 60 } }).map(bind);
```

| Tool | What it does |
| --- | --- |
| `read` | Returns a file 2,000 lines at a time, with a note saying where to continue; images come back as images. |
| `write` | Creates or replaces a whole file, creating folders, keeping the file's mode, writing all or nothing. |
| `edit` | Replaces exact text; each `oldText` must occur once, and several edits apply together or not at all. |
| `bash` | Runs a command in the folder, stopping the whole process group on timeout or cancel; long output keeps its start and end. |

Any path that resolves outside the folder, including through a link, is refused. The tools
don't decide whether they may run: pair them with an `authorize` such as
`rules({ read: "allow" }, { otherwise: "ask", ask })`, so writes, edits and commands wait for a yes.

## Sessions on disk

`@aum/harness/sessions/jsonl` saves a session as one JSON line per entry, synced to disk before
the run moves on. A crash mid-write leaves half a line, which is cut off on the next load.

```ts
import { listSessions, newSessionId, openSession } from "@aum/harness/sessions/jsonl";

const session = await openSession(".aum/sessions", newSessionId()); // or an existing id to continue
const recent = await listSessions(".aum/sessions");                // most recent first
```

## Putting it together

A coding agent in a few lines: a real model, the coding tools, a saved session, and approval
before anything changes.

```ts
import { Agent, bind, lineageContext, rules } from "@aum/core";
import { PiCatalog } from "@aum/harness/providers/pi";
import { openSession } from "@aum/harness/sessions/jsonl";
import { createCodingTools } from "@aum/harness/tools/coding";

const { model } = new PiCatalog().load("openai/gpt-5-mini");
const tools = createCodingTools(".").map(bind);
const authorize = rules({ read: "allow" }, { otherwise: "ask", ask: async call => confirm(`Allow ${call.name}?`) });

const agent = new Agent({
    session: await openSession(".aum/sessions", "first"),
    getBindings: () => ({ model, tools, context: lineageContext("You are a coding agent."), authorize }),
});
const run = agent.run("What does package.json say this project is called?");
for await (const { event } of run.events) if (event.type === "model_delta") process.stdout.write(event.text);
```

`confirm` stands for however you ask a person. [`apps/demo.ts`](apps/demo.ts) is this, made
interactive: it reads an OpenAI key from `LLM_API_KEY` in `.env` (gitignored), asks in the
terminal before each write, edit or command, and switches model or reasoning mid-conversation.

```sh
echo 'LLM_API_KEY=sk-...' > .env
npm run demo                                        # openai/gpt-5-mini, reasoning medium
npm run demo -- --model openai/gpt-5.5 --reasoning high
npm run demo -- --session <id>                      # continue a saved session
npm run demo -- --list                              # model families; ● means a key was found
npm run demo -- --list openai                       # that family's models and reasoning levels
```

Inside the demo, `/model <family>/<model> [level]` and `/reasoning <level>` switch from the next
reply, since the bindings are read every cycle, and several can share a line, such as
`/model openai/gpt-5.5 /reasoning high`. Sessions are saved in `.aum/sessions/`, the system
prompt comes from [`prompts/coding.md`](prompts/coding.md) (`--system <file>`), and the tools
work in the current folder (`--root <dir>`). `LLM_API_KEY` is used only for `openai/*` models.

## Packages and phases

aum ships as four packages, one per kind of user, built one phase at a time. Dependencies point
only toward the core.

| Phase | Package | Folder | For | Status |
| --- | --- | --- | --- | --- |
| 0 | [`@aum/core`](src/README.md) | `src/` | Building on the bare loop | Done |
| 1 | [`@aum/harness`](packages/harness/README.md) | `packages/harness` | Building an agent, directly or on top | In progress: providers, tools and sessions are in |
| 2 | `@aum/cli` | | Using the coding agent in a terminal | Next: built only on the harness |
| 3 | `@aum/app` | | The desktop app | After the CLI ships |

Phase 0 set up the packages: the core is `@aum/core`, the harness imports it by name, both
build into `dist/`, and a check installs them outside the repo. Code imports by package name,
never by path into another package.

## Scripts

- `npm run typecheck`: check types across the core, packages, apps and checks, without writing output.
- `npm run build`: compile the core and the harness into their `dist/` folders, in dependency order: JavaScript, type declarations and source maps.
- `npm test`: run the offline checks in `checks/` (Pi's faux provider stands in for a real model), including one that packs the packages, installs them into an empty project outside the repo and runs them as plain JavaScript.
- `npm run demo`: the interactive coding agent above.

# aum

A small TypeScript framework for building agents: a model that can ask for tools to be run.

aum runs the loop. It sends the conversation to the model, saves its reply, runs the tools it
asked for, saves the results, and repeats until the model answers. You bring the model
provider and, if you want sessions that survive a restart, the storage. There are no runtime
dependencies.

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

## Requirements

Node.js 22.18 or newer, which runs TypeScript directly.

```sh
npm install
npm run typecheck
```

Import everything from `src/index.ts`.

## Quick start

This runs offline: the "model" below always answers by echoing the last message.

```ts
import { MemorySession, lineageContext, runAgent, textOf, userMessage, type Model } from "./src/index.ts";

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

Swap `echo` for a real model (see [Connecting a model](#connecting-a-model)) and the rest stays the same.

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
import { ToolError, bind, defineTool } from "./src/index.ts";

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
import { rules } from "./src/index.ts";

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
import { journalSession, type Journal } from "./src/index.ts";

const file = "session.jsonl";
const journal: Journal = { append: entry => appendFile(file, JSON.stringify(entry) + "\n") };

const saved = (await readFile(file, "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line));

const session = journalSession(journal, saved); // resumes where the file left off
```

For real durability, sync each write to disk (`FileHandle.sync()`) before `append` resolves,
and drop a half-written last line when loading. Saved entries are validated on load, and a
damaged or out-of-order one fails with a message naming it.

## Running inside an application

`Agent` owns runs on one session: one run at a time, a run id, cancellation, and events you
read at your own pace.

```ts
import { Agent, MemorySession } from "./src/index.ts";

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

## Packages

`packages/` holds pieces that plug into the core. The core still has no runtime dependencies;
each package declares its own.

| Package | What it does |
| --- | --- |
| `providers-pi` | Every model family [Pi](https://github.com/earendil-works/pi/tree/main/packages/ai) ships (42), behind `Model`. `PiCatalog` lists families and models and loads one by `<family>/<model>`, with reasoning at medium unless you pick another level. Pinned to `@earendil-works/pi-ai` 1.4.0. |
| `tools-coding` | `read`, `write`, `edit` and `bash`, confined to one workspace folder. `createCodingTools(root)` returns all four. |
| `session-jsonl` | Sessions saved as JSONL files that survive a crash: `openSession(dir, id)` plugs into `Agent`. |

`apps/demo.ts` wires them to `Agent` in about a hundred lines, to try the loop against real models.
It reads an OpenAI key from `LLM_API_KEY` in `.env` (gitignored) and starts on `openai/gpt-5-mini`
at medium reasoning:

```sh
echo 'LLM_API_KEY=sk-...' > .env
npm run demo                                        # openai/gpt-5-mini, reasoning medium
npm run demo -- --model openai/gpt-5.5 --reasoning high
npm run demo -- --session <id>                      # continue a saved session
npm run demo -- --list                              # model families; ● means a key was found
npm run demo -- --list openai                       # that family's models and reasoning levels
```

`LLM_API_KEY` is used only for `openai/*` models. Other families find their keys the way Pi
does, for example `ANTHROPIC_API_KEY` in the environment. In code, pass a key yourself with
`catalog.load("openai/gpt-5-mini", { apiKey })` or `createPiModel({ ..., apiKey })`.

Reads run freely; writes, edits and commands ask first. `/model <family>/<model> [level]` and
`/reasoning <level>` switch from the next reply, since the bindings are read every cycle; several
can share a line, such as `/model openai/gpt-5.5 /reasoning high`.
Sessions are saved in `.aum/sessions/`. The system prompt comes from `prompts/coding.md`
(`--system <file>`), and the tools work in the current folder (`--root <dir>`).

## Scripts

- `npm run typecheck`: check types across the core, packages, apps and checks, without writing output.
- `npm run build`: compile the core (`src/`) into `dist/`: JavaScript, type declarations and source maps.
- `npm test`: run the offline checks in `checks/` (Pi's faux provider stands in for a real model).
- `npm run demo`: try the core loop with a Pi model and the coding tools.

# @aum/core

The agent loop on its own: a model, the tools it may call, and a conversation that is saved as
it goes. It has no runtime dependencies, so you bring the model and the storage, and it works the
same in a script, a server or inside another framework.

```sh
npm install @aum/core
```

## Model Integration

The loop talks to a model through one method, `complete`, which takes the conversation and
returns the next assistant message. To see the loop without a provider, start with a model that
plays back replies you've written. Its first reply asks for a tool; its second answers:

```ts
import { type AssistantMessage, type Model } from "@aum/core";

function scripted(replies: AssistantMessage[]): Model {
    let turn = 0;
    return {
        info: { adapter: "scripted", provider: "local", model: "scripted", capabilities: { tools: true, images: false } },
        async complete() {
            const message = replies[turn++] ?? { role: "assistant", content: [{ type: "text", text: "Done." }] };
            const asksForTools = message.content.some(block => block.type === "tool_use");
            return { message, finishReason: asksForTools ? "tool_calls" : "stop" };
        },
    };
}

const model = scripted([
    { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "list_todos", args: {} }] },
    { role: "assistant", content: [{ type: "text", text: "You have two things to do." }] },
]);
```

A `tool_use` block is how any model asks for a tool: a name, arguments, and an `id` that its
result will answer. A real provider is the same shape; [Connecting a provider](#connecting-a-provider)
shows how to write one.

## Tools

A tool is a name, a description the model reads, a JSON Schema for its arguments, and the code
that runs. The model can send any arguments at all, so `defineTool` runs `parse` first and
`execute` only gets arguments you've checked:

```ts
import { bind, defineTool } from "@aum/core";

const todos = ["buy milk", "call the bank"];

const listTodos = defineTool({
    name: "list_todos",
    description: "List the user's to-dos",
    parameters: { type: "object", properties: {} },
    parse: () => ({}),
    execute: async () => todos.map((item, index) => `${index + 1}. ${item}`).join("\n"),
});

const addTodo = defineTool({
    name: "add_todo",
    description: "Add a to-do",
    parameters: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
    parse: raw => {
        const item = (raw as { item?: unknown }).item;
        if (typeof item !== "string" || !item.trim()) throw new Error("item must be non-empty text");
        return { item: item.trim() };
    },
    execute: async ({ item }) => { todos.push(item); return `Added "${item}"`; },
});

const tools = [bind(listTodos), bind(addTodo)];
```

If `parse` throws, the call fails before anything happens and the model reads the message, so it
can fix its arguments and try again. `bind` makes a tool that is always available; you'll see
how to switch one off [further down](#changing-things-mid-run).

`execute` returns text, or content blocks when it has images to give back. It also gets a
`signal`, which fires when the run is cancelled, and `progress`, for reporting while it works.
To fail but still show the model what happened, throw `ToolError(message, output)`.

## A run

`runAgent` puts the pieces together. `bindings` says what this run works with, and `session`
is where the conversation is kept:

```ts
import { MemorySession, lineageContext, runAgent, textOf, userMessage } from "@aum/core";

const session = new MemorySession();
const result = await runAgent({
    session,
    bindings: () => ({ model, tools, context: lineageContext("You manage the user's to-do list.") }),
    input: userMessage("What's on my list?"),
});

console.log(result.status, textOf(result.message!.content)); // completed You have two things to do.
console.log((await session.lineage()).map(entry => entry.message.role));
// [ 'user', 'assistant', 'tool', 'assistant' ]
```

The saved conversation shows the loop's work. The model asked for `list_todos`; that request
was saved before the tool ran; the tool's result was saved as a `tool` message; the model read
it and answered. The run stops when a reply asks for no tools.

A run doesn't throw when something goes wrong; it ends with a status. `result` holds the
status, the final message, how many replies it took (`cycles`), the tokens used (`usage`), and an
`error` when it didn't complete:

| Status | Why the run ended |
| --- | --- |
| `completed` | The model answered without asking for a tool |
| `cancelled` | You cancelled it |
| `limited` | It reached `maxCycles` (30 by default) or the model's output limit |
| `blocked` | The provider refused to answer |
| `failed` | The model failed, or replied with something the loop can't use, which is not saved |

## Asking before a change

Reading the list is harmless; adding to it changes something. An `authorize` function in the
bindings decides each call before it runs, and `rules` builds one from a table:

```ts
import { rules } from "@aum/core";

const authorize = rules(
    { list_todos: "allow", add_todo: "ask" },
    { ask: async call => confirm(`Add "${(call.args as { item: string }).item}"?`) },
);

// bindings: () => ({ model, tools, context, authorize })
```

`confirm` stands for however you ask a person, and `true` allows the call. A rule is `allow`,
`ask` or `deny`. A tool missing from the table is denied unless you set `otherwise`, and an
`ask` with no `ask` function is denied too, so an agent left running alone never does anything
risky by default. With no `authorize` at all, every call is allowed.

A refused call is not an error. It still gets a result, with the status `denied` and the
reason, and the model carries on knowing it wasn't allowed. Every call the model makes ends with
exactly one result:

| Status | What happened to the call |
| --- | --- |
| `success` | The tool ran and returned |
| `error` | The tool ran and failed, or its arguments didn't parse |
| `denied` | It never ran: refused, switched off, never offered, or cut off by a limit |
| `cancelled` | The run was cancelled before the call started |
| `unknown` | It may or may not have run, after a cancel or a crash; the model should check |

## Watching a run

Pass `emit` to see the run as it happens, for a screen or a log:

```ts
await runAgent({
    session,
    bindings: () => ({ model, tools, context: lineageContext("You manage the user's to-do list.") }),
    input: userMessage("What's on my list?"),
    emit: event => {
        if (event.type === "model_delta") process.stdout.write(event.text);
        if (event.type === "tool_started") console.log(`→ ${event.name}`, event.args);
        if (event.type === "tool_finished") console.log(`← ${event.status}`);
        if (event.type === "run_finished") console.log(event.result.status);
    },
});
```

| Event | When |
| --- | --- |
| `run_started`, `run_finished` | Once each; `run_finished` carries the result, however the run ended |
| `cycle_started`, `cycle_finished` | Around each model reply, with the model's name, then the finish reason and usage |
| `model_delta` | As reply text streams in |
| `message_committed` | When a message has been saved |
| `tool_started`, `tool_progress`, `tool_finished` | Around each tool call, with its arguments, progress, then status and content |

Events only report: an `emit` that throws or is slow changes nothing about the run, and only
`message_committed` means something was saved.

## Keeping the conversation

`MemorySession` is lost when the process exits. To keep a conversation, give `journalSession` a
`Journal`: an object with one method, `append(entry)`, that stores an entry and resolves once
it's safe. A file with one JSON line per entry is enough:

```ts
import { appendFile, readFile } from "node:fs/promises";
import { journalSession, type Journal } from "@aum/core";

const file = "todos.jsonl";
const journal: Journal = { append: async entry => appendFile(file, JSON.stringify(entry) + "\n") };
const saved = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));

const kept = journalSession(journal, saved); // pass it as session; it picks up where the file left off
```

The session writes each entry to the journal before the run moves on, so memory is never ahead
of what's stored. On load it checks the saved entries and names any that are damaged or out of
order. If the process died while a tool was running, the next run first records that call as
`unknown`, so the model checks before doing it again.

For real durability, sync each write to disk before `append` resolves and drop a half-written
last line on load. `@aum/harness` has a session file that does both.

Each entry records its `id`, its `parentId`, `created_at`, and the `runId` of the run that saved
it. Entries are never changed or removed. `MemorySession` can also `fork(entryId)`, which
continues from an earlier point while keeping everything after it:

```ts
const retry = session.fork(earlierEntryId);
```

## Inside an application

`runAgent` is one call that finishes when the run does. An application usually wants to start a
run, show it as it goes, and let the user stop it. `Agent` does that for one session:

```ts
import { Agent } from "@aum/core";

const agent = new Agent({ session, getBindings: () => ({ model, tools, context: lineageContext("You manage the user's to-do list."), authorize }) });

const run = agent.run("Add 'water the plants'");  // returns at once
stopButton.onclick = () => run.cancel();

for await (const { sequence, event } of run.events) {
    if (event.type === "model_delta") output.append(event.text);
}
const result = await run.result;
```

Events wait until you read them, so a slow screen never slows the run, and they arrive numbered,
so you can tell if one was missed. Only one run goes at a time; starting another while one is
going throws. Every entry a run saves carries `run.runId`.

## Changing things mid-run

`bindings` is a function, and the loop calls it again before every model reply. Whatever it
returns then is what the next reply uses, so you can switch models or tools without stopping the
run:

```ts
let current = model;
let readOnly = false;

const tools = [bind(listTodos), { tool: addTodo, isEnabled: () => !readOnly }];
const bindings = () => ({ model: current, tools, context: lineageContext("You manage the user's to-do list.") });

// later, even while a run is going:
current = otherModel;  // the next reply comes from otherModel
readOnly = true;       // add_todo is no longer offered
```

`isEnabled` is also checked just before each call runs, so a tool switched off between the
model asking and the call starting gets `denied`.

## What the model sees

The `context` binding builds each request from the session. `lineageContext(system)` sends your
system prompt and the whole conversation. For models that can't read images, it swaps each image
for a short note in the request; the session keeps the images.

To change what's sent, write your own: an async function that gets `{ session, model, signal }`
and returns `{ systemPrompt, messages }`. Here the current list goes into the system prompt on
every reply:

```ts
import { type ContextBuilder } from "@aum/core";

const withList: ContextBuilder = async input => {
    const base = await lineageContext("You manage the user's to-do list.")(input);
    return { ...base, systemPrompt: `${base.systemPrompt}\n\nCurrent list:\n${todos.join("\n")}` };
};
```

The same way, a builder can trim old messages, summarize, or add retrieved documents. It should
only read the session, never write to it, so what was said stays as it was said. If you trim,
keep each `tool` message with the assistant message that asked for it; providers reject a
result without its call.

## Connecting a provider

A model is anything with `info` and `complete`:

```ts
interface Model {
    readonly info: { adapter: string; provider: string; model: string; capabilities: { tools: boolean; images: boolean } };
    complete(request: ModelRequest, execution: ModelExecution): Promise<ModelCompletion>;
}
```

An adapter translates between the core and a provider's API, in both directions:

- **The request.** `request.context` holds the system prompt and the messages: `user`,
`assistant` with text and `tool_use` blocks, and `tool` with one result per call.
`request.tools` holds the tool definitions, and `request.settings` the temperature and output
limit. Map them to the provider's format. For a result that isn't `success`, include its
status, so the model knows the call was refused or interrupted.
- **Running.** Pass `execution.signal` to the HTTP call so a run can be cancelled, and call
`execution.onProgress({ type: "text_delta", text })` as text streams in.
- **The reply.** Return one assistant message, with text and a `tool_use` block per call, each
with a unique `id`. Add the `finishReason` (`stop`, `tool_calls`, `length` or `blocked`) and
`usage`.
- **Failures.** Throw `ModelError(message, kind, retryable)` with kind `auth`, `rate_limit`,
`network`, `protocol` or `unsupported`. The run fails with that kind in `result.error`, so the
caller can decide whether to retry.

Set `capabilities.images` to whether the model reads images, and `lineageContext` handles the
rest. If the provider needs its own data back on the next request, such as signed reasoning,
keep it in the assistant message's `adapterData` under your adapter's key.

`@aum/harness` has an adapter for every model family [Pi](https://github.com/earendil-works/pi/tree/main/packages/ai)
supports.

## What you can rely on

- A tool runs only if it was offered, is still enabled, and was allowed, and then only once.
- The model's request is saved before any tool runs, and every call gets exactly one result,
even when it was refused, cancelled or cut off.
- A call interrupted by a crash is recorded as `unknown` on the next run.
- A reply the loop can't use fails the run and is never saved.
- Building a request never changes the session.
- An observer can't change a run, and every run reports `run_finished` once.

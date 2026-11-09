# @aum/harness

The harness layer built on top of [`@aum/core`](../../src) for building working agents. It
includes:

- **Native provider support** for every model family that
[`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) supports.
- **Tool integration**, with basic coding tools ready to use out of the box: `read`, `write`,
`edit` and `bash`.
- **Logged conversations**, saved to disk as they happen and picked up again after a restart.

```sh
npm install @aum/core @aum/harness
```

`@aum/core` is a peer dependency, so your program and the harness share one copy of it.

## A model

`PiCatalog` knows every model Pi knows. Load one by `<family>/<model>`:

```ts
import { PiCatalog } from "@aum/harness/providers/pi";

const catalog = new PiCatalog();
const { model, reasoning } = catalog.load("openai/gpt-5-mini");
console.log(model.info.model, reasoning); // gpt-5-mini medium
```

`model` is a core `Model`, so it goes anywhere the core takes one. Loading only looks the model
up: a misspelled family or model fails here, with a list of the ones that exist, instead of at
the first reply.

To see what's available:

```ts
catalog.families().map(family => family.id);  // [ "amazon-bedrock", "ant-ling", "anthropic", ... ]
catalog.modelsOf("openai").find(m => m.id === "gpt-5.4");
// { id: "gpt-5.4", name: "GPT-5.4", reasoning: [ "low", "medium", "high", "xhigh" ] }
```

**Keys.** Pi finds each family's key itself, such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in
the environment. `families()` gives each family's `keyName`, and
`await catalog.hasCredentials("openai")` says whether a key was found; a lookup that takes more
than three seconds counts as not found. To use a key kept somewhere else, pass it:
`catalog.load("openai/gpt-5-mini", { apiKey })`.

**Reasoning.** Models that reason start at `medium`. Ask for another level with
`catalog.load("openai/gpt-5.5", { reasoning: "high" })`. If the model doesn't take that level,
you get `medium` or the nearest level it does take, and `load` returns the level you got. A
model that doesn't reason gets none. The levels are `minimal`, `low`, `medium`, `high`, `xhigh`
and `max`, exported as `REASONING`.

## Tools

`createCodingTools(folder)` gives the model the four tools a coding agent needs, all confined to
that folder:

```ts
import { bind } from "@aum/core";
import { createCodingTools } from "@aum/harness/tools/coding";

const tools = createCodingTools("./my-project").map(bind);
```

| Tool | What it does |
| --- | --- |
| `read` | Returns a file 2,000 lines at a time, saying where to continue. Images come back as images. |
| `write` | Creates or replaces a whole file. It creates missing folders, keeps the file's mode, and never leaves a file half written. |
| `edit` | Replaces exact text. Each `oldText` must appear exactly once, and several edits apply together or not at all. Windows line endings are kept. |
| `bash` | Runs a command in the folder, with output and errors together. Long output keeps its first 16 KB and last 48 KB. |

Every path is resolved to where it really is, and anything outside the folder is refused, even
through a link.

A command stops after 120 seconds unless the model asks for longer, up to 600. Both limits can be
changed with `createCodingTools(folder, { bash: { timeoutSeconds: 60, maxTimeoutSeconds: 300 } })`.
A timeout or a cancelled run stops the command and everything it started. Pagers print straight
through and git never waits for a password, so a command can't wait forever for a person who
isn't there.

## Approval

The tools run whatever the model asks, inside the folder. Whether a call may run is decided by
the `authorize` you give the agent. A sensible start lets the model read freely and asks before
anything else:

```ts
import { rules } from "@aum/core";

const authorize = rules({ read: "allow" }, { otherwise: "ask", ask: async call => confirm(`Allow ${call.name}?`) });
```

`confirm` stands for however you ask a person. A refused call reaches the model as `denied`, and
it carries on.

## A saved conversation

`openSession(folder, id)` keeps a conversation in `<folder>/<id>.jsonl`. It starts the file if
there isn't one and continues it if there is:

```ts
import { newSessionId, openSession } from "@aum/harness/sessions/jsonl";

const session = await openSession(".aum/sessions", newSessionId());
```

Each saved message is one JSON line, synced to disk before the agent moves on, so a power cut
loses nothing that was reported as saved. If the process dies in the middle of writing a line,
the half line is cut off the next time the session is opened. Damage anywhere else stops the
load with the line number, rather than guessing.

`newSessionId()` makes an id from the time and a random suffix. Your own ids may use letters,
digits, `.`, `_` and `-`, since they become file names.

## The agent

Now put the pieces together with the core's `Agent`:

```ts
import { Agent, bind, lineageContext, rules } from "@aum/core";
import { PiCatalog } from "@aum/harness/providers/pi";
import { newSessionId, openSession } from "@aum/harness/sessions/jsonl";
import { createCodingTools } from "@aum/harness/tools/coding";

const { model } = new PiCatalog().load("openai/gpt-5-mini");
const tools = createCodingTools(".").map(bind);
const authorize = rules({ read: "allow" }, { otherwise: "ask", ask: async call => confirm(`Allow ${call.name}?`) });

const agent = new Agent({
    session: await openSession(".aum/sessions", newSessionId()),
    getBindings: () => ({ model, tools, context: lineageContext("You are a coding agent."), authorize }),
});

const run = agent.run("What does package.json say this project is called?");
for await (const { event } of run.events) {
    if (event.type === "model_delta") process.stdout.write(event.text);
    if (event.type === "tool_started") console.log(`\n→ ${event.name}`, event.args);
}
const result = await run.result;
console.log(`\n${result.status} after ${result.cycles} replies`);
```

The model reads `package.json` without asking, answers, and the whole exchange is in
`.aum/sessions/`. Ask it to change a file and `confirm` is called first.

## Coming back to a conversation

`listSessions(folder)` lists the saved conversations, most recently used first. Open one by its
id and the agent continues where it stopped:

```ts
import { listSessions, openSession } from "@aum/harness/sessions/jsonl";

const [latest] = await listSessions(".aum/sessions");  // { id, modified }
const session = await openSession(".aum/sessions", latest!.id);
```

If the agent was stopped while a tool was running, the next run tells the model that call's
result is `unknown`, so it checks before doing the work again.

## Switching models

The core reads the bindings before every reply, so keep the model in a variable and change it
whenever you like, even in the middle of a conversation:

```ts
let { model } = catalog.load("openai/gpt-5-mini");
const getBindings = () => ({ model, tools, context: lineageContext("You are a coding agent."), authorize });

model = catalog.load("anthropic/claude-sonnet-5-5", { reasoning: "high" }).model; // used from the next reply
```

A model's own reasoning from earlier replies is sent back only to that same model. After a
switch, the new model sees the conversation without it, rather than the provider rejecting the
request.

## When a provider fails

Provider failures end the run with `failed` and a `kind` in `result.error`, so you can decide
what to do:

| `kind` | Usually means | `retryable` |
| --- | --- | --- |
| `rate_limit` | Too many requests; wait and retry | yes |
| `network` | The connection dropped or the provider was briefly unavailable | yes |
| `auth` | The key is missing or wrong | no |
| `unsupported` | The conversation is too long for the model | no |
| `protocol` | The provider sent something unexpected | no |

## Going further

The pieces above are made of smaller ones, which you can use on their own.

**Your own Pi models.** `new PiCatalog(models)` takes a Pi model collection of your own, for
example with a local provider added. `createPiModel({ models, model, reasoning, apiKey })` wraps
a single Pi model without a catalog.

**Single tools.** Each tool can be made alone over a `Workspace`, which is the folder they're
confined to:

```ts
import { Workspace, createReadTool, createEditTool } from "@aum/harness/tools/coding";

const workspace = new Workspace("./my-project");
const reviewerTools = [createReadTool(workspace), createEditTool(workspace)].map(bind);
```

`createWriteTool` and `createBashTool(workspace, { timeoutSeconds })` work the same way.
`writeAtomic(path, content, signal)` is the write that never leaves a half-written file.

**A session file somewhere else.** `jsonlJournal(path)` is the core `Journal` that writes and
syncs the file, and `recoverJournal(path)` loads it back, cutting off a half-written last line.
`openSession` is `journalSession(jsonlJournal(path), await recoverJournal(path))`:

```ts
import { journalSession } from "@aum/core";
import { jsonlJournal, recoverJournal } from "@aum/harness/sessions/jsonl";

const path = "/var/data/review.jsonl";
const session = journalSession(jsonlJournal(path), await recoverJournal(path));
```

## What it exports

| Import | Exports |
| --- | --- |
| `@aum/harness/providers/pi` | `PiCatalog`, `createPiModel`, `REASONING`, `DEFAULT_REASONING`, and `encode`/`decode` for converting requests and replies |
| `@aum/harness/tools/coding` | `createCodingTools`, `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, `Workspace`, `writeAtomic` |
| `@aum/harness/sessions/jsonl` | `openSession`, `newSessionId`, `listSessions`, `jsonlJournal`, `recoverJournal` |

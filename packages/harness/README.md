# @aum/harness

An agent framework built on [`@aum/core`](../../src/README.md), usable directly or built on.
It ships with what most agents need, so installing it is enough to start: every model family
[Pi](https://github.com/earendil-works/pi/tree/main/packages/ai) supports, coding tools, and
sessions saved to disk. The aum CLI and desktop app (phases 2 and 3) will be built only on
what this package exports, so anything they do, your own program can do too.

```sh
npm install @aum/core @aum/harness
```

`@aum/core` is a peer dependency, so the application and the harness share one copy of it.

## A coding agent

```ts
import { Agent, bind, lineageContext, rules } from "@aum/core";
import { PiCatalog } from "@aum/harness/providers/pi";
import { openSession } from "@aum/harness/sessions/jsonl";
import { createCodingTools } from "@aum/harness/tools/coding";

const { model } = new PiCatalog().load("openai/gpt-5-mini");   // key from OPENAI_API_KEY
const tools = createCodingTools(".").map(bind);
const authorize = rules({ read: "allow" }, { otherwise: "ask", ask: async call => confirm(`Allow ${call.name}?`) });

const agent = new Agent({
    session: await openSession(".aum/sessions", "first"),
    getBindings: () => ({ model, tools, context: lineageContext("You are a coding agent."), authorize }),
});
const result = await agent.run("What does package.json say this project is called?").result;
```

`confirm` stands for however you ask a person. Today the pieces are put together by hand like
this; phase 1 adds `createAgent`, which takes the model by name and does the assembly.
[`apps/demo.ts`](../../apps/demo.ts) is the interactive version.

## What it exports

| Import | What it gives you |
| --- | --- |
| `@aum/harness/providers/pi` | `PiCatalog`: `families()`, `modelsOf(family)`, `hasCredentials(family)`, and `load("<family>/<model>", { reasoning, apiKey })`, which returns `{ model, reasoning }`. `createPiModel` wraps one Pi model as a `Model`; `encode` and `decode` are its codec. `REASONING` and `DEFAULT_REASONING` (`medium`). |
| `@aum/harness/tools/coding` | `createCodingTools(root, { bash })`: `read`, `write`, `edit` and `bash` for one folder. Each also on its own (`createReadTool` and so on) over a `Workspace`, plus `writeAtomic`. |
| `@aum/harness/sessions/jsonl` | `openSession(dir, id)`, `newSessionId()`, `listSessions(dir)`, and the parts beneath them: `jsonlJournal(path)` and `recoverJournal(path)`. |

### Providers

- **42 families, none named in advance.** The list is Pi's own, pinned at
  `@earendil-works/pi-ai` 1.4.0.
- **Reasoning at medium by default.** A level the model doesn't take falls back to medium, or
  the nearest it takes; a model that doesn't reason gets none.
- **Keys stay with Pi.** Pi finds each family's key in the environment or its credential store.
  `apiKey` overrides it for one model, and a lookup that stalls past three seconds counts as
  not found.
- **Errors you can act on.** Provider failures become `ModelError` kinds: `rate_limit`
  (retryable), `auth`, `network`, `unsupported` for an overlong conversation, and `protocol`.
- **Reasoning replayed only where it's valid.** A model's reasoning and signatures are saved
  beside its message and sent back only to that same model; switching models drops them
  instead of failing.

### Coding tools

- **Confined to the folder.** Every path is resolved to its real location, and anything
  outside the root is refused, including through a link.
- **`read`** pages text 2,000 lines at a time and says where to continue; images come back
  as images.
- **`write`** goes through a temporary file and a rename, so a file is never half written; it
  creates folders and keeps the file's mode.
- **`edit`** needs each `oldText` to occur exactly once, applies several edits together or
  not at all, and handles Windows line endings.
- **`bash`** runs in its own process group, so a timeout (120 s by default, up to 600) or a
  cancel stops everything it started. Long output keeps the first 16 KB and the last 48 KB.
- **No approval of their own.** Whether a tool may run is the `authorize` you pass the agent.

### Sessions

- One JSON line per entry, synced to disk before the run moves on.
- A half-written last line from a crash is cut off on load; damage anywhere else fails with
  the line number.
- Session ids become file names, so they are limited to letters, digits, `.`, `_` and `-`.

## Layout

```
providers/pi/      catalog.ts · model.ts · codec.ts · index.ts
tools/coding/      read.ts · write.ts · edit.ts · bash.ts · workspace.ts · args.ts · index.ts
sessions/          jsonl.ts
```

Files import the core as `@aum/core` and each other by relative path. Inside the repo,
`--conditions=development` loads the TypeScript source; `npm run build` compiles to `dist/`,
which is all the published package contains.

## Phase 1 roadmap

Done:

- [x] Every Pi family by `<family>/<model>`, medium reasoning by default, keys by environment or `apiKey` · `checks/pi.test.ts`
- [x] Coding tools confined to one folder · `checks/tools.test.ts`
- [x] JSONL sessions that survive a crash · `checks/session.test.ts`
- [x] Published as its own package, installable and runnable outside the repo · `checks/pack.test.ts`

Next, each with its checks, following the reference design in the
[field guide](https://claude.ai/artifact/BWJNpyUomQaojgNAuLY4yS):

- [ ] `createAgent({ model: "openai/gpt-5-mini", tools, session, system, policy })`: the
  model by name, the assembly done for you
- [ ] Services under keys, where the user's version wins over the shipped one and removing it
  brings the default back
- [ ] Changes with their own undo, so removing a component leaves no trace
- [ ] Layered config (shipped, machine, project, session), each layer saying only what it changes
- [ ] Reloads that keep the running version if the new one fails
- [ ] Control: preview, apply, inspect and undo, for people and the agent alike
- [ ] Mods: a person's own components, run in their own process once trusted
- [ ] The application runtime the CLI and app share: sessions, approvals any screen can
  answer, model choice, commands

## How it's checked

`npm test` from the repository root runs every check offline: Pi's faux provider answers
through Pi's real request path, so no network or key is needed. `checks/pack.test.ts` builds
and packs this package with the core, installs both into an empty project outside the repo,
and runs an agent as plain JavaScript.

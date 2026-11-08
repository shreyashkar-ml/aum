import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Agent, bind, lineageContext, rules, textOf, type AgentEvent, type Json, type Model, type RunHandle, type ToolUseBlock } from "@aum/core";
import { PiCatalog, REASONING, type Reasoning } from "@aum/harness/providers/pi";
import { newSessionId, openSession } from "@aum/harness/sessions/jsonl";
import { createCodingTools } from "@aum/harness/tools/coding";

// A small playground for the core loop with real models. @aum/harness supplies the Pi model,
// the coding tools and the saved conversation; everything else is @aum/core (src/) as it is.
//
//   npm run demo -- --list                       model families, and which have credentials
//   npm run demo -- --list anthropic             that family's models
//   npm run demo -- [--model openai/gpt-5-mini] [--reasoning high] [--session <id>]
//
// LLM_API_KEY in .env is an OpenAI key and is used for openai/* models; other families find
// their keys the way Pi usually does.

const { values: flags } = parseArgs({ options: {
    list: { type: "boolean", default: false },
    model: { type: "string", default: "openai/gpt-5-mini" },
    reasoning: { type: "string" },
    session: { type: "string" },
    root: { type: "string", default: "." },
    system: { type: "string", default: "prompts/coding.md" },
}, allowPositionals: true });

// A missing .env is fine: the key may already be in the environment.
try { process.loadEnvFile(".env"); } catch {}
const openaiKey = process.env.LLM_API_KEY;
const catalog = new PiCatalog();

if (flags.list) {
    const family = parseArgs({ allowPositionals: true, strict: false }).positionals[0];
    if (family) for (const model of catalog.modelsOf(family)) stdout.write(`  ${model.id}  ${model.name}${model.reasoning.length ? `  [${model.reasoning.join(" ")}]` : ""}\n`);
    else for (const family of catalog.families())
        stdout.write(`  ${(family.id === "openai" && openaiKey) || await catalog.hasCredentials(family.id) ? "●" : "○"} ${family.id.padEnd(24)} ${family.name}${family.keyName ? `  (${family.keyName})` : ""}\n`);
    process.exit(0);
}

// The model lives in a variable the bindings read, so /model switches it from the next reply,
// even in the middle of a conversation.
let model: Model, ref = flags.model, reasoning: Reasoning | undefined;
try { use(ref, flags.reasoning as Reasoning | undefined); }
catch (error) { stdout.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); }

// Every line typed or piped in waits here until the request loop or an approval reads it.
const lines: string[] = [];
let waiting: ((line: string | undefined) => void) | undefined, ended = false;
const terminal = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY ?? false });
terminal.on("line", line => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); } else lines.push(line); });
terminal.on("close", () => { ended = true; waiting?.(undefined); });
const nextLine = (prompt: string): Promise<string | undefined> => {
    stdout.write(prompt);
    if (lines.length) return Promise.resolve(lines.shift());
    return ended ? Promise.resolve(undefined) : new Promise(resolve => { waiting = resolve; });
};

// Reads run freely; writes, edits and commands wait for a yes, and a cancelled run counts as no.
const authorize = rules({ read: "allow" }, { otherwise: "ask", ask: async (call: ToolUseBlock, signal: AbortSignal) => {
    const answer = await Promise.race([
        nextLine(`\n? Allow ${call.name} ${describe(call.args)} [y/N] `),
        new Promise<undefined>(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true })),
    ]);
    return /^y(es)?$/i.test(answer?.trim() ?? "");
} });

const system = await readFile(flags.system, "utf8").catch(() => "You are a helpful coding agent.");
const tools = createCodingTools(flags.root).map(bind);
const sessionId = flags.session ?? newSessionId();
const agent = new Agent({
    session: await openSession(".aum/sessions", sessionId),
    getBindings: () => ({ model, tools, context: lineageContext(system), authorize }),
});

stdout.write(`session ${sessionId} · ${status()}\n/model <family>/<model> [level], /reasoning <level>, /exit. Ctrl+C cancels a reply.\n`);
let current: RunHandle | undefined;
terminal.on("SIGINT", () => current ? current.cancel() : terminal.close());

while (true) {
    const line = (await nextLine("› "))?.trim();
    if (line === undefined || line === "/exit") break;
    try {
        if (line.startsWith("/")) command(line);
        else if (line) {
            current = agent.run(line);
            for await (const { event } of current.events) render(event);
            await current.result;
        }
    } catch (error) {
        stdout.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
        current = undefined;
    }
}
process.exit(0);

// A line may hold several commands, such as /model openai/gpt-5.5 /reasoning high. They apply
// in order, and the first that fails stops the rest.
function command(line: string) {
    for (const part of line.split(/\s+(?=\/)/)) {
        const [name, ...args] = part.split(/\s+/);
        if (name === "/model" && args.length >= 1 && args.length <= 2) use(args[0]!, args[1] ? accepted(args[0]!, args[1]) : reasoning);
        else if (name === "/reasoning" && args.length === 1) use(ref, accepted(ref, args[0]!));
        else throw new Error(`Unknown command ${part}. Use /model <family>/<model> [level], /reasoning <level> or /exit`);
    }
    stdout.write(`${status()}\n`);
}

// A level asked for by name must be one the model takes; one carried over from the previous
// model may fall back to the new model's default instead.
function accepted(next: string, level: string): Reasoning {
    const [family = "", ...rest] = next.split("/");
    const levels = catalog.modelsOf(family).find(model => model.id === rest.join("/"))?.reasoning ?? REASONING;
    if (!levels.includes(level as Reasoning)) throw new Error(`${next} takes ${levels.join(", ") || "no reasoning level"}, not ${level}`);
    return level as Reasoning;
}

function use(next: string, level: Reasoning | undefined) {
    if (level && !REASONING.includes(level)) throw new Error(`Reasoning is one of ${REASONING.join(", ")}`);
    const apiKey = next.startsWith("openai/") ? openaiKey : undefined;
    const loaded = catalog.load(next, { ...(level && { reasoning: level }), ...(apiKey && { apiKey }) });
    model = loaded.model; ref = next; reasoning = loaded.reasoning;
}

function status() {
    return `${ref}${reasoning ? ` · reasoning ${reasoning}` : ""}`;
}

function render(event: AgentEvent) {
    switch (event.type) {
        case "model_delta": return void stdout.write(event.text);
        case "tool_started": return void stdout.write(`\n→ ${event.name} ${describe(event.args)}\n`);
        case "tool_finished": return void stdout.write(event.status === "success"
            ? `✓ ${event.name}: ${(textOf(event.content).split("\n")[0] ?? "").slice(0, 120)}\n`
            : `✗ ${event.name} ${event.status}${event.error ? `: ${event.error.message}` : ""}\n`);
        case "run_finished": {
            const { status, cycles, usage, error } = event.result;
            return void stdout.write(`\n[${status}${error ? `: ${error.message}` : ""} · ${cycles} replies · ${usage.inputTokens} in · ${usage.outputTokens} out]\n`);
        }
    }
}

// A call is shown by what it acts on, which reads better than its full arguments.
function describe(args: Json): string {
    const fields = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const shown = String(fields.command ?? fields.path ?? JSON.stringify(args));
    return shown.length > 160 ? `${shown.slice(0, 160)}…` : shown;
}

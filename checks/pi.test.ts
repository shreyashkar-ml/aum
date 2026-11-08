import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall,
    type Message as PiMessage, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { MemorySession, bind, defineTool, lineageContext, rules, runAgent, userMessage, type Bindings, type Model } from "@aum/core";
import { PiCatalog, createPiModel } from "@aum/harness/providers/pi";

// Pi's faux provider streams scripted replies through Pi's real request path, so these checks
// cover the codec and Pi's handling of it with no network and no key.

const echo = defineTool({
    name: "echo", description: "Echo text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    parse: raw => {
        if (!raw || typeof raw !== "object" || typeof (raw as { text?: unknown }).text !== "string")
            throw new Error(`Expected { text: string }, got ${JSON.stringify(raw)}`);
        return (raw as { text: string }).text;
    },
    execute: async text => text,
});

function setup(id = "faux-a") {
    const faux = fauxProvider({ provider: id, models: [{ id: `${id}-model`, reasoning: true }] });
    const models = createModels();
    models.setProvider(faux.provider);
    return { faux, model: createPiModel({ models, model: faux.getModel() }) };
}

const bindingsFor = (model: () => Model, extra: Partial<Bindings> = {}) =>
    () => ({ model: model(), tools: [bind(echo)], context: lineageContext("Be brief."), ...extra });

// Every message Pi sent to the provider, without the system message it adds in front.
const sent = (context: TranscriptContext) => context.messages.filter((message: PiMessage) => message.role !== "system");

test("a tool call round trip keeps the model's reasoning for the same model", async () => {
    const { faux, model } = setup();
    let second: TranscriptContext | undefined;
    faux.setResponses([
        fauxAssistantMessage([fauxThinking("I should echo."), fauxToolCall("echo", { text: "hi" }, { id: "call-1" })], { stopReason: "toolUse" }),
        context => { second = context; return fauxAssistantMessage([fauxText("Done: hi")]); },
    ]);
    const session = new MemorySession();
    const result = await runAgent({ session, bindings: bindingsFor(() => model), input: userMessage("echo hi") });

    assert.equal(result.status, "completed");
    const saved = (await session.lineage()).map(entry => entry.message);
    assert.deepEqual(saved.map(message => message.role), ["user", "assistant", "tool", "assistant"]);
    assert.equal(saved[1]!.role === "assistant" && saved[1]!.adapterData?.pi?.version, 1);

    const replayed = sent(second!)[1];
    assert.equal(replayed?.role, "assistant");
    assert.deepEqual(replayed?.role === "assistant" && replayed.content.map(block => block.type), ["thinking", "toolCall"]);
});

test("switching models mid-session drops the old reasoning instead of failing", async () => {
    const a = setup("faux-a"), b = setup("faux-b");
    let seenByB: TranscriptContext | undefined;
    a.faux.setResponses([fauxAssistantMessage([fauxThinking("secret plan"), fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" })]);
    b.faux.setResponses([context => { seenByB = context; return fauxAssistantMessage("Finished on model B"); }]);

    let current = a.model;
    const session = new MemorySession();
    const result = await runAgent({
        session, input: userMessage("go"),
        bindings: bindingsFor(() => current),
        emit: event => { if (event.type === "message_committed" && event.message.role === "tool") current = b.model; },
    });

    assert.equal(result.status, "completed");
    const assistant = sent(seenByB!).find(message => message.role === "assistant");
    assert.deepEqual(assistant?.role === "assistant" && assistant.content.map(block => block.type), ["toolCall"]);
});

test("a refused call reaches the model as an error that says why", async () => {
    const { faux, model } = setup();
    let second: TranscriptContext | undefined;
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" }),
        context => { second = context; return fauxAssistantMessage("ok"); },
    ]);
    await runAgent({ session: new MemorySession(), input: userMessage("go"), bindings: bindingsFor(() => model, { authorize: rules({ echo: "deny" }) }) });
    const result = sent(second!).find(message => message.role === "toolResult");
    assert.equal(result?.role === "toolResult" && result.isError, true);
    assert.match(JSON.stringify(result), /\[denied\] PolicyDenied: Policy denies echo/);
});

test("arguments that are not valid JSON reach the tool as text the model can see", async () => {
    const { faux, model } = setup();
    let second: TranscriptContext | undefined;
    const broken = { ...fauxToolCall("echo", {}), argumentsError: "Invalid JSON: {\"text\": " };
    faux.setResponses([
        fauxAssistantMessage([broken], { stopReason: "toolUse" }),
        context => { second = context; return fauxAssistantMessage("ok"); },
    ]);
    await runAgent({ session: new MemorySession(), input: userMessage("go"), bindings: bindingsFor(() => model) });
    assert.match(JSON.stringify(sent(second!).find(message => message.role === "toolResult")), /Invalid JSON/);
});

test("provider failures become ModelError kinds the application can act on", async () => {
    const { faux, model } = setup();
    faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests: rate limit exceeded" })]);
    const result = await runAgent({ session: new MemorySession(), input: userMessage("go"), bindings: bindingsFor(() => model) });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.kind, "rate_limit");
    assert.equal(result.error?.retryable, true);
});

test("cancelling during a reply ends the run as cancelled", async () => {
    const { faux, model } = setup();
    faux.setResponses([async () => { await new Promise(resolve => setTimeout(resolve, 500)); return fauxAssistantMessage("late"); }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runAgent({ session: new MemorySession(), input: userMessage("go"), bindings: bindingsFor(() => model), signal: controller.signal });
    assert.equal(result.status, "cancelled");
});

test("every model family Pi ships is listed, and a model loads by <family>/<model>", () => {
    const catalog = new PiCatalog();
    const families = catalog.families().map(family => family.id);
    assert.ok(families.length >= 40, `only ${families.length} families`);
    for (const id of ["anthropic", "openai", "google", "openrouter"]) assert.ok(families.includes(id), id);
    const sonnet = catalog.modelsOf("anthropic").find(model => model.id === "claude-sonnet-5-5");
    assert.ok(sonnet?.reasoning.includes("medium"));
    assert.ok(!sonnet?.reasoning.includes("minimal"), "Pi marks minimal as unsupported for this model");
    const loaded = catalog.load("anthropic/claude-sonnet-5-5");
    assert.equal(loaded.reasoning, "medium");
    assert.equal(loaded.model.info.model, "claude-sonnet-5-5");
    assert.equal(catalog.load("anthropic/claude-sonnet-5-5", { reasoning: "minimal" }).reasoning, "medium");
});

test("an unknown family or model is named with the known ones", () => {
    const catalog = new PiCatalog();
    assert.throws(() => catalog.load("anthropik/x"), /Pi has no model family anthropik\. Known: .*anthropic/);
    assert.throws(() => catalog.load("anthropic/nope"), /has no model nope\. Known:/);
    assert.throws(() => catalog.load("anthropic"), /Expected <family>\/<model>/);
});

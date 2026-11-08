import type {
    AssistantMessage as PiAssistant, Context as PiContext, ImageContent, Message as PiMessage,
    TextContent, ThinkingContent, ToolCall, Usage as PiUsage,
} from "@earendil-works/pi-ai";
import {
    ModelError, type AssistantMessage, type Content, type FinishReason, type Json, type JsonObject,
    type ModelCompletion, type ModelRequest, type ToolResultBlock,
} from "@aum/core";

// Converts between aum's messages and Pi's. aum's messages are what the session saves, and they
// have no room for a model's reasoning or for the signatures some providers attach to replies.
// Those are kept beside the message, in adapterData.pi, and put back when the same model sees
// the conversation again. Pi's types change between releases; only this package sees them.

type PiBlock = TextContent | ThinkingContent | ToolCall;

// One entry per block of Pi's reply, in order. Text and calls are already in aum's message, so
// only what aum cannot hold is kept for them; reasoning is kept whole.
type Slot =
    | { type: "thinking"; block: ThinkingContent }
    | { type: "text"; textSignature?: string }
    | { type: "toolCall"; id: string; thoughtSignature?: string; namespace?: string };
type Replay = { api: string; provider: string; model: string; slots: Slot[] };

const VERSION = 1;

export function decode(native: PiAssistant): ModelCompletion {
    const content: AssistantMessage["content"] = [];
    const slots: Slot[] = [];
    let extra = false;
    for (const block of native.content) {
        if (block.type === "thinking") {
            slots.push({ type: "thinking", block });
            extra = true;
        } else if (block.type === "text") {
            content.push({ type: "text", text: block.text });
            slots.push({ type: "text", ...(block.textSignature !== undefined && { textSignature: block.textSignature }) });
            extra ||= block.textSignature !== undefined;
        } else {
            // When the model's arguments were not valid JSON, Pi describes the problem and the text
            // it received. Passing that on, instead of Pi's empty {}, lets the tool's argument check
            // show the model what went wrong.
            content.push({ type: "tool_use", id: block.id, name: block.name, args: block.argumentsError ?? (block.arguments as Json) });
            slots.push({
                type: "toolCall", id: block.id,
                ...(block.thoughtSignature !== undefined && { thoughtSignature: block.thoughtSignature }),
                ...(block.namespace !== undefined && { namespace: block.namespace }),
            });
            extra ||= block.thoughtSignature !== undefined || block.namespace !== undefined;
        }
    }

    const message: AssistantMessage = { role: "assistant", content };
    if (extra) {
        const replay: Replay = { api: native.api, provider: native.provider, model: native.model, slots };
        message.adapterData = { pi: { version: VERSION, value: JSON.parse(JSON.stringify(replay)) as Json } };
    }
    return {
        message,
        finishReason: finishReason(native.stopReason),
        usage: { inputTokens: native.usage.input + native.usage.cacheRead + native.usage.cacheWrite, outputTokens: native.usage.output },
    };
}

function finishReason(reason: PiAssistant["stopReason"]): FinishReason {
    switch (reason) {
        case "stop": return "stop";
        case "toolUse": return "tool_calls";
        case "length": return "length";
        default: throw new ModelError(`Pi ended the reply with "${reason}", which aum does not handle`, "unsupported");
    }
}

// The model the request is for. Saved reasoning and signatures are valid only for the model that
// produced them, so they are sent back only when the request goes to that same model.
export type Target = { api: string; provider: string; id: string };

export function encode(request: ModelRequest, target: Target): PiContext {
    const names = new Map<string, string>(); // call id → tool name, which Pi needs on each result
    const messages: PiMessage[] = [];
    for (const message of request.context.messages) {
        if (message.role === "user") {
            messages.push({ role: "user", content: message.content.map(toPi), timestamp: 0 });
        } else if (message.role === "assistant") {
            messages.push(assistant(message, target));
            for (const block of message.content) if (block.type === "tool_use") names.set(block.id, block.name);
        } else {
            for (const result of message.content) {
                const name = names.get(result.callId);
                if (name === undefined) throw new ModelError(`Tool result ${result.callId} has no matching call`, "protocol");
                messages.push({
                    role: "toolResult", toolCallId: result.callId, toolName: name,
                    content: resultContent(result), isError: result.status !== "success", timestamp: 0,
                });
            }
        }
    }
    return {
        ...(request.context.systemPrompt !== undefined && { systemPrompt: request.context.systemPrompt }),
        messages,
        tools: request.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    };
}

const toPi = (block: Content): TextContent | ImageContent =>
    block.type === "image" ? { type: "image", data: block.base64, mimeType: block.mimeType } : block;

// Without the reason, a model may simply retry a call that was refused. Every result that is not
// a success says how it ended, and why when there is an error.
function resultContent(result: ToolResultBlock): (TextContent | ImageContent)[] {
    const content = result.content.map(toPi);
    if (result.status !== "success") {
        content.push({ type: "text", text: `[${result.status}]${result.error ? ` ${result.error.name}: ${result.error.message}` : ""}` });
    } else if (!content.length) {
        content.push({ type: "text", text: "(no output)" });
    }
    return content;
}

const NO_USAGE: PiUsage = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// A reply without usable replay data is labelled as coming from no known model, so Pi treats it
// the way it treats a reply from another provider: text and calls go through, nothing else.
function assistant(message: AssistantMessage, target: Target): PiAssistant {
    const blocks = message.content.map((block): PiBlock => {
        if (block.type === "tool_use") return { type: "toolCall", id: block.id, name: block.name, arguments: isObject(block.args) ? block.args : {} };
        if (block.type === "image") return { type: "text", text: `[image (${block.mimeType}) omitted]` };
        return { type: "text", text: block.text };
    });
    const replay = readReplay(message.adapterData?.pi);
    const same = replay?.api === target.api && replay.provider === target.provider && replay.model === target.id;
    const merged = same ? merge(blocks, replay.slots) : undefined;
    return {
        role: "assistant",
        content: merged ?? blocks,
        api: merged ? target.api : "aum", provider: merged ? target.provider : "aum", model: merged ? target.id : "aum",
        usage: NO_USAGE,
        stopReason: blocks.some(block => block.type === "toolCall") ? "toolUse" : "stop",
        timestamp: 0,
    };
}

// Puts the saved reasoning and signatures back around the message's own text and calls. If the
// two no longer line up, because the message was changed after it was saved, nothing is put back:
// the reply is then sent like one from another model, which loses the reasoning but never fails.
function merge(blocks: PiBlock[], slots: Slot[]): PiBlock[] | undefined {
    const merged: PiBlock[] = [];
    let next = 0;
    for (const slot of slots) {
        if (slot.type === "thinking") {
            merged.push(slot.block);
            continue;
        }
        const block = blocks[next++];
        if (!block || block.type !== slot.type) return undefined;
        if (block.type === "text") {
            merged.push(slot.type === "text" && slot.textSignature !== undefined ? { ...block, textSignature: slot.textSignature } : block);
        } else if (slot.type === "toolCall") {
            if (block.id !== slot.id) return undefined;
            merged.push({
                ...block,
                ...(slot.thoughtSignature !== undefined && { thoughtSignature: slot.thoughtSignature }),
                ...(slot.namespace !== undefined && { namespace: slot.namespace }),
            });
        }
    }
    return next === blocks.length ? merged : undefined;
}

// Saved sessions come back from disk, possibly written by an older version or edited by hand,
// so replay data is checked before use. Anything unexpected is ignored rather than trusted.
function readReplay(data: { version: number; value: Json } | undefined): Replay | undefined {
    if (data?.version !== VERSION || !isObject(data.value)) return undefined;
    const { api, provider, model, slots } = data.value;
    if (typeof api !== "string" || typeof provider !== "string" || typeof model !== "string" || !Array.isArray(slots)) return undefined;
    const valid = slots.every(slot => isObject(slot) && (
        slot.type === "text" ? optionalString(slot.textSignature)
        : slot.type === "toolCall" ? typeof slot.id === "string" && optionalString(slot.thoughtSignature) && optionalString(slot.namespace)
        : slot.type === "thinking" && isObject(slot.block) && slot.block.type === "thinking" && typeof slot.block.thinking === "string"));
    return valid ? { api, provider, model, slots: slots as unknown as Slot[] } : undefined;
}

const isObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: unknown) => value === undefined || typeof value === "string";

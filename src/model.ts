import type { AssistantMessage, Message } from "./message.ts";
import type { ToolDefinition } from "./tools.ts";

export type Context = { systemPrompt?: string; messages: Message[] };
export type ModelSettings = { temperature?: number; maxOutputTokens?: number };
export type ModelRequest = {
    context: Context;
    tools: readonly ToolDefinition[];
    settings?: ModelSettings;
};
export type ModelExecution = {
    signal: AbortSignal;
    onProgress?: (delta: { type: "text_delta"; text: string }) => void;
};
export type Usage = { inputTokens: number; outputTokens: number };
export type FinishReason = "stop" | "tool_calls" | "length" | "blocked";
export type ModelCompletion = {
    message: AssistantMessage;
    finishReason: FinishReason;
    usage?: Usage;
};
export type ModelInfo = {
    adapter: string;
    provider: string;
    model: string;
    capabilities: { tools: boolean; images: boolean; };
};

// Credentials, endpoints and wire formats differ per provider, so we hide them in an adapter class.
// Lets a host swap models and adapters without touching the loop.
export interface Model {
    readonly info: ModelInfo;
    complete(request: ModelRequest, execution: ModelExecution): Promise<ModelCompletion>;
}

export class ModelError extends Error {
    readonly kind: "auth" | "rate_limit" | "network" | "protocol" | "unsupported";
    readonly retryable: boolean;
    constructor(message: string, kind: ModelError["kind"], retryable = false) {
        super(message);
        this.name = "ModelError";
        this.kind = kind;
        this.retryable = retryable;
    }
}
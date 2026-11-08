import {
    isContextOverflow, isRetryableAssistantError,
    type Api, type AssistantMessage as PiAssistant, type Model as PiModel, type Models, type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { ModelError, type Model } from "../../src/index.ts";
import { decode, encode } from "./codec.ts";

export type PiModelOptions = {
    // The Pi collection that owns the model's provider, and with it the provider's credentials.
    models: Models;
    model: PiModel<Api>;
    reasoning?: ThinkingLevel;
    // Overrides the key Pi would find on its own, for callers that keep it somewhere else.
    apiKey?: string;
};

// One Pi model behind aum's Model port. Pi streams the reply; text is passed on as it arrives,
// but a half-streamed tool call has incomplete arguments, so calls are taken from the final reply.
export function createPiModel({ models, model, reasoning, apiKey }: PiModelOptions): Model {
    return {
        info: {
            adapter: "pi", provider: model.provider, model: model.id,
            capabilities: { tools: true, images: model.input.includes("image") },
        },
        async complete(request, { signal, onProgress }) {
            const settings = request.settings;
            const stream = models.streamSimple(model, encode(request, model), {
                signal,
                ...(apiKey !== undefined && { apiKey }),
                ...(reasoning !== undefined && { reasoning }),
                ...(settings?.temperature !== undefined && { temperature: settings.temperature }),
                ...(settings?.maxOutputTokens !== undefined && { maxTokens: settings.maxOutputTokens }),
            });
            for await (const event of stream) {
                if (event.type === "text_delta") onProgress?.({ type: "text_delta", text: event.delta });
            }
            const reply = await stream.result();
            if (reply.stopReason === "aborted") {
                signal.throwIfAborted();
                throw new ModelError(reply.errorMessage ?? "The provider stopped the reply", "network", true);
            }
            if (reply.stopReason === "error") throw failure(reply, model);
            return decode(reply);
        },
    };
}

// The run's result tells the application what went wrong, so it can retry, ask for a key, or
// shorten the conversation. Pi reports failures as text, so they are sorted by Pi's own patterns
// first and by common status words after.
function failure(reply: PiAssistant, model: PiModel<Api>): ModelError {
    const message = reply.errorMessage ?? "The provider returned an error";
    if (isContextOverflow(reply, model.contextWindow))
        return new ModelError(`The conversation no longer fits ${model.id}'s context window: ${message}`, "unsupported");
    if (/\b429\b|rate.?limit|too many requests/i.test(message)) return new ModelError(message, "rate_limit", true);
    if (/\b40[13]\b|api key|unauthori[sz]ed|authentication|forbidden|credential/i.test(message)) return new ModelError(message, "auth");
    if (isRetryableAssistantError(reply)) return new ModelError(message, "network", true);
    return new ModelError(message, "protocol");
}

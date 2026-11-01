import { text, type Content, type Message } from "./message.ts";
import type { Context, Model } from "./model.ts";
import type { Session } from "./session.ts";

export type ContextBuilder = (input: { session: Session; model: Model; signal: AbortSignal }) => Promise<Context>;

export function lineageContext(system: string): ContextBuilder {
    return async ({ session, model, signal }) => {
        signal.throwIfAborted();
        const messages = (await session.lineage()).map(entry => entry.message);
        if (model.info.capabilities.images) return { systemPrompt: system, messages };
        const swap = (block: Content) => block.type === "image"
            ? text(`[image omitted (${block.mimeType}): this model cannot read images]`) : block;
        return { systemPrompt: system, messages: messages.map((message): Message => {
            if (message.role === "user") return { ...message, content: message.content.map(swap) };
            if (message.role === "tool") return { ...message,
                content: message.content.map(result => ({ ...result, content: result.content.map(swap) }))
            };
            return { ...message, content: message.content.map(block => block.type === "tool_use" ? block: swap(block))};
        }
        )}
    };
}
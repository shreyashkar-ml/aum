export type JsonObject = { [key: string]: Json };
export type Json = null | boolean | number | string | Json[] | JsonObject;

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; mimeType: string; base64: string };
export type Content = TextBlock | ImageBlock;

export type ToolUseBlock = { type: "tool_use"; id: string; name: string; args: Json };

export type ErrorInfo = { name: string; message: string };

type ToolResultBase = { type: "tool_result"; callId: string; content: Content[] };

export type ToolResultBlock = 
    | (ToolResultBase & { status: "success"; error?: never })
    | (ToolResultBase & { status: "error"; error: ErrorInfo })
    | (ToolResultBase & { status: "denied" | "cancelled" | "unknown"; error?: ErrorInfo });

export type ToolStatus = ToolResultBlock["status"];

// Adapter data keeps provider specific continuation details at the message boundary
export type AdapterData = Record<string, { version: number; value: Json }>;

export type UserMessage = { role: "user"; content: Content[] };
export type AssistantMessage = {
    role: "assistant";
    content: (Content | ToolUseBlock)[];
    adapterData?: AdapterData;
};
export type ToolMessage = { role: "tool"; content: ToolResultBlock[] };

export type Message = UserMessage | AssistantMessage | ToolMessage;

export const text = (value: string): TextBlock => ({ type: "text", text: value });

export const userMessage = (input: string | Content[]): UserMessage => ({
    role: "user", content: typeof input === "string" ? [text(input)] : structuredClone(input),
});

export function textOf(blocks: readonly (Content | ToolUseBlock)[], separator = "\n"): string {
    return blocks.flatMap(block => block.type === "text" ? [block.text] : []).join(separator);
}

export function errorInfo(error: unknown): ErrorInfo {
    return error instanceof Error ? { name: error.name, message: error.message } 
    : { name: "Unknown", message: String(error) };
}

// A crash between running a tool and saving its result leaves a call no provider accepts.
// Results are always saved right after their proposal, so only the newest message can hold such a call.
// Checking the tail is enough to find all open calls.
export function openCalls(messages: readonly Message[]): ToolUseBlock[] {
    const last = messages.at(-1);
    return last?.role === "assistant" ? last.content.filter(block => block.type === "tool_use") : [];
}
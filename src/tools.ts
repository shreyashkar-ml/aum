import { text, type Content, type Json, type ToolStatus, type ToolUseBlock } from "./message.ts";

export type ToolDefinition = {
    name: string;
    description: string;
    parameters: Record<string, Json>;
}

export type ToolContext = { callId: string; signal: AbortSignal; progress(value: Json): void };
export type ToolOutput = string | Content[];
export type Tool = ToolDefinition & {
    execute(args: unknown, context: ToolContext): Promise<ToolOutput>;
};
export class ToolError extends Error {
    readonly output: ToolOutput;
    constructor(message: string, output: ToolOutput = "") {
        super(message);
        this.name = "ToolError";
        this.output = output;
    }
}

export function defineTool<T>({ parse, execute, ...definition }: ToolDefinition & { 
    parse: (input: unknown) => T; execute: (input: T, context: ToolContext) => Promise<ToolOutput> 
}): Tool {
        return { ...definition, execute: async (input, context) => execute(parse(input), context)};
}

export type ToolBinding = { tool: Tool; isEnabled(): boolean; };
export const bind = (tool: Tool): ToolBinding => ({ tool, isEnabled: () => true });

export type Decision = { allow: true } | { allow: false; reason: string };
export type Authorize = (call: ToolUseBlock, signal: AbortSignal) => Decision | Promise<Decision>;

// An unattended agent must not run risky tools, so "ask" with no approver
// attached is a denial, and tools missing from the table are denied by default.
export function rules(table: Readonly<Record<string, "allow" | "deny" | "ask">>, options: {
    otherwise?: "allow" | "deny" | "ask";
    ask?: (call: ToolUseBlock, signal: AbortSignal) => Promise<boolean>;
} = {}): Authorize {
    return async (call, signal) => {
        const rule = (Object.hasOwn(table, call.name) ? table[call.name] : undefined) ?? options.otherwise ?? "deny";
        if (rule === "allow") return { allow: true };
        if (rule === "deny") return { allow: false, reason: `Policy denies ${call.name}`};
        if (!options.ask) return { allow: false, reason: `${call.name} needs approval and no approver is attached` };
        return await options.ask(call, signal) ? { allow: true } : { allow: false, reason: `Approver denied ${call.name}` };
    }
}

// Mirrors ToolResultBlock: a failed tool always has its error, a successful one never does.
export type ToolOutcome =
    | { status: "success"; content: Content[]; error?: never }
    | { status: "error"; content: Content[]; error: Error }
    | { status: Exclude<ToolStatus, "success" | "error">; content: Content[]; error?: Error };
const toContent = (output: ToolOutput): Content[] => 
    typeof output === "string" ? (output ? [text(output)] : []) : output;

// Every call must end in a result, so this never throws.
// A failure after cancellation is "unknown".
export async function invokeTool(tool: Tool, args: unknown, options: Partial<ToolContext> = {}): Promise<ToolOutcome> {
    const { callId = crypto.randomUUID(), signal = new AbortController().signal, progress = () => {} } = options;
    if (signal.aborted) return { status: "cancelled", content: [] };
    try { return { status: "success", content: toContent(await tool.execute(args, { callId, signal, progress })) }; }
    catch(error) {
        return { status: signal.aborted ? "unknown" : "error",
            content: error instanceof ToolError ? toContent(error.output) : [],
            error: error instanceof Error ? error : new Error(String(error))
        };
    }
}
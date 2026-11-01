import { errorInfo, openCalls, type Message, type ToolResultBlock, type ToolStatus, type ToolUseBlock, type UserMessage } from "./message.ts";
import { ModelError, type FinishReason, type Model, type ModelSettings } from "./model.ts";
import { invokeTool, type Authorize, type Decision, type ToolBinding, type ToolOutcome } from "./tools.ts";
import type { ContextBuilder } from "./context.ts";
import type { Session } from "./session.ts";
import type { Emit, RunResult, RunStatus } from "./events.ts";

// Bindings for current cycle from caller: model, tools, context, authorize, settings.
// It is read again every cycle; so switching models/tools/contexts mid-response is safe and only applies to the next reply.
export type Bindings = {
    model: Model;
    tools: readonly ToolBinding[];
    context: ContextBuilder;
    authorize?: Authorize;
    settings?: ModelSettings;
};

export type RunOptions = {
    session: Session;
    bindings: () => Bindings;
    runId?: string | undefined;
    input?: UserMessage;
    emit?: Emit;
    signal?: AbortSignal;
    maxCycles?: number | undefined;
};

export type Refusal = "Truncated" | "NotOffered" | "Unavailable" | "PolicyDenied" | "PolicyError" | "Interrupted";

class RunStop extends Error {
    readonly status: Exclude<RunStatus, "completed">;
    constructor(status: RunStop["status"], message: string) {
        super(message);
        this.name = "RunStop";
        this.status = status;
    }
}

// Order of steps:
// Unanswered calls left by a crash are answered first, or the provider rejects the conversation.
// Each reply is saved before its tools run to infer original ask even if tool crashes.
export async function runAgent({
    session, bindings, runId, input,
    emit: observe = () => {},
    signal = new AbortController().signal,
    maxCycles = 30,
}: RunOptions): Promise<RunResult> {
    // emit is the caller's code, such as a screen. If it threw while tools were running,
    // the run would stop with their results unsaved, so its errors are ignored here.
    const emit: Emit = event => {
        try { observe(event); } catch {}
    };

    const commit = async (message: Message) => {
        await session.append(message, runId === undefined ? {} : { runId });
        emit({ type: "message_committed", message });
    };

    const result: RunResult = { status: "completed", cycles: 0, usage: { inputTokens: 0, outputTokens: 0 }};
    emit({ type: "run_started" });

    try {
        if (!Number.isInteger(maxCycles) || maxCycles < 1) throw new Error("Invalid cycle limit");

        const open = openCalls((await session.lineage()).map(entry => entry.message));
        if (open.length > 0) {
            const interrupted = outcome("unknown", "Interrupted",
                "The run stopped before this call's result was saved, so it may or may not have run. Check before relying on it or running it again.");
            await commit({ role: "tool", content: open.map(call => closed(call, interrupted))});
        }

        if (input) await commit(input);

        while (true) {
            signal.throwIfAborted();
            if (result.cycles === maxCycles) throw new RunStop("limited", `Cycle limit of ${maxCycles} reached`);

            const { model, tools, authorize, settings, context: build } = bindings();

            // The model can only call tools it is told about. Only switched-on tools are listed, duplicate tool names are an error
            const names = new Set<string>();
            const offered = new Map<string, ToolBinding>();

            for (const binding of tools) {
                if (names.has(binding.tool.name))
                    throw new Error(`Duplicate tool name: ${binding.tool.name}`);

                names.add(binding.tool.name);

                if (binding.isEnabled())
                    offered.set(binding.tool.name, binding);
            }

            if (offered.size && !model.info.capabilities.tools)
                throw new ModelError("Model does not support tools", "unsupported");

            const context = await build({ session, model, signal });
            const definitions = [...offered.values()].map(({ tool: { name, description, parameters }}) => ({ name, description, parameters }));
            signal.throwIfAborted();

            emit({ type: "cycle_started", cycle: ++result.cycles, model: model.info.model });

            const { message, finishReason, usage } = await model.complete(
                { context, tools: definitions, ...(settings && { settings }) },
                { signal, onProgress: delta => emit({ type: "model_delta", text: delta.text })},
            );
            signal.throwIfAborted();

            if (usage) {
                result.usage.inputTokens += usage.inputTokens;
                result.usage.outputTokens += usage.outputTokens;
            }
            emit({ type: "cycle_finished", cycle: result.cycles, finishReason, ...(usage && { usage })});

            // A reply the provider would reject, once saved, breaks every request after it in conversation.
            // So a malformed reply fails the run before it can be saved.
            const calls = message.content.filter(block => block.type === "tool_use");
            const ids = new Set<string>();
            for (const call of calls) {
                if (!call.id || ids.has(call.id))
                    throw new ModelError(`Duplicate or empty tool-call ID: "${call.id}"`, "protocol");
                ids.add(call.id);
            }

            // A reply cut off at its length limit may hold half-written calls. They are saved, so the conversation stays complete.
            // But answered as refused, instead of run.
            if (finishReason === "tool_calls" ? !calls.length : finishReason === "stop" && calls.length > 0)
                throw new ModelError("Finish reason and tool calls disagree", "protocol");

            // Saved before any tool runs, so a crash mid-tool still shows what the model asked for.
            await commit(message);

            if (calls.length) {
                const results: ToolResultBlock[] = [];
                for (const call of calls) {
                    emit({ type: "tool_started", callId: call.id, name: call.name, args: call.args });
                    const settled = await admit(call, { offered, authorize, finishReason, signal, emit });
                    emit({ type: "tool_finished", callId: call.id, name: call.name, ...settled });
                    results.push(closed(call, settled));
                }
                await commit({ role: "tool", content: results });
            }

            if (finishReason === "stop") {
                result.message = message;
                break;
            }

            signal.throwIfAborted();

            if (finishReason === "length")
                throw new RunStop("limited", `Response length limit of ${model.info.model} reached`);

            if (finishReason === "blocked")
                throw new RunStop("blocked", "Response was blocked by the provider");
        }
    } catch (error) {
        result.status = error instanceof RunStop ? error.status : signal.aborted ? "cancelled" : "failed";
        result.error = error instanceof ModelError
            ? { ...errorInfo(error), kind: error.kind, retryable: error.retryable}
            : errorInfo(error);
    }

    emit({ type: "run_finished", result });
    return result;
}

async function admit(call: ToolUseBlock, { offered, authorize, finishReason, signal, emit }: {
    offered: ReadonlyMap<string, ToolBinding>;
    authorize: Authorize | undefined;
    finishReason: FinishReason;
    signal: AbortSignal;
    emit: Emit;
}): Promise<ToolOutcome> {
    // The status says everything about a call cancelled before it started, so it carries no error.
    const cancelled: ToolOutcome = { status: "cancelled", content: [] };
    if (signal.aborted) return cancelled;

    if (finishReason !== "tool_calls") {
        return outcome("denied", "Truncated", `The response ended (${finishReason}) before ${call.name} could run`);
    }

    const binding = offered.get(call.name);
    if (!binding) return outcome("denied", "NotOffered", `${call.name} was not offered in this cycle`);
    if (!binding.isEnabled()) return outcome("denied", "Unavailable", `${call.name} is no longer available`);

    // With no approver configured, giving the model a tool already means agreeing to its use.
    if (authorize) {
        let decision: Decision;
        try {
            decision = await authorize(call, signal);
        } catch (error) {
            return signal.aborted ? cancelled : outcome("denied", "PolicyError", errorInfo(error).message);
        }
        if (!decision.allow) return outcome("denied", "PolicyDenied", decision.reason);
    }

    return invokeTool(binding.tool, call.args, {
        callId: call.id,
        signal,
        progress: value => emit({ type: "tool_progress", callId: call.id, value }),
    });
}

function outcome(status: Exclude<ToolStatus, "success" | "error">, name: Refusal, message: string): ToolOutcome {
    return { status, content: [], error: Object.assign(new Error(message), { name })};
}

function closed(call: ToolUseBlock, settled: ToolOutcome): ToolResultBlock {
    const base = { type: "tool_result" as const, callId: call.id, content: settled.content };
    switch (settled.status) {
        case "success": return { ...base, status: settled.status };
        case "error": return { ...base, status: settled.status, error: errorInfo(settled.error) };
        default: return { ...base, status: settled.status, ...(settled.error && { error: errorInfo(settled.error) })};
    }
}
import type { AssistantMessage, Content, ErrorInfo, Json, Message, ToolStatus } from "./message.ts";
import type { FinishReason, ModelError, Usage } from "./model.ts";

export type RunStatus = "completed" | "cancelled" | "limited" | "blocked" | "failed";

export type RunResult = {
    status: RunStatus;
    cycles: number;
    usage: Usage;
    message?: AssistantMessage;
    error?: ErrorInfo & { kind?: ModelError["kind"]; retryable?: boolean };
};

export type AgentEvent = 
    | { type: "run_started" }
    | { type: "cycle_started"; cycle: number; model: string }
    | { type: "model_delta"; text: string }
    | { type: "cycle_finished"; cycle: number; finishReason: FinishReason; usage?: Usage }
    | { type: "message_committed"; message: Message }
    | { type: "tool_started"; callId: string; name: string; args: Json }
    | { type: "tool_progress"; callId: string; value: Json }
    | { type: "tool_finished"; callId: string; name: string; status: ToolStatus; 
        content: Content[]; error?: Error }
    | { type: "run_finished"; result: RunResult }

export type Emit = (event: AgentEvent) => void;
export type EventEnvelope = { runId: string; sequence: number; event: AgentEvent };
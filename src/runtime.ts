import { userMessage, type Content } from "./message.ts";
import type { Session } from "./session.ts";
import type { AgentEvent, EventEnvelope, RunResult } from "./events.ts";
import { runAgent, type Bindings } from "./agent.ts";

export type AgentOptions = {
    session: Session;
    getBindings(): Bindings;
    maxCycles?: number;
};

export type RunHandle = {
    runId: string;
    events: AsyncIterable<EventEnvelope>;
    result: Promise<RunResult>;
    cancel(): void;
};

// Events wait here until read, so a slow screen never slows the run.
class EventQueue<T> implements AsyncIterable<T> {
    #values: T[] = [];
    #head = 0;
    #wait: (() => void) | undefined;
    #closed = false;
    #consumed = false;
    push(value: T) {
        if (this.#closed) return;
        this.#values.push(value);
        this.#wait?.();
    }
    close() {
        this.#closed = true;
        this.#wait?.();
    }
    
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        if (this.#consumed) throw new Error("Events already have a consumer");
        this.#consumed = true;
        while (true) {
            while (this.#head < this.#values.length) {
                const value = this.#values[this.#head++]!;

                if (this.#head > 1024 && this.#head * 2 >= this.#values.length) {
                    this.#values = this.#values.slice(this.#head);
                    this.#head = 0;
                }
                yield value;
            }
            if (this.#closed) return;
            await new Promise<void>(resolve => { this.#wait = resolve; });
            this.#wait = undefined;
        }
    }
}

// runAgent (agent.ts) performs one run a session.
// An application needs cancel, events to read, idempotency, etc.
export class Agent {
    readonly session: Session;
    readonly #options: AgentOptions;
    #busy = false;
    constructor(options: AgentOptions) {
        this.#options = options;
        this.session = options.session;
    }
    get busy() { return this.#busy; }
    run(input: string | Content[]): RunHandle {
        if (this.#busy) throw new Error("Agent already has an active run");
        this.#busy = true;
        const runId = crypto.randomUUID();
        const events = new EventQueue<EventEnvelope>(), controller = new AbortController();
        let sequence = 0;
        const emit = (event: AgentEvent) => events.push({ runId, sequence: ++sequence, event });

        const result = runAgent({
            session: this.session,
            bindings: () => this.#options.getBindings(),
            runId, input: userMessage(input), 
            emit, signal: controller.signal,
            maxCycles: this.#options.maxCycles,
        }).finally(() => { events.close(); this.#busy = false; });
        return { runId, events, result, cancel: () => controller.abort() };
    }
}
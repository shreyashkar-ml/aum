import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { defineTool, ToolError, type Tool } from "../../src/index.ts";
import { Args } from "./args.ts";
import type { Workspace } from "./workspace.ts";

export type BashOptions = { timeoutSeconds?: number; maxTimeoutSeconds?: number };

const HEAD = 16 * 1024, TAIL = 48 * 1024;
const KILL_GRACE_MS = 2000, DRAIN_MS = 250;

// With no terminal attached, a command that waits for a person (a pager, a password prompt)
// would wait forever. Pagers print straight through, and git fails instead of prompting.
const UNATTENDED = { PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };

// Commands have real effects, so this assumes a trusted workspace and leaves approval to the
// policy. A hung command must not hang the agent: every command runs in its own process group,
// and a timeout or a cancel ends the whole group, including anything it started.
export function createBashTool(workspace: Workspace, options: BashOptions = {}): Tool {
    const fallback = options.timeoutSeconds ?? 120, max = options.maxTimeoutSeconds ?? 600;
    return defineTool({
        name: "bash",
        description: `Run a bash command in the workspace root. stdout and stderr come back together; long output keeps `
            + `its first ${HEAD / 1024} KB and last ${TAIL / 1024} KB. The command stops after ${fallback} seconds unless `
            + `you pass timeout (seconds, up to ${max}). A background process outlives the command only if its output is `
            + "redirected away from it, for example: server > server.log 2>&1 &",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string" },
                timeout: { type: "integer", minimum: 1, maximum: max, description: "Seconds before the command is stopped" },
            },
            required: ["command"],
            additionalProperties: false,
        },
        parse: raw => {
            const args = new Args(raw, ["command", "timeout"]);
            return { command: args.string("command"), timeout: args.integer("timeout", 1, fallback, max) };
        },
        async execute({ command, timeout }, { signal, progress }) {
            const cwd = await workspace.real();
            return new Promise<string>((resolve, reject) => {
                const child = spawn("/bin/bash", ["-c", command], {
                    cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...UNATTENDED },
                });
                const output = new Output();
                let stoppedFor: string | undefined, settled = false;

                const signalGroup = (name: NodeJS.Signals) => {
                    try { if (child.pid) process.kill(-child.pid, name); } catch {}
                };
                const stop = (reason: string) => {
                    if (stoppedFor) return;
                    stoppedFor = reason;
                    signalGroup("SIGTERM");
                    setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
                };
                const timer = setTimeout(() => stop(`Stopped after ${timeout} seconds`), timeout * 1000);
                const onAbort = () => stop("Cancelled");
                signal.addEventListener("abort", onAbort, { once: true });

                const finish = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    signal.removeEventListener("abort", onAbort);
                    child.stdout.destroy();
                    child.stderr.destroy();
                    if (error) reject(error); else resolve(String(output));
                };

                for (const stream of [child.stdout, child.stderr]) {
                    stream.setEncoding("utf8").on("data", (chunk: string) => {
                        output.add(chunk);
                        progress(chunk);
                    });
                }
                child.on("error", error => finish(new ToolError(error.message, String(output))));
                child.on("exit", async (code, killedBy) => {
                    // The shell is done, but a background process it started may still hold the
                    // output pipes, and waiting for them to close would hang the call. Output that
                    // arrives within a short grace period is kept; whatever still holds the pipes
                    // after that is stopped, since nobody would ever read what it writes.
                    const ended = [child.stdout, child.stderr].map(stream =>
                        stream.readableEnded ? undefined : new Promise(done => stream.once("end", done)));
                    const drained = await Promise.race([Promise.all(ended).then(() => true), delay(DRAIN_MS, false)]);
                    if (!drained) signalGroup("SIGTERM");
                    if (stoppedFor) finish(new ToolError(stoppedFor, String(output)));
                    else if (code === 0) finish();
                    else finish(new ToolError(killedBy ? `Killed by ${killedBy}` : `Exit code ${code}`, String(output)));
                });
            });
        },
    });
}

// Commands usually say what they are doing at the start of their output and why they failed at
// the end, so long output keeps both and drops the middle.
class Output {
    #head = "";
    #tail = "";
    #dropped = 0;

    add(chunk: string) {
        if (this.#head.length < HEAD) {
            const room = HEAD - this.#head.length;
            this.#head += chunk.slice(0, room);
            chunk = chunk.slice(room);
        }
        this.#tail += chunk;
        if (this.#tail.length > TAIL) {
            this.#dropped += this.#tail.length - TAIL;
            this.#tail = this.#tail.slice(-TAIL);
        }
    }

    toString() {
        return this.#dropped
            ? `${this.#head}\n[... ${this.#dropped} characters omitted ...]\n${this.#tail}`
            : this.#head + this.#tail;
    }
}

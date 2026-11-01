import type { Message } from "./message.ts";

export type Entry = {
    id: string;
    parentId: string | null;
    created_at: number;
    runId?: string;
    message: Message;
};

// Evidence is append-only so a rewind or a crash never destroys history.
export interface Session {
    readonly head: string | null;
    // Callers supply only runId; the store sets id, parent and time, so history can't be forged.
    append(message: Message, meta?: Pick<Entry, "runId">): Promise<Entry>;
    lineage(): Promise<Entry[]>;
}

export function createEntry(message: Message, parentId: string | null, meta: Pick<Entry, "runId"> = {}): Entry {
    return { id: crypto.randomUUID(), parentId, created_at: Date.now(),
        ...(meta.runId === undefined ? {} : { runId: meta.runId }), message: structuredClone(message)
    }
}

// The history from the root to head, oldest first. Returns copies, so a caller
// that mutates a message cannot rewrite stored history.
export function lineageOf(entries: ReadonlyMap<string, Entry>, head: string | null): Entry[] {
    const result: Entry[] = [];
    for (let id = head; id !== null;) {
        const entry = entries.get(id);
        if (!entry) throw new Error(`Missing entry ${id}`);
        result.push(structuredClone(entry));
        id = entry.parentId;
    }
    return result.reverse();
}

export class MemorySession implements Session {
    #head: string | null;
    #entries: Map<string, Entry>;
    constructor(entries = new Map<string, Entry>(), head: string | null = null) {
        this.#head = head;
        this.#entries = entries;
    }

    get head() { return this.#head; }

    async append(message: Message, meta?: Pick<Entry, "runId">): Promise<Entry> {
        const entry = createEntry(message, this.#head, meta);
        this.#entries.set(entry.id, entry);
        this.#head = entry.id;
        // A copy, so a caller mutating the returned entry cannot rewrite stored history.
        return structuredClone(entry);
    }

    async lineage(): Promise<Entry[]> { return lineageOf(this.#entries, this.#head); }

    fork(at: string | null = this.#head): MemorySession {
        if (at !== null && !this.#entries.has(at)) throw new Error(`Unknown session entry: ${at}`);
        return new MemorySession(this.#entries, at);
    }
}

// Where a session that survives restarts writes its entries: a file, a database, a remote store.
// append must resolve only once the entry is safely stored, because the session moves on after it.
export interface Journal {
    append(entry: Entry): Promise<void>;
}

// Saved entries are loaded back by whoever owns the store, so they arrive as unknown. A damaged
// or out-of-order entry would load as a wrong conversation, so loading fails on the first one,
// naming it. Entries must be in the order they were saved: each parent before its children.
export function checkEntries(saved: readonly unknown[]): Entry[] {
    const seen = new Set<string>();
    return saved.map((value, index) => {
        const entry = value as Partial<Entry> | null;
        const where = `Saved entry ${index + 1}`;
        if (!entry || typeof entry !== "object") throw new Error(`${where} is not an object`);
        if (typeof entry.id !== "string" || !entry.id) throw new Error(`${where} has no id`);
        if (seen.has(entry.id)) throw new Error(`${where} repeats the id ${entry.id}`);
        if (typeof entry.created_at !== "number") throw new Error(`${where} has no time`);
        if (entry.runId !== undefined && typeof entry.runId !== "string") throw new Error(`${where} has an invalid runId`);
        if (entry.parentId !== null && !(typeof entry.parentId === "string" && seen.has(entry.parentId))) {
            throw new Error(`${where} points to a parent saved after it, or never saved`);
        }
        if (typeof entry.message?.role !== "string" || !Array.isArray(entry.message.content)) {
            throw new Error(`${where} has no valid message`);
        }
        seen.add(entry.id);
        return structuredClone(entry as Entry);
    });
}

// A session that survives restarts: reads come from memory, and every write goes to the journal
// first. The head moves only after the journal confirms, so a crash never leaves memory ahead of
// the store. On restart, pass the saved entries back in and the conversation resumes at the last.
export function journalSession(journal: Journal, saved: readonly unknown[] = []): Session {
    const loaded = checkEntries(saved);
    const entries = new Map(loaded.map(entry => [entry.id, entry]));
    let head = loaded.at(-1)?.id ?? null;
    return {
        get head() { return head; },
        lineage: async () => lineageOf(entries, head),
        async append(message, meta) {
            const entry = createEntry(message, head, meta);
            await journal.append(structuredClone(entry));
            entries.set(entry.id, entry);
            head = entry.id;
            return structuredClone(entry);
        },
    };
}

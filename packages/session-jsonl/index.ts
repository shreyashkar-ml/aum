import { mkdir, open, readdir, readFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { checkEntries, journalSession, type Entry, type Journal, type Session } from "../../src/index.ts";

// A Journal that writes each entry to a file as one JSON line. journalSession (src/session.ts)
// decides the order of writes; this file only knows about the file.

// A write the operating system still holds in memory is lost in a power cut, so each line is
// synced to disk before append resolves, and the session moves on only after that.
export function jsonlJournal(path: string): Journal {
    return {
        async append(entry) {
            const file = await open(path, "a");
            try {
                await file.appendFile(JSON.stringify(entry) + "\n", "utf8");
                await file.sync();
            } finally {
                await file.close();
            }
        },
    };
}

// A crash mid-write leaves half a line at the end of the file. It is cut off, so the session
// still loads; damage anywhere else fails loudly, since guessing would corrupt the conversation.
export async function recoverJournal(path: string): Promise<Entry[]> {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const lines = raw.split("\n"), torn = lines.pop();
    if (torn) await truncate(path, Buffer.byteLength(raw) - Buffer.byteLength(torn));
    return checkEntries(lines.map((line, index) => {
        try { return JSON.parse(line) as unknown; }
        catch { throw new Error(`${path}: line ${index + 1} is not valid JSON`); }
    }));
}

// Session ids become file names, so they are limited to characters that cannot form a path.
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function newSessionId(): string {
    return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

// Opens the session saved in <dir>/<id>.jsonl, or starts it if the file does not exist yet.
export async function openSession(dir: string, id: string): Promise<Session> {
    if (!ID.test(id)) throw new Error(`Invalid session id: ${id}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    return journalSession(jsonlJournal(path), await recoverJournal(path));
}

// Saved sessions, most recently written first.
export async function listSessions(dir: string): Promise<Array<{ id: string; modified: Date }>> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const sessions = await Promise.all(names.filter(name => name.endsWith(".jsonl")).map(async name =>
        ({ id: name.slice(0, -".jsonl".length), modified: (await stat(join(dir, name))).mtime })));
    return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

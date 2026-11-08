import { chmod, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// The model chooses every path, and "../.." or a symbolic link could point outside the project.
// All four tools resolve paths through one Workspace, which refuses any path whose real location
// lies outside the root.
export class Workspace {
    readonly root: string;

    constructor(root: string) {
        this.root = resolve(root);
    }

    // The real root is looked up on every call, so a root that is itself a link is judged by
    // where it points now.
    real(): Promise<string> {
        return realpath(this.root);
    }

    // A file that does not exist yet has no real location, so the check falls back to the nearest
    // folder above it that does exist; a link there could otherwise lead a new file outside.
    async resolve(requested: string, { allowMissing = false } = {}): Promise<string> {
        const base = await this.real();
        const target = resolve(base, requested);
        try {
            const canonical = await realpath(target);
            assertInside(base, canonical, requested);
            return canonical;
        } catch (error) {
            if (code(error) !== "ENOENT") throw error;
            // Checked before saying the file is missing, so the answer reveals nothing about what
            // exists outside the workspace.
            assertInside(base, await nearestExisting(dirname(target)), requested);
            if (!allowMissing) throw new Error(`${requested} does not exist`);
            return target;
        }
    }
}

function assertInside(base: string, target: string, requested: string): void {
    const path = relative(base, target);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
        throw new Error(`${requested} is outside the workspace`);
}

async function nearestExisting(path: string): Promise<string> {
    for (let current = path; ; current = dirname(current)) {
        try { return await realpath(current); }
        catch (error) {
            if (code(error) !== "ENOENT" || dirname(current) === current) throw error;
        }
    }
}

const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

// A cancel or a crash halfway through a write would leave half a file, which then looks like the
// model's own mistake. The text goes to a temporary file beside the target and is renamed over it,
// so the file holds either the old content or the new, never a mix. The old file's mode is kept.
export async function writeAtomic(target: string, content: string, signal: AbortSignal): Promise<void> {
    const mode = await stat(target).then(info => info.mode & 0o7777, () => undefined);
    const temporary = join(dirname(target), `.${basename(target)}.${crypto.randomUUID()}.tmp`);
    try {
        await writeFile(temporary, content, { encoding: "utf8", signal });
        if (mode !== undefined) await chmod(temporary, mode);
        signal.throwIfAborted();
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

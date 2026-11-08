import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { textOf, type ToolOutcome } from "@aum/core";

// A fresh folder per check, removed when the file's checks finish.
export async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "aum-check-"));
    after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

export const outputOf = (outcome: ToolOutcome) =>
    [textOf(outcome.content), outcome.error?.message].filter(Boolean).join("\n");

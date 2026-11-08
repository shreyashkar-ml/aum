import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { listSessions, openSession } from "../packages/session-jsonl/index.ts";
import { scratch } from "./support.ts";

test("a session file cut off mid-line still loads", async () => {
    const dir = await scratch();
    const session = await openSession(dir, "torn");
    await session.append({ role: "user", content: [{ type: "text", text: "kept" }] });
    await appendFile(join(dir, "torn.jsonl"), '{"id":"half');
    const reopened = await openSession(dir, "torn");
    assert.equal((await reopened.lineage()).length, 1);
});

test("a reopened session continues where it left off, and is listed", async () => {
    const dir = await scratch();
    await (await openSession(dir, "kept")).append({ role: "user", content: [{ type: "text", text: "first" }] });
    const lineage = await (await openSession(dir, "kept")).lineage();
    assert.equal(lineage.length, 1);
    assert.deepEqual((await listSessions(dir)).map(saved => saved.id), ["kept"]);
    await assert.rejects(openSession(dir, "../escape"), /Invalid session id/);
});

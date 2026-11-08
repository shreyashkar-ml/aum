import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { invokeTool, type Tool } from "../src/index.ts";
import { createCodingTools } from "../packages/tools-coding/index.ts";
import { outputOf, scratch } from "./support.ts";

async function workspace() {
    const root = await scratch();
    const [read, write, edit, bash] = createCodingTools(root) as [Tool, Tool, Tool, Tool];
    return { root, read, write, edit, bash };
}

describe("paths", () => {
    test("a path outside the workspace is refused, including through a link", async () => {
        const { root, read, write } = await workspace();
        const outside = await scratch();
        await writeFile(join(outside, "secret"), "x");
        await symlink(outside, join(root, "link"));
        for (const path of ["../secret", join(outside, "secret"), "link/secret"]) {
            const result = await invokeTool(read, { path });
            assert.equal(result.status, "error");
            assert.match(outputOf(result), /outside the workspace/);
        }
        assert.match(outputOf(await invokeTool(write, { path: "link/new", content: "x" })), /outside the workspace/);
    });
});

describe("read", () => {
    test("pages long files and says where to continue", async () => {
        const { root, read } = await workspace();
        await writeFile(join(root, "long.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
        const first = outputOf(await invokeTool(read, { path: "long.txt" }));
        assert.match(first, /showing lines 1-2000 of 2500; continue with offset 2001/);
        const rest = outputOf(await invokeTool(read, { path: "long.txt", offset: 2001 }));
        assert.ok(rest.startsWith("line 2001\n") && rest.endsWith("line 2500"));
    });

    test("returns images as images and refuses binary files", async () => {
        const { root, read } = await workspace();
        await writeFile(join(root, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        await writeFile(join(root, "blob.bin"), Buffer.from([1, 0, 2]));
        const image = await invokeTool(read, { path: "dot.png" });
        assert.deepEqual(image.content.map(block => block.type), ["text", "image"]);
        assert.match(outputOf(await invokeTool(read, { path: "blob.bin" })), /binary/);
    });

    test("rejects unknown arguments with a message the model can act on", async () => {
        const { read } = await workspace();
        assert.match(outputOf(await invokeTool(read, { path: "a", lines: 3 })), /unknown field lines/);
        assert.match(outputOf(await invokeTool(read, "Expected ',' at position 9")), /Received: Expected/);
    });
});

describe("write", () => {
    test("creates folders, keeps the file's mode, and leaves no temporary files", async () => {
        const { root, write } = await workspace();
        assert.equal((await invokeTool(write, { path: "a/b/run.sh", content: "echo 1\n" })).status, "success");
        await chmod(join(root, "a/b/run.sh"), 0o755);
        assert.match(outputOf(await invokeTool(write, { path: "a/b/run.sh", content: "echo 2\n" })), /Replaced/);
        assert.equal(await readFile(join(root, "a/b/run.sh"), "utf8"), "echo 2\n");
        assert.equal((await stat(join(root, "a/b/run.sh"))).mode & 0o777, 0o755);
        assert.deepEqual(await readdir(join(root, "a/b")), ["run.sh"]);
    });
});

describe("edit", () => {
    test("applies several edits at once and inserts replacement text literally", async () => {
        const { root, edit } = await workspace();
        await writeFile(join(root, "f.sh"), "a=1\nb=2\nc=3\n");
        const result = await invokeTool(edit, { path: "f.sh", edits: [{ oldText: "c=3", newText: "c='$$5 $&'" }, { oldText: "a=1", newText: "a=10" }] });
        assert.equal(result.status, "success", outputOf(result));
        assert.equal(await readFile(join(root, "f.sh"), "utf8"), "a=10\nb=2\nc='$$5 $&'\n");
    });

    test("changes nothing when any edit is ambiguous, missing or overlapping", async () => {
        const { root, edit } = await workspace();
        await writeFile(join(root, "f.txt"), "x x\nabc\n");
        const cases = [
            [[{ oldText: "abc", newText: "ABC" }, { oldText: "x", newText: "y" }], /more than once/],
            [[{ oldText: "abc", newText: "ABC" }, { oldText: "nope", newText: "y" }], /was not found/],
            [[{ oldText: "ab", newText: "AB" }, { oldText: "bc", newText: "BC" }], /overlap/],
        ] as const;
        for (const [edits, message] of cases) assert.match(outputOf(await invokeTool(edit, { path: "f.txt", edits })), message);
        assert.equal(await readFile(join(root, "f.txt"), "utf8"), "x x\nabc\n");
    });

    test("matches files with Windows line endings", async () => {
        const { root, edit } = await workspace();
        await writeFile(join(root, "w.txt"), "one\r\ntwo\r\n");
        assert.equal((await invokeTool(edit, { path: "w.txt", edits: [{ oldText: "one\ntwo", newText: "1\n2" }] })).status, "success");
        assert.equal(await readFile(join(root, "w.txt"), "utf8"), "1\r\n2\r\n");
    });
});

describe("bash", () => {
    test("returns output, and fails with the exit code and output", async () => {
        const { bash } = await workspace();
        assert.equal(outputOf(await invokeTool(bash, { command: "echo hi" })), "hi\n");
        const failed = await invokeTool(bash, { command: "echo why >&2; exit 3" });
        assert.equal(failed.status, "error");
        assert.match(outputOf(failed), /why[\s\S]*Exit code 3/);
    });

    test("a background process holding the output does not hang the call", async () => {
        const { bash } = await workspace();
        const started = Date.now();
        const result = await invokeTool(bash, { command: "echo start; sleep 30 & echo done" });
        assert.equal(result.status, "success");
        assert.ok(Date.now() - started < 3000, "returned promptly");
    });

    test("a timeout stops the whole process group", async () => {
        const { root, bash } = await workspace();
        const started = Date.now();
        const result = await invokeTool(bash, { command: "(sleep 30; touch survived) & sleep 30", timeout: 1 });
        assert.match(outputOf(result), /Stopped after 1 seconds/);
        assert.ok(Date.now() - started < 4000);
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.deepEqual(await readdir(root), []);
    });

    test("a cancelled command ends as unknown, since it may have had effects", async () => {
        const { bash } = await workspace();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200);
        const result = await invokeTool(bash, { command: "sleep 30" }, { signal: controller.signal });
        assert.equal(result.status, "unknown");
    });
});

test("a missing file is reported by the path the model used", async () => {
    const { root, edit } = await workspace();
    await mkdir(join(root, "src"));
    assert.match(outputOf(await invokeTool(edit, { path: "src/x.ts", edits: [{ oldText: "a", newText: "b" }] })), /src\/x.ts does not exist/);
});

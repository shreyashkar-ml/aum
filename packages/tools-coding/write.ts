import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool, type Tool } from "../../src/index.ts";
import { Args } from "./args.ts";
import { writeAtomic, type Workspace } from "./workspace.ts";

export function createWriteTool(workspace: Workspace): Tool {
    return defineTool({
        name: "write",
        description: "Create a file in the workspace, or replace one's whole content. Missing folders are created. "
            + "To change part of an existing file, use edit instead.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to the workspace root" },
                content: { type: "string", description: "The complete new content of the file" },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
        parse: raw => {
            const args = new Args(raw, ["path", "content"]);
            return { path: args.string("path"), content: args.string("content") };
        },
        async execute({ path, content }, { signal }) {
            const target = await workspace.resolve(path, { allowMissing: true });
            const existed = await stat(target).then(info => {
                if (info.isDirectory()) throw new Error(`${path} is a folder`);
                return true;
            }, () => false);
            await mkdir(dirname(target), { recursive: true });
            await writeAtomic(target, content, signal);
            return `${existed ? "Replaced" : "Created"} ${path} (${Buffer.byteLength(content)} bytes)`;
        },
    });
}

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { defineTool, text, type Tool } from "@aum/core";
import { Args } from "./args.ts";
import type { Workspace } from "./workspace.ts";

const MAX_LINES = 2000, MAX_LINE = 2000, MAX_CHARS = 256 * 1024, MAX_IMAGE = 5 * 1024 * 1024;
const IMAGES: Readonly<Record<string, string>> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

// A tool result is sent to the model again on every later cycle, so one huge file would be paid
// for over and over. Text comes back a page at a time, with a note saying where to continue.
// Images come back as images; for a model that cannot see them, the request swaps in a note.
export function createReadTool(workspace: Workspace): Tool {
    return defineTool({
        name: "read",
        description: `Read a file in the workspace. Text comes back up to ${MAX_LINES} lines at a time; `
            + "use offset (1-based line number) and limit to page through longer files. "
            + "PNG, JPEG, GIF and WebP files come back as images.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to the workspace root" },
                offset: { type: "integer", minimum: 1, description: "First line to return (1-based)" },
                limit: { type: "integer", minimum: 1, description: `Lines to return, at most ${MAX_LINES}` },
            },
            required: ["path"],
            additionalProperties: false,
        },
        parse: raw => {
            const args = new Args(raw, ["path", "offset", "limit"]);
            return { path: args.string("path"), offset: args.integer("offset", 1, 1), limit: Math.min(args.integer("limit", 1, MAX_LINES), MAX_LINES) };
        },
        async execute({ path, offset, limit }, { signal }) {
            const target = await workspace.resolve(path);
            const info = await stat(target);
            if (info.isDirectory()) throw new Error(`${path} is a folder; list it with bash (ls)`);

            const mimeType = IMAGES[extname(target).toLowerCase()];
            if (mimeType) {
                if (info.size > MAX_IMAGE) throw new Error(`${path} is ${info.size} bytes; images are read up to ${MAX_IMAGE} bytes`);
                const data = await readFile(target, { signal });
                return [text(`${path} (${mimeType}, ${info.size} bytes)`), { type: "image", mimeType, base64: data.toString("base64") }];
            }

            const bytes = await readFile(target, { signal });
            if (!bytes.length) return `${path} is empty`;
            // A NUL byte almost never appears in text, and decoding binary as UTF-8 floods the context with noise.
            if (bytes.subarray(0, 8192).includes(0)) throw new Error(`${path} looks like a binary file; inspect it with bash instead`);

            const lines = bytes.toString("utf8").split("\n");
            if (lines.at(-1) === "") lines.pop();
            if (offset > lines.length) throw new Error(`Offset ${offset} is past the end of ${path}, which has ${lines.length} lines`);

            const end = Math.min(offset - 1 + limit, lines.length), notes: string[] = [];
            let cut = 0;
            let body = lines.slice(offset - 1, end).map(line => {
                if (line.length <= MAX_LINE) return line;
                cut++;
                return `${line.slice(0, MAX_LINE)} [line cut at ${MAX_LINE} characters]`;
            }).join("\n");
            if (body.length > MAX_CHARS) {
                body = body.slice(0, MAX_CHARS);
                notes.push(`output cut at ${MAX_CHARS} characters; use a smaller limit`);
            }
            if (end < lines.length) notes.push(`showing lines ${offset}-${end} of ${lines.length}; continue with offset ${end + 1}`);
            if (cut) notes.push(`${cut} long lines were cut`);
            return notes.length ? `${body}\n[${notes.join("; ")}]` : body;
        },
    });
}

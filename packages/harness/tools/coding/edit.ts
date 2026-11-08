import { readFile } from "node:fs/promises";
import { defineTool, type Tool } from "@aum/core";
import { Args } from "./args.ts";
import { writeAtomic, type Workspace } from "./workspace.ts";

type Change = { oldText: string; newText: string };

// An edit must change exactly what the model meant, so each oldText has to occur exactly once in
// the file as it was read. Several edits go in one call to save round trips, and they apply all
// together or not at all, so a failed edit never leaves the file half changed.
export function createEditTool(workspace: Workspace): Tool {
    return defineTool({
        name: "edit",
        description: "Replace exact text in a workspace file. Each oldText must appear exactly once in the file "
            + "and must not overlap another edit's oldText; include surrounding lines to make it unique. "
            + "All edits apply together, or none do.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to the workspace root" },
                edits: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: {
                            oldText: { type: "string", description: "Text copied exactly from the file" },
                            newText: { type: "string", description: "Text to put in its place" },
                        },
                        required: ["oldText", "newText"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["path", "edits"],
            additionalProperties: false,
        },
        parse: raw => {
            const args = new Args(raw, ["path", "edits"]);
            const edits = args.list("edits").map((item, index): Change => {
                const edit = new Args(item, ["oldText", "newText"], `Edit ${index + 1}`);
                const change = { oldText: edit.string("oldText"), newText: edit.string("newText") };
                if (!change.oldText) throw new Error(`Edit ${index + 1}: oldText must not be empty`);
                if (change.oldText === change.newText) throw new Error(`Edit ${index + 1}: newText is the same as oldText`);
                return change;
            });
            if (!edits.length) throw new Error("edits must hold at least one edit");
            return { path: args.string("path"), edits };
        },
        async execute({ path, edits }, { signal }) {
            const target = await workspace.resolve(path);
            const original = await readFile(target, { encoding: "utf8", signal });
            const spans = edits.map((change, index) => locate(original, change, index, path)).sort((a, b) => a.at - b.at);
            for (let i = 1; i < spans.length; i++) {
                if (spans[i]!.at < spans[i - 1]!.end)
                    throw new Error(`Edits ${spans[i - 1]!.index + 1} and ${spans[i]!.index + 1} overlap in ${path}; merge them into one edit`);
            }

            // Built by slicing rather than String.replace, which would read "$&" or "$$" in the new
            // text as patterns and quietly corrupt shell scripts and templates.
            let next = "", from = 0;
            for (const span of spans) {
                next += original.slice(from, span.at) + span.newText;
                from = span.end;
            }
            next += original.slice(from);
            await writeAtomic(target, next, signal);

            const where = spans.map(span => `line ${original.slice(0, span.at).split("\n").length}`);
            return `Edited ${path}: ${spans.length} ${spans.length === 1 ? "change" : "changes"}, at ${where.join(", ")}`;
        },
    });
}

// Models write "\n" even when the file uses "\r\n". When the text as sent is not found in such a
// file, it is tried again with Windows line endings, and the new text gets them too.
function locate(content: string, change: Change, index: number, path: string) {
    let { oldText, newText } = change;
    let at = content.indexOf(oldText);
    if (at < 0 && content.includes("\r\n") && !oldText.includes("\r")) {
        const crlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
        oldText = crlf(oldText);
        newText = crlf(newText);
        at = content.indexOf(oldText);
    }
    if (at < 0) throw new Error(`Edit ${index + 1}: oldText was not found in ${path}; read the file again and copy the text exactly`);
    // Searching again from one character later also catches overlapping repeats, which are just as ambiguous.
    if (content.indexOf(oldText, at + 1) >= 0)
        throw new Error(`Edit ${index + 1}: oldText occurs more than once in ${path}; include more surrounding lines so it matches once`);
    return { index, at, end: at + oldText.length, newText };
}

import type { Tool } from "../../src/index.ts";
import { createBashTool, type BashOptions } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { Workspace } from "./workspace.ts";

export { Workspace, writeAtomic } from "./workspace.ts";
export { createReadTool } from "./read.ts";
export { createWriteTool } from "./write.ts";
export { createEditTool } from "./edit.ts";
export { createBashTool, type BashOptions } from "./bash.ts";

// All four tools for one workspace, for scripts that want them without a config file.
export function createCodingTools(root: string, options: { bash?: BashOptions } = {}): Tool[] {
    const workspace = new Workspace(root);
    return [createReadTool(workspace), createWriteTool(workspace), createEditTool(workspace), createBashTool(workspace, options.bash)];
}

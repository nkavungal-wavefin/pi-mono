import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { attachTool } from "./attach.js";
import { createEditTool } from "./edit.js";
import { createExecutorTool } from "./executor.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(executor: Executor): AgentTool<any>[] {
	return [
		createReadTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createLsTool(executor),
		createGrepTool(executor),
		createFindTool(executor),
		attachTool,
		createExecutorTool(),
	];
}

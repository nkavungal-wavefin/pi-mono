/**
 * Local Executor Extension
 *
 * Registers a locked-down tool profile:
 * - local filesystem tools: read, edit, write, grep, find, ls
 * - executor runtime tool: executor
 * - bash disabled
 *
 * Filesystem tools are restricted to the current working directory and descendants.
 *
 * This extension is intended for a local executor checkout running with:
 *   cd /Users/nkavungal/Workspace/pockyclaw/executor
 *   bun dev
 *
 * Default assumptions:
 * - Executor repo: /Users/nkavungal/Workspace/pockyclaw/executor
 * - Executor server: http://localhost:8788
 *
 * Usage:
 *   pi --extension ./packages/coding-agent/examples/extensions/executor-local.ts
 *
 * Optional flags:
 *   --executor-root /path/to/executor
 *   --executor-base-url http://localhost:8788
 *   --executor-command "/custom/command"
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_EXECUTOR_ROOT = "/Users/nkavungal/Workspace/pockyclaw/executor";
const DEFAULT_EXECUTOR_BASE_URL = "http://localhost:8788";
const EXECUTOR_FS_TOOLS = ["read", "edit", "write", "grep", "find", "ls", "executor"];
const SESSION_CWD = process.cwd();
const PATH_LOCKED_GUIDELINE =
	"Filesystem tools are locked to the current working directory and its descendants. Never use parent paths or absolute paths outside the current working directory.";

type ExecutorCliCommand = {
	command: string;
	args: string[];
	cwd: string;
};

type ParsedExecutorOutput =
	| { kind: "completed"; text: string; parsedJson?: unknown }
	| {
			kind: "waiting_for_interaction";
			text: string;
			paused: {
				id: string;
				status: "waiting_for_interaction";
				interactionId?: string;
				message?: string;
				resumeCommand?: string;
				instruction?: string;
				interaction?: {
					mode?: "form" | "url";
					message?: string;
					url?: string | null;
					requestedSchema?: Record<string, unknown> | null;
				};
			};
	  };

interface ExecutorToolDetails {
	action: "call" | "resume";
	status: "completed" | "waiting_for_interaction";
	command: string[];
	baseUrl: string;
	truncation?: TruncationResult;
	parsedJson?: unknown;
	executionId?: string;
	interactionId?: string;
	resumeCommand?: string;
	instruction?: string;
	requestedSchema?: Record<string, unknown> | null;
	url?: string | null;
}

function ensurePathWithinCwd(targetPath: string, cwd: string): string {
	const resolvedTarget = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
	const resolvedCwd = path.resolve(cwd);
	const relative = path.relative(resolvedCwd, resolvedTarget);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
		return resolvedTarget;
	}
	throw new Error(`Path escapes current working directory: ${targetPath}`);
}

function getRequestedPath(params: unknown): string | undefined {
	if (!params || typeof params !== "object") return undefined;
	const maybePath = (params as { path?: unknown }).path;
	return typeof maybePath === "string" ? maybePath : undefined;
}

function rewriteReadResultText(text: string): string {
	return text.replace(
		/\. Use bash:[^\]]+\]/g,
		". Use a narrower read request with offset/limit or use grep for targeted inspection.]",
	);
}

function wrapPathLockedToolDefinition(
	definition: ToolDefinition,
	options?: { rewriteReadHints?: boolean },
): ToolDefinition {
	return {
		...definition,
		promptGuidelines: [...(definition.promptGuidelines ?? []), PATH_LOCKED_GUIDELINE],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const requestedPath = getRequestedPath(params);
			if (requestedPath) {
				ensurePathWithinCwd(requestedPath, ctx.cwd);
			}

			const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
			if (!options?.rewriteReadHints) {
				return result;
			}

			return {
				...result,
				content: result.content.map((item) =>
					item.type === "text" && typeof item.text === "string"
						? { ...item, text: rewriteReadResultText(item.text) }
						: item,
				),
			};
		},
	};
}

function createLockedFsToolDefinitions(cwd: string): ToolDefinition[] {
	const read = wrapPathLockedToolDefinition(createReadToolDefinition(cwd), { rewriteReadHints: true });
	const edit = wrapPathLockedToolDefinition(createEditToolDefinition(cwd));
	const write = wrapPathLockedToolDefinition(createWriteToolDefinition(cwd));
	const grep = wrapPathLockedToolDefinition(createGrepToolDefinition(cwd));
	const find = wrapPathLockedToolDefinition(createFindToolDefinition(cwd));
	const ls = wrapPathLockedToolDefinition(createLsToolDefinition(cwd));
	return [read, edit, write, grep, find, ls];
}

const executorSchema = Type.Object({
	label: Type.String({
		description: "Brief description of what this executor run does (shown to user)",
	}),
	action: StringEnum(["call", "resume"] as const, {
		description: 'Use "call" to run TypeScript, or "resume" to continue a paused execution.',
	}),
	code: Type.Optional(
		Type.String({
			description:
				"TypeScript code to execute when action=\"call\". This runs inside executor's runtime, not Node.js, bash, or pi's host process. Runtime APIs are exposed under tools.*. Discover capabilities by intent with tools.discover({ query, ... }); it returns { bestPath, results, total }. Return values directly.",
		}),
	),
	executionId: Type.Optional(
		Type.String({
			description: 'Execution ID to resume when action="resume".',
		}),
	),
	baseUrl: Type.Optional(
		Type.String({
			description: "Executor server base URL. Defaults to http://localhost:8788.",
		}),
	),
	noOpen: Type.Optional(
		Type.Boolean({
			description: "Disable browser auto-open for executor interaction flows.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Timeout in milliseconds for the executor CLI process.",
		}),
	),
});

function getExecutorCommand(root: string, override?: string): ExecutorCliCommand {
	if (override && override.trim().length > 0) {
		const parts = override.trim().split(/\s+/);
		const [command, ...args] = parts;
		return { command, args, cwd: root };
	}
	return {
		command: "bun",
		args: ["run", "executor"],
		cwd: root,
	};
}

function runExecutorCli(
	command: ExecutorCliCommand,
	executorArgs: string[],
	options: {
		stdinText?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
	},
): Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command.command, [...command.args, ...executorArgs], {
			cwd: command.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const killProcess = () => {
			if (killed) return;
			killed = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 5000);
		};

		if (options.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeoutMs);
		}

		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.on("error", (error) => {
			if (timeoutId) clearTimeout(timeoutId);
			if (options.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
			reject(error);
		});
		child.on("close", (code) => {
			if (timeoutId) clearTimeout(timeoutId);
			if (options.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
			resolve({ stdout, stderr, code, killed });
		});

		if (options.stdinText !== undefined) {
			child.stdin.write(options.stdinText);
		}
		child.stdin.end();
	});
}

function tryParseJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function parseExecutorOutput(stdout: string, exitCode: number | null): ParsedExecutorOutput {
	const trimmed = stdout.trim();
	const parsedJson = tryParseJson(trimmed);

	if (
		exitCode === 20 &&
		parsedJson &&
		typeof parsedJson === "object" &&
		parsedJson !== null &&
		(parsedJson as { status?: string }).status === "waiting_for_interaction"
	) {
		return {
			kind: "waiting_for_interaction",
			text: trimmed,
			paused: parsedJson as ParsedExecutorOutput & {
				id: string;
				status: "waiting_for_interaction";
			},
		};
	}

	return {
		kind: "completed",
		text: trimmed.length > 0 ? trimmed : "(no output)",
		parsedJson,
	};
}

function truncateOutput(text: string): { text: string; truncation?: TruncationResult } {
	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return {
		text: truncation.content,
		truncation: truncation.truncated ? truncation : undefined,
	};
}

function formatExecutorResult(
	output: ParsedExecutorOutput,
	command: string[],
	baseUrl: string,
	action: "call" | "resume",
): { text: string; details: ExecutorToolDetails } {
	if (output.kind === "waiting_for_interaction") {
		const paused = output.paused;
		const lines = [
			paused.instruction ?? "Execution paused because executor needs additional input.",
			`Execution ID: ${paused.id}`,
		];
		if (paused.resumeCommand) {
			lines.push(`Resume command: ${paused.resumeCommand}`);
		}
		const text = lines.join("\n");
		return {
			text,
			details: {
				action,
				status: "waiting_for_interaction",
				command,
				baseUrl,
				executionId: paused.id,
				interactionId: paused.interactionId,
				resumeCommand: paused.resumeCommand,
				instruction: paused.instruction,
				requestedSchema: paused.interaction?.requestedSchema ?? null,
				url: paused.interaction?.url ?? null,
			},
		};
	}

	const truncated = truncateOutput(output.text);
	let text = truncated.text;
	if (truncated.truncation) {
		text += `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.]`;
	}
	return {
		text,
		details: {
			action,
			status: "completed",
			command,
			baseUrl,
			truncation: truncated.truncation,
			parsedJson: output.parsedJson,
		},
	};
}

function rewriteExecutorOnlySystemPrompt(systemPrompt: string): string {
	const intro =
		"You are an expert coding assistant operating inside pi with a locked-down tool profile. You have filesystem tools (`read`, `edit`, `write`, `grep`, `find`, `ls`) plus the `executor` tool. Bash is disabled.";
	const hiddenToolsWarning =
		"No other pi tools are available in this session unless they are explicitly added later. Do not mention provider/protocol names such as `functions.executor` or synthetic names such as `multi_tool_use.parallel` in user-facing answers.";
	const executorOnlyContract = `Locked-down session contract:
- Available pi tools: \`read\`, \`edit\`, \`write\`, \`grep\`, \`find\`, \`ls\`, and \`executor\`.
- \`bash\` is not available.
- Filesystem tools are locked to the current working directory and its descendants. Never use parent paths or absolute paths outside the current working directory.
- Use filesystem tools for local repository work.
- Use \`executor\` for external integrations and capabilities that are not simple local filesystem operations.
- The \`code\` string for \`executor\` with \`action="call"\` runs inside executor's runtime, not Node.js, not bash, and not the pi host process.
- Code run through \`executor\` can use executor runtime APIs exposed under \`tools.*\`.
- When you need to understand what executor can do, discover capabilities by intent with \`tools.discover({ query, limit?, includeSchemas? })\`. It returns an object like \`{ bestPath, results, total }\`. Read \`matches.results\` rather than calling \`matches.map(...)\`.
- Do not inventory or enumerate the full executor runtime unless the user explicitly asks you to inspect executor itself. Default to discovering capabilities by intent.
- Prefer \`return\` values from executor code. Do not assume \`process\`, \`stdout\`, \`fs\`, \`bun\`, or shell commands are available unless executor explicitly exposes them through \`tools.*\`.
- Repo docs may mention shell commands for humans. Treat those as host-environment instructions, not executor runtime code.
- If executor returns a paused execution, call the \`executor\` tool again with \`action="resume"\` and the returned \`executionId\`.`;

	let rewritten = systemPrompt
		.replace(
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.",
			intro,
		)
		.replace(
			"In addition to the tools above, you may have access to other custom tools depending on the project.",
			hiddenToolsWarning,
		);

	if (!rewritten.includes("Locked-down session contract:")) {
		rewritten = rewritten.replace("\n\nGuidelines:\n", `\n\n${executorOnlyContract}\n\nGuidelines:\n`);
	}

	return rewritten;
}

export default function executorLocalExtension(pi: ExtensionAPI): void {
	for (const tool of createLockedFsToolDefinitions(SESSION_CWD)) {
		pi.registerTool(tool);
	}

	pi.registerFlag("executor-root", {
		description: "Path to the local executor checkout",
		type: "string",
		default: DEFAULT_EXECUTOR_ROOT,
	});
	pi.registerFlag("executor-base-url", {
		description: "Base URL of the running local executor server",
		type: "string",
		default: DEFAULT_EXECUTOR_BASE_URL,
	});
	pi.registerFlag("executor-command", {
		description: "Optional command override used to invoke executor CLI",
		type: "string",
	});

	pi.registerTool({
		name: "executor",
		label: "Executor",
		description:
			"Use this for external integrations and executor runtime capabilities. It runs TypeScript in the local executor runtime or resumes a paused execution. Code run through it can use executor runtime APIs exposed under tools.*.",
		promptSnippet:
			"Run TypeScript in the local executor runtime at http://localhost:8788 or resume paused executions.",
		promptGuidelines: [
			"Available pi tools in this session are `read`, `edit`, `write`, `grep`, `find`, `ls`, and `executor`. Do not describe them using provider/protocol names such as `functions.executor` or `multi_tool_use.parallel` in user-facing answers.",
			"Use `read`, `edit`, `write`, `grep`, `find`, and `ls` for local filesystem work. Use `executor` for external integrations and executor runtime capabilities.",
			"`bash` is not available in this session.",
			"Write TypeScript for executor call runs. The code runs inside executor's runtime, not Node.js, not bash, and not the pi host process.",
			"Code run through `executor` can use runtime APIs exposed under tools.*. Use tools.discover({ query, limit?, includeSchemas? }) to discover capabilities by intent; it returns { bestPath, results, total }, so inspect matches.results rather than calling matches.map(...).",
			"Do not enumerate or inventory the full executor runtime unless the user explicitly asks you to inspect executor itself. Default to capability search by intent.",
			"Prefer returning strings, objects, or arrays from executor call code instead of printing to stdout. Do not assume process, stdout, fs, bun, or shell commands are available.",
			"If executor returns a paused execution, resume it with the executor tool using action=resume and the returned executionId.",
		],
		parameters: executorSchema,
		async execute(_toolCallId, params, signal) {
			const action = params.action;
			if (action === "call" && (!params.code || params.code.trim().length === 0)) {
				throw new Error('executor tool requires "code" when action="call"');
			}
			if (action === "resume" && (!params.executionId || params.executionId.trim().length === 0)) {
				throw new Error('executor tool requires "executionId" when action="resume"');
			}
			const baseUrl =
				("baseUrl" in params && typeof params.baseUrl === "string" && params.baseUrl.trim().length > 0
					? params.baseUrl
					: (pi.getFlag("executor-base-url") as string | undefined)) ?? DEFAULT_EXECUTOR_BASE_URL;
			const root = (pi.getFlag("executor-root") as string | undefined) ?? DEFAULT_EXECUTOR_ROOT;
			const commandOverride = pi.getFlag("executor-command") as string | undefined;
			const cli = getExecutorCommand(root, commandOverride);

			const executorArgs =
				action === "call"
					? [
							"call",
							"--stdin",
							"--base-url",
							baseUrl,
							...("noOpen" in params && params.noOpen ? ["--no-open"] : []),
						]
					: [
							"resume",
							"--execution-id",
							params.executionId,
							"--base-url",
							baseUrl,
							...("noOpen" in params && params.noOpen ? ["--no-open"] : []),
						];

			const result = await runExecutorCli(cli, executorArgs, {
				stdinText: action === "call" ? params.code : undefined,
				signal,
				timeoutMs: "timeoutMs" in params ? params.timeoutMs : undefined,
			});

			const command = [cli.command, ...cli.args, ...executorArgs];
			const parsed = parseExecutorOutput(result.stdout, result.code);
			const formatted = formatExecutorResult(parsed, command, baseUrl, action);

			if (result.code !== 0 && result.code !== 20) {
				const stderr = result.stderr.trim();
				throw new Error(
					[
						formatted.text,
						stderr.length > 0 ? `stderr:\n${stderr}` : undefined,
						`Command: ${command.join(" ")}`,
						`Exit code: ${result.code}`,
					]
						.filter(Boolean)
						.join("\n\n"),
				);
			}

			return {
				content: [{ type: "text", text: formatted.text }],
				details: formatted.details,
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		pi.setActiveTools(EXECUTOR_FS_TOOLS);
		const baseUrl = ((pi.getFlag("executor-base-url") as string | undefined) ?? DEFAULT_EXECUTOR_BASE_URL).trim();
		ctx.ui.notify(`Locked-down mode enabled. Active tools: ${EXECUTOR_FS_TOOLS.join(", ")}`, "info");
		ctx.ui.setStatus("executor-local", ctx.ui.theme.fg("accent", `executor ${baseUrl}`));
	});

	pi.on("session_tree", () => {
		pi.setActiveTools(EXECUTOR_FS_TOOLS);
	});

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: rewriteExecutorOnlySystemPrompt(event.systemPrompt) };
	});
}

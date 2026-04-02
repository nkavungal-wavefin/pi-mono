import { spawn } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

const FALLBACK_EXECUTOR_ROOT = "/Users/nkavungal/Workspace/pockyclaw/executor";
const FALLBACK_EXECUTOR_BASE_URL = "http://localhost:8788";

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
				"TypeScript code to execute when action=\"call\". This runs inside executor's runtime, not Node.js, bash, or mom's host process. Runtime APIs are exposed under tools.*.",
		}),
	),
	executionId: Type.Optional(
		Type.String({
			description: 'Execution ID to resume when action="resume".',
		}),
	),
	baseUrl: Type.Optional(
		Type.String({
			description: `Executor server base URL. Defaults to ${getDefaultExecutorBaseUrl()}.`,
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

export function createExecutorTool(): AgentTool<typeof executorSchema> {
	return {
		name: "executor",
		label: "executor",
		description:
			"Use this for external integrations and executor runtime capabilities. It runs TypeScript in the local executor runtime or resumes a paused execution. Code run through it can use executor runtime APIs exposed under tools.*.",
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
				typeof params.baseUrl === "string" && params.baseUrl.trim().length > 0
					? params.baseUrl.trim()
					: getDefaultExecutorBaseUrl();
			const cli = getExecutorCommand(getDefaultExecutorRoot());
			const executorArgs =
				action === "call"
					? ["call", "--stdin", "--base-url", baseUrl, ...(params.noOpen ? ["--no-open"] : [])]
					: [
							"resume",
							"--execution-id",
							params.executionId!,
							"--base-url",
							baseUrl,
							...(params.noOpen ? ["--no-open"] : []),
						];

			const result = await runExecutorCli(cli, executorArgs, {
				stdinText: action === "call" ? params.code : undefined,
				signal,
				timeoutMs: params.timeoutMs,
			});

			const command = [cli.command, ...cli.args, ...executorArgs];
			const parsed = parseExecutorOutput(result.stdout, result.code);
			const formatted = formatExecutorResult(parsed, command, baseUrl, action);

			if (parsed.kind === "waiting_for_interaction") {
				throw new Error(
					[
						formatted.text,
						"Milestone 1 does not support approval/resume flows yet. Retry after the executor action is made non-interactive or implement Milestone 2 approvals.",
					].join("\n\n"),
				);
			}

			if (result.code !== 0) {
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
	};
}

function getExecutorCommand(root: string): ExecutorCliCommand {
	return {
		command: "bun",
		args: ["run", "executor"],
		cwd: root,
	};
}

function getDefaultExecutorRoot(): string {
	return process.env.MOM_EXECUTOR_ROOT ?? FALLBACK_EXECUTOR_ROOT;
}

function getDefaultExecutorBaseUrl(): string {
	return process.env.MOM_EXECUTOR_BASE_URL ?? FALLBACK_EXECUTOR_BASE_URL;
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

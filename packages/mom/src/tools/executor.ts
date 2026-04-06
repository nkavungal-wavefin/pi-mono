import { spawn } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ApprovalSummary } from "../approvals.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

const FALLBACK_EXECUTOR_ROOT = "/Users/nkavungal/Workspace/pockyclaw/executor";
const FALLBACK_EXECUTOR_BASE_URL = "http://localhost:8788";

type ExecutorCliCommand = {
	command: string;
	args: string[];
	cwd: string;
};

interface ExecutorExecutionEnvelope {
	execution: {
		id: string;
		status: "pending" | "running" | "waiting_for_interaction" | "completed" | "failed" | "cancelled";
		resultJson: string | null;
		errorText: string | null;
	};
	pendingInteraction: {
		id: string;
		purpose?: string;
		kind?: string;
		payloadJson: string;
	} | null;
}

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
				approvalDisplay?: ApprovalSummary;
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
	approvalDisplay?: ApprovalSummary;
}

/**
 * Sentinel key in tool result details that tells mom host code this is a paused
 * executor execution awaiting human approval. Never exposed to the model.
 */
export const MOM_APPROVAL_PENDING_KEY = "__momApprovalPending";

/**
 * Model-facing schema: only "call" action is exposed.
 * "resume" is handled host-side after approval and never offered to the model.
 */
const executorSchema = Type.Object({
	label: Type.String({
		description: "Brief description of what this executor run does (shown to user)",
	}),
	action: StringEnum(["call"] as const, {
		description: 'Use "call" to run TypeScript inside executor runtime.',
	}),
	code: Type.String({
		description:
			"TypeScript code to execute. This runs inside executor's runtime, not Node.js, bash, or mom's host process. Runtime APIs are exposed under tools.*.",
	}),
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
			"Use this for external integrations and executor runtime capabilities. It runs TypeScript in the local executor runtime. Code run through it can use executor runtime APIs exposed under tools.*. If executor needs human approval, it will be handled in Slack — you will receive the outcome later.",
		parameters: executorSchema,
		async execute(_toolCallId, params, signal) {
			if (!params.code || params.code.trim().length === 0) {
				throw new Error('executor tool requires "code" when action="call"');
			}

			const baseUrl =
				typeof params.baseUrl === "string" && params.baseUrl.trim().length > 0
					? params.baseUrl.trim()
					: getDefaultExecutorBaseUrl();
			const cli = getExecutorCommand(getDefaultExecutorRoot());
			const executorArgs = ["call", "--stdin", "--base-url", baseUrl, "--no-open"];

			const result = await runExecutorCli(cli, executorArgs, {
				stdinText: params.code,
				signal,
				timeoutMs: params.timeoutMs,
			});

			const command = [cli.command, ...cli.args, ...executorArgs];
			const parsed = parseExecutorOutput(result.stdout, result.code);
			const formatted = formatExecutorResult(parsed, command, baseUrl, "call");

			if (parsed.kind === "waiting_for_interaction") {
				// Return a special result that mom's afterToolCall hook will intercept.
				// The __momApprovalPending marker in details triggers approval flow.
				return {
					content: [
						{ type: "text", text: "⏳ This action requires human approval. Waiting for review in Slack." },
					],
					details: {
						[MOM_APPROVAL_PENDING_KEY]: true,
						action: "call",
						status: "waiting_for_interaction",
						command,
						baseUrl,
						label: params.label,
						executionId: parsed.paused.id,
						interactionId: parsed.paused.interactionId,
						resumeCommand: parsed.paused.resumeCommand,
						instruction: parsed.paused.instruction,
						requestedSchema: parsed.paused.interaction?.requestedSchema ?? null,
						url: parsed.paused.interaction?.url ?? null,
						approvalDisplay: formatted.details.approvalDisplay,
						originalArgs: { ...params },
					} satisfies ExecutorToolDetails & {
						[MOM_APPROVAL_PENDING_KEY]: true;
						label: string;
						originalArgs: Record<string, unknown>;
					},
				};
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

/**
 * Host-only: resume a paused executor execution after approval.
 * Not exposed as a model tool.
 */
export async function resumeExecutorExecution(params: {
	executionId: string;
	baseUrl?: string;
	noOpen?: boolean;
	timeoutMs?: number;
	input?: Record<string, unknown>;
}): Promise<{ text: string; details: ExecutorToolDetails }> {
	const baseUrl = params.baseUrl?.trim() || getDefaultExecutorBaseUrl();
	const workspaceId = await fetchLocalWorkspaceId(baseUrl);
	const envelope = await resumeExecutorViaHttp(baseUrl, workspaceId, params.executionId, params.input);
	return formatExecutorEnvelope(envelope, baseUrl, "resume");
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

async function fetchLocalWorkspaceId(baseUrl: string): Promise<string> {
	const response = await fetch(`${baseUrl}/v1/local/installation`);
	if (!response.ok) {
		throw new Error(`Failed to fetch executor installation (${response.status} ${response.statusText})`);
	}
	const payload = (await response.json()) as { scopeId?: string };
	if (!payload.scopeId || typeof payload.scopeId !== "string") {
		throw new Error("Executor installation response did not include scopeId");
	}
	return payload.scopeId;
}

async function resumeExecutorViaHttp(
	baseUrl: string,
	workspaceId: string,
	executionId: string,
	input: Record<string, unknown> | undefined,
): Promise<ExecutorExecutionEnvelope> {
	const approved = input?.approve === true;
	const response = await fetch(`${baseUrl}/v1/workspaces/${workspaceId}/executions/${executionId}/resume`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify({
			interactionMode: "live_form",
			responseJson: JSON.stringify({
				action: approved ? "accept" : "decline",
				content: input ?? {},
			}),
		}),
	});
	if (!response.ok) {
		const errorText = (await response.text()).trim();
		throw new Error(
			`Failed to resume executor execution (${response.status} ${response.statusText})${errorText ? `\n\n${errorText}` : ""}`,
		);
	}
	return (await response.json()) as ExecutorExecutionEnvelope;
}

function runExecutorCli(
	command: ExecutorCliCommand,
	executorArgs: string[],
	options: {
		stdinText?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		usePty?: boolean;
	},
): Promise<{ stdout: string; stderr: string; code: number | null; killed: boolean }> {
	return new Promise((resolve, reject) => {
		const child = options.usePty
			? spawn("script", ["-q", "/dev/null", command.command, ...command.args, ...executorArgs], {
					cwd: command.cwd,
					stdio: ["pipe", "pipe", "pipe"],
					shell: false,
				})
			: spawn(command.command, [...command.args, ...executorArgs], {
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

function tryParseJson(text: string): { parsedJson?: unknown; parsedText?: string } {
	const trimmed = text.trim();
	if (!trimmed) return {};
	try {
		return { parsedJson: JSON.parse(trimmed), parsedText: trimmed };
	} catch {
		const lines = trimmed
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]!;
			try {
				return { parsedJson: JSON.parse(line), parsedText: line };
			} catch {
				// continue scanning upward for the final JSON payload line
			}
		}
		return {};
	}
}

function parseApprovalSummary(value: unknown): ApprovalSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.toolPath !== "string") return undefined;
	if (typeof candidate.toolName !== "string") return undefined;
	if (!Array.isArray(candidate.fields)) return undefined;
	if (!candidate.args || typeof candidate.args !== "object" || Array.isArray(candidate.args)) return undefined;

	const fields = candidate.fields.flatMap((field) => {
		if (!field || typeof field !== "object") return [];
		const entry = field as Record<string, unknown>;
		if (typeof entry.key !== "string") return [];
		if (typeof entry.label !== "string") return [];
		if (typeof entry.value !== "string") return [];
		return [{ key: entry.key, label: entry.label, value: entry.value }];
	});

	return {
		toolPath: candidate.toolPath,
		toolName: candidate.toolName,
		title: typeof candidate.title === "string" ? candidate.title : undefined,
		description: typeof candidate.description === "string" ? candidate.description : undefined,
		fields,
		args: candidate.args as Record<string, unknown>,
	};
}

function parseExecutorOutput(stdout: string, exitCode: number | null): ParsedExecutorOutput {
	const trimmed = stdout.trim();
	const { parsedJson, parsedText } = tryParseJson(trimmed);

	if (
		exitCode === 20 &&
		parsedJson &&
		typeof parsedJson === "object" &&
		parsedJson !== null &&
		(parsedJson as { status?: string }).status === "waiting_for_interaction"
	) {
		const paused = parsedJson as {
			id: string;
			status: "waiting_for_interaction";
			interactionId?: string;
			message?: string;
			resumeCommand?: string;
			instruction?: string;
			approvalDisplay?: unknown;
			interaction?: {
				mode?: "form" | "url";
				message?: string;
				url?: string | null;
				requestedSchema?: Record<string, unknown> | null;
				approvalDisplay?: unknown;
			};
		};
		const approvalDisplay = parseApprovalSummary(paused.approvalDisplay ?? paused.interaction?.approvalDisplay);
		return {
			kind: "waiting_for_interaction",
			text: trimmed,
			paused: {
				...paused,
				approvalDisplay,
			},
		};
	}

	return {
		kind: "completed",
		text: parsedText ?? (trimmed.length > 0 ? trimmed : "(no output)"),
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
				approvalDisplay: paused.approvalDisplay,
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

function formatExecutorEnvelope(
	envelope: ExecutorExecutionEnvelope,
	baseUrl: string,
	action: "call" | "resume",
): { text: string; details: ExecutorToolDetails } {
	if (envelope.execution.status === "waiting_for_interaction" && envelope.pendingInteraction) {
		let instruction = "Execution paused because executor needs additional input.";
		let requestedSchema: Record<string, unknown> | null = null;
		let approvalDisplay: ApprovalSummary | undefined;
		try {
			const payload = JSON.parse(envelope.pendingInteraction.payloadJson) as {
				elicitation?: { message?: string; requestedSchema?: Record<string, unknown> };
				approvalDisplay?: unknown;
			};
			const message = payload.elicitation?.message;
			if (typeof message === "string" && message.trim().length > 0) {
				instruction = `Execution paused because executor needs additional input. The interaction prompt is "${message}".`;
			}
			requestedSchema = payload.elicitation?.requestedSchema ?? null;
			approvalDisplay = parseApprovalSummary(payload.approvalDisplay);
		} catch {
			// Keep fallback instruction
		}
		return {
			text: `${instruction}\nExecution ID: ${envelope.execution.id}`,
			details: {
				action,
				status: "waiting_for_interaction",
				command: [],
				baseUrl,
				executionId: envelope.execution.id,
				interactionId: envelope.pendingInteraction.id,
				instruction,
				requestedSchema,
				url: null,
				approvalDisplay,
			},
		};
	}

	if (envelope.execution.status === "failed") {
		throw new Error(envelope.execution.errorText ?? "Execution failed");
	}

	const text = envelope.execution.resultJson?.trim() || "completed";
	const truncated = truncateOutput(text);
	let formattedText = truncated.text;
	if (truncated.truncation) {
		formattedText += `\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.]`;
	}
	return {
		text: formattedText,
		details: {
			action,
			status: "completed",
			command: [],
			baseUrl,
			truncation: truncated.truncation,
			parsedJson: tryParseJson(text).parsedJson,
			executionId: envelope.execution.id,
		},
	};
}

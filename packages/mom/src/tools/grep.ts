import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { shellEscape } from "./shell.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const grepSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're searching for (shown to user)" }),
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
}

const DEFAULT_LIMIT = 100;

export function createGrepTool(executor: Executor): AgentTool<typeof grepSchema> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: grepSchema,
		execute: async (
			_toolCallId: string,
			params: {
				label: string;
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
		) => {
			const searchPath = params.path?.trim() || ".";
			const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_LIMIT);
			const result = await executor.exec(buildGrepCommand(searchPath, params, effectiveLimit), { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `Failed to search in ${searchPath}`);
			}

			const rawOutput = result.stdout.trim();
			if (!rawOutput) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: undefined,
				};
			}

			const lines = rawOutput.split("\n");
			const matchLimitReached = lines.length > effectiveLimit;
			const displayLines = matchLimitReached ? lines.slice(0, effectiveLimit) : lines;
			const truncation = truncateHead(displayLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let text = truncation.content;
			const notices: string[] = [];
			const details: GrepToolDetails = {};

			if (matchLimitReached) {
				notices.push(`${effectiveLimit} matches limit reached`);
				details.matchLimitReached = effectiveLimit;
			}
			if (truncation.truncated) {
				notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
				details.truncation = truncation;
			}
			if (notices.length > 0) {
				text += `\n\n[${notices.join(". ")}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: Object.keys(details).length > 0 ? details : undefined,
			};
		},
	};
}

function buildGrepCommand(
	searchPath: string,
	params: {
		pattern: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
	},
	limit: number,
): string {
	const args = ["--line-number", "--with-filename", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.context && params.context > 0) {
		args.push("-C", String(params.context));
	}
	if (params.glob) args.push("--glob", params.glob);
	args.push(params.pattern);
	const escapedPath = shellEscape(searchPath);
	return `rg ${args.map(shellEscape).join(" ")} --max-count ${limit_plus_one(limit)} --glob '!.git' --glob '!node_modules' -- ${escapedPath}`;
}

function limit_plus_one(limit: number): number {
	return limit + 1;
}

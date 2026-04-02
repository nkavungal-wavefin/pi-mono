import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { shellEscape } from "./shell.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const lsSchema = Type.Object({
	label: Type.String({ description: "Brief description of the directory listing (shown to user)" }),
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

const DEFAULT_LIMIT = 500;

export function createLsTool(executor: Executor): AgentTool<typeof lsSchema> {
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: lsSchema,
		execute: async (
			_toolCallId: string,
			{ path, limit }: { label: string; path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			const dir = path?.trim() || ".";
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const result = await executor.exec(buildLsCommand(dir, effectiveLimit), { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `Failed to list directory: ${dir}`);
			}

			const rawOutput = result.stdout.trim();
			if (!rawOutput) {
				return {
					content: [{ type: "text", text: "(empty directory)" }],
					details: undefined,
				};
			}

			const lines = rawOutput.split("\n");
			const entryLimitReached = lines.length > effectiveLimit;
			const displayLines = entryLimitReached ? lines.slice(0, effectiveLimit) : lines;
			const truncation = truncateHead(displayLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let text = truncation.content;
			const notices: string[] = [];
			const details: LsToolDetails = {};

			if (entryLimitReached) {
				notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
				details.entryLimitReached = effectiveLimit;
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

function buildLsCommand(dir: string, limit: number): string {
	const escapedDir = shellEscape(dir);
	const escapedMessageDir = shellEscape(dir);
	return `dir=${escapedDir}
if [ ! -e "$dir" ]; then
  printf '%s\n' "Path not found: " >&2
  printf '%s\n' ${escapedMessageDir} >&2
  exit 1
fi
if [ ! -d "$dir" ]; then
  printf '%s\n' "Not a directory: " >&2
  printf '%s\n' ${escapedMessageDir} >&2
  exit 1
fi
find "$dir" -mindepth 1 -maxdepth 1 | while IFS= read -r entry; do
  name=$(basename "$entry")
  if [ -d "$entry" ]; then
    printf '%s/\\n' "$name"
  else
    printf '%s\\n' "$name"
  fi
done | LC_ALL=C sort | head -n ${limit_plus_one(limit)}`;
}

function limit_plus_one(limit: number): number {
	return limit + 1;
}

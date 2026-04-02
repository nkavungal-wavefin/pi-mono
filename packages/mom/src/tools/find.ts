import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { shellEscape } from "./shell.js";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const findSchema = Type.Object({
	label: Type.String({ description: "Brief description of what files you're searching for (shown to user)" }),
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

const DEFAULT_LIMIT = 1000;

export function createFindTool(executor: Executor): AgentTool<typeof findSchema> {
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: findSchema,
		execute: async (
			_toolCallId: string,
			{ pattern, path, limit }: { label: string; pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
		) => {
			const searchDir = path?.trim() || ".";
			const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
			const result = await executor.exec(buildFindCommand(searchDir, pattern, effectiveLimit), { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `Failed to search for files in ${searchDir}`);
			}

			const rawOutput = result.stdout.trim();
			if (!rawOutput) {
				return {
					content: [{ type: "text", text: "No files found matching pattern" }],
					details: undefined,
				};
			}

			const lines = rawOutput.split("\n");
			const resultLimitReached = lines.length > effectiveLimit;
			const displayLines = resultLimitReached ? lines.slice(0, effectiveLimit) : lines;
			const truncation = truncateHead(displayLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
			let text = truncation.content;
			const notices: string[] = [];
			const details: FindToolDetails = {};

			if (resultLimitReached) {
				notices.push(`${effectiveLimit} results limit reached`);
				details.resultLimitReached = effectiveLimit;
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

function buildFindCommand(searchDir: string, pattern: string, limit: number): string {
	const escapedDir = shellEscape(searchDir);
	const escapedMessageDir = shellEscape(searchDir);
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
fd --glob --color=never --hidden --max-results ${limit_plus_one(limit)} --exclude .git --exclude node_modules ${shellEscape(pattern)} "$dir" | while IFS= read -r entry; do
  rel="$entry"
  case "$entry" in
    "$dir"/*) rel=\${entry#"$dir"/} ;;
  esac
  if [ -d "$entry" ]; then
    printf '%s/\\n' "$rel"
  else
    printf '%s\\n' "$rel"
  fi
done`;
}

function limit_plus_one(limit: number): number {
	return limit + 1;
}

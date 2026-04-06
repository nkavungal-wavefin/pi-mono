import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { test } from "vitest";
import { buildSystemPrompt, getSilentCompletionText, MOM_TOOL_EXECUTION, parseEventEnvelope } from "../src/agent.js";
import type { Executor } from "../src/sandbox.js";
import { createMomTools } from "../src/tools/index.js";

class FakeExecutor implements Executor {
	constructor(private readonly responses: Map<string, { stdout: string; stderr: string; code: number }>) {}

	async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
		for (const [matcher, result] of this.responses.entries()) {
			if (command.includes(matcher)) {
				return result;
			}
		}
		throw new Error(`Unexpected command: ${command}`);
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

test("milestone 1 tool profile includes discovery tools and excludes bash", () => {
	const tools = createMomTools(new FakeExecutor(new Map()));
	const names = tools.map((tool) => tool.name).sort();
	assert.deepEqual(names, ["attach", "edit", "executor", "find", "grep", "ls", "read", "write"]);
	assert.ok(!names.includes("bash"));
});

test("mom uses sequential tool execution", () => {
	assert.strictEqual(MOM_TOOL_EXECUTION, "sequential");
});

test("executor tool returns approval-pending result on paused executions (M2)", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "mom-executor-test-"));
	mkdirSync(join(tempRoot, "apps", "executor", "bin"), { recursive: true });
	writeFileSync(
		join(tempRoot, "package.json"),
		JSON.stringify({
			name: "executor",
			private: true,
			type: "module",
			scripts: { executor: "./apps/executor/bin/executor" },
		}),
		"utf8",
	);
	writeFileSync(
		join(tempRoot, "apps", "executor", "bin", "executor"),
		`#!/usr/bin/env bash
printf '{"id":"exec_123","status":"waiting_for_interaction","instruction":"Approval required","resumeCommand":"executor resume --execution-id exec_123","interaction":{"mode":"form","requestedSchema":{"type":"object"},"approvalDisplay":{"toolPath":"atlassian.mcp.createjiraissue","toolName":"createJiraIssue","title":"Create Jira issue","description":"Creates a Jira issue in the requested project.","fields":[{"key":"projectKey","label":"Project","value":"INC"},{"key":"summary","label":"Summary","value":"Payments API elevated 5xx in prod"}],"args":{"projectKey":"INC","summary":"Payments API elevated 5xx in prod"}}}}\n'
exit 20
`,
		{ encoding: "utf8", mode: 0o755 },
	);

	const previousRoot = process.env.MOM_EXECUTOR_ROOT;
	process.env.MOM_EXECUTOR_ROOT = tempRoot;

	try {
		const tool = createMomTools(new FakeExecutor(new Map())).find((entry) => entry.name === "executor");
		assert.ok(tool);
		const result = await tool!.execute("tool-call-1", {
			label: "Run external integration",
			action: "call",
			code: "return 1;",
			noOpen: true,
		});
		// Should NOT throw — returns a special approval-pending result
		assert.ok(result.content[0]);
		assert.match((result.content[0] as { text: string }).text, /approval/i);
		// Details must contain the approval marker
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.__momApprovalPending, true);
		assert.strictEqual(details.executionId, "exec_123");
		assert.strictEqual(details.status, "waiting_for_interaction");
		assert.deepStrictEqual(details.approvalDisplay, {
			toolPath: "atlassian.mcp.createjiraissue",
			toolName: "createJiraIssue",
			title: "Create Jira issue",
			description: "Creates a Jira issue in the requested project.",
			fields: [
				{ key: "projectKey", label: "Project", value: "INC" },
				{ key: "summary", label: "Summary", value: "Payments API elevated 5xx in prod" },
			],
			args: {
				projectKey: "INC",
				summary: "Payments API elevated 5xx in prod",
			},
		});
	} finally {
		if (previousRoot === undefined) delete process.env.MOM_EXECUTOR_ROOT;
		else process.env.MOM_EXECUTOR_ROOT = previousRoot;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("system prompt reflects milestone 2 approval contract", () => {
	const prompt = buildSystemPrompt(
		"/workspace",
		"C123",
		"(no memory)",
		{ type: "docker", container: "mom-sandbox" },
		[],
		[],
		[],
		"",
	);

	// Identity & personality
	assert.match(prompt, /You are PockyClaw/);
	assert.match(prompt, /autonomous team member/);
	assert.match(prompt, /genuinely helpful/);
	assert.match(prompt, /Have opinions/);
	assert.match(prompt, /Slack mrkdwn formatting/);

	assert.match(prompt, /`bash` is not available/i);
	assert.match(prompt, /executor.*external integrations/i);
	assert.match(prompt, /ls: List directory contents/);
	assert.match(prompt, /grep: Search file contents/);
	assert.match(prompt, /find: Search for files by glob pattern/);
	assert.doesNotMatch(prompt, /Run shell commands \(primary tool\)/);
	// M2: prompt mentions approval flow
	assert.match(prompt, /approval/i);
	assert.doesNotMatch(prompt, /treat that as an error/i);
	assert.match(prompt, /tools\.discover\(\{ query: .*includeSchemas: true/);
	assert.doesNotMatch(prompt, /Discover executor capabilities by intent/);
	assert.match(prompt, /Do not use `intent`/);
	assert.match(prompt, /Do not use `export default`/);
	assert.match(prompt, /Never call bare globals like `atlassian/);
	assert.match(prompt, /Do not introspect or stringify the `tools` object/);
	assert.match(prompt, /includeSchemas: true/);
	assert.match(prompt, /data: null, error/);
	assert.match(prompt, /Missing optional files are not fatal/);
	assert.match(prompt, /Do not branch into extra investigation just because an optional file is absent/);
	assert.match(prompt, /Prefer local tools first for workspace files and logs/);
	assert.match(prompt, /Default Atlassian site is `waveaccounting\.atlassian\.net`/);
	assert.match(prompt, /default Atlassian `cloudId` is `e51599e8-b54e-4415-9a99-c1989312dfff`/);
	assert.match(prompt, /call it directly instead of rediscovering it/);
	assert.match(prompt, /extract stable identifiers from the link before searching broadly/);
	assert.match(prompt, /Prefer stable identifiers over URL guessing/);
	assert.match(prompt, /prefer Atlassian search\/fetch-style tools first/i);
	assert.match(prompt, /Never emit more than one tool call in a single assistant message/);
	assert.match(prompt, /After any tool call, wait for its result before deciding the next step/);
	assert.match(prompt, /If you think you need multiple tools, call the first tool only/);
	assert.match(prompt, /stop retrying alternate code snippets and report it as an executor environment issue/);
	assert.match(prompt, /do not retry the same action with slightly different code while approval is pending/i);
	assert.match(prompt, /normalize them to the fields needed for the task/i);
	assert.match(prompt, /Do not dump giant raw payloads unless the user explicitly asks for them/);
	assert.match(prompt, /For `grep`, prefer simple or literal patterns unless regex is truly necessary/);
	assert.match(prompt, /This conversation \(channel or thread\)/);
	assert.match(prompt, /thread__C123ABC__1234567890_123456/);
	assert.match(prompt, /context\.jsonl/);
	assert.match(prompt, /last_prompt\.jsonl/);
	assert.match(prompt, /pending-approvals\//);
	assert.match(prompt, /Conversation \(/);
	assert.match(prompt, /AGENTS\.md/i);
	assert.match(prompt, /team-onboarding/);
	assert.match(prompt, /Prioritize durable team context/);
	assert.match(
		prompt,
		/If the team says to remember a link or document for later, save that reference and do not open every linked document immediately/,
	);
	assert.match(prompt, /Always leave a visible result for scheduled workflows/);
	assert.match(prompt, /Do not use `\[SILENT\]` for periodic events/);
});

test("parseEventEnvelope reads periodic event metadata", () => {
	const parsed = parseEventEnvelope(
		"[EVENT:payments-check.json:periodic:0 * * * *] Check Datadog for payments-core errors in scylla",
	);
	assert.deepStrictEqual(parsed, {
		filename: "payments-check.json",
		type: "periodic",
		schedule: "0 * * * *",
		body: "Check Datadog for payments-core errors in scylla",
	});
});

test("getSilentCompletionText preserves visible summaries for periodic events only", () => {
	assert.strictEqual(
		getSilentCompletionText("[EVENT:payments-check.json:periodic:0 * * * *] Check Datadog for payments-core errors"),
		"_Scheduled check complete: no issues found._",
	);
	assert.strictEqual(getSilentCompletionText("[EVENT:ping.json:immediate:immediate] Ping the service"), undefined);
	assert.strictEqual(getSilentCompletionText("regular user message"), undefined);
});

test("system prompt injects workspace AGENTS.md content when present", () => {
	const prompt = buildSystemPrompt(
		"/workspace",
		"C123",
		"(no memory)",
		{ type: "docker", container: "mom-sandbox" },
		[],
		[],
		[],
		"# Team\nWe own incident response and service desk escalations.",
	);

	assert.match(prompt, /## AGENTS\.md/);
	assert.match(prompt, /We own incident response and service desk escalations\./);
	assert.doesNotMatch(prompt, /Currently empty/);
});

test("ls tool returns directory entries", async () => {
	const tool = createMomTools(
		new FakeExecutor(
			new Map([
				[
					'find "$dir" -mindepth 1 -maxdepth 1',
					{
						stdout: "alpha.txt\nbeta/\n",
						stderr: "",
						code: 0,
					},
				],
			]),
		),
	).find((entry) => entry.name === "ls");

	assert.ok(tool);
	const result = await tool!.execute("tool-call-2", { label: "List root", path: ".", limit: 20 });
	assert.match((result.content[0] as { text: string }).text, /alpha\.txt/);
	assert.match((result.content[0] as { text: string }).text, /beta\//);
});

test("grep tool returns matches", async () => {
	const tool = createMomTools(
		new FakeExecutor(
			new Map([
				[
					"rg '--line-number'",
					{
						stdout: "./src/app.ts:3:const value = 1\n./src/app.ts:9:const VALUE = 2\n",
						stderr: "",
						code: 0,
					},
				],
			]),
		),
	).find((entry) => entry.name === "grep");

	assert.ok(tool);
	const result = await tool!.execute("tool-call-3", {
		label: "Find value",
		pattern: "value",
		path: ".",
		ignoreCase: true,
		limit: 20,
	});
	assert.match((result.content[0] as { text: string }).text, /src\/app\.ts:3/);
});

test("find tool returns matched paths", async () => {
	const tool = createMomTools(
		new FakeExecutor(
			new Map([
				[
					"fd --glob --color=never",
					{
						stdout: "src/index.ts\nsrc/utils/\n",
						stderr: "",
						code: 0,
					},
				],
			]),
		),
	).find((entry) => entry.name === "find");

	assert.ok(tool);
	const result = await tool!.execute("tool-call-4", {
		label: "Find ts files",
		pattern: "src/*",
		path: ".",
		limit: 20,
	});
	assert.match((result.content[0] as { text: string }).text, /src\/index\.ts/);
});

test("assistant text is only queued for main response, not thread duplicate", () => {
	const queued: Array<{ target: "main" | "thread"; text: string }> = [];
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "Hello." }],
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5.4",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};

	const thinkingParts: string[] = [];
	const textParts: string[] = [];
	for (const part of message.content) {
		if (part.type === "thinking") {
			thinkingParts.push(part.thinking);
		} else if (part.type === "text") {
			textParts.push(part.text);
		}
	}

	const enqueueMessage = (text: string, target: "main" | "thread") => {
		queued.push({ target, text });
	};

	for (const thinking of thinkingParts) {
		enqueueMessage(`_${thinking}_`, "main");
	}

	const text = textParts.join("\n");
	if (text.trim()) {
		enqueueMessage(text, "main");
	}

	assert.deepEqual(queued, [{ target: "main", text: "Hello." }]);
});

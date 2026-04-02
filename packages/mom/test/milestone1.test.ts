import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { buildSystemPrompt } from "../src/agent.js";
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

test("executor tool errors on paused executions for milestone 1", async () => {
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
printf '{"id":"exec_123","status":"waiting_for_interaction","instruction":"Approval required","resumeCommand":"executor resume --execution-id exec_123","interaction":{"mode":"form","requestedSchema":{"type":"object"}}}\n'
exit 20
`,
		{ encoding: "utf8", mode: 0o755 },
	);

	const previousRoot = process.env.MOM_EXECUTOR_ROOT;
	process.env.MOM_EXECUTOR_ROOT = tempRoot;

	try {
		const tool = createMomTools(new FakeExecutor(new Map())).find((entry) => entry.name === "executor");
		assert.ok(tool);
		await assert.rejects(
			() =>
				tool!.execute("tool-call-1", {
					label: "Run external integration",
					action: "call",
					code: "return 1;",
					noOpen: true,
				}),
			/does not support approval\/resume flows yet/i,
		);
	} finally {
		if (previousRoot === undefined) delete process.env.MOM_EXECUTOR_ROOT;
		else process.env.MOM_EXECUTOR_ROOT = previousRoot;
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("system prompt reflects milestone 1 contract", () => {
	const prompt = buildSystemPrompt(
		"/workspace",
		"C123",
		"(no memory)",
		{ type: "docker", container: "mom-sandbox" },
		[],
		[],
		[],
	);

	assert.match(prompt, /`bash` is not available/i);
	assert.match(prompt, /executor.*external integrations/i);
	assert.match(prompt, /ls: List directory contents/);
	assert.match(prompt, /grep: Search file contents/);
	assert.match(prompt, /find: Search for files by glob pattern/);
	assert.doesNotMatch(prompt, /Run shell commands \(primary tool\)/);
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

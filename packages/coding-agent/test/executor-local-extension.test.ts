import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import executorLocalExtension from "../examples/extensions/executor-local.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import type { ExtensionRunner } from "../src/core/extensions/runner.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { codingTools } from "../src/core/tools/index.js";

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, "utf8");
	chmodSync(path, 0o755);
}

function createFakeExecutorRepo(mode: "success" | "paused"): string {
	const repoDir = mkdtempSync(join(tmpdir(), "pi-executor-local-test-"));
	const appsExecutorBinDir = join(repoDir, "apps", "executor", "bin");
	mkdirSync(appsExecutorBinDir, { recursive: true });

	const packageJson = {
		name: "executor",
		private: true,
		type: "module",
		scripts: {
			executor: "./apps/executor/bin/executor",
		},
	};
	writeFileSync(join(repoDir, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");

	const binPath = join(appsExecutorBinDir, "executor");
	if (mode === "success") {
		writeExecutable(
			binPath,
			`#!/usr/bin/env bash
set -euo pipefail
subcommand="$1"
shift
if [ "$subcommand" = "call" ]; then
  input="$(cat)"
  printf '{"action":"call","received":%s,"baseUrl":"%s"}\n' "$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" "http://localhost:8788"
  exit 0
fi
if [ "$subcommand" = "resume" ]; then
  printf '{"action":"resume","resumed":true}\n'
  exit 0
fi
echo "unexpected subcommand" >&2
exit 1
`,
		);
	} else {
		writeExecutable(
			binPath,
			`#!/usr/bin/env bash
set -euo pipefail
printf '{"id":"exec_123","status":"waiting_for_interaction","resumeCommand":"executor resume --execution-id exec_123 --base-url http://localhost:8788","instruction":"Execution paused because approval is required.","interaction":{"mode":"form","message":"Approve tool call","requestedSchema":{"type":"object","properties":{"approve":{"type":"boolean"}},"required":["approve"]}}}\n'
exit 20
`,
		);
	}

	return repoDir;
}

async function createSessionWithExtension(
	tempDir: string,
	runtimeConfig: { root: string; baseUrl?: string; commandOverride?: string },
): Promise<{ session: AgentSession; cleanup: () => void }> {
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const sessionManager = SessionManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload();

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, agentDir);
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extension = await loadExtensionFromFactory(
		executorLocalExtension,
		tempDir,
		eventBus,
		runtime,
		"<inline:executor-local>",
	);

	const agent = new Agent({
		getApiKey: async () => "test-key",
		initialState: {
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			systemPrompt: "You are a test assistant.",
			tools: codingTools,
		},
	});

	const injectedResourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		extensionsOverride: () => ({ extensions: [extension], errors: [], runtime }),
	});
	await injectedResourceLoader.reload();

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		resourceLoader: injectedResourceLoader,
		modelRegistry,
	});

	await session.bindExtensions({});

	const runner = (session as unknown as { _extensionRunner?: ExtensionRunner })._extensionRunner;
	if (!runner) {
		throw new Error("Expected extension runner to be initialized");
	}
	runner.setFlagValue("executor-root", runtimeConfig.root);
	runner.setFlagValue("executor-base-url", runtimeConfig.baseUrl ?? "http://localhost:8788");
	if (runtimeConfig.commandOverride) {
		runner.setFlagValue("executor-command", runtimeConfig.commandOverride);
	}

	await runner.emit({ type: "session_start", reason: "startup" });

	return {
		session,
		cleanup: () => session.dispose(),
	};
}

describe("executor-local extension", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-executor-local-session-"));
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers the locked-down executor tool set", async () => {
		const fakeRepo = createFakeExecutorRepo("success");
		const { session, cleanup } = await createSessionWithExtension(tempDir, { root: fakeRepo });
		try {
			expect(session.getActiveToolNames()).toEqual(["read", "edit", "write", "grep", "find", "ls", "executor"]);
			expect(session.systemPrompt).toContain("- executor: Run TypeScript in the local executor runtime");
			expect(session.systemPrompt).toContain("- read:");
			expect(session.systemPrompt).not.toContain("- bash:");
		} finally {
			cleanup();
			rmSync(fakeRepo, { recursive: true, force: true });
		}
	});

	it("executes executor call against the local checkout", async () => {
		const fakeRepo = createFakeExecutorRepo("success");
		const { session, cleanup } = await createSessionWithExtension(tempDir, { root: fakeRepo });
		try {
			const tool = session.agent.state.tools.find((entry) => entry.name === "executor");
			expect(tool).toBeDefined();
			const result = await tool!.execute("tool-call-1", {
				label: "Return two",
				action: "call",
				code: "return 1 + 1;",
			});

			expect(result.content[0]).toMatchObject({
				type: "text",
			});
			expect((result.content[0] as { text: string }).text).toContain('"action":"call"');
			expect((result.details as { status?: string }).status).toBe("completed");
		} finally {
			cleanup();
			rmSync(fakeRepo, { recursive: true, force: true });
		}
	});

	it("surfaces paused executor executions as a non-error result", async () => {
		const fakeRepo = createFakeExecutorRepo("paused");
		const { session, cleanup } = await createSessionWithExtension(tempDir, { root: fakeRepo });
		try {
			const tool = session.agent.state.tools.find((entry) => entry.name === "executor");
			expect(tool).toBeDefined();
			const result = await tool!.execute("tool-call-2", {
				label: "Approve flow",
				action: "call",
				code: "return await tools.example.secureCall({});",
				noOpen: true,
			});

			const text = (result.content[0] as { text: string }).text;
			expect(text).toContain("Execution paused");
			expect(text).toContain("Execution ID: exec_123");
			expect(result.details).toMatchObject({
				status: "waiting_for_interaction",
				executionId: "exec_123",
			});
		} finally {
			cleanup();
			rmSync(fakeRepo, { recursive: true, force: true });
		}
	});
});

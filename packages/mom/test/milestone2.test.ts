import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { continueResolvedApproval, resolveApprovalAction } from "../src/approval-actions.js";
import type { ApprovalStatus } from "../src/approvals.js";
import {
	findApprovalAcrossChannels,
	listPendingApprovals,
	loadApproval,
	type PendingApproval,
	saveApproval,
	updateApproval,
} from "../src/approvals.js";
import { buildApprovalWidgetBlocks, buildResolvedApprovalMessage } from "../src/slack.js";
import { createExecutorTool, MOM_APPROVAL_PENDING_KEY } from "../src/tools/executor.js";

// ============================================================================
// Approval storage tests
// ============================================================================

test("saveApproval creates file and loadApproval reads it back", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		const approval: PendingApproval = {
			channelId: "C123",
			toolCallId: "tc-001",
			toolName: "executor",
			label: "Create Jira Issue",
			executorExecutionId: "exec-abc",
			interactionId: "int-001",
			instruction: "Approval required for Jira",
			originalArgs: { code: "tools.jira.create()" },
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		};

		saveApproval(tempDir, approval);

		const loaded = loadApproval(tempDir, "C123", "tc-001");
		assert.ok(loaded);
		assert.strictEqual(loaded.toolCallId, "tc-001");
		assert.strictEqual(loaded.executorExecutionId, "exec-abc");
		assert.strictEqual(loaded.status, "pending");
		assert.strictEqual(loaded.label, "Create Jira Issue");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("saveApproval supports path-unsafe toolCallIds", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		const toolCallId = "call_abc|segment/with/slashes+and=chars";
		const approval: PendingApproval = {
			channelId: "C123",
			toolCallId,
			toolName: "executor",
			label: "Create Jira Issue",
			executorExecutionId: "exec-unsafe",
			originalArgs: { code: "tools.jira.create()" },
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		};

		saveApproval(tempDir, approval);

		const loaded = loadApproval(tempDir, "C123", toolCallId);
		assert.ok(loaded);
		assert.strictEqual(loaded.toolCallId, toolCallId);
		assert.strictEqual(loaded.executorExecutionId, "exec-unsafe");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("updateApproval changes status", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		const approval: PendingApproval = {
			channelId: "C123",
			toolCallId: "tc-002",
			toolName: "executor",
			label: "Test",
			executorExecutionId: "exec-def",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		};

		saveApproval(tempDir, approval);
		approval.status = "approved";
		approval.resolvedAt = new Date().toISOString();
		approval.resolvedBy = "U999";
		updateApproval(tempDir, approval);

		const loaded = loadApproval(tempDir, "C123", "tc-002");
		assert.ok(loaded);
		assert.strictEqual(loaded.status, "approved");
		assert.strictEqual(loaded.resolvedBy, "U999");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("listPendingApprovals returns only pending items", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		saveApproval(tempDir, {
			channelId: "C456",
			toolCallId: "tc-a",
			toolName: "executor",
			label: "Pending one",
			executorExecutionId: "e1",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		});
		saveApproval(tempDir, {
			channelId: "C456",
			toolCallId: "tc-b",
			toolName: "executor",
			label: "Approved one",
			executorExecutionId: "e2",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "approved",
			createdAt: new Date().toISOString(),
		});
		saveApproval(tempDir, {
			channelId: "C456",
			toolCallId: "tc-c",
			toolName: "executor",
			label: "Pending two",
			executorExecutionId: "e3",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		});

		const pending = listPendingApprovals(tempDir, "C456");
		assert.strictEqual(pending.length, 2);
		const ids = pending.map((p) => p.toolCallId).sort();
		assert.deepStrictEqual(ids, ["tc-a", "tc-c"]);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("findApprovalAcrossChannels finds approval in any channel", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		saveApproval(tempDir, {
			channelId: "CH-AAA",
			toolCallId: "tc-cross",
			toolName: "executor",
			label: "Cross-channel",
			executorExecutionId: "e-cross",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		});

		const found = findApprovalAcrossChannels(tempDir, "tc-cross");
		assert.ok(found);
		assert.strictEqual(found.channelId, "CH-AAA");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("loadApproval returns null for missing approval", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		const result = loadApproval(tempDir, "C999", "nonexistent");
		assert.strictEqual(result, null);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Executor tool schema tests
// ============================================================================

test("executor schema only exposes 'call' action, not 'resume'", () => {
	const tool = createExecutorTool();
	const schema = tool.parameters;

	// The action field should only have "call"
	const actionProp = schema.properties.action;
	assert.ok(actionProp);
	assert.ok(actionProp.enum || actionProp.anyOf);
	if (actionProp.enum) {
		assert.deepStrictEqual(actionProp.enum, ["call"]);
	}
	// Should not contain "resume"
	const schemaStr = JSON.stringify(schema);
	assert.ok(!schemaStr.includes('"resume"'));
});

test("executor tool requires code for call action", async () => {
	const tool = createExecutorTool();
	await assert.rejects(
		() => tool.execute("tc-schema", { label: "Test", action: "call", code: "" }),
		/requires "code"/,
	);
});

// ============================================================================
// Slack approval UI tests
// ============================================================================

test("buildApprovalWidgetBlocks encodes approve/reject actions", () => {
	const blocks = buildApprovalWidgetBlocks("C123", "tc-123", "Create Jira issue", "Needs approval");
	assert.strictEqual(blocks.length, 3);

	const actionsBlock = blocks[2] as {
		type: string;
		elements: Array<{ action_id: string; value: string }>;
	};
	assert.strictEqual(actionsBlock.type, "actions");
	assert.deepStrictEqual(
		actionsBlock.elements.map((element) => element.action_id),
		["mom_approve", "mom_reject"],
	);
	assert.deepStrictEqual(JSON.parse(actionsBlock.elements[0].value), {
		toolCallId: "tc-123",
		channelId: "C123",
	});
	assert.deepStrictEqual(JSON.parse(actionsBlock.elements[1].value), {
		toolCallId: "tc-123",
		channelId: "C123",
	});
});

test("buildResolvedApprovalMessage formats approved state", () => {
	const resolved = buildResolvedApprovalMessage("Create Jira issue", true, "U123");
	assert.match(resolved.text, /Approved/);
	assert.match(resolved.text, /Create Jira issue/);
	assert.match(resolved.text, /<@U123>/);
	const section = resolved.blocks[0] as { text: { text: string } };
	assert.match(section.text.text, /Approved/);
});

// ============================================================================
// Approval resolution tests
// ============================================================================

test("resolveApprovalAction resumes approved executor call and persists resumed state", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		saveApproval(tempDir, {
			channelId: "C123",
			toolCallId: "tc-resume",
			toolName: "executor",
			label: "Create Jira issue",
			executorExecutionId: "exec-123",
			originalArgs: { code: "tools.jira.createIssue()" },
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		});

		const result = await resolveApprovalAction(tempDir, "C123", "tc-resume", "U123", true, async (approval) => {
			assert.strictEqual(approval.executorExecutionId, "exec-123");
			return { text: "Issue created: ENG-123" };
		});

		assert.ok(result);
		assert.strictEqual(result.approved, true);
		assert.match(result.resultText, /approved/);
		assert.match(result.resultText, /Issue created: ENG-123/);

		const stored = loadApproval(tempDir, "C123", "tc-resume");
		assert.ok(stored);
		assert.strictEqual(stored.status, "resumed");
		assert.strictEqual(stored.resolvedBy, "U123");
		assert.strictEqual(stored.result, "Issue created: ENG-123");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("resolveApprovalAction persists rejected state without resuming executor", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mom-approval-test-"));
	try {
		saveApproval(tempDir, {
			channelId: "C123",
			toolCallId: "tc-reject",
			toolName: "executor",
			label: "Create Jira issue",
			executorExecutionId: "exec-456",
			originalArgs: { code: "tools.jira.createIssue()" },
			baseUrl: "http://localhost:8788",
			status: "pending",
			createdAt: new Date().toISOString(),
		});

		let resumeCalled = false;
		const result = await resolveApprovalAction(tempDir, "C123", "tc-reject", "U999", false, async () => {
			resumeCalled = true;
			return { text: "should not happen" };
		});

		assert.ok(result);
		assert.strictEqual(result.approved, false);
		assert.strictEqual(resumeCalled, false);
		assert.match(result.resultText, /rejected/);

		const stored = loadApproval(tempDir, "C123", "tc-reject");
		assert.ok(stored);
		assert.strictEqual(stored.status, "rejected");
		assert.strictEqual(stored.resolvedBy, "U999");
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("continueResolvedApproval forwards both approve and reject results to session continuation", async () => {
	const calls: string[] = [];
	const runner = {
		async continueAfterApproval(_ctx: unknown, _store: unknown, approvalResultText: string) {
			calls.push(approvalResultText);
			return { stopReason: "stop" };
		},
	};
	const fakeCtx = {
		message: { text: "", rawText: "", user: "U1", channel: "C1", ts: "1", attachments: [] },
		channels: [],
		users: [],
		respond: async () => {},
		replaceMessage: async () => {},
		respondInThread: async () => {},
		setTyping: async () => {},
		uploadFile: async () => {},
		setWorking: async () => {},
		deleteMessage: async () => {},
	};
	const fakeStore = {} as never;

	const approved = {
		approval: {
			channelId: "C1",
			toolCallId: "tc-1",
			toolName: "executor",
			label: "Create Jira issue",
			executorExecutionId: "exec-1",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "resumed" as ApprovalStatus,
			createdAt: new Date().toISOString(),
		},
		approved: true,
		resultText:
			'[APPROVAL RESULT] The executor call "Create Jira issue" was *approved* by <@U1>.\n\nResult:\nIssue created',
	};
	const rejected = {
		approval: {
			channelId: "C1",
			toolCallId: "tc-2",
			toolName: "executor",
			label: "Create Jira issue",
			executorExecutionId: "exec-2",
			originalArgs: {},
			baseUrl: "http://localhost:8788",
			status: "rejected" as ApprovalStatus,
			createdAt: new Date().toISOString(),
		},
		approved: false,
		resultText: '[APPROVAL RESULT] The executor call "Create Jira issue" was *rejected* by <@U2>.',
	};

	await continueResolvedApproval(runner as never, fakeCtx as never, fakeStore, approved);
	await continueResolvedApproval(runner as never, fakeCtx as never, fakeStore, rejected);

	assert.strictEqual(calls.length, 2);
	assert.match(calls[0], /approved/);
	assert.match(calls[1], /rejected/);
});

// ============================================================================
// MOM_APPROVAL_PENDING_KEY sentinel
// ============================================================================

test("MOM_APPROVAL_PENDING_KEY is a string constant", () => {
	assert.strictEqual(typeof MOM_APPROVAL_PENDING_KEY, "string");
	assert.ok(MOM_APPROVAL_PENDING_KEY.length > 0);
});

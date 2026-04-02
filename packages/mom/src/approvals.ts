import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "resumed" | "failed";

export interface PendingApproval {
	channelId: string;
	toolCallId: string;
	toolName: string;
	label: string;
	branchFromEntryId?: string;
	executorExecutionId: string;
	interactionId?: string;
	instruction?: string;
	resumeCommand?: string;
	requestedSchema?: Record<string, unknown> | null;
	url?: string | null;
	originalArgs: Record<string, unknown>;
	baseUrl: string;
	status: ApprovalStatus;
	approvalMessageTs?: string;
	createdAt: string;
	resolvedAt?: string;
	resolvedBy?: string;
	result?: string;
}

function approvalsDir(workingDir: string, channelId: string): string {
	return join(workingDir, channelId, "pending-approvals");
}

function approvalFileName(toolCallId: string): string {
	return `${createHash("sha256").update(toolCallId).digest("hex")}.json`;
}

function approvalPath(workingDir: string, channelId: string, toolCallId: string): string {
	return join(approvalsDir(workingDir, channelId), approvalFileName(toolCallId));
}

function legacyApprovalPath(workingDir: string, channelId: string, toolCallId: string): string {
	return join(approvalsDir(workingDir, channelId), `${toolCallId}.json`);
}

function readApprovalFile(path: string): PendingApproval | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PendingApproval;
	} catch {
		return null;
	}
}

export function saveApproval(workingDir: string, approval: PendingApproval): void {
	const dir = approvalsDir(workingDir, approval.channelId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(approvalPath(workingDir, approval.channelId, approval.toolCallId), JSON.stringify(approval, null, 2));
}

export function loadApproval(workingDir: string, channelId: string, toolCallId: string): PendingApproval | null {
	return (
		readApprovalFile(approvalPath(workingDir, channelId, toolCallId)) ??
		readApprovalFile(legacyApprovalPath(workingDir, channelId, toolCallId))
	);
}

export function updateApproval(workingDir: string, approval: PendingApproval): void {
	saveApproval(workingDir, approval);
}

export function listPendingApprovals(workingDir: string, channelId: string): PendingApproval[] {
	const dir = approvalsDir(workingDir, channelId);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	const approvals: PendingApproval[] = [];
	for (const file of files) {
		try {
			const approval = JSON.parse(readFileSync(join(dir, file), "utf-8")) as PendingApproval;
			if (approval.status === "pending") approvals.push(approval);
		} catch {
			// skip corrupt files
		}
	}
	return approvals;
}

/**
 * Find a pending approval by looking across all channels.
 * Used when resolving a Slack action where we only have the toolCallId.
 */
export function findApprovalAcrossChannels(workingDir: string, toolCallId: string): PendingApproval | null {
	if (!existsSync(workingDir)) return null;
	const entries = readdirSync(workingDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const result = loadApproval(workingDir, entry.name, toolCallId);
		if (result) return result;
	}
	return null;
}

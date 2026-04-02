import { loadApproval, type PendingApproval, updateApproval } from "./approvals.js";
import type { SlackContext } from "./slack.js";
import type { ChannelStore } from "./store.js";

export interface ApprovalActionResult {
	approval: PendingApproval;
	approved: boolean;
	toolResultText: string;
	toolResultIsError: boolean;
}

export interface ApprovalContinuationRunner {
	continueAfterApproval(
		ctx: SlackContext,
		store: ChannelStore,
		resolution: ApprovalActionResult,
	): Promise<{ stopReason: string; errorMessage?: string }>;
}

export async function resolveApprovalAction(
	workingDir: string,
	channelId: string,
	toolCallId: string,
	userId: string,
	approved: boolean,
	resumeExecution: (approval: PendingApproval) => Promise<{ text: string }>,
): Promise<ApprovalActionResult | null> {
	const approval = loadApproval(workingDir, channelId, toolCallId);
	if (!approval || approval.status !== "pending") {
		return null;
	}

	approval.resolvedAt = new Date().toISOString();
	approval.resolvedBy = userId;

	if (approved) {
		approval.status = "approved";
		updateApproval(workingDir, approval);

		try {
			const resumeResult = await resumeExecution(approval);
			approval.status = "resumed";
			approval.result = resumeResult.text;
			updateApproval(workingDir, approval);

			return {
				approval,
				approved: true,
				toolResultText: resumeResult.text,
				toolResultIsError: false,
			};
		} catch (err) {
			approval.status = "failed";
			approval.result = err instanceof Error ? err.message : String(err);
			updateApproval(workingDir, approval);

			return {
				approval,
				approved: true,
				toolResultText: `Approval by <@${userId}> succeeded, but resuming "${approval.label}" failed.\n\n${approval.result}`,
				toolResultIsError: true,
			};
		}
	}

	approval.status = "rejected";
	updateApproval(workingDir, approval);
	return {
		approval,
		approved: false,
		toolResultText: `The executor call "${approval.label}" was rejected by <@${userId}>.`,
		toolResultIsError: true,
	};
}

export async function continueResolvedApproval(
	runner: ApprovalContinuationRunner,
	ctx: SlackContext,
	store: ChannelStore,
	resolution: ApprovalActionResult,
): Promise<{ stopReason: string; errorMessage?: string }> {
	return runner.continueAfterApproval(ctx, store, resolution);
}

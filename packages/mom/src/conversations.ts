export interface ConversationInfo {
	conversationId: string;
	slackChannelId: string;
	threadTs?: string;
	isDm: boolean;
}

const THREAD_PREFIX = "thread__";

export function sanitizeSlackTs(ts: string): string {
	return ts.replace(/\./g, "_");
}

export function unsanitizeSlackTs(ts: string): string {
	return ts.replace(/_/g, ".");
}

export function buildConversationId(channelId: string, threadTs?: string, isDm = false): string {
	if (isDm || !threadTs) {
		return channelId;
	}
	return `${THREAD_PREFIX}${channelId}__${sanitizeSlackTs(threadTs)}`;
}

export function parseConversationId(conversationId: string): ConversationInfo {
	if (!conversationId.startsWith(THREAD_PREFIX)) {
		return {
			conversationId,
			slackChannelId: conversationId,
			isDm: conversationId.startsWith("D"),
		};
	}

	const remainder = conversationId.slice(THREAD_PREFIX.length);
	const separatorIndex = remainder.indexOf("__");
	if (separatorIndex === -1) {
		throw new Error(`Invalid threaded conversation id: ${conversationId}`);
	}

	const slackChannelId = remainder.slice(0, separatorIndex);
	const threadTs = unsanitizeSlackTs(remainder.slice(separatorIndex + 2));

	return {
		conversationId,
		slackChannelId,
		threadTs,
		isDm: false,
	};
}

export function buildConversationInfo(input: {
	channelId: string;
	ts: string;
	threadTs?: string;
	isDm: boolean;
}): ConversationInfo {
	if (input.isDm) {
		return {
			conversationId: input.channelId,
			slackChannelId: input.channelId,
			isDm: true,
		};
	}

	const rootThreadTs = input.threadTs?.trim().length ? input.threadTs : input.ts;
	return {
		conversationId: buildConversationId(input.channelId, rootThreadTs),
		slackChannelId: input.channelId,
		threadTs: rootThreadTs,
		isDm: false,
	};
}

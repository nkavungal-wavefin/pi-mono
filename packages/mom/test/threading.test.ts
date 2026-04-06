import assert from "node:assert/strict";
import { test } from "vitest";
import {
	buildConversationId,
	buildConversationInfo,
	parseConversationId,
	sanitizeSlackTs,
	unsanitizeSlackTs,
} from "../src/conversations.js";

test("thread conversation ids round-trip", () => {
	const threadTs = "1712345678.000100";
	const conversationId = buildConversationId("C123", threadTs);

	assert.strictEqual(conversationId, "thread__C123__1712345678_000100");
	assert.strictEqual(unsanitizeSlackTs(sanitizeSlackTs(threadTs)), threadTs);
	assert.deepStrictEqual(parseConversationId(conversationId), {
		conversationId,
		slackChannelId: "C123",
		threadTs,
		isDm: false,
	});
});

test("root channel mention creates a thread-scoped conversation", () => {
	assert.deepStrictEqual(
		buildConversationInfo({
			channelId: "C234",
			ts: "1712345678.000200",
			isDm: false,
		}),
		{
			conversationId: "thread__C234__1712345678_000200",
			slackChannelId: "C234",
			threadTs: "1712345678.000200",
			isDm: false,
		},
	);
});

test("thread reply keeps the root thread conversation id", () => {
	assert.deepStrictEqual(
		buildConversationInfo({
			channelId: "C234",
			ts: "1712345680.000300",
			threadTs: "1712345678.000200",
			isDm: false,
		}),
		{
			conversationId: "thread__C234__1712345678_000200",
			slackChannelId: "C234",
			threadTs: "1712345678.000200",
			isDm: false,
		},
	);
});

test("dm conversations stay keyed by channel id", () => {
	assert.deepStrictEqual(
		buildConversationInfo({
			channelId: "D123",
			ts: "1712345678.000400",
			isDm: true,
		}),
		{
			conversationId: "D123",
			slackChannelId: "D123",
			isDm: true,
		},
	);
	assert.deepStrictEqual(parseConversationId("D123"), {
		conversationId: "D123",
		slackChannelId: "D123",
		isDm: true,
	});
});

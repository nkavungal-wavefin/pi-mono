import assert from "node:assert/strict";
import { test } from "vitest";
import { buildConversationId } from "../src/conversations.js";
import { EventsWatcher, type MomEvent } from "../src/events.js";
import type { SlackEvent } from "../src/slack.js";

test("channel events always create a fresh top-level thread even when targeting a thread conversation", async () => {
	let postedAnchor:
		| {
				channel: string;
				text: string;
				threadTs?: string;
		  }
		| undefined;
	let enqueuedEvent: SlackEvent | undefined;

	const slack = {
		async postMessage(channel: string, text: string, threadTs?: string) {
			postedAnchor = { channel, text, threadTs };
			return "1712345678.000999";
		},
		enqueueEvent(event: SlackEvent) {
			enqueuedEvent = event;
			return true;
		},
	};

	const watcher = new EventsWatcher("/tmp/mom-events-test", slack as never);
	const event: MomEvent = {
		type: "periodic",
		channelId: "thread__C123__1712345000_000100",
		text: "Check payments-core errors in scylla",
		schedule: "*/5 * * * *",
		timezone: "UTC",
	};

	await (watcher as any).execute("payments-check.json", event, false);

	assert.deepStrictEqual(postedAnchor, {
		channel: "C123",
		text: "_Scheduled workflow started: payments-check.json_",
		threadTs: undefined,
	});
	assert.ok(enqueuedEvent);
	assert.strictEqual(enqueuedEvent?.channel, "C123");
	assert.strictEqual(enqueuedEvent?.threadTs, "1712345678.000999");
	assert.strictEqual(enqueuedEvent?.conversationId, buildConversationId("C123", "1712345678.000999"));
	assert.match(
		enqueuedEvent?.text ?? "",
		/^\[EVENT:payments-check\.json:periodic:\*\/5 \* \* \* \*\] Check payments-core errors in scylla$/,
	);
});

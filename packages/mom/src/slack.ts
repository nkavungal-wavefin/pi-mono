import { SocketModeClient } from "@slack/socket-mode";
import type { KnownBlock } from "@slack/types";
import { ErrorCode, type WebAPIPlatformError, WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { ApprovalSummary, ApprovalSummaryField } from "./approvals.js";
import { buildConversationInfo, type ConversationInfo, parseConversationId } from "./conversations.js";
import * as log from "./log.js";
import type { Attachment, ChannelStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
	type: "mention" | "dm";
	conversationId: string;
	channel: string;
	ts: string;
	threadTs?: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		conversationId: string;
		channel: string;
		ts: string;
		threadTs?: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setToolTimelineStatus: (status: RunStatusKind, entries: ToolTimelineEntry[]) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export type ToolTimelineStatus = "in_progress" | "success" | "error" | "paused";

export interface ToolTimelineEntry {
	label: string;
	status: ToolTimelineStatus;
}

export type RunStatusKind = "working" | "approval_pending" | "done" | "failed" | "stopped";

export interface MomHandler {
	/**
	 * Check if conversation is currently running (SYNC)
	 */
	isRunning(conversationId: string): boolean;

	/**
	 * Handle an event that triggers mom (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while a conversation is running
	 */
	handleStop(event: SlackEvent, slack: SlackBot): Promise<void>;

	/**
	 * Handle an approval action from Slack interactive message (ASYNC)
	 */
	handleApprovalAction?(action: ApprovalAction, slack: SlackBot): Promise<void>;
}

/** Parsed approval action from a Slack block_actions interaction */
export interface ApprovalAction {
	actionId: "mom_approve" | "mom_reject";
	toolCallId: string;
	conversationId: string;
	userId: string;
	messageTs: string;
}

const MAX_ASSISTANT_MESSAGE_LENGTH = 72;
const MAX_APPROVAL_FIELD_TEXT_LENGTH = 2000;
const MAX_APPROVAL_CONTEXT_TEXT_LENGTH = 2000;
type AssistantThreadStatusResult = "updated" | "unsupported" | "failed";
const UNSUPPORTED_ASSISTANT_STATUS_ERRORS = new Set([
	"access_denied",
	"deprecated_endpoint",
	"invalid_auth",
	"missing_scope",
	"not_allowed_token_type",
	"unknown_method",
]);

function isVerboseApprovalDescription(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	if (trimmed.length > 280) return true;
	if (trimmed.includes("\n\n")) return true;
	if (/\n[-*]\s/.test(trimmed)) return true;
	return false;
}

function truncateSlackText(text: string, maxLength: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	if (maxLength <= 1) return "…".slice(0, maxLength);
	return `${trimmed.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatApprovalFieldText(field: ApprovalSummaryField): string {
	const label = field.label.trim() || field.key.trim() || "Value";
	const labelText = `*${truncateSlackText(label, 80)}*\n`;
	const maxValueLength = Math.max(1, MAX_APPROVAL_FIELD_TEXT_LENGTH - labelText.length);
	return `${labelText}${truncateSlackText(field.value, maxValueLength)}`;
}

function getApprovalDescriptionText(approvalDisplay?: ApprovalSummary, instruction?: string): string | undefined {
	const description = approvalDisplay?.description?.trim();
	if (description) {
		const hasFields = (approvalDisplay?.fields.length ?? 0) > 0;
		if (!(hasFields && isVerboseApprovalDescription(description))) {
			return truncateSlackText(description, MAX_APPROVAL_CONTEXT_TEXT_LENGTH);
		}
	}
	const trimmedInstruction = instruction?.trim();
	return trimmedInstruction ? truncateSlackText(trimmedInstruction, MAX_APPROVAL_CONTEXT_TEXT_LENGTH) : undefined;
}

export function buildApprovalWidgetBlocks(
	conversationId: string,
	toolCallId: string,
	label: string,
	instruction?: string,
	approvalDisplay?: ApprovalSummary,
): KnownBlock[] {
	const title = approvalDisplay?.title || approvalDisplay?.toolName || label;
	const descriptionText = getApprovalDescriptionText(approvalDisplay, instruction);
	const blocks: KnownBlock[] = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: "Approval required",
				emoji: true,
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*${title}*`,
			},
		},
	];
	if (descriptionText) {
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: descriptionText }],
		});
	}
	if (approvalDisplay?.fields.length) {
		blocks.push({
			type: "section",
			fields: approvalDisplay.fields.slice(0, 10).map((field) => ({
				type: "mrkdwn" as const,
				text: formatApprovalFieldText(field),
			})),
		});
	}
	blocks.push({
		type: "actions",
		elements: [
			{
				type: "button",
				text: { type: "plain_text", text: "Approve", emoji: true },
				style: "primary",
				action_id: "mom_approve",
				value: JSON.stringify({ toolCallId, conversationId }),
			},
			{
				type: "button",
				text: { type: "plain_text", text: "Reject", emoji: true },
				style: "danger",
				action_id: "mom_reject",
				value: JSON.stringify({ toolCallId, conversationId }),
			},
		],
	});
	return blocks;
}

export function buildResolvedApprovalMessage(
	label: string,
	approved: boolean,
	resolvedBy?: string,
	approvalDisplay?: ApprovalSummary,
): { text: string; blocks: KnownBlock[] } {
	const status = approved ? "✅ Approved" : "❌ Rejected";
	const byText = resolvedBy ? ` by <@${resolvedBy}>` : "";
	const title = approvalDisplay?.title || approvalDisplay?.toolName || label;
	const descriptionText = getApprovalDescriptionText(approvalDisplay);
	const blocks: KnownBlock[] = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: "Approval resolved",
				emoji: true,
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${status}: *${title}*${byText}`,
			},
		},
	];
	if (descriptionText) {
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: descriptionText }],
		});
	}
	if (approvalDisplay?.fields.length) {
		blocks.push({
			type: "section",
			fields: approvalDisplay.fields.slice(0, 10).map((field) => ({
				type: "mrkdwn" as const,
				text: formatApprovalFieldText(field),
			})),
		});
	}
	return {
		text: `${status}: ${title}${byText}`,
		blocks,
	};
}

function truncateAssistantMessage(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_ASSISTANT_MESSAGE_LENGTH) {
		return normalized;
	}
	return `${normalized.slice(0, MAX_ASSISTANT_MESSAGE_LENGTH - 3).trimEnd()}...`;
}

export function buildAssistantStatusText(entries: ToolTimelineEntry[], idleLabel?: string): string {
	if (entries.length === 0) {
		return idleLabel ? truncateAssistantMessage(`⏳ Handling ${idleLabel}...`) : "💭 Thinking...";
	}

	const entry = entries.at(-1)!;
	let message: string;
	switch (entry.status) {
		case "success":
			message = `✅ Completed ${entry.label}`;
			break;
		case "error":
			message = `❌ Failed ${entry.label}`;
			break;
		case "paused":
			message = `⏸ Waiting for approval on ${entry.label}`;
			break;
		default:
			message = `⏳ Working on ${entry.label}`;
			break;
	}
	return truncateAssistantMessage(message);
}

function buildToolTimelineText(status: RunStatusKind, entries: ToolTimelineEntry[]): string {
	if (entries.length === 0) {
		switch (status) {
			case "approval_pending":
				return ":pause_button: Awaiting approval";
			case "done":
				return ":white_check_mark: Done";
			case "failed":
				return ":x: Failed";
			case "stopped":
				return ":stop_sign: Stopped";
			default:
				return ":thought_balloon: Thinking";
		}
	}

	return entries
		.map((entry) => {
			switch (entry.status) {
				case "success":
					return `:white_check_mark: ${entry.label}`;
				case "error":
					return `:x: ${entry.label}`;
				case "paused":
					return `:pause_button: ${entry.label}`;
				default:
					return `:hourglass_flowing_sand: ${entry.label}`;
			}
		})
		.join("\n");
}

export function buildToolTimelineBlocks(status: RunStatusKind, entries: ToolTimelineEntry[]): KnownBlock[] {
	const headerText =
		status === "approval_pending"
			? "Waiting for approval"
			: status === "done"
				? "Done"
				: status === "failed"
					? "Failed"
					: status === "stopped"
						? "Stopped"
						: "Working on it";

	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: headerText,
				emoji: true,
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: buildToolTimelineText(status, entries),
			},
		},
	];
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: MomHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private startupTs: string | null = null; // Messages older than this are just logged, not processed

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();
	private assistantStatusUnsupported = false;

	constructor(
		handler: MomHandler,
		config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;

		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();
	}

	getUser(userId: string): SlackUser | undefined {
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	async postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, text, thread_ts: threadTs });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		await this.webClient.chat.update({ channel, ts, text });
	}

	async postToolTimeline(
		channel: string,
		status: RunStatusKind,
		entries: ToolTimelineEntry[],
		threadTs?: string,
	): Promise<string> {
		const blocks = buildToolTimelineBlocks(status, entries);
		const text = buildToolTimelineText(status, entries);
		const result = await this.webClient.chat.postMessage({
			channel,
			text,
			blocks,
			thread_ts: threadTs,
		});
		return result.ts as string;
	}

	async updateToolTimeline(
		channel: string,
		ts: string,
		status: RunStatusKind,
		entries: ToolTimelineEntry[],
	): Promise<void> {
		const blocks = buildToolTimelineBlocks(status, entries);
		const text = buildToolTimelineText(status, entries);
		await this.webClient.chat.update({
			channel,
			ts,
			text,
			blocks,
		});
	}

	async setAssistantThreadStatus(
		channel: string,
		threadTs: string,
		statusText: string,
	): Promise<AssistantThreadStatusResult> {
		if (this.assistantStatusUnsupported) {
			return "unsupported";
		}

		try {
			await this.webClient.assistant.threads.setStatus({
				channel_id: channel,
				thread_ts: threadTs,
				status: statusText,
			});
			return "updated";
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === ErrorCode.PlatformError &&
				"data" in error
			) {
				const platformError = error as WebAPIPlatformError;
				if (UNSUPPORTED_ASSISTANT_STATUS_ERRORS.has(platformError.data.error ?? "")) {
					this.assistantStatusUnsupported = true;
					log.logWarning(
						"Slack assistant status unavailable",
						platformError.data.error ?? "unsupported assistant status API",
					);
					return "unsupported";
				}
			}

			log.logWarning("Slack assistant status error", error instanceof Error ? error.message : String(error));
			return "failed";
		}
	}

	async clearAssistantThreadStatus(channel: string, threadTs: string): Promise<void> {
		if (this.assistantStatusUnsupported) {
			return;
		}

		try {
			await this.webClient.assistant.threads.setStatus({
				channel_id: channel,
				thread_ts: threadTs,
				status: "",
			});
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === ErrorCode.PlatformError &&
				"data" in error
			) {
				const platformError = error as WebAPIPlatformError;
				if (UNSUPPORTED_ASSISTANT_STATUS_ERRORS.has(platformError.data.error ?? "")) {
					this.assistantStatusUnsupported = true;
					return;
				}
			}

			log.logWarning("Slack clear assistant status error", error instanceof Error ? error.message : String(error));
		}
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text });
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string, threadTs?: string): Promise<void> {
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		if (threadTs) {
			await this.webClient.files.uploadV2({
				channels: channel,
				thread_ts: threadTs,
				file: fileContent,
				filename: fileName,
				title: fileName,
			});
			return;
		}
		await this.webClient.files.uploadV2({
			channel_id: channel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * Post a Block Kit approval widget with approve/reject buttons.
	 * Returns the message ts.
	 */
	async postApprovalWidget(
		channel: string,
		conversationId: string,
		toolCallId: string,
		label: string,
		instruction?: string,
		approvalDisplay?: ApprovalSummary,
		threadTs?: string,
	): Promise<string> {
		const blocks = buildApprovalWidgetBlocks(conversationId, toolCallId, label, instruction, approvalDisplay);
		const text = approvalDisplay?.title || approvalDisplay?.toolName || label;

		const result = await this.webClient.chat.postMessage({
			channel,
			text: `Approval required: ${text}`,
			blocks,
			thread_ts: threadTs,
		});
		return result.ts as string;
	}

	/**
	 * Update an approval widget to show resolved state.
	 */
	async updateApprovalWidget(
		channel: string,
		messageTs: string,
		label: string,
		approved: boolean,
		resolvedBy?: string,
		approvalDisplay?: ApprovalSummary,
	): Promise<void> {
		const resolved = buildResolvedApprovalMessage(label, approved, resolvedBy, approvalDisplay);
		await this.webClient.chat.update({
			channel,
			ts: messageTs,
			text: resolved.text,
			blocks: resolved.blocks,
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(conversationId: string, entry: object): void {
		const dir = join(this.workingDir, conversationId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(conversationId: string, text: string, ts: string, threadTs?: string): void {
		this.logToFile(conversationId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
			threadTs,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.conversationId);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.conversationId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.conversationId}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(conversationId: string): ChannelQueue {
		let queue = this.queues.get(conversationId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(conversationId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Interactive messages (approval buttons)
		this.socketClient.on("interactive", ({ ack, body }: { ack: () => void; body: Record<string, unknown> }) => {
			ack();

			if (body.type !== "block_actions") return;

			const actions = body.actions as
				| Array<{
						action_id: string;
						value?: string;
				  }>
				| undefined;
			if (!actions || actions.length === 0) return;

			const action = actions[0];
			if (action.action_id !== "mom_approve" && action.action_id !== "mom_reject") return;

			let parsed: { toolCallId: string; conversationId?: string };
			try {
				parsed = JSON.parse(action.value || "{}");
			} catch {
				log.logWarning("Failed to parse approval action value", action.value || "");
				return;
			}

			const userId = (body.user as { id?: string })?.id || "unknown";
			const messageTs = (body.message as { ts?: string })?.ts || "";
			const channel = (body.channel as { id?: string })?.id || "";

			const approvalAction: ApprovalAction = {
				actionId: action.action_id as "mom_approve" | "mom_reject",
				toolCallId: parsed.toolCallId,
				conversationId: parsed.conversationId || channel,
				userId,
				messageTs,
			};

			if (this.handler.handleApprovalAction) {
				this.handler.handleApprovalAction(approvalAction, this).catch((err) => {
					log.logWarning("Approval action error", err instanceof Error ? err.message : String(err));
				});
			}
		});

		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const conversation = buildConversationInfo({
				channelId: e.channel,
				ts: e.ts,
				threadTs: e.thread_ts,
				isDm: false,
			});
			const slackEvent: SlackEvent = {
				type: "mention",
				conversationId: conversation.conversationId,
				channel: e.channel,
				ts: e.ts,
				threadTs: conversation.threadTs,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// Check for stop command - execute immediately, don't queue!
			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(slackEvent.conversationId)) {
					this.handler.handleStop(slackEvent, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_", slackEvent.threadTs);
				}
				ack();
				return;
			}

			// SYNC: Check if busy
			if (this.handler.isRunning(slackEvent.conversationId)) {
				this.postMessage(e.channel, "_Already working. Say `@mom stop` to cancel._", slackEvent.threadTs);
			} else {
				this.getQueue(slackEvent.conversationId).enqueue(() => this.handler.handleEvent(slackEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip bot messages, edits, etc.
			if (e.bot_id || !e.user || e.user === this.botUserId) {
				ack();
				return;
			}
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				ack();
				return;
			}
			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const conversation = buildConversationInfo({
				channelId: e.channel,
				ts: e.ts,
				threadTs: e.thread_ts,
				isDm: isDM,
			});
			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				conversationId: conversation.conversationId,
				channel: e.channel,
				ts: e.ts,
				threadTs: conversation.threadTs,
				user: e.user,
				text: (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// Ignore non-DM non-thread chatter; only thread conversations are persisted in channels.
			if (!isDM && !slackEvent.threadTs) {
				ack();
				return;
			}

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			if (slackEvent.text.toLowerCase().trim() === "stop") {
				if (this.handler.isRunning(slackEvent.conversationId)) {
					this.handler.handleStop(slackEvent, this); // Don't await, don't queue
				} else {
					this.postMessage(e.channel, "_Nothing running_", isDM ? undefined : slackEvent.threadTs);
				}
				ack();
				return;
			}

			// Only trigger handler for DMs. Thread replies are context only unless they explicitly mention via app_mention.
			if (isDM) {
				if (this.handler.isRunning(slackEvent.conversationId)) {
					this.postMessage(e.channel, "_Already working. Say `stop` to cancel._");
				} else {
					this.getQueue(slackEvent.conversationId).enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.users.get(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.conversationId, event.files, event.ts) : [];
		this.logToFile(event.conversationId, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
			channelId: event.channel,
			threadTs: event.threadTs,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(conversationId: string): Set<string> {
		const logPath = join(this.workingDir, conversationId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillThreadConversation(conversation: ConversationInfo): Promise<number> {
		if (!conversation.threadTs) return 0;
		const existingTs = this.getExistingTimestamps(conversation.conversationId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			thread_ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.replies({
				channel: conversation.slackChannelId,
				ts: conversation.threadTs,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 200,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include mom's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files
				? this.store.processAttachments(conversation.conversationId, msg.files, msg.ts!)
				: [];

			this.logToFile(conversation.conversationId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
				channelId: conversation.slackChannelId,
				threadTs: conversation.threadTs,
			});
		}

		return relevantMessages.length;
	}

	private async backfillDmConversation(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs,
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false;
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		relevantMessages.reverse();

		for (const msg of relevantMessages) {
			const isMomMessage = msg.user === this.botUserId;
			const user = this.users.get(msg.user!);
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isMomMessage ? "bot" : msg.user!,
				userName: isMomMessage ? undefined : user?.userName,
				displayName: isMomMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isMomMessage,
				channelId,
			});
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill conversations that already have a log.jsonl.
		const conversationsToBackfill: ConversationInfo[] = [];
		for (const entry of readdirSync(this.workingDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "skills" || entry.name === "events") continue;
			const logPath = join(this.workingDir, entry.name, "log.jsonl");
			if (!existsSync(logPath)) continue;
			try {
				conversationsToBackfill.push(parseConversationId(entry.name));
			} catch {
				// Ignore unrelated directories and legacy channel-only sessions
			}
		}

		log.logBackfillStart(conversationsToBackfill.length);

		let totalMessages = 0;
		for (const conversation of conversationsToBackfill) {
			try {
				const count = conversation.isDm
					? await this.backfillDmConversation(conversation.slackChannelId)
					: await this.backfillThreadConversation(conversation);
				const channelName = this.channels.get(conversation.slackChannelId)?.name ?? conversation.slackChannelId;
				const label = conversation.threadTs ? `${channelName}:${conversation.threadTs}` : channelName;
				if (count > 0) log.logBackfillChannel(label, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill ${conversation.conversationId}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		try {
			let cursor: string | undefined;
			do {
				const result = await this.webClient.users.list({ limit: 200, cursor });
				const members = result.members as
					| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
					| undefined;
				if (members) {
					for (const u of members) {
						if (u.id && u.name && !u.deleted) {
							this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
						}
					}
				}
				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			if (isMissingScopeError(error)) {
				log.logWarning("Skipping Slack user lookup due to missing scope", "Add users:read to enable user names.");
				return;
			}
			throw error;
		}
	}

	private async fetchChannels(): Promise<void> {
		try {
			// Fetch public/private channels
			let cursor: string | undefined;
			do {
				const result = await this.webClient.conversations.list({
					types: "public_channel,private_channel",
					exclude_archived: true,
					limit: 200,
					cursor,
				});
				const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
				if (channels) {
					for (const c of channels) {
						if (c.id && c.name && c.is_member) {
							this.channels.set(c.id, { id: c.id, name: c.name });
						}
					}
				}
				cursor = result.response_metadata?.next_cursor;
			} while (cursor);

			// Also fetch DM channels (IMs)
			cursor = undefined;
			do {
				const result = await this.webClient.conversations.list({
					types: "im",
					limit: 200,
					cursor,
				});
				const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
				if (ims) {
					for (const im of ims) {
						if (im.id) {
							const user = im.user ? this.users.get(im.user) : undefined;
							const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
							this.channels.set(im.id, { id: im.id, name });
						}
					}
				}
				cursor = result.response_metadata?.next_cursor;
			} while (cursor);
		} catch (error) {
			if (isMissingScopeError(error)) {
				log.logWarning(
					"Skipping Slack channel lookup due to missing scope",
					"Add channels:read, groups:read, and im:read to enable channel and DM names plus startup backfill.",
				);
				return;
			}
			throw error;
		}
	}
}

function isMissingScopeError(error: unknown): error is WebAPIPlatformError {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === ErrorCode.PlatformError &&
		"data" in error &&
		typeof error.data === "object" &&
		error.data !== null &&
		"error" in error.data &&
		error.data.error === "missing_scope"
	);
}

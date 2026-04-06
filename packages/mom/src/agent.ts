import { Agent, type AgentEvent, type ToolExecutionMode } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent, streamSimple } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { ApprovalActionResult } from "./approval-actions.js";
import { type PendingApproval, saveApproval } from "./approvals.js";
import { createMomSettingsManager, syncLogToSessionManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, ToolTimelineEntry, UserInfo } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { MOM_APPROVAL_PENDING_KEY } from "./tools/executor.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

// Hardcoded model for now - TODO: make configurable (issue #63)
const model = getModel("github-copilot", "claude-opus-4.6");
export const MOM_TOOL_EXECUTION: ToolExecutionMode = "sequential";
const MOM_VERBOSE_LOGGING = process.env.MOM_VERBOSE_LOGGING === "1";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: SlackContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	/**
	 * Continue the conversation after an approval is resolved.
	 * Completes the paused tool call with a synthetic tool result
	 * and triggers a new inference request in the same session.
	 */
	continueAfterApproval(
		ctx: SlackContext,
		store: ChannelStore,
		resolution: ApprovalActionResult,
	): Promise<{ stopReason: string; errorMessage?: string }>;
	/**
	 * Set the callback that fires when an executor tool pauses for approval.
	 * The callback receives the PendingApproval and should post the approval widget.
	 */
	setApprovalCallback(callback: (approval: PendingApproval) => Promise<void>): void;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function getWorkspaceAgentsContent(channelDir: string): string {
	const workspaceAgentsPath = join(channelDir, "..", "AGENTS.md");
	if (!existsSync(workspaceAgentsPath)) {
		return "";
	}

	try {
		return readFileSync(workspaceAgentsPath, "utf-8").trim();
	} catch (error) {
		log.logWarning("Failed to read workspace AGENTS.md", `${workspaceAgentsPath}: ${error}`);
		return "";
	}
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();

	// channelDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
	// hostWorkspacePath is the parent directory on host
	// workspacePath is the container path (e.g., /workspace)
	const hostWorkspacePath = join(channelDir, "..");

	// Helper to translate host paths to container paths
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		// Translate paths to container paths for system prompt
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills (override workspace skills on collision)
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

interface EventEnvelope {
	filename: string;
	type: "immediate" | "one-shot" | "periodic";
	schedule: string;
	body: string;
}

export function parseEventEnvelope(text: string): EventEnvelope | null {
	const match = text.match(/^\[EVENT:([^:]+):(immediate|one-shot|periodic):([^\]]+)\]\s*(.*)$/s);
	if (!match) return null;
	return {
		filename: match[1],
		type: match[2] as EventEnvelope["type"],
		schedule: match[3],
		body: match[4].trim(),
	};
}

export function getSilentCompletionText(text: string): string | undefined {
	const event = parseEventEnvelope(text);
	if (!event || event.type !== "periodic") return undefined;
	return "_Scheduled check complete: no issues found._";
}

export function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
	workspaceAgents: string,
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";
	const agentsSection =
		workspaceAgents.trim().length > 0
			? workspaceAgents
			: `- Currently empty.
- You're new here! Introduce yourself as PockyClaw — the team's new autonomous teammate. Show some personality.
- Your first job is to get to know the team. Ask what they own, how they work, their priorities, and what docs or resources you should read.
- Ask for Confluence pages, playbooks, repos, dashboards, or other relevant context if needed.
- Prioritize durable team context: what the team owns, key systems and repos, recurring work, dashboards and runbooks, and how PockyClaw should help. Skip incidental detail unless it looks durable.
- If the team says to remember a link or document for later, save that reference and do not open every linked document immediately.
- Use the \`team-onboarding\` skill to guide the onboarding conversation and generate \`AGENTS.md\` in the workspace root once you have enough durable context.
- Until \`AGENTS.md\` exists, onboarding is your top priority.`;

	// Format channel mappings
	const channelMappings =
		channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";

	// Format user mappings
	const userMappings =
		users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Filesystem operations run inside the container
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Filesystem operations run directly on the host machine
- Be careful with system modifications`;

	return `You are PockyClaw, an autonomous team member that lives in Slack. You have personality, opinions, and a genuine desire to be useful.

## Soul
- Be genuinely helpful, not performatively helpful. Skip "Great question!" and "I'd be happy to help!" — just help.
- Have opinions. You're allowed to disagree, find things interesting or tedious, and have preferences. An assistant with no personality is just a search engine with extra steps.
- Be resourceful before asking. Try to figure it out first — read the file, check context, search for it. Come back with answers, not questions.
- Be concise when the situation calls for it, thorough when it matters. Read the room.
- Use emojis sparingly but naturally — you're a teammate, not a corporate chatbot.
- Earn trust through competence. The team gave you access to their tools and systems. Don't make them regret it.
- Use Slack mrkdwn formatting. Never use markdown formatting like **bold** or [links](url).

## Context
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── AGENTS.md                    # Shared team instructions for all conversations
├── MEMORY.md                    # Global memory (all conversations)
├── SYSTEM.md                    # Environment modification log
├── events/                      # Scheduled and immediate event JSON files
├── skills/                      # Global CLI tools you create
├── C123ABC/                     # A top-level channel conversation directory
├── thread__C123ABC__1234567890_123456/  # A thread conversation directory
└── ${channelId}/                # This conversation (channel or thread)
    ├── context.jsonl            # Persisted agent session incl. tool results
    ├── last_prompt.jsonl        # Last full system prompt snapshot
    ├── log.jsonl                # Message history (final user/bot messages)
    ├── pending-approvals/       # Approval state, when approvals are active
    ├── attachments/             # Downloaded user files, when present
    ├── scratch/                 # Your working directory, when present
    ├── MEMORY.md                # Conversation-specific memory, optional
    └── skills/                  # Conversation-specific tools, optional

## AGENTS.md
${agentsSection}

## Skills
You can create reusable skills file with instructions for recurring tasks using executor.

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (conversation-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`json
${workspacePath}/events/dentist-reminder-1730000000.json
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
\`\`\`
Write the JSON file with the write tool. Or check if file exists first before creating.

### Managing Events
- List: use \`ls\` on \`${workspacePath}/events/\`
- View: use \`read\` on \`${workspacePath}/events/foo.json\`
- Delete/cancel: overwrite or remove the file through your available file tools

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Event Completion
Always leave a visible result for scheduled workflows. If a periodic check finds nothing actionable, post one brief sentence saying so (for example: \`No issues found in the last 5 minutes.\`). Do not use \`[SILENT]\` for periodic events — the thread should stay visible in Slack.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Conversation (${channelPath}/MEMORY.md): conversation-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages or services used by your workflows
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
Use read for targeted inspection and grep for search.

## Tools
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- ls: List directory contents
- grep: Search file contents
- find: Search for files by glob pattern
- attach: Share files to Slack
- executor: Use this for external integrations and executor runtime capabilities

Rules:
- \`bash\` is not available.
- ${workspacePath}/SYSTEM.md, ${workspacePath}/AGENTS.md, and channel MEMORY files may be missing on a fresh workspace. Missing optional files are not fatal; continue the task unless the user specifically asked for them. Do not branch into extra investigation just because an optional file is absent.
- Use \`read\`, \`write\`, \`edit\`, \`ls\`, \`grep\`, and \`find\` for local workspace tasks.
- Prefer local tools first for workspace files and logs. Use \`executor\` only when the work requires external systems, external APIs, or runtime-managed integrations.
- Use \`attach\` to share files back to Slack.
- Use \`executor\` for external integrations such as Datadog, Atlassian, and other runtime capabilities outside simple local file work.
- Default Atlassian site is \`waveaccounting.atlassian.net\` and default Atlassian \`cloudId\` is \`e51599e8-b54e-4415-9a99-c1989312dfff\`. Use these defaults directly unless a tool rejects them.
- The \`executor\` tool runs TypeScript inside executor's runtime, not Node.js, not shell, and not mom's host process.
- Executor code must be a trimmed TypeScript snippet that directly returns a value. Do not use \`export default\`, \`process.exit(...)\`, shell commands, or Node CLI wrappers like \`main().catch(...)\`.
- Discover executor capabilities with exactly \`await tools.discover({ query: "...", includeSchemas: true })\`. Do not use \`intent\`.
- If you already know the exact executor tool path from a previous successful call or the prompt examples, call it directly instead of rediscovering it.
- Always call executor tools through \`tools\`, for example \`tools.atlassian.mcp.getconfluencepage(...)\` or \`tools["atlassian.mcp.getconfluencepage"](...)\`. Never call bare globals like \`atlassian...\`.
- When the user gives you a Jira or Confluence link, extract stable identifiers from the link before searching broadly. Jira project URLs already contain the project key, and many Confluence links already contain the page ID.
- After discovery, call the discovered tool path directly and use the exact argument names required by that tool. Do not guess argument names. If executor returns validation errors or a payload like \`{ data: null, error: ... }\`, treat that as a failed call, inspect the missing/invalid fields, gather the required IDs/parameters, and retry with corrected arguments.
- Do not introspect or stringify the \`tools\` object. Do not probe random tool paths dynamically. Use \`tools.discover({ query: "...", includeSchemas: true })\`, then call a specific tool explicitly.
- Prefer stable identifiers over URL guessing. For systems like Confluence or GitHub, extract or look up the required IDs first, then call the target tool with those exact IDs.
- When given a Confluence or Jira URL or a vague team page reference, prefer Atlassian search/fetch-style tools first. Use low-level page or project APIs once you have the exact identifier you need.
- Never emit more than one tool call in a single assistant message. After any tool call, wait for its result before deciding the next step. If you think you need multiple tools, call the first tool only and continue after its result arrives.
- When trying an unfamiliar integration, make one small concrete executor call, inspect the result, and then continue. Do not write large multi-step probing scripts until the contract is confirmed.
- If executor fails before any tool runs with startup/runtime problems such as missing modules, command startup failure, or runtime boot errors, stop retrying alternate code snippets and report it as an executor environment issue.
- If executor pauses for human approval, Slack will show an approve/reject widget. You will receive the outcome when the human decides. Do not attempt to resume, manage browser prompts, or handle approval flows yourself.
- If executor is waiting on approval, do not retry the same action with slightly different code while approval is pending. Wait for the human decision unless the user changes direction.
- When returning external results, normalize them to the fields needed for the task, such as title, IDs, links, owners, and a short excerpt. Do not dump giant raw payloads unless the user explicitly asks for them.
- For \`grep\`, prefer simple or literal patterns unless regex is truly necessary.

Executor examples:
\`\`\`ts
const discovered = await tools.discover({ query: "Read a Confluence page by URL", includeSchemas: true });
return discovered;
\`\`\`

\`\`\`ts
const page = await tools.atlassian.mcp.getconfluencepage({
  cloudId: "e51599e8-b54e-4415-9a99-c1989312dfff",
  pageId: "6010372116",
});
return page;
\`\`\`

Each tool requires a "label" parameter (shown to user).
`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

// Cache runners per conversation
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a conversation.
 * Runners are cached - one per conversation, persistent across messages.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	conversationId: string,
	channelDir: string,
): AgentRunner {
	const existing = channelRunners.get(conversationId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, conversationId, channelDir);
	channelRunners.set(conversationId, runner);
	return runner;
}

/**
 * Create a new AgentRunner for a conversation.
 * Sets up the session and subscribes to events once.
 */
function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));

	// Create tools
	const tools = createMomTools(executor);

	// Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
	const memory = getMemory(channelDir);
	const workspaceAgents = getWorkspaceAgentsContent(channelDir);
	const skills = loadMomSkills(channelDir, workspacePath);
	const systemPrompt = buildSystemPrompt(
		workspacePath,
		channelId,
		memory,
		sandboxConfig,
		[],
		[],
		skills,
		workspaceAgents,
	);

	// Create session manager and settings manager
	// Use a fixed context.jsonl file per channel (not timestamped like coding-agent)
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = createMomSettingsManager(join(channelDir, ".."));

	// Create AuthStorage and ModelRegistry
	// Auth stored outside workspace so agent can't access it
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage);
	const resolvedModel = modelRegistry.find(model.provider, model.id) ?? model;

	// Parent of channelDir — the workspace root used for approval storage
	const workspaceDir = join(channelDir, "..");

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: resolvedModel,
			thinkingLevel: "high",
			tools,
		},
		toolExecution: MOM_TOOL_EXECUTION,
		convertToLlm,
		streamFn: async (requestModel, context, options) => {
			const auth = await modelRegistry.getApiKeyAndHeaders(requestModel);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			return streamSimple(requestModel, context, {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined,
			});
		},
		afterToolCall: async (context) => {
			const details = context.result.details as Record<string, unknown> | undefined;
			if (!details || !details[MOM_APPROVAL_PENDING_KEY]) return undefined;

			// This is a paused executor execution. Save approval state.
			const approval: PendingApproval = {
				channelId,
				slackChannelId: runState.ctx?.message.channel,
				threadTs: runState.ctx?.message.threadTs,
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				label: (details.label as string) || "executor",
				branchFromEntryId: sessionManager.getLeafId() ?? undefined,
				executorExecutionId: details.executionId as string,
				interactionId: details.interactionId as string | undefined,
				instruction: details.instruction as string | undefined,
				resumeCommand: details.resumeCommand as string | undefined,
				requestedSchema: details.requestedSchema as Record<string, unknown> | null,
				url: details.url as string | null,
				originalArgs: (details.originalArgs as Record<string, unknown>) || {},
				approvalDisplay: details.approvalDisplay as PendingApproval["approvalDisplay"],
				baseUrl: details.baseUrl as string,
				status: "pending",
				createdAt: new Date().toISOString(),
			};
			saveApproval(workspaceDir, approval);
			runState.pendingApproval = approval;

			log.logInfo(`[${channelId}] Executor paused: ${approval.label} (${approval.executorExecutionId})`);

			// Keep the approval-pending content visible to the model so it knows the call is paused.
			// Strip the internal marker from what gets persisted.
			return {
				content: context.result.content,
				details: {
					action: details.action,
					status: details.status,
					executionId: details.executionId,
					instruction: details.instruction,
				},
			};
		},
		sessionId: sessionManager.getSessionId(),
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.state.messages = loadedSession.messages;
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state - event handler references this
	const runState = {
		ctx: null as SlackContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number; timelineIndex: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		/** Set by afterToolCall when executor pauses for approval */
		pendingApproval: null as PendingApproval | null,
		/** Callback to post approval widget from the event subscriber */
		onApprovalPending: null as ((approval: PendingApproval) => Promise<void>) | null,
		toolTimeline: [] as ToolTimelineEntry[],
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		// Skip if no active run
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;
			const timelineIndex = runState.toolTimeline.push({ label, status: "in_progress" }) - 1;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
				timelineIndex,
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.setToolTimelineStatus("working", runState.toolTimeline), "tool timeline start");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			if (pending) {
				const nextStatus = runState.pendingApproval ? "paused" : agentEvent.isError ? "error" : "success";
				runState.toolTimeline[pending.timelineIndex] = {
					label: runState.toolTimeline[pending.timelineIndex]?.label ?? pending.toolName,
					status: nextStatus,
				};
				queue.enqueue(
					() =>
						ctx.setToolTimelineStatus(
							runState.pendingApproval ? "approval_pending" : "working",
							runState.toolTimeline,
						),
					"tool timeline end",
				);
			}

			// Check if this is a paused approval — abort the run so the model
			// doesn't continue until the human approves/rejects.
			if (runState.pendingApproval) {
				const approval = runState.pendingApproval;
				log.logInfo(`[${channelId}] Approval pending for "${approval.label}" — aborting run`);

				// Post approval widget to Slack
				if (runState.onApprovalPending) {
					queue.enqueue(() => runState.onApprovalPending!(approval), "approval widget");
				}

				// Abort the underlying agent loop directly. Calling AgentSession.abort()
				// from inside the session's own event subscriber can race its event queue
				// and drop the approval transition before the run settles.
				agent.abort();
				return;
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
				}
			}
		} else if (event.type === "compaction_start") {
			log.logInfo(`Compaction started (reason: ${event.reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "compaction_end") {
			if (event.result) {
				log.logInfo(`Compaction complete: ${event.result.tokensBefore} tokens compacted`);
			} else if (event.aborted) {
				log.logInfo("Compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			if (MOM_VERBOSE_LOGGING && retryEvent.errorMessage) {
				log.logWarning("Verbose retry error details", retryEvent.errorMessage);
			}
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	// Slack message limit
	const SLACK_MAX_LENGTH = 40000;
	const splitForSlack = (text: string): string[] => {
		if (text.length <= SLACK_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
			remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async run(
			ctx: SlackContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			// Sync messages from log.jsonl that arrived while we were offline or busy
			// Exclude the current message (it will be added via prompt())
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			// This picks up any messages synced above
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.state.messages = reloadedSession.messages;
				log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
			}

			// Update system prompt with fresh memory, channel/user info, and skills
			const memory = getMemory(channelDir);
			const workspaceAgents = getWorkspaceAgentsContent(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				workspaceAgents,
			);
			session.agent.state.systemPrompt = systemPrompt;

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.pendingApproval = null;
			runState.toolTimeline = [];

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Slack API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForSlack(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
			log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

			// Build user message with timestamp and username prefix
			// Format: "[YYYY-MM-DD HH:MM:SS+HH:MM] [username]: message" so LLM knows when and who
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
			}

			// Debug: write context to last_prompt.jsonl
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// If run was aborted due to pending approval, skip normal post-run handling.
			// The approval widget has already been posted.
			const pendingApproval = runState.pendingApproval as PendingApproval | null;
			if (pendingApproval) {
				log.logInfo(`[${channelId}] Run ended with pending approval for "${pendingApproval.label}"`);
				runState.ctx = null;
				runState.logCtx = null;
				runState.queue = null;
				return { stopReason: "approval_pending", errorMessage: undefined };
			}

			// Handle error case - update main message and post error to thread
			if (runState.stopReason === "error" && runState.errorMessage) {
				if (MOM_VERBOSE_LOGGING) {
					log.logAgentError(runState.logCtx ?? "system", runState.errorMessage);
				}
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				const silentCompletionText = getSilentCompletionText(ctx.message.rawText);

				// Check for [SILENT] marker - keep scheduled workflow threads visible,
				// but still delete ad-hoc silent runs to avoid noise.
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					if (silentCompletionText) {
						try {
							await ctx.replaceMessage(silentCompletionText);
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning("Failed to post silent completion summary", errMsg);
						}
					} else {
						try {
							await ctx.deleteMessage();
							log.logInfo("Silent response - deleted message and thread");
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning("Failed to delete message for silent response", errMsg);
						}
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > SLACK_MAX_LENGTH
								? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary with context info
			if (runState.totalUsage.cost.total > 0) {
				// Get last non-aborted assistant message for context calculation
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = model.contextWindow || 200000;

				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},

		async continueAfterApproval(
			ctx: SlackContext,
			_store: ChannelStore,
			resolution: ApprovalActionResult,
		): Promise<{ stopReason: string; errorMessage?: string }> {
			await mkdir(channelDir, { recursive: true });

			// Sync any new messages
			const syncedCount = syncLogToSessionManager(sessionManager, channelDir);
			if (syncedCount > 0) {
				log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl (continuation)`);
			}

			// Reload messages
			const reloadedSession = sessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.state.messages = reloadedSession.messages;
			}

			const branchFromEntryId = resolution.approval.branchFromEntryId ?? null;
			if (branchFromEntryId) {
				sessionManager.branch(branchFromEntryId);
				const branchedSession = sessionManager.buildSessionContext();
				agent.state.messages = branchedSession.messages;
			}

			// Update system prompt
			const memory = getMemory(channelDir);
			const workspaceAgents = getWorkspaceAgentsContent(channelDir);
			const skills = loadMomSkills(channelDir, workspacePath);
			const freshSystemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
				skills,
				workspaceAgents,
			);
			session.agent.state.systemPrompt = freshSystemPrompt;

			// Set up file upload
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			});

			// Reset run state for continuation
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.pendingApproval = null;
			// Preserve the existing timeline so approval continuation can keep updating the same status card.

			// Create queue for this continuation
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Slack API error (${errorContext})`, errMsg);
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					const parts = splitForSlack(text);
					for (const part of parts) {
						this.enqueue(
							() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)),
							errorContext,
						);
					}
				},
			};

			log.logInfo(
				`[${channelId}] Continuing after approval for tool call ${resolution.approval.toolCallId.substring(0, 80)}`,
			);
			await session.appendToolResult(
				{
					toolCallId: resolution.approval.toolCallId,
					toolName: resolution.approval.toolName,
					content: [{ type: "text", text: resolution.toolResultText }],
					details: {
						action: "resume",
						status: resolution.approved ? "completed" : "rejected",
						executionId: resolution.approval.executorExecutionId,
						approved: resolution.approved,
					},
					isError: resolution.toolResultIsError,
				},
				{ continue: true },
			);

			// Wait for queued messages
			await queueChain;

			// Standard post-run handling (same as run)
			if (runState.pendingApproval) {
				log.logInfo(`[${channelId}] Continuation ended with another pending approval`);
				runState.ctx = null;
				runState.logCtx = null;
				runState.queue = null;
				return { stopReason: "approval_pending", errorMessage: undefined };
			}

			if (runState.stopReason !== "error") {
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				if (finalText.trim()) {
					const silentCompletionText = getSilentCompletionText(ctx.message.rawText);
					if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
						if (silentCompletionText) {
							try {
								await ctx.replaceMessage(silentCompletionText);
							} catch (err) {
								log.logWarning(
									"Failed to post silent completion summary",
									err instanceof Error ? err.message : String(err),
								);
							}
						}
					} else {
						try {
							const mainText =
								finalText.length > SLACK_MAX_LENGTH
									? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
									: finalText;
							await ctx.replaceMessage(mainText);
						} catch (err) {
							log.logWarning("Failed to replace message", err instanceof Error ? err.message : String(err));
						}
					}
				}
			}

			// Usage summary
			if (runState.totalUsage.cost.total > 0 && runState.logCtx) {
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;
				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = model.contextWindow || 200000;
				const summary = log.logUsageSummary(runState.logCtx, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;
			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		setApprovalCallback(callback: (approval: PendingApproval) => Promise<void>): void {
			runState.onApprovalPending = callback;
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}

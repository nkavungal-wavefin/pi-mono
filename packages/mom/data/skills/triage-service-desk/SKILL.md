---
name: triage-service-desk
description: Triage Jira Service Desk and customer support tickets. Use when asked to look into, investigate, or resolve a Jira ticket (especially service desk or customer-reported issues). Reads the ticket, searches Confluence for a relevant playbook, presents findings, and optionally runs management commands or rake tasks with user approval.
---

# Triage Service Desk Ticket

Investigate a Jira service desk or customer issue ticket, find the relevant playbook, and resolve it.

## Workflow

### Step 1 — Read the Ticket

Use `executor` to fetch the Jira issue. Pass the issue key provided by the user (e.g. `SD-1234`, `SUPPORT-567`). DO NOT USE THE RELATED TICKET and use data from the provided ticket only. If you don't have sufficient information from the provided ticket, ask the user for more details instead of looking at related tickets.

```typescript
const issue = await tools.atlassian.mcp.getjiraissue({
  cloudId: "waveaccounting.atlassian.net",
  issueIdOrKey: "<ISSUE_KEY>",
  responseContentFormat: "markdown",
});
return issue;
```

Extract from the result:
- **Summary** and **description** (the customer's problem)
- **Status**, **priority**, **issue type**
- **Comments** (may contain additional context or prior investigation)
- **Labels** and **custom fields** (may hint at the affected product area)

If the description references other tickets, fetch those too for context.

### Step 2 — Find the Right Tool

Discover what executor tools are available for the issue. Use `tools.discover()` with the `query` parameter (NOT `intent` — that will error).

```typescript
const discovered = await tools.discover({
  query: "run a rake task to <describe what needs to happen based on the ticket>"
});
return discovered;
```

If you need to see what rake tasks exist, list them:

```typescript
const result = await tools.demo['run-rake-task']({ task: '--tasks' });
return result;
```

### Step 3 — Search for a Playbook

Search Confluence for a relevant runbook or playbook using keywords from the ticket.

```typescript
const results = await tools.atlassian.mcp.searchatlassian({
  query: "playbook <keywords from ticket summary/description>",
});
return results;
```

If Rovo search doesn't find good results, try CQL:

```typescript
const results = await tools.atlassian.mcp.searchconfluenceusingcql({
  cloudId: "waveaccounting.atlassian.net",
  cql: 'type = page AND title ~ "playbook" AND text ~ "<keyword>"',
  limit: 5,
});
return results;
```

When you find a likely playbook, read the full page:

```typescript
const page = await tools.atlassian.mcp.getconfluencepage({
  cloudId: "waveaccounting.atlassian.net",
  pageId: "<PAGE_ID>",
  contentFormat: "markdown",
});
return page;
```

### Step 4 — Present Findings

Summarize your findings to the user in this format:

```
*Ticket:* <ISSUE_KEY> — <summary>
*Status:* <status> | *Priority:* <priority>

*Problem:*
<concise description of what the customer is experiencing>

*Playbook:* <link to Confluence page if found>

*Recommended Action:*
<what the playbook says to do, or your analysis if no playbook exists>
```

If the playbook or your analysis identifies a **management command** or **rake task** that can fix the issue:

```
*Command to Run:*
`<the exact command>`

Should I run this command to resolve the issue? (yes/no)
```

Wait for user confirmation before proceeding. *Never execute a management command or rake task without explicit user approval.*

### Step 5 — Execute (Only After Approval)

If the user approves, run the command via executor.

**For rake tasks**, use `tools.demo['run-rake-task']` with the `task` parameter. Arguments to the rake task use **Ruby bracket syntax** appended to the task name — do NOT use the `args` field for positional rake arguments.

```typescript
// Correct — bracket syntax for rake task arguments:
const result = await tools.demo['run-rake-task']({
  task: 'hackathon:disable_requires_ytd[9f506719-73c0-4043-8242-4dd126b3c034]'
});
return result;

// WRONG — this will fail with "business_id is required":
// tools.demo['run-rake-task']({ task: 'hackathon:disable_requires_ytd', args: 'business_id=...' })
```

The `args` field is only for extra environment-variable-style arguments (e.g. `args: 'RAILS_ENV=production'`), not for positional rake task parameters.

For other management commands, write the appropriate executor TypeScript code based on the playbook instructions and available `tools.*` APIs.

### Step 6 — Summarize

After execution (or if no command was needed), provide a concise summary:

```
*Resolution:*
<what was done or what needs to happen next>

*Ticket:* <ISSUE_KEY>
*Playbook Used:* <link or "none found">
*Command Executed:* <command or "none">
*Result:* <outcome>
```

If the issue is resolved, suggest updating the ticket status and adding a comment:

```typescript
await tools.atlassian.mcp.addcommenttojiraissue({
  cloudId: "waveaccounting.atlassian.net",
  issueIdOrKey: "<ISSUE_KEY>",
  commentBody: "<resolution summary>",
  contentFormat: "markdown",
});
```

## Notes

- Always use `waveaccounting.atlassian.net` as the `cloudId` for Atlassian API calls
- Use `responseContentFormat: "markdown"` or `contentFormat: "markdown"` for readable output
- If no playbook is found, analyze the ticket yourself and present your best assessment
- Never run destructive commands without explicit user approval
- If the ticket mentions a specific product area (Invoicing, Payments, Payroll, Banking), include that as a search keyword when looking for playbooks

## Executor API Gotchas

- `tools.discover()` requires `query` (string), NOT `intent`. Using `intent` will error with "query: is missing"
- Do NOT call `String()` on tool objects — it causes a `toPrimitive` error
- Rake task positional arguments use bracket syntax: `task: 'name[arg1,arg2]'` — the `args` field is for env-var-style args only
- List available rake tasks with `task: '--tasks'`
- Ignore Rails deprecation warnings and constant redefinition warnings in output — they are normal noise

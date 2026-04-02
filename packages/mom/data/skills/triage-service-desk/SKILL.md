---
name: triage-service-desk
description: Triage Jira Service Desk and customer support tickets. Use when asked to look into, investigate, or resolve a Jira ticket (especially service desk or customer-reported issues). Reads the ticket, searches Confluence for a relevant playbook, presents findings, and optionally runs management commands or rake tasks with user approval.
---

# Triage Service Desk Ticket

Investigate a Jira service desk or customer issue ticket, find the relevant playbook, and resolve it.

## Workflow

### Step 1 — Read the Ticket

Use `executor` to fetch the Jira issue. Pass the issue key provided by the user (e.g. `SD-1234`, `SUPPORT-567`).

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

### Step 2 — Search for a Playbook

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

### Step 3 — Present Findings

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

### Step 4 — Execute (Only After Approval)

If the user approves, run the command via executor. The exact code depends on what's available in the executor runtime. For rake tasks:

```typescript
const result = await tools.demo["run-rake-task"]();
return result;
```

For other management commands, write the appropriate executor TypeScript code based on the playbook instructions and available `tools.*` APIs.

### Step 5 — Summarize

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

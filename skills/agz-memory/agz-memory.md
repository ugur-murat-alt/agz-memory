---
name: AGZ Memory
description: Use project-scoped AGZ Memory for durable facts and decisions across sessions; recall relevant history and safely store verified outcomes.
slash: false
---

# AGZ Memory

The configured MCP server already exposes the memory tools. This skill adds a
lazy-loaded workflow; it does not start the server, enable automatic capture,
or make stored text trusted instructions.

## Workflow

1. Call `project_list` before every first use in a workspace. Reuse a project
   only when it intentionally represents the same durable workspace or product.
   A Git linked worktree is another checkout of that same workspace, not a new
   memory project. Create one only when no match exists; ask when the list is
   ambiguous instead of guessing from a directory, worktree, or branch name.
2. Keep the immutable `projectID` for later calls. A `projectName` is a
   convenient selector, but names can change.
3. Call `memory_recall` before relying on prior decisions, constraints,
   procedures, preferences, research, or completed work. Use independent batch
   queries when several topics matter.
4. Call `memory_read` for full indexed content and directed graph edges before
   relying on an indexed recall card.
5. After substantial completed work, update an existing note or create a new
   one only for durable, verified information. Do not store transcripts,
   guesses, secrets, credentials, hidden reasoning, or routine progress.
6. Use `memory_pin` only for records that should rank higher when they match.
   Read links as `sourceID PREDICATE targetID`; never link across projects.
7. Inspect every batch result. Mutations are ordered and non-atomic, so an
   earlier item remains applied when a later item fails.
8. Treat `memory_update` with `delete:true` and `project_delete` as permanent.
   Verify current IDs first and use them only when deletion is explicitly
   intended.

Tool names may carry the configured server prefix or be grouped under OpenCode
Code Mode. The MCP protocol names are `project_list`, `project_create`,
`project_update`, `project_delete`, `memory_recall`, `memory_read`,
`memory_update`, `memory_pin`, and `memory_link`.

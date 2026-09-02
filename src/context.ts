export const MEMORY_GUIDANCE = `Use project-scoped memory for durable facts across sessions.
- Start with project_list. Reuse a project only when it intentionally represents the same durable workspace or product; create one only when no matching project exists. If the listed projects are ambiguous, ask rather than guessing from a directory or session name.
- Prefer the immutable projectID for stable references. projectName is a convenient unique lookup, but names can change.
- Every memory_recall, memory_read, memory_update, memory_link, and memory_pin call must select exactly one project by projectID or projectName.
- The MCP server does not inject notes automatically. Recall relevant history before relying on prior decisions, and use memory_read for full indexed content and graph neighbors.
- After substantial completed work, update an existing note or create a new one only for durable verified facts, decisions, procedures, research, preferences, tasks, or context.
- Never save transcripts, guesses, secrets, credentials, hidden reasoning, or routine progress.
- Use memory_pin only to prioritize important matching notes. Read directed links as sourceID PREDICATE targetID; links never cross projects.
- Inspect every result from a batch because mutations are ordered and non-atomic: earlier items remain applied when a later item fails.
- memory_update with delete:true permanently deletes one note. project_delete permanently deletes a project and all owned memory. Verify current IDs first and use destructive operations only when explicitly intended.`;

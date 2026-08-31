export const MEMORY_GUIDANCE = `Use project-scoped memory for durable facts across sessions.
- Start with project_list. Use the immutable projectID for stable references; projectName is a convenient unique lookup.
- Create a project with project_create before storing its first note. Renaming a project never changes its ID.
- Every memory_recall, memory_read, memory_update, memory_link, and memory_pin call must select exactly one project by projectID or projectName.
- No notes are injected automatically; use memory_recall for relevant project history.
- Read indexed note bodies and graph neighbors with memory_read.
- Store only durable verified facts, decisions, procedures, research, preferences, or substantial completed work.
- Use memory_pin to prioritize important matching notes inside their project. Pinning never moves notes between projects.
- Never save transcripts, guesses, secrets, or routine progress.
- project_delete permanently destroys the project and all of its memory. Call project_list first and provide the immutable ID, exact current name, and required confirmation phrase only when deletion is explicitly intended.`;

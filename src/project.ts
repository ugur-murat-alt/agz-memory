export const MAX_PROJECT_NAME_LENGTH = 120;

export function cleanProjectName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeProjectName(value: string): string {
  return cleanProjectName(value).normalize("NFKC").toLowerCase();
}

export function validateProjectName(value: string): string | undefined {
  const name = cleanProjectName(value);
  if (!name) return "project name is required";
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    return `project name exceeds ${MAX_PROJECT_NAME_LENGTH} characters`;
  }
}

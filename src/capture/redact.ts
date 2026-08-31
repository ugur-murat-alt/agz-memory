export const REDACTION_POLICY_VERSION = "redaction/1";

export interface RedactionResult {
  text: string;
  replacements: number;
  classes: Record<string, number>;
  truncated: boolean;
  quarantined: boolean;
}

interface Rule {
  name: string;
  pattern: RegExp;
  highRisk?: boolean;
}

const RULES: Rule[] = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    highRisk: true,
  },
  {
    name: "credential-uri",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
    highRisk: true,
  },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  { name: "basic-auth", pattern: /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: "secret-assignment",
    pattern: /\b(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)\s*[:=]\s*["']?[^\s,"']{8,}["']?/gi,
  },
];

export function redactText(
  value: string,
  options: { maxCharacters?: number; denylist?: readonly string[] } = {},
): RedactionResult {
  const maxCharacters = options.maxCharacters ?? Number.MAX_SAFE_INTEGER;
  let text = value;
  let replacements = 0;
  let highRisk = 0;
  const classes: Record<string, number> = {};

  for (const literal of options.denylist ?? []) {
    if (!literal) continue;
    const count = text.split(literal).length - 1;
    if (count === 0) continue;
    replacements += count;
    classes.denylist = (classes.denylist ?? 0) + count;
    text = text.replaceAll(literal, "[REDACTED:denylist]");
  }

  for (const rule of RULES) {
    text = text.replace(rule.pattern, () => {
      replacements++;
      classes[rule.name] = (classes[rule.name] ?? 0) + 1;
      if (rule.highRisk) highRisk++;
      return `[REDACTED:${rule.name}]`;
    });
  }

  text = text.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, (candidate) => {
    if (!looksHighEntropy(candidate)) return candidate;
    replacements++;
    classes.entropy = (classes.entropy ?? 0) + 1;
    return "[REDACTED:entropy]";
  });

  const truncated = text.length > maxCharacters;
  if (truncated) text = text.slice(0, maxCharacters);
  return {
    text,
    replacements,
    classes,
    truncated,
    quarantined: highRisk > 0 || replacements >= 3,
  };
}

function looksHighEntropy(value: string): boolean {
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4.1;
}

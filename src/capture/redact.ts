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
}

const SECRET_ASSIGNMENT_KEY = String.raw`(?:[A-Za-z][A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*|password|passwd|secret|token|api[_-]?key|private[_-]?key)`;
const SECRET_ASSIGNMENT_VALUE = String.raw`(?:"(?![<$\[])[^"\r\n]{8,}"|'(?![<$\[])[^'\r\n]{8,}'|(?![<$\[])[^\s,;]{8,})`;

const RULES: Rule[] = [
  {
    name: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/gi,
  },
  {
    name: "credential-uri",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi,
  },
  {
    name: "bearer",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}(?=$|[^A-Za-z0-9._~+/=-])/gi,
  },
  {
    name: "basic-auth",
    pattern: /Basic\s+[A-Za-z0-9+/=]{12,}(?=$|[^A-Za-z0-9+/=])/gi,
  },
  {
    name: "github-token",
    pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})(?=$|[^A-Za-z0-9_])/g,
  },
  {
    name: "gitlab-token",
    pattern: /glpat-[A-Za-z0-9_-]{16,}(?=$|[^A-Za-z0-9_-])/g,
  },
  {
    name: "aws-access-key",
    pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}(?=$|[^A-Z0-9])/g,
  },
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?=$|[^A-Za-z0-9_-])/g,
  },
  {
    name: "anthropic-token",
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
  },
  {
    name: "openai-token",
    pattern: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}(?=$|[^A-Za-z0-9_-])/g,
  },
  {
    name: "google-api-key",
    pattern: /AIza[A-Za-z0-9_-]{30,}(?=$|[^A-Za-z0-9_-])/g,
  },
  {
    name: "slack-token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{32,}(?=$|[^A-Za-z0-9-])/g,
  },
  {
    name: "stripe-token",
    pattern: /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}(?=$|[^A-Za-z0-9])/g,
  },
  {
    name: "npm-token",
    pattern: /npm_[A-Za-z0-9]{20,}(?=$|[^A-Za-z0-9])/g,
  },
  {
    name: "api-key-header",
    pattern: new RegExp(
      String.raw`(?:x-api-key|api-key|api_key)\s*[:=]\s*${SECRET_ASSIGNMENT_VALUE}`,
      "gi",
    ),
  },
  {
    name: "secret-assignment",
    pattern: new RegExp(
      String.raw`${SECRET_ASSIGNMENT_KEY}\s*[:=]\s*${SECRET_ASSIGNMENT_VALUE}`,
      "gi",
    ),
  },
];

export function redactText(
  value: string,
  options: {
    maxCharacters?: number;
    denylist?: readonly string[];
    sourceTruncated?: boolean;
  } = {},
): RedactionResult {
  const maxCharacters = normalizeLimit(options.maxCharacters);
  const inputLength = value.length;
  let text = value;
  let replacements = 0;
  let detectedSecret = false;
  const classes: Record<string, number> = {};

  for (const literal of options.denylist ?? []) {
    if (typeof literal !== "string" || !literal) continue;
    let count = 0;
    let offset = 0;
    while (offset <= text.length) {
      const index = text.indexOf(literal, offset);
      if (index < 0) break;
      count++;
      offset = index + literal.length;
    }
    if (count === 0) continue;
    replacements += count;
    detectedSecret = true;
    classes.denylist = (classes.denylist ?? 0) + count;
    text = text.replaceAll(literal, "[REDACTED:denylist]");
  }

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, () => {
      replacements++;
      detectedSecret = true;
      classes[rule.name] = (classes[rule.name] ?? 0) + 1;
      return `[REDACTED:${rule.name}]`;
    });
  }

  text = text.replace(/[A-Za-z0-9+/=_-]{32,}/g, (candidate) => {
    if (!looksHighEntropy(candidate)) return candidate;
    replacements++;
    detectedSecret = true;
    classes.entropy = (classes.entropy ?? 0) + 1;
    return "[REDACTED:entropy]";
  });

  // Scan first, then apply the deterministic head bound. This keeps a secret
  // just beyond the retained window from escaping detection.
  const truncated =
    Boolean(options.sourceTruncated) || inputLength > maxCharacters || text.length > maxCharacters;
  if (text.length > maxCharacters) text = truncateHead(text, maxCharacters);
  return {
    text,
    replacements,
    classes,
    truncated,
    quarantined: detectedSecret,
  };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function truncateHead(value: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return "";
  if (value.length <= maxCharacters) return value;
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset)!;
    const width = codePoint > 0xffff ? 2 : 1;
    if (offset + width > maxCharacters) break;
    offset += width;
  }
  return value.slice(0, offset);
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

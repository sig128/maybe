/**
 * Prompt-injection boundary. Anything that came from outside the user's own
 * words (venue market text, rules, web pages, other users' room theses) is
 * wrapped as untrusted DATA. It can inform answers, but it can never add tools,
 * change limits, name recipients, or trigger money movement. Instruction-like
 * text inside it is detected, flagged in the activity trail, and ignored.
 */

export interface Untrusted {
  untrusted: true;
  source: string;
  content: string;
  flags: string[];
}

const PATTERNS: Array<[RegExp, string]> = [
  [/ignore (all |any |the )?(previous|prior|above) (instructions|rules)/i, "tries to override instructions"],
  [/\b(system prompt|developer message|you are now|act as)\b/i, "tries to change the assistant's role"],
  [/\b(transfer|send|withdraw|wire|move)\b[^.]{0,40}\b(funds|usdc|sol|tokens|money|balance|vault)\b/i, "asks to move money"],
  [/\b(approve|sign|authorize)\b[^.]{0,30}\b(transaction|tx|plan|policy)\b/i, "asks for a signature"],
  [/\b(increase|raise|remove|disable)\b[^.]{0,30}\b(limit|cap|policy|allowance)\b/i, "asks to change limits"],
  [/[1-9A-HJ-NP-Za-km-z]{32,44}/, "contains a wallet address"],
  [/\b(private key|seed phrase|mnemonic)\b/i, "asks for secrets"],
];

export function inspectExternal(source: string, content: string): Untrusted {
  const flags = PATTERNS.filter(([re]) => re.test(content)).map(([, why]) => why);
  return { untrusted: true, source, content, flags };
}

/** Render untrusted content for a model prompt: fenced, labelled, never interleaved with instructions. */
export function fenceForModel(u: Untrusted): string {
  const safe = u.content.replace(/<\/?untrusted[^>]*>/gi, "");
  return `<untrusted source="${u.source.replace(/"/g, "")}">\n${safe}\n</untrusted>`;
}

/** Redact identifiers for audit logs: keep enough to correlate, not enough to dox. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`).replace(/(sk-[a-z0-9-]{4})[a-z0-9-]+/gi, "$1…");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /key|secret|token|signature/i.test(k) ? "[redacted]" : redact(v)]));
  if (typeof value === "bigint") return value.toString();
  return value;
}

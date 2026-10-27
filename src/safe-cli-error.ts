const C0_C1_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const SECRET_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i,
  /\b(?:access[\s_-]*token|refresh[\s_-]*token|id[\s_-]*token|api[\s_-]*key|client[\s_-]*secret|password|authorization[\s_-]*code|code[\s_-]*verifier)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\b[A-Za-z0-9_-]{24,}\b/,
  /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/,
  /https?:\/\/\S+/i,
] as const;

/** Return only a non-sensitive Error.message/string; stack and cause are never read or returned. */
export function safeCliErrorText(value: unknown, fallback: string, allowlistedLiterals: readonly string[] = []): string {
  const message = typeof value === "string" ? value : value instanceof Error ? value.message : null;
  if (!message?.trim()) return fallback;

  const detectionText = message
    .replace(C0_C1_CONTROLS, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
  const textForDetection = allowlistedLiterals.reduce(
    (text, literal) => literal ? text.replaceAll(literal, " ") : text,
    detectionText,
  );
  if (!textForDetection || SECRET_PATTERNS.some((pattern) => pattern.test(textForDetection))) return fallback;
  return message;
}

/** Strictly accept only diagnostic request IDs that cannot plausibly be credentials. */
export function isSafeSiwcRequestId(value: string): boolean {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return false;
  // The project's only positive fixture is req_ plus 28 lowercase hex digits; fail closed for unknown formats.
  if (!/^req_[a-f0-9]{28}$/.test(value)) return false;
  if (/(?:^|[._:-])(?:sk(?:[-_]|$)|sess(?:[-_]|$)|whsec_|github_pat_|gh[pousr]_|xox[baprs]-)/i.test(value)) return false;
  if (/^(?:bearer|token|access[_-]?token|refresh[_-]?token|id[_-]?token)/i.test(value)) return false;
  if (/(?:^|[._:-])(?:bearer|token|jwt|secret|credential|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization[_-]?code|code[_-]?verifier|password)(?:$|[._:-])/i.test(value)) return false;
  const jwtCandidate = value.replace(/^req_/i, "");
  if (/^eyJ[A-Za-z0-9_-]{8,}\./.test(jwtCandidate) || /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(jwtCandidate)) return false;
  return true;
}

/** Use the same strict filter for headers from OAuth/OIDC and the Responses API. */
export function safeSiwcRequestId(headers: Headers): string | null {
  const value = headers.get("openai-request-id") ?? headers.get("x-request-id");
  return value && isSafeSiwcRequestId(value) ? value : null;
}

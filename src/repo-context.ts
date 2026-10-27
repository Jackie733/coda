import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_ENV_KEYS = ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;

export const CONTEXT_LIMITS = Object.freeze({
  maxFiles: 6,
  maxFileBytes: 16 * 1024,
  maxTotalBytes: 24 * 1024,
  maxPathListBytes: 512 * 1024,
});

const RELEVANT_PATHS = [
  ":(top,glob)README*",
  ":(top)package.json",
  ":(top)tsconfig.json",
  ":(top)pyproject.toml",
  ":(top)go.mod",
  ":(top)Cargo.toml",
  ":(top)pom.xml",
  ":(top)build.gradle",
  ":(top)Makefile",
  ":(top)src",
  ":(top)app",
  ":(top)lib",
  ":(top)server",
  ":(top)client",
  ":(top)web",
  ":(top)api",
  ":(top)cmd",
  ":(top)internal",
  ":(top)test",
  ":(top)tests",
];

const ALLOWED_TEXT_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|c|h|cc|cpp|hpp|sh|sql|html|css|json|ya?ml|toml|xml|md)$/i;
const DENIED_DIRECTORY_NAMES = new Set([
  ".git", ".ssh", ".secrets", "secrets", "secret", "credentials", "credential",
  "private", "certs", "certificates", "keys", "key", "node_modules", "bower_components",
  ".aws", ".azure", ".config", ".docker", ".gcloud", ".gnupg", ".kube", ".terraform", "vendor", "third_party", "third-party",
  "external", "deps", "dependencies", ".pnpm-store", ".yarn", "pods", "carthage", ".gradle",
  ".venv", "venv", "site-packages", "__pycache__", "build", "dist", "out", "target",
  "coverage", "obj", ".next", ".nuxt", ".svelte-kit", ".angular", ".expo", "storybook-static",
  ".turbo", ".cache", ".parcel-cache", ".vite", ".output",
]);
const DENIED_FILE_EXTENSIONS = new Set([
  ".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der", ".jks", ".keystore",
  ".lock", ".sqlite", ".db", ".wasm", ".zip", ".gz", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".bmp", ".tif", ".tiff", ".ico", ".pdf", ".mp3", ".mp4", ".webm",
  ".mov", ".avi", ".wav", ".flac", ".woff", ".woff2", ".ttf", ".otf", ".bin", ".dat",
  ".so", ".dylib", ".dll", ".exe", ".class", ".o", ".a", ".7z", ".rar", ".tar", ".bz2", ".xz",
]);
const DENIED_FILE_NAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", "service-account.json",
  "service_account.json", "secrets.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "bun.lockb", "cargo.lock", "poetry.lock", "composer.lock", "gemfile.lock",
]);
const DISALLOWED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const LIKELY_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|token|password|passwd|pwd|secret)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[A-Za-z0-9_./+=-]+)/i,
];

export type RepositorySnapshot = Readonly<{
  root: string;
  branch: string;
  worktree: "clean" | "dirty";
  context: string;
  includedFiles: readonly string[];
  skippedCandidateFiles: number;
  contextBytes: number;
}>;

async function runGit(args: string[], cwd: string, maxBuffer: number): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
    env: {
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      ...Object.fromEntries(GIT_ENV_KEYS.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]])),
    },
  });
  return result.stdout;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function isAllowedCandidate(relativePath: string): boolean {
  if (
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(relativePath)
  ) return false;

  const segments = relativePath.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) return false;

  const lowerSegments = segments.map((part) => part.toLowerCase());
  if (lowerSegments.some((part) => DENIED_DIRECTORY_NAMES.has(part))) return false;
  if (lowerSegments.some((part) => part.startsWith(".env"))) return false;

  const basename = lowerSegments.at(-1) ?? "";
  if (DENIED_FILE_NAMES.has(basename)) return false;
  if (/(?:^|[._-])(?:secret|secrets|credential|credentials)(?:[._-]|$)/i.test(basename)) return false;
  if (DENIED_FILE_EXTENSIONS.has(path.posix.extname(basename))) return false;
  if (!ALLOWED_TEXT_FILE.test(basename)) return false;
  return true;
}

function priority(relativePath: string): number {
  const lowerPath = relativePath.toLowerCase();
  if (/^(?:src|app|lib|server|client|web|api|cmd|internal)\//.test(lowerPath)) return 0;
  if (/^(?:test|tests)\//.test(lowerPath)) return 1;
  if (!relativePath.includes("/")) return 2;
  return 3;
}

async function readSafeTextFile(root: string, relativePath: string): Promise<string | null> {
  const rootReal = root;
  const candidatePath = path.resolve(rootReal, ...relativePath.split("/"));
  if (!isWithinRoot(rootReal, candidatePath)) return null;

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidatePath);
  } catch {
    return null;
  }
  // Reject both escaping links and in-repository links: a tracked link is not needed for this prototype.
  if (!isWithinRoot(rootReal, canonicalPath) || canonicalPath !== candidatePath) return null;

  let cursor = rootReal;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }

  let handle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > CONTEXT_LIMITS.maxFileBytes) return null;

    const buffer = Buffer.alloc(CONTEXT_LIMITS.maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > CONTEXT_LIMITS.maxFileBytes) return null;
    const contentBuffer = buffer.subarray(0, bytesRead);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(contentBuffer);
    } catch {
      return null;
    }
    if (DISALLOWED_CONTROLS.test(text) || LIKELY_SECRET_PATTERNS.some((pattern) => pattern.test(text))) return null;
    return text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function formatFile(relativePath: string, text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  if (lines.length === 0) lines.push("");
  const digits = String(lines.length).length;
  const numberedLines = lines.map((line, index) => `${String(index + 1).padStart(digits, " ")} | ${line}`);
  return `File ${JSON.stringify(relativePath)}\n${numberedLines.join("\n")}`;
}

async function collectContext(root: string, trackedPaths: string[]): Promise<Pick<RepositorySnapshot, "context" | "includedFiles" | "skippedCandidateFiles" | "contextBytes">> {
  const candidates = [...new Set(trackedPaths)]
    .filter(isAllowedCandidate)
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
  const blocks: string[] = [];
  const includedFiles: string[] = [];
  let skippedCandidateFiles = 0;

  for (const relativePath of candidates) {
    if (includedFiles.length >= CONTEXT_LIMITS.maxFiles) {
      skippedCandidateFiles += 1;
      continue;
    }
    const text = await readSafeTextFile(root, relativePath);
    if (text === null) {
      skippedCandidateFiles += 1;
      continue;
    }
    const block = formatFile(relativePath, text);
    const candidateContext = [...blocks, block].join("\n\n");
    const candidateBytes = Buffer.byteLength(candidateContext, "utf8");
    if (candidateBytes > CONTEXT_LIMITS.maxTotalBytes) {
      skippedCandidateFiles += 1;
      continue;
    }
    blocks.push(block);
    includedFiles.push(relativePath);
  }

  const context = blocks.join("\n\n");
  return {
    context,
    includedFiles: Object.freeze(includedFiles),
    skippedCandidateFiles,
    contextBytes: Buffer.byteLength(context, "utf8"),
  };
}

export async function inspectRepository(cwd = process.cwd()): Promise<RepositorySnapshot> {
  const cwdReal = await realpath(cwd);
  const rootFromGit = (await runGit(["rev-parse", "--show-toplevel"], cwdReal, 64 * 1024)).trim();
  if (!rootFromGit) throw new Error("Git did not return a repository root.");
  const root = await realpath(rootFromGit);
  if (!path.isAbsolute(root)) throw new Error("Git returned a non-absolute repository root.");

  const branchName = (await runGit(["branch", "--show-current"], root, 64 * 1024)).trim();
  const branch = branchName || `detached@${(await runGit(["rev-parse", "--short", "HEAD"], root, 64 * 1024)).trim()}`;
  const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], root, 2 * 1024 * 1024);
  const worktree = status.length === 0 ? "clean" : "dirty";

  // Query only common, explicitly relevant project paths; never walk the filesystem or read untracked files.
  const trackedOutput = await runGit(["ls-files", "--cached", "-z", "--", ...RELEVANT_PATHS], root, CONTEXT_LIMITS.maxPathListBytes);
  const trackedPaths = trackedOutput.split("\0").filter(Boolean);
  const collected = await collectContext(root, trackedPaths);

  return Object.freeze({
    root,
    branch,
    worktree,
    ...collected,
  });
}

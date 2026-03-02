/**
 * Project file discovery with .gitignore support.
 * Walks the project tree, respects .gitignore, and filters to JS/TS files.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, extname } from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ignore from "ignore";

const execFileAsync = promisify(execFile);

export interface WalkOptions {
  projectRoot: string;
  extensions?: string[];      // default: JS/TS extensions
  maxFileSize?: number;       // default 100KB
  excludeDirs?: string[];     // additional dirs to skip
  includePaths?: string[];    // glob patterns to include
  excludePaths?: string[];    // glob patterns to exclude
}

export interface WalkedFile {
  absolutePath: string;
  relativePath: string;
  language: string;
  sizeBytes: number;
}

const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".d.ts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
};

const DEFAULT_EXTENSIONS = Object.keys(EXTENSION_MAP);

const ALWAYS_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".output", "coverage", ".claude", ".venv", "vendor", "target",
  "__pycache__", ".svelte-kit", ".turbo", ".cache",
]);

const DEFAULT_MAX_FILE_SIZE = 100 * 1024; // 100KB

export function detectLanguage(fileName: string): string | null {
  // Check compound extensions first (e.g., .d.ts)
  if (fileName.toLowerCase().endsWith(".d.ts")) return "typescript";
  const ext = extname(fileName).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

export function computeContentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function computeFileHash(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return computeContentHash(content);
}

export async function walkProjectFiles(options: WalkOptions): Promise<WalkedFile[]> {
  const {
    projectRoot,
    extensions = DEFAULT_EXTENSIONS,
    maxFileSize = DEFAULT_MAX_FILE_SIZE,
    excludeDirs = [],
    includePaths,
    excludePaths,
  } = options;

  const extSet = new Set(extensions.map(e => e.startsWith(".") ? e : `.${e}`));
  const skipDirs = new Set([...ALWAYS_SKIP_DIRS, ...excludeDirs]);

  // Load .gitignore
  const ig = ignore();
  const gitignorePath = join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const gitignoreContent = await readFile(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }

  // Add user exclude patterns
  if (excludePaths?.length) {
    ig.add(excludePaths);
  }

  // Build include filter if specified
  const includeIg = includePaths?.length ? ignore().add(includePaths) : null;

  const results: WalkedFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(projectRoot, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (ig.ignores(relPath + "/")) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!extSet.has(ext)) continue;
        if (ig.ignores(relPath)) continue;
        if (includeIg && !includeIg.ignores(relPath)) continue;

        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > maxFileSize) continue;
          if (fileStat.size === 0) continue;

          const language = detectLanguage(entry.name);
          if (!language) continue;

          results.push({
            absolutePath: fullPath,
            relativePath: relPath,
            language,
            sizeBytes: fileStat.size,
          });
        } catch {
          // skip files we can't stat
        }
      }
    }
  }

  await walk(projectRoot);
  return results;
}

// --- Git-diff change detection ---

export interface GitChanges {
  modified: string[];     // changed since lastCommit
  added: string[];        // new untracked files
  deleted: string[];      // removed files
  lastCommit: string;     // current HEAD SHA
  isGitRepo: boolean;
}

/**
 * Detect changed files using git. Much faster than hashing every file.
 * Falls back gracefully for non-git directories or missing sinceCommit.
 */
export async function getGitChangedFiles(
  projectRoot: string,
  sinceCommit?: string
): Promise<GitChanges> {
  // Check if this is a git repo
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: projectRoot });
  } catch {
    return { modified: [], added: [], deleted: [], lastCommit: "", isGitRepo: false };
  }

  // Get current HEAD SHA
  let lastCommit: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot });
    lastCommit = stdout.trim();
  } catch {
    return { modified: [], added: [], deleted: [], lastCommit: "", isGitRepo: true };
  }

  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];

  // Get tracked changes since sinceCommit
  if (sinceCommit) {
    try {
      // Verify sinceCommit exists (may be gone after rebase/force-push)
      await execFileAsync("git", ["cat-file", "-t", sinceCommit], { cwd: projectRoot });

      const { stdout } = await execFileAsync(
        "git", ["diff", "--name-status", sinceCommit, "HEAD"],
        { cwd: projectRoot }
      );

      for (const line of stdout.trim().split("\n")) {
        if (!line) continue;
        const [status, ...rest] = line.split("\t");
        const filePath = rest.join("\t"); // handle paths with tabs
        if (!filePath) continue;

        const normalized = filePath.replace(/\\/g, "/");
        if (status === "D") {
          deleted.push(normalized);
        } else if (status === "A") {
          added.push(normalized);
        } else {
          modified.push(normalized); // M, R, C, etc.
        }
      }
    } catch {
      // sinceCommit is invalid — caller should fall back to hash-based
      return { modified: [], added: [], deleted: [], lastCommit, isGitRepo: true };
    }
  }

  // Get working tree changes (unstaged + staged + untracked)
  try {
    const { stdout } = await execFileAsync(
      "git", ["status", "--porcelain", "--no-renames"],
      { cwd: projectRoot }
    );

    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const filePath = line.slice(3).replace(/\\/g, "/");

      if (xy === "??") {
        // Untracked — only add if not already in added list
        if (!added.includes(filePath)) added.push(filePath);
      } else if (xy.includes("D")) {
        if (!deleted.includes(filePath)) deleted.push(filePath);
      } else {
        if (!modified.includes(filePath)) modified.push(filePath);
      }
    }
  } catch {
    // git status failed — non-fatal
  }

  return { modified, added, deleted, lastCommit, isGitRepo: true };
}

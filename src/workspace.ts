/**
 * Monorepo detection, pnpm workspace parsing, and dependency collection.
 * No external YAML library — uses simple line-by-line parsing.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { glob } from "node:fs/promises";
import type { Dependency, AnalyzeResult } from "./types.js";

export interface MonorepoInfo {
  isMonorepo: boolean;
  type?: "pnpm" | "npm" | "yarn";
  workspacePatterns: string[];
  catalog: Record<string, string>;
}

/**
 * Detect whether the project root is a monorepo.
 * Checks for pnpm-workspace.yaml and package.json workspaces field.
 */
export async function detectMonorepo(root: string): Promise<MonorepoInfo> {
  // Check pnpm-workspace.yaml first
  const pnpmWsPath = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmWsPath)) {
    const content = await readFile(pnpmWsPath, "utf-8");
    const parsed = parsePnpmWorkspace(content);
    return {
      isMonorepo: true,
      type: "pnpm",
      workspacePatterns: parsed.packages,
      catalog: parsed.catalog,
    };
  }

  // Check package.json workspaces
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.workspaces) {
        const patterns: string[] = Array.isArray(pkg.workspaces)
          ? pkg.workspaces
          : pkg.workspaces.packages ?? [];
        if (patterns.length > 0) {
          return {
            isMonorepo: true,
            type: pkg.workspaces ? "npm" : "yarn",
            workspacePatterns: patterns,
            catalog: {},
          };
        }
      }
    } catch {
      // Invalid package.json, treat as non-monorepo
    }
  }

  return { isMonorepo: false, workspacePatterns: [], catalog: {} };
}

/**
 * Parse pnpm-workspace.yaml without a YAML library.
 * Extracts `packages:` glob patterns and `catalog:` version map.
 */
export function parsePnpmWorkspace(content: string): {
  packages: string[];
  catalog: Record<string, string>;
} {
  const packages: string[] = [];
  const catalog: Record<string, string> = {};

  const lines = content.split("\n");
  let section: "none" | "packages" | "catalog" = "none";
  let catalogKey = ""; // for nested catalog like "catalog:" at top level

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Detect top-level sections
    if (/^packages\s*:/.test(line)) {
      section = "packages";
      continue;
    }
    if (/^catalog\s*:/.test(line)) {
      section = "catalog";
      continue;
    }
    // Any other top-level key ends the current section
    if (/^\S/.test(line) && line.trim().length > 0) {
      section = "none";
      continue;
    }

    if (section === "packages") {
      // Lines like: - "apps/*" or - 'packages/*' or - packages/*
      const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
      if (match) {
        packages.push(match[1].trim());
      }
    }

    if (section === "catalog") {
      // Lines like:   react: "^18.0.0" or   react: ^18.0.0
      const match = line.match(/^\s+(['"]?)([@\w\/-]+)\1\s*:\s*['"]?([^'"#]+)['"]?\s*$/);
      if (match) {
        catalog[match[2].trim()] = match[3].trim();
      }
    }
  }

  return { packages, catalog };
}

/**
 * Expand workspace glob patterns into actual package.json paths.
 */
export async function resolveWorkspacePackageJsonPaths(
  root: string,
  patterns: string[]
): Promise<string[]> {
  const paths: string[] = [];

  for (const pattern of patterns) {
    // Pattern like "apps/*" or "packages/*" — look for package.json in each match
    const globPattern = pattern.endsWith("/")
      ? `${pattern}*/package.json`
      : `${pattern}/package.json`;

    try {
      for await (const entry of glob(globPattern, { cwd: root })) {
        const fullPath = resolve(root, String(entry));
        if (existsSync(fullPath)) {
          paths.push(fullPath);
        }
      }
    } catch {
      // Pattern didn't match anything, skip
    }
  }

  // Always include root package.json
  const rootPkg = join(root, "package.json");
  if (existsSync(rootPkg) && !paths.includes(rootPkg)) {
    paths.unshift(rootPkg);
  }

  return paths;
}

/**
 * Collect all dependencies from multiple package.json files.
 * Resolves `catalog:` versions, skips `workspace:*` internal deps, deduplicates.
 */
export async function collectAllDependencies(
  packageJsonPaths: string[],
  catalog: Record<string, string>
): Promise<{ deps: Dependency[]; internalPackages: string[] }> {
  const seen = new Map<string, Dependency>();
  const internalPackages: string[] = [];

  // First pass: collect internal package names
  for (const pkgPath of packageJsonPaths) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.name) {
        internalPackages.push(pkg.name);
      }
    } catch {
      // Skip unreadable files
    }
  }

  const internalSet = new Set(internalPackages);

  // Second pass: collect dependencies
  for (const pkgPath of packageJsonPaths) {
    try {
      const raw = await readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);

      const addDeps = (deps: Record<string, string>, kind: "runtime" | "dev") => {
        for (const [name, rawVersion] of Object.entries(deps)) {
          // Skip workspace-internal deps
          if (internalSet.has(name)) continue;
          if (typeof rawVersion !== "string") continue;

          let version = rawVersion;

          // Resolve catalog: references
          if (version === "catalog:" || version === "catalog:default") {
            version = catalog[name] ?? version;
          } else if (version.startsWith("catalog:")) {
            // Named catalog like "catalog:react18"
            const catalogName = version.slice("catalog:".length);
            version = catalog[catalogName] ?? catalog[name] ?? version;
          }

          // Skip workspace protocol
          if (version.startsWith("workspace:")) continue;

          // Deduplicate: runtime wins over dev
          const existing = seen.get(name);
          if (!existing || (existing.kind === "dev" && kind === "runtime")) {
            seen.set(name, { name, version, kind });
          }
        }
      };

      addDeps(pkg.dependencies ?? {}, "runtime");
      addDeps(pkg.devDependencies ?? {}, "dev");
    } catch {
      // Skip unreadable files
    }
  }

  return {
    deps: Array.from(seen.values()),
    internalPackages,
  };
}

/**
 * Full monorepo-aware dependency analysis.
 */
export async function analyzeDependencies(root: string): Promise<AnalyzeResult> {
  const mono = await detectMonorepo(root);

  if (mono.isMonorepo) {
    const pkgPaths = await resolveWorkspacePackageJsonPaths(root, mono.workspacePatterns);
    const { deps, internalPackages } = await collectAllDependencies(pkgPaths, mono.catalog);

    return {
      dependencies: deps,
      isMonorepo: true,
      workspacePackages: internalPackages,
    };
  }

  // Single package.json
  const pkgPath = join(root, "package.json");
  const { deps } = await collectAllDependencies([pkgPath], {});

  return {
    dependencies: deps,
    isMonorepo: false,
  };
}

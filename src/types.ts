export interface Dependency {
  name: string;
  version: string;
  kind: "runtime" | "dev";
}

export interface AnalyzeResult {
  dependencies: Dependency[];
  isMonorepo: boolean;
  workspacePackages?: string[];
}

export interface LibraryMetadata {
  library: string;
  version: string;
  sourceUrl: string;
  fetchedAt: string;
  chunkCount: number;
}

export interface DocMetadata {
  libraries: LibraryMetadata[];
}

export interface SearchResult {
  score: number;
  library: string;
  headingPath: string[];
  content: string;
  chunkId: number;
}

/** Shape of a row stored in LanceDB */
export interface DocRow {
  id: number;
  library: string;
  headingPath: string;       // JSON-stringified string[]
  text: string;
  vector: number[];
}

// --- Codebase indexing types ---

export type CodeEntityType =
  | "function" | "class" | "method" | "interface"
  | "type_alias" | "enum" | "import" | "variable" | "module" | "namespace" | "other";

/** Shape of a code chunk row stored in LanceDB "code" table */
export interface CodeRow {
  id: number;
  filePath: string;          // relative to project root
  language: string;          // "typescript" | "javascript"
  entityType: CodeEntityType;
  entityName: string;        // function/class name or "" for module-level
  signature: string;         // full signature line
  scopeChain: string;        // JSON-stringified string[] e.g. ["MyClass", "myMethod"]
  lineStart: number;         // 1-based
  lineEnd: number;           // 1-based
  jsdoc: string;             // extracted JSDoc text, "" if none
  decorators: string;        // JSON-stringified string[] of decorator names
  isExported: boolean;
  isAsync: boolean;
  isAbstract: boolean;
  text: string;              // contextual header + code
  vector: number[];          // code embedding vector
}

export interface CodeSearchResult {
  score: number;
  filePath: string;
  language: string;
  entityType: CodeEntityType;
  entityName: string;
  signature: string;
  scopeChain: string[];
  lineStart: number;
  lineEnd: number;
  content: string;
  chunkId: number;
}

export interface IndexedFileMetadata {
  filePath: string;
  sha256: string;
  language: string;
  chunkCount: number;
  indexedAt: string;
}

export interface CodeMetadata {
  projectRoot: string;
  files: IndexedFileMetadata[];
  lastFullIndexAt?: string;
  schemaVersion?: number;      // 1=original, 2=with JSDoc/decorators/flags + Qodo-Embed
  lastIndexedCommit?: string;  // HEAD SHA at last index — for git-diff optimization
}

/** Escape a string for use in LanceDB SQL filter expressions. */
export function sqlEscapeString(value: string): string {
  return value.replace(/'/g, "''");
}

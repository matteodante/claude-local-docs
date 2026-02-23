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

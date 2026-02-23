import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { DocRow, DocMetadata, LibraryMetadata } from "./types.js";

// Lazy-loaded LanceDB connection
let dbInstance: any = null;
let tableInstance: any = null;

export class DocStore {
  private docsDir: string;
  private dbPath: string;
  private metadataPath: string;
  private rawDir: string;
  private metadata: DocMetadata | null = null;
  private nextId: number = 1;

  constructor(projectRoot: string) {
    this.docsDir = join(projectRoot, ".claude", "docs");
    this.dbPath = join(this.docsDir, "lancedb");
    this.metadataPath = join(this.docsDir, ".metadata.json");
    this.rawDir = join(this.docsDir, "raw");
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.rawDir, { recursive: true });
  }

  private async getTable(): Promise<any> {
    if (tableInstance) return tableInstance;
    const lancedb = await import("@lancedb/lancedb");
    dbInstance = await lancedb.connect(this.dbPath);

    try {
      tableInstance = await dbInstance.openTable("docs");
      // Find max existing ID
      const rows = await tableInstance.query().select(["id"]).toArray();
      if (rows.length > 0) {
        this.nextId = Math.max(...rows.map((r: any) => r.id)) + 1;
      }
    } catch {
      // Table doesn't exist yet — will be created on first insert
      tableInstance = null;
    }
    return tableInstance;
  }

  async loadMetadata(): Promise<DocMetadata> {
    if (this.metadata) return this.metadata;
    try {
      const data = await readFile(this.metadataPath, "utf-8");
      this.metadata = JSON.parse(data) as DocMetadata;
    } catch {
      this.metadata = { libraries: [] };
    }
    return this.metadata;
  }

  private async saveMetadata(metadata: DocMetadata): Promise<void> {
    await this.ensureDir();
    this.metadata = metadata;
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2));
  }

  async saveRawDoc(library: string, content: string): Promise<void> {
    await this.ensureDir();
    const safeName = library.replace(/\//g, "__").replace(/@/g, "");
    await writeFile(join(this.rawDir, `${safeName}.md`), content, "utf-8");
  }

  async addLibrary(
    library: string,
    version: string,
    sourceUrl: string,
    chunks: Omit<DocRow, "id">[]
  ): Promise<{ chunkCount: number; indexSize: number }> {
    await this.ensureDir();
    const lancedb = await import("@lancedb/lancedb");

    if (!dbInstance) {
      dbInstance = await lancedb.connect(this.dbPath);
    }

    // Assign IDs
    const rows: DocRow[] = chunks.map((chunk) => ({
      ...chunk,
      id: this.nextId++,
    }));

    // Get or create table
    let table = await this.getTable();
    if (table) {
      // Delete existing rows for this library, then add new ones
      await table.delete(`library = '${library.replace(/'/g, "''")}'`);
      if (rows.length > 0) {
        await table.add(rows);
      }
    } else {
      // Create table with first batch of rows
      if (rows.length > 0) {
        table = await dbInstance.createTable("docs", rows);
        tableInstance = table;
      }
    }

    // Update metadata
    const metadata = await this.loadMetadata();
    const existing = metadata.libraries.findIndex((l) => l.library === library);
    const libMeta: LibraryMetadata = {
      library,
      version,
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      chunkCount: rows.length,
    };
    if (existing >= 0) {
      metadata.libraries[existing] = libMeta;
    } else {
      metadata.libraries.push(libMeta);
    }
    await this.saveMetadata(metadata);

    // Rebuild FTS index after adding new rows
    await this.createFtsIndex();

    // Count total rows
    const totalRows = table
      ? (await table.countRows())
      : 0;

    return {
      chunkCount: rows.length,
      indexSize: totalRows,
    };
  }

  /** Vector search using LanceDB native search. Returns rows with _distance. */
  async vectorSearch(
    queryVector: number[],
    limit: number,
    library?: string
  ): Promise<(DocRow & { _distance?: number })[]> {
    const table = await this.getTable();
    if (!table) return [];

    let query = table.vectorSearch(queryVector).limit(limit);
    if (library) {
      query = query.where(`library = '${library.replace(/'/g, "''")}'`);
    }
    return await query.toArray();
  }

  /** Get chunks by library or all chunks (for list/section tools). */
  async getChunks(library?: string): Promise<DocRow[]> {
    const table = await this.getTable();
    if (!table) return [];

    let query = table.query();
    if (library) {
      query = query.where(`library = '${library.replace(/'/g, "''")}'`);
    }
    return await query.toArray();
  }

  async getChunkById(chunkId: number): Promise<DocRow | undefined> {
    const table = await this.getTable();
    if (!table) return undefined;

    const rows = await table.query().where(`id = ${chunkId}`).toArray();
    return rows[0];
  }

  async getChunksByHeading(
    library: string,
    heading: string
  ): Promise<DocRow[]> {
    // LanceDB string filtering doesn't support LIKE on JSON, so we filter in JS
    const chunks = await this.getChunks(library);
    const lowerHeading = heading.toLowerCase();
    return chunks.filter((c: DocRow) => {
      const path = JSON.parse(c.headingPath) as string[];
      return path.some((h) => h.toLowerCase().includes(lowerHeading));
    });
  }

  /** Create BM25 full-text search index on the text column. Safe to call repeatedly (replace=true). */
  async createFtsIndex(): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    const lancedb = await import("@lancedb/lancedb");
    await table.createIndex("text", {
      config: lancedb.Index.fts({ stem: true, lowercase: true, removeStopWords: true }),
      replace: true,
    });
  }

  /** BM25 full-text search using LanceDB native FTS index. */
  async ftsSearch(query: string, limit: number, library?: string): Promise<DocRow[]> {
    const table = await this.getTable();
    if (!table) return [];
    try {
      let q = table.query().fullTextSearch(query, { columns: ["text"] }).limit(limit);
      if (library) {
        q = q.where(`library = '${library.replace(/'/g, "''")}'`);
      }
      return await q.toArray();
    } catch {
      // FTS index doesn't exist yet (first search before any docs indexed)
      return [];
    }
  }

  async isEmpty(): Promise<boolean> {
    const table = await this.getTable();
    return !table;
  }

  getDocsDir(): string {
    return this.docsDir;
  }
}

/** Resolve the project root: walk up from cwd until we find a package.json */
export function resolveProjectRoot(startDir?: string): string {
  let dir = startDir ?? process.cwd();
  while (true) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return startDir ?? process.cwd();
}

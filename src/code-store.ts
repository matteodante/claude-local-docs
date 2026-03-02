/**
 * LanceDB "code" table management for codebase indexing.
 * Follows the same patterns as src/store.ts (DocStore) but operates
 * on per-file code chunks instead of per-library doc chunks.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { sqlEscapeString } from "./types.js";
import type { CodeRow, CodeMetadata, IndexedFileMetadata } from "./types.js";

export class CodeStore {
  private docsDir: string;
  private dbPath: string;
  private metadataPath: string;
  private metadata: CodeMetadata | null = null;
  private nextId: number = 1;
  private projectRoot: string;
  private dbInstance: any = null;
  private tableInstance: any = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.docsDir = join(projectRoot, ".claude", "docs");
    this.dbPath = join(this.docsDir, "lancedb");
    this.metadataPath = join(this.docsDir, ".code-metadata.json");
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.docsDir, { recursive: true });
  }

  private static readonly CURRENT_SCHEMA_VERSION = 2;

  private async getTable(): Promise<any> {
    if (this.tableInstance) return this.tableInstance;
    const lancedb = await import("@lancedb/lancedb");

    if (!this.dbInstance) {
      this.dbInstance = await lancedb.connect(this.dbPath);
    }

    // Check schema version — drop old table if outdated
    const metadata = await this.loadMetadata();
    if (metadata.files.length > 0 && (metadata.schemaVersion ?? 1) < CodeStore.CURRENT_SCHEMA_VERSION) {
      try {
        await this.dbInstance.dropTable("code");
      } catch { /* table may not exist */ }
      this.tableInstance = null;
      // Clear files list to force full reindex
      metadata.files = [];
      metadata.schemaVersion = CodeStore.CURRENT_SCHEMA_VERSION;
      await this.saveMetadata(metadata);
      return null;
    }

    try {
      this.tableInstance = await this.dbInstance.openTable("code");
      // Find max existing ID
      const rows = await this.tableInstance.query().select(["id"]).toArray();
      if (rows.length > 0) {
        this.nextId = Math.max(...rows.map((r: any) => r.id)) + 1;
      }
    } catch {
      // Table doesn't exist yet — will be created on first insert
      this.tableInstance = null;
    }
    return this.tableInstance;
  }

  async addFile(
    filePath: string,
    language: string,
    sha256: string,
    chunks: Omit<CodeRow, "id">[],
    options?: { skipMetadataSave?: boolean }
  ): Promise<{ chunkCount: number; indexSize: number }> {
    await this.ensureDir();
    const lancedb = await import("@lancedb/lancedb");

    if (!this.dbInstance) {
      this.dbInstance = await lancedb.connect(this.dbPath);
    }

    // Get or create table (before assigning IDs so nextId is up-to-date)
    let table = await this.getTable();

    // Assign IDs
    const rows: CodeRow[] = chunks.map((chunk) => ({
      ...chunk,
      id: this.nextId++,
    }));

    if (table) {
      // Delete existing rows for this file, then add new ones
      await table.delete(`"filePath" = '${sqlEscapeString(filePath)}'`);
      if (rows.length > 0) {
        await table.add(rows);
      }
    } else {
      // Create table with first batch of rows
      if (rows.length > 0) {
        table = await this.dbInstance.createTable("code", rows);
        this.tableInstance = table;
      }
    }

    // Update file metadata
    const metadata = await this.loadMetadata();
    const existing = metadata.files.findIndex(f => f.filePath === filePath);
    const fileMeta: IndexedFileMetadata = {
      filePath,
      sha256,
      language,
      chunkCount: rows.length,
      indexedAt: new Date().toISOString(),
    };
    if (existing >= 0) {
      metadata.files[existing] = fileMeta;
    } else {
      metadata.files.push(fileMeta);
    }
    if (!options?.skipMetadataSave) {
      await this.saveMetadata(metadata);
    }

    const totalRows = table ? (await table.countRows()) : 0;
    return { chunkCount: rows.length, indexSize: totalRows };
  }

  async removeFile(filePath: string): Promise<void> {
    const table = await this.getTable();
    if (table) {
      await table.delete(`"filePath" = '${sqlEscapeString(filePath)}'`);
    }

    const metadata = await this.loadMetadata();
    metadata.files = metadata.files.filter(f => f.filePath !== filePath);
    await this.saveMetadata(metadata);
  }

  async removeStaleFiles(currentFiles: Set<string>): Promise<string[]> {
    const metadata = await this.loadMetadata();
    const stale = metadata.files.filter(f => !currentFiles.has(f.filePath));

    const table = await this.getTable();
    if (table && stale.length > 0) {
      const escaped = stale.map(f => `'${sqlEscapeString(f.filePath)}'`).join(", ");
      await table.delete(`"filePath" IN (${escaped})`);
    }

    if (stale.length > 0) {
      metadata.files = metadata.files.filter(f => currentFiles.has(f.filePath));
      await this.saveMetadata(metadata);
    }

    return stale.map(f => f.filePath);
  }

  async vectorSearch(
    queryVector: number[],
    limit: number,
    filter?: string
  ): Promise<(CodeRow & { _distance?: number })[]> {
    const table = await this.getTable();
    if (!table) return [];

    let query = table.vectorSearch(queryVector).limit(limit);
    if (filter) {
      query = query.where(filter);
    }
    return await query.toArray();
  }

  async ftsSearch(query: string, limit: number, filter?: string): Promise<CodeRow[]> {
    const table = await this.getTable();
    if (!table) return [];
    try {
      let q = table.query().fullTextSearch(query, { columns: ["text"] }).limit(limit);
      if (filter) {
        q = q.where(filter);
      }
      return await q.toArray();
    } catch {
      return [];
    }
  }

  async createFtsIndex(): Promise<void> {
    const table = await this.getTable();
    if (!table) return;
    const lancedb = await import("@lancedb/lancedb");
    await table.createIndex("text", {
      config: lancedb.Index.fts({ stem: true, lowercase: true, removeStopWords: true }),
      replace: true,
    });
  }

  async loadMetadata(): Promise<CodeMetadata> {
    if (this.metadata) return this.metadata;
    try {
      const data = await readFile(this.metadataPath, "utf-8");
      this.metadata = JSON.parse(data) as CodeMetadata;
    } catch {
      this.metadata = { projectRoot: this.projectRoot, files: [], schemaVersion: CodeStore.CURRENT_SCHEMA_VERSION };
    }
    return this.metadata;
  }

  async saveMetadata(metadata: CodeMetadata): Promise<void> {
    await this.ensureDir();
    this.metadata = metadata;
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2));
  }

  async getFileHash(filePath: string): Promise<string | undefined> {
    const metadata = await this.loadMetadata();
    return metadata.files.find(f => f.filePath === filePath)?.sha256;
  }

  async getChunkById(chunkId: number): Promise<CodeRow | undefined> {
    const table = await this.getTable();
    if (!table) return undefined;
    const rows = await table.query().where(`id = ${chunkId}`).toArray();
    return rows[0];
  }

  /**
   * Drop the "code" table and clear file metadata.
   * Used by forceReindex to ensure the table is recreated with the correct vector dimension.
   */
  async dropTable(): Promise<void> {
    const lancedb = await import("@lancedb/lancedb");
    if (!this.dbInstance) {
      await this.ensureDir();
      this.dbInstance = await lancedb.connect(this.dbPath);
    }
    try {
      await this.dbInstance.dropTable("code");
    } catch { /* table may not exist */ }
    this.tableInstance = null;
    this.nextId = 1;
    const metadata = await this.loadMetadata();
    metadata.files = [];
    metadata.schemaVersion = CodeStore.CURRENT_SCHEMA_VERSION;
    await this.saveMetadata(metadata);
  }

  async isEmpty(): Promise<boolean> {
    const table = await this.getTable();
    return !table;
  }

  getDocsDir(): string {
    return this.docsDir;
  }
}

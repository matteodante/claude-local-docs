/**
 * AST-based code chunking via web-tree-sitter + code embedding.
 * Parses JS/TS files into function/class/method-level chunks with contextual headers.
 * Extracts JSDoc, decorators, and metadata flags (exported, async, abstract).
 */

import type { CodeRow, CodeEntityType } from "./types.js";
import { codeEmbedClient, truncateAndNormalize } from "./tei-client.js";
import { extractScriptBlocks } from "./sfc-extractor.js";

const CODE_EMBED_DIM = 1536;
// Qodo-Embed-1-1.5B: no explicit prefix needed (TEI handles internally)

// --- Tree-sitter lazy init ---

let Parser: any = null;
const languageCache = new Map<string, any>();

async function initParser(): Promise<any> {
  if (Parser) return Parser;
  const TreeSitter = await import("web-tree-sitter");
  await TreeSitter.default.init();
  Parser = TreeSitter.default;
  return Parser;
}

async function getLanguage(lang: string): Promise<any> {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const P = await initParser();

  // tree-sitter-wasms provides pre-built WASM grammars
  const wasmMap: Record<string, string> = {
    typescript: "tree-sitter-typescript.wasm",
    javascript: "tree-sitter-javascript.wasm",
  };

  const wasmFile = wasmMap[lang];
  if (!wasmFile) throw new Error(`Unsupported language: ${lang}`);

  // Resolve WASM path from tree-sitter-wasms package
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  // tsx files use typescript grammar
  const wasmPath = require.resolve(`tree-sitter-wasms/out/${wasmFile}`);

  const language = await P.Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

// --- Entity extraction ---

interface ExtractedEntity {
  type: CodeEntityType;
  name: string;
  signature: string;
  scopeChain: string[];
  lineStart: number; // 1-based
  lineEnd: number;   // 1-based
  text: string;
  jsdoc: string;
  decorators: string[];
  isExported: boolean;
  isAsync: boolean;
  isAbstract: boolean;
}

/** Split camelCase/PascalCase/snake_case into space-separated words for BM25 */
function splitIdentifier(name: string): string {
  if (!name) return "";
  // camelCase/PascalCase split
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .toLowerCase()
    .trim();
  return parts;
}

function getNodeText(node: any, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function extractSignature(text: string): string {
  // Up to opening brace or end of first line
  const braceIdx = text.indexOf("{");
  if (braceIdx !== -1) {
    return text.slice(0, braceIdx).trim();
  }
  const newlineIdx = text.indexOf("\n");
  if (newlineIdx !== -1) {
    return text.slice(0, newlineIdx).trim();
  }
  return text.trim();
}

function classifyNode(nodeType: string, parentType?: string): CodeEntityType {
  switch (nodeType) {
    case "function_declaration":
    case "function":
      return "function";
    case "class_declaration":
    case "class":
      return "class";
    case "method_definition":
      return "method";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type_alias";
    case "enum_declaration":
      return "enum";
    case "import_statement":
      return "import";
    case "lexical_declaration":
    case "variable_declaration":
      return "variable";
    case "module":
    case "ambient_declaration":
    case "internal_module":
      return "namespace";
    default:
      // Arrow functions in variable declarations
      if (parentType === "variable_declarator") return "function";
      return "other";
  }
}

function findNameNode(node: any): string {
  // Try direct name child
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // For variable declarators, the name is the first identifier
  if (node.type === "variable_declarator") {
    const id = node.childForFieldName("name");
    if (id) return id.text;
  }

  // For export_statement, look at the declaration inside
  if (node.type === "export_statement") {
    const decl = node.childForFieldName("declaration");
    if (decl) return findNameNode(decl);
    // export default — try value
    const value = node.childForFieldName("value");
    if (value) return findNameNode(value);
  }

  return "";
}

// --- JSDoc extraction ---

function extractJSDoc(node: any, source: string): string {
  // Walk backward from entity node to find preceding /** ... */ comment
  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === "comment") {
      const text = getNodeText(prev, source);
      if (text.startsWith("/**")) {
        return text
          .replace(/^\/\*\*\s*/, "")
          .replace(/\s*\*\/$/, "")
          .replace(/^\s*\* ?/gm, "")
          .trim();
      }
      // Skip non-JSDoc comments and keep looking
      prev = prev.previousNamedSibling;
    } else {
      break;
    }
  }
  return "";
}

// --- Decorator extraction ---

function extractDecorators(node: any, source: string): string[] {
  const decorators: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === "decorator") {
      const match = getNodeText(child, source).match(/@(\w+)/);
      if (match) decorators.push(match[1]);
    }
  }
  return decorators;
}

// --- Metadata flag detection ---

function detectIsExported(node: any): boolean {
  // Check if inside export_statement
  if (node.parent?.type === "export_statement") return true;
  // Check if node text starts with export
  const text = node.text ?? "";
  return /^export\s/.test(text);
}

function detectIsAsync(text: string): boolean {
  return /\basync\s/.test(text);
}

function detectIsAbstract(text: string): boolean {
  return /\babstract\s/.test(text);
}

const TOP_LEVEL_TYPES = new Set([
  "function_declaration", "class_declaration", "interface_declaration",
  "type_alias_declaration", "enum_declaration", "export_statement",
  "lexical_declaration", "import_statement", "variable_declaration",
  "module", "ambient_declaration", "internal_module",
]);

function createEntity(
  type: CodeEntityType,
  name: string,
  node: any,
  outerNode: any,
  source: string,
  scopeChain: string[],
  isExportedOverride?: boolean
): ExtractedEntity {
  const text = getNodeText(outerNode, source);
  const jsdocTarget = outerNode.type === "export_statement" ? outerNode : node;
  return {
    type,
    name,
    signature: extractSignature(text),
    scopeChain: [...scopeChain],
    lineStart: outerNode.startPosition.row + 1,
    lineEnd: outerNode.endPosition.row + 1,
    text,
    jsdoc: extractJSDoc(jsdocTarget, source),
    decorators: extractDecorators(node, source),
    isExported: isExportedOverride ?? detectIsExported(outerNode),
    isAsync: detectIsAsync(text),
    isAbstract: detectIsAbstract(text),
  };
}

function extractEntitiesFromNode(
  node: any,
  source: string,
  scopeChain: string[],
  entities: ExtractedEntity[]
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (TOP_LEVEL_TYPES.has(child.type)) {
      // Handle export statements — unwrap the inner declaration
      if (child.type === "export_statement") {
        const decl = child.childForFieldName("declaration");
        if (decl && TOP_LEVEL_TYPES.has(decl.type)) {
          // Process the inner declaration with the export text
          const text = getNodeText(child, source);
          let entityType = classifyNode(decl.type);

          // Check for arrow functions inside exported lexical_declarations
          if (decl.type === "lexical_declaration") {
            for (let j = 0; j < decl.childCount; j++) {
              const declarator = decl.child(j);
              if (declarator?.type === "variable_declarator") {
                const value = declarator.childForFieldName("value");
                if (value && (value.type === "arrow_function" || value.type === "function")) {
                  entityType = "function";
                  const declName = findNameNode(declarator);
                  entities.push(createEntity("function", declName, decl, child, source, scopeChain, true));
                  break;
                }
              }
            }
            if (entityType === "function") continue;
          }

          const name = findNameNode(child);

          if (entityType === "class") {
            entities.push(createEntity("class", name, decl, child, source, scopeChain, true));

            // If class is large, also extract individual methods
            const nonWs = text.replace(/\s/g, "").length;
            if (nonWs > 1500) {
              extractClassMembers(decl, source, [...scopeChain, name], entities);
            }
          } else {
            entities.push(createEntity(entityType, name, decl, child, source, scopeChain, true));
          }
          continue;
        }
        // export default or re-exports
        entities.push(createEntity("other", findNameNode(child), child, child, source, scopeChain, true));
        continue;
      }

      const text = getNodeText(child, source);
      const name = findNameNode(child);
      const entityType = classifyNode(child.type);

      // Handle lexical_declaration with arrow functions
      if (child.type === "lexical_declaration") {
        let hasArrow = false;
        for (let j = 0; j < child.childCount; j++) {
          const declarator = child.child(j);
          if (declarator?.type === "variable_declarator") {
            const value = declarator.childForFieldName("value");
            if (value && (value.type === "arrow_function" || value.type === "function")) {
              hasArrow = true;
              const declName = findNameNode(declarator);
              entities.push(createEntity("function", declName, child, child, source, scopeChain));
              break;
            }
          }
        }
        if (!hasArrow) {
          entities.push(createEntity("variable", name, child, child, source, scopeChain));
        }
        continue;
      }

      if (entityType === "class") {
        entities.push(createEntity("class", name, child, child, source, scopeChain));

        // If class is large, also extract individual methods
        const nonWs = text.replace(/\s/g, "").length;
        if (nonWs > 1500) {
          extractClassMembers(child, source, [...scopeChain, name], entities);
        }
      } else {
        entities.push(createEntity(entityType, name, child, child, source, scopeChain));
      }
    }
  }
}

function extractClassMembers(
  classNode: any,
  source: string,
  scopeChain: string[],
  entities: ExtractedEntity[]
): void {
  const body = classNode.childForFieldName("body");
  if (!body) return;

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;

    if (member.type === "method_definition" || member.type === "public_field_definition" ||
        member.type === "property_definition" || member.type === "field_definition") {
      const text = getNodeText(member, source);
      const name = findNameNode(member);
      const type: CodeEntityType = member.type === "method_definition" ? "method" : "variable";
      entities.push({
        type,
        name,
        signature: extractSignature(text),
        scopeChain: [...scopeChain],
        lineStart: member.startPosition.row + 1,
        lineEnd: member.endPosition.row + 1,
        text,
        jsdoc: extractJSDoc(member, source),
        decorators: extractDecorators(member, source),
        isExported: false,
        isAsync: detectIsAsync(text),
        isAbstract: detectIsAbstract(text),
      });
    }
  }
}

// --- Merge small chunks ---

function mergeSmallEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const MIN_CHARS = 100;
  const merged: ExtractedEntity[] = [];
  let buffer: ExtractedEntity | null = null;

  for (const entity of entities) {
    const nonWs = entity.text.replace(/\s/g, "").length;

    if (nonWs < MIN_CHARS) {
      if (buffer) {
        // Merge into buffer
        buffer.text += "\n\n" + entity.text;
        buffer.lineEnd = entity.lineEnd;
        if (entity.name && !buffer.name) buffer.name = entity.name;
        if (entity.jsdoc && !buffer.jsdoc) buffer.jsdoc = entity.jsdoc;
        if (entity.decorators.length > 0) buffer.decorators.push(...entity.decorators);
        if (entity.isExported) buffer.isExported = true;
        if (entity.isAsync) buffer.isAsync = true;
      } else {
        buffer = { ...entity, decorators: [...entity.decorators] };
      }
    } else {
      if (buffer) {
        // Flush buffer, check if it can merge with current (same scope)
        const sameScope = JSON.stringify(buffer.scopeChain) === JSON.stringify(entity.scopeChain);
        if (sameScope && buffer.text.replace(/\s/g, "").length < MIN_CHARS) {
          buffer.text += "\n\n" + entity.text;
          buffer.lineEnd = entity.lineEnd;
          buffer.name = entity.name;
          buffer.type = entity.type;
          buffer.signature = entity.signature;
          buffer.jsdoc = entity.jsdoc || buffer.jsdoc;
          buffer.decorators.push(...entity.decorators);
          if (entity.isExported) buffer.isExported = true;
          if (entity.isAsync) buffer.isAsync = true;
          if (entity.isAbstract) buffer.isAbstract = true;
          merged.push(buffer);
          buffer = null;
        } else {
          merged.push(buffer);
          buffer = null;
          merged.push(entity);
        }
      } else {
        merged.push(entity);
      }
    }
  }

  if (buffer) merged.push(buffer);
  return merged;
}

// --- Main chunking entry point ---

/**
 * Parse and chunk a code file into entities. Accepts an optional lineOffset
 * for SFC files where script content starts at a non-zero line.
 */
export async function chunkCodeFile(
  source: string,
  filePath: string,
  language: string,
  lineOffset: number = 0
): Promise<Omit<CodeRow, "id" | "vector">[]> {
  const P = await initParser();
  const lang = await getLanguage(language);

  const parser = new P();
  parser.setLanguage(lang);

  // TSX files use TypeScript grammar
  const tree = parser.parse(source);
  const rootNode = tree.rootNode;

  const entities: ExtractedEntity[] = [];
  extractEntitiesFromNode(rootNode, source, [], entities);

  // If no entities extracted, create a single module-level chunk
  if (entities.length === 0) {
    return [{
      filePath,
      language,
      entityType: "module",
      entityName: "",
      signature: "",
      scopeChain: "[]",
      lineStart: 1 + lineOffset,
      lineEnd: source.split("\n").length + lineOffset,
      jsdoc: "",
      decorators: "[]",
      isExported: false,
      isAsync: false,
      isAbstract: false,
      text: buildContextHeader(filePath, [], "module", "", { jsdoc: "", decorators: [], isExported: false, isAsync: false, isAbstract: false }) + source,
    }];
  }

  const merged = mergeSmallEntities(entities);

  return merged.map((entity) => ({
    filePath,
    language,
    entityType: entity.type,
    entityName: entity.name,
    signature: entity.signature,
    scopeChain: JSON.stringify(entity.scopeChain),
    lineStart: entity.lineStart + lineOffset,
    lineEnd: entity.lineEnd + lineOffset,
    jsdoc: entity.jsdoc,
    decorators: JSON.stringify(entity.decorators),
    isExported: entity.isExported,
    isAsync: entity.isAsync,
    isAbstract: entity.isAbstract,
    text: buildContextHeader(filePath, entity.scopeChain, entity.type, entity.name, entity) + entity.text,
  }));
}

interface HeaderMetadata {
  jsdoc: string;
  decorators: string[];
  isExported: boolean;
  isAsync: boolean;
  isAbstract: boolean;
}

function buildContextHeader(
  filePath: string,
  scopeChain: string[],
  entityType: CodeEntityType,
  entityName: string,
  meta?: HeaderMetadata
): string {
  const parts: string[] = [`// File: ${filePath}`];

  if (scopeChain.length > 0) {
    parts.push(`// Scope: ${scopeChain.join(" > ")}`);
  }

  // Flags line
  if (meta) {
    const flags: string[] = [];
    if (meta.isExported) flags.push("exported");
    if (meta.isAsync) flags.push("async");
    if (meta.isAbstract) flags.push("abstract");
    if (flags.length > 0) {
      parts.push(`// Flags: ${flags.join(", ")}`);
    }
  }

  // Decorators line
  if (meta?.decorators && meta.decorators.length > 0) {
    parts.push(`// Decorators: ${meta.decorators.map(d => `@${d}`).join(", ")}`);
  }

  if (entityName) {
    const split = splitIdentifier(entityName);
    const label = entityName !== split ? `${entityName} (${split})` : entityName;
    parts.push(`// ${entityType}: ${label}`);
  }

  let header = parts.join("\n") + "\n\n";

  // Prepend JSDoc if present (makes it visible to embeddings and BM25)
  if (meta?.jsdoc) {
    header += `/** ${meta.jsdoc} */\n\n`;
  }

  return header;
}

// --- Code embedding ---

export async function embedCodeTexts(
  texts: string[],
  mode: "document" | "query" = "document"
): Promise<number[][]> {
  // Qodo-Embed-1-1.5B: no explicit prefix for documents or queries
  const inputs = texts;

  const fullVecs = await codeEmbedClient.embed(inputs, { truncate: true });

  // L2 normalize, truncate to CODE_EMBED_DIM
  return truncateAndNormalize(fullVecs, CODE_EMBED_DIM);
}

const SFC_LANGUAGES = new Set(["vue", "svelte", "astro"]);

/** Parse and embed a code file, returning rows ready for LanceDB. */
export async function indexCodeFile(
  source: string,
  filePath: string,
  language: string
): Promise<Omit<CodeRow, "id">[]> {
  let rawChunks: Omit<CodeRow, "id" | "vector">[];

  if (SFC_LANGUAGES.has(language)) {
    // SFC file — extract script blocks and parse each separately
    const ext = language === "vue" ? ".vue" : language === "svelte" ? ".svelte" : ".astro";
    const blocks = extractScriptBlocks(source, ext);
    rawChunks = [];
    for (const block of blocks) {
      const chunks = await chunkCodeFile(block.scriptContent, filePath, block.language, block.lineOffset);
      rawChunks.push(...chunks);
    }
    // If no script blocks found, create a minimal module-level chunk
    if (rawChunks.length === 0) {
      rawChunks = [{
        filePath,
        language,
        entityType: "module",
        entityName: "",
        signature: "",
        scopeChain: "[]",
        lineStart: 1,
        lineEnd: source.split("\n").length,
        jsdoc: "",
        decorators: "[]",
        isExported: false,
        isAsync: false,
        isAbstract: false,
        text: `// File: ${filePath}\n// module\n\n(template-only component)`,
      }];
    }
  } else {
    rawChunks = await chunkCodeFile(source, filePath, language);
  }

  if (rawChunks.length === 0) return [];

  const texts = rawChunks.map(c => c.text);
  const embeddings = await embedCodeTexts(texts, "document");

  return rawChunks.map((chunk, i) => ({
    ...chunk,
    vector: embeddings[i],
  }));
}

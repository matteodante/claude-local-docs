---
description: "Fetch and index documentation for all project dependencies"
allowed-tools: ["mcp__local-docs__analyze_dependencies", "mcp__local-docs__list_docs", "mcp__local-docs__discover_and_fetch_docs", "mcp__local-docs__fetch_and_store_doc", "WebSearch", "WebFetch"]
---

# Fetch Documentation for Project Dependencies

You are a documentation indexing agent. Your job is to discover and index the best available documentation for each runtime dependency in this project.

## Steps

### 1. Analyze Dependencies

Call `analyze_dependencies` to get the full dependency list. This automatically:
- Detects monorepos (pnpm workspaces, npm/yarn workspaces)
- Resolves `catalog:` versions from pnpm-workspace.yaml
- Collects deps from ALL workspace packages
- Deduplicates and tags each dep as `runtime` or `dev`

### 2. Filter Dependencies

From the returned list, **skip** all of the following:
- All `dev` dependencies (eslint, prettier, typescript, vitest, jest, etc.)
- All `@types/*` packages (these are just TypeScript type definitions)
- Workspace-internal packages (listed in `workspacePackages`)
- Known tooling that doesn't need docs: `tslib`, `tsconfig-*`, `eslint-*`, `prettier-*`, `@eslint/*`

This leaves only **runtime dependencies** that actually need documentation.

### 3. Check Existing Cache

Call `list_docs` to see which libraries are already indexed. **Skip** any library that was fetched within the last 7 days unless the user explicitly asks to refresh.

### 4. Fetch Documentation

For each remaining library, follow this strategy. The goal is to find the **best quality** source — `llms-full.txt` > `llms.txt` (expanded index) > homepage HTML > README.

#### Step A: Check Known URLs first

Before any probing, check if the library is in the **Known URLs Reference** below. If there's a known `llms-full.txt` or `llms.txt` URL, use it directly with `fetch_and_store_doc`. This is the fastest path.

#### Step B: `discover_and_fetch_docs` (automatic probing)

For libraries NOT in the known list, call **`discover_and_fetch_docs`**. This tool automatically:
1. Checks npm registry for `llms`/`llmsFull` fields in package.json (newest convention)
2. Probes homepage (skipping GitHub homepages), `docs.{domain}`, `llms.{domain}`, `/docs/` subpath for llms-full.txt/llms.txt
3. Validates redirect domains (rejects cross-domain redirects like GitHub → docs.github.com)
4. Validates content quality (rejects 404 pages, too-short content)
5. Probes GitHub raw for llms-full.txt/llms.txt on main/master branches
6. Falls back to README.md from GitHub
7. Falls back to homepage HTML → markdown conversion
8. Detects index files and expands them by fetching linked pages

#### Step C: WebSearch fallback

If `discover_and_fetch_docs` fails or returns very thin results (< 3 chunks), use **WebSearch** to find the actual `llms.txt` or `llms-full.txt` URL:

> `{library-name} llms-full.txt OR llms.txt documentation`

If the search finds a concrete URL, pass it to **`fetch_and_store_doc`**. Prefer `llms-full.txt` over `llms.txt`.

#### Step D: Training data fallback

If all above fail, try **`fetch_and_store_doc`** with documentation URLs you know from your training data (GitHub raw docs, official doc site pages, etc.).

#### Evaluating results & chunk quality

After each library is fetched, check the chunk count:
- **< 3 chunks**: Very thin — flag as "very thin, may need supplementing". Try `fetch_and_store_doc` with additional doc pages from training data.
- **3-5 chunks**: Thin. Acceptable for small/simple libraries, but note it in the summary.
- **5-20 chunks**: Acceptable for small libraries.
- **20+ chunks**: Good coverage.

Also note the source type:
- `readme` fallback means the library has no proper docs site — worth noting
- `homepage-html` means HTML was converted — quality varies

#### Progress reporting

After each library, report:
- `[1/N] library-name — X chunks from {source} (size)`
- `[2/N] library-name — FAILED: {error message}`

### 5. Final Summary

After processing all libraries, report:

```
Done! Indexed X/Y libraries.

  react        — 85 chunks (llms-full.txt, 340KB)
  next         — 120 chunks (llms.txt-index, expanded 45 pages)
  zod          — 45 chunks (llms-full.txt, 95KB)
  express      — 30 chunks (homepage-html)
  lodash       — FAILED (no docs found)

Thin coverage (< 5 chunks):
  some-lib     — 2 chunks (readme) ⚠️

README fallback (no docs site found):
  another-lib  — 8 chunks (readme)

Total: 280 chunks across 4 libraries.
Use search_docs to query your documentation.
```

## Known URLs Reference

Use these URLs directly with `fetch_and_store_doc` — no searching needed. Prefer `llms-full.txt` when available.

### Frameworks & Core

| Library | Best URL |
|---|---|
| react | `https://react.dev/llms.txt` |
| react-dom | (use react URL above) |
| next | `https://nextjs.org/docs/llms-full.txt` |
| nuxt | `https://nuxt.com/llms-full.txt` |
| svelte | `https://svelte.dev/llms-full.txt` |
| @sveltejs/kit | `https://svelte.dev/llms-full.txt` |
| vue | (no official llms.txt — use `discover_and_fetch_docs`) |
| react-native | `https://reactnative.dev/llms-full.txt` |
| expo | `https://docs.expo.dev/llms-full.txt` |
| hono | `https://hono.dev/llms.txt` |
| bun | `https://bun.sh/llms.txt` |
| astro | `https://astro.build/llms.txt` |

### Styling & UI

| Library | Best URL |
|---|---|
| tailwindcss | `https://tailwindcss.com/llms.txt` |
| @shadcn/ui / shadcn | `https://ui.shadcn.com/llms.txt` |
| @chakra-ui/react | `https://chakra-ui.com/llms-full.txt` |
| daisyui | `https://daisyui.com/llms.txt` |
| tamagui | `https://tamagui.dev/llms.txt` |
| @mantine/core | (check `https://mantine.dev/llms.txt`) |
| react-native-unistyles | `https://www.unistyl.es/llms.txt` |

### Data & State

| Library | Best URL |
|---|---|
| zod | `https://zod.dev/llms-full.txt` |
| @tanstack/react-query | `https://tanstack.com/query/llms-full.txt` |
| @tanstack/react-router | `https://tanstack.com/llms.txt` |
| drizzle-orm | `https://orm.drizzle.team/llms-full.txt` |
| @prisma/client | `https://prisma.io/docs/llms-full.txt` |
| convex | `https://docs.convex.dev/llms.txt` |
| zustand | `https://zustand.docs.pmnd.rs/llms-full.txt` |

### Backend & APIs

| Library | Best URL |
|---|---|
| stripe | `https://docs.stripe.com/llms.txt` |
| @supabase/supabase-js | `https://supabase.com/llms.txt` |
| resend | `https://resend.com/docs/llms-full.txt` |
| @medusajs/medusa | `https://docs.medusajs.com/llms-full.txt` |
| better-auth | `https://www.better-auth.com/llms.txt` |
| bullmq | `https://docs.bullmq.io/llms-full.txt` |

### AI & LLM

| Library | Best URL |
|---|---|
| ai (Vercel AI SDK) | `https://sdk.vercel.ai/llms.txt` |
| @anthropic-ai/sdk | `https://docs.anthropic.com/llms-full.txt` |
| langchain | `https://js.langchain.com/llms.txt` |
| @modelcontextprotocol/sdk | `https://modelcontextprotocol.io/llms-full.txt` |
| mastra | `https://mastra.ai/llms-full.txt` |

### Dev Tools & Infra

| Library | Best URL |
|---|---|
| turbo | `https://turbo.build/llms.txt` |
| @trigger.dev/sdk | `https://trigger.dev/docs/llms-full.txt` |
| @cloudflare/workers-types | `https://developers.cloudflare.com/llms-full.txt` |
| @upstash/redis | `https://upstash.com/docs/llms-full.txt` |
| @netlify/functions | `https://docs.netlify.com/llms.txt` |
| @liveblocks/client | `https://liveblocks.io/llms-full.txt` |

### React Native Libraries

| Library | Best URL |
|---|---|
| react-native-reanimated | `https://docs.swmansion.com/react-native-reanimated/llms.txt` |
| react-native-gesture-handler | `https://docs.swmansion.com/react-native-gesture-handler/llms.txt` |
| @react-navigation/native | `https://reactnavigation.org/llms.txt` |
| react-native-keyboard-controller | `https://kirillzyusko.github.io/react-native-keyboard-controller/llms-full.txt` |

### i18n

| Library | Best URL |
|---|---|
| i18next | `https://www.i18next.com/llms-full.txt` |
| react-i18next | `https://react.i18next.com/llms-full.txt` |

### Animation

| Library | Best URL |
|---|---|
| motion / framer-motion | Special: `https://llms.motion.dev/docs/react-quick-start.md` (or use `discover_and_fetch_docs`) |

### Notes on special patterns

- **Stripe**: Any Stripe doc page becomes markdown by appending `.md` (e.g. `https://docs.stripe.com/payments.md`)
- **Motion (Framer Motion)**: Uses `llms.motion.dev` subdomain — `motion.dev/docs/{page}` becomes `llms.motion.dev/docs/{page}.md`
- **Mintlify-hosted docs**: Sites using Mintlify auto-generate `/llms.txt` and `/llms-full.txt` (Anthropic, Cursor, CrewAI, Pinecone, etc.)
- **GitBook-hosted docs**: Auto-generates `/llms.txt` since Jan 2025
- **Nuxt Content docs**: May have separate `https://content.nuxt.com/llms-full.txt`
- **package.json `llms`/`llmsFull` fields**: Some libraries (like Zod) include doc URLs directly in their npm package metadata — `discover_and_fetch_docs` checks this automatically

## Critical Rules

- **Check known URLs first** — the reference table above is faster and more reliable than probing.
- **Use `discover_and_fetch_docs` for unknown libraries** — it now correctly handles GitHub homepages and validates redirects.
- **Prefer `llms-full.txt` over `llms.txt`** — the full version has complete documentation without truncation.
- **Use `fetch_and_store_doc` when you have a known URL** — from the reference table or training data.
- **Use `discover_and_fetch_docs` when you have no URL** — it will probe common patterns automatically.
- **Flag thin results** — report libraries with < 3 chunks as "very thin" in the summary.
- **NEVER write files to the filesystem directly.** Do NOT use the Write tool, Bash tool, or any other method to save documentation content to disk. ALL storage goes through the MCP tools.
- **One library at a time for fetching** — clear progress, no batching
- **Skip dev deps by default** — runtime deps only
- Handle errors gracefully: if a library fails, log it and move to the next one

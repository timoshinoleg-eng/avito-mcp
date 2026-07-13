/**
 * Domain `lookup` — Russian-friendly search over the bundled swaggers/ catalogue.
 *
 * Bakugan fork v1.3.0: faithful port of MissiaL/avito-api/scripts/lookup_endpoint.py
 * (Apache-2.0, credit: https://github.com/MissiaL/avito-api). Two read-only tools:
 *   - lookup_search  — substring search over path/summary/tags across all
 *                      swaggers, with a 2-char stem-fallback for Russian
 *                      morphology (если ничего не нашлось, повторяет поиск
 *                      с обрезанным хвостом длины 2)
 *   - lookup_show    — full operation object for a given (path, method),
 *                      with `$ref` resolved ONE LEVEL DEEP (matches MissiaL)
 *
 * No env guard: this domain only reads the swaggers/ directory shipped with the
 * package and is therefore always available. No Avito credentials required.
 *
 * The index is built once at register time (eager) so the first call is already
 * O(n) over a small flat array — no per-call file I/O.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';
import { type RequestResponse } from '../core/client.js';
import { logger } from '../logger.js';

// `here` is .../src/domains/ in dev (tsx) or .../dist/domains/ in built (node).
// REPO_ROOT is 2 levels up in both cases.
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');
const SWAGGERS_DIR = resolve(REPO_ROOT, 'swaggers');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

/** A single operation extracted from a swagger file. */
interface OperationEntry {
  source: string; // file name, e.g. 'items.json'
  method: string; // upper-case: GET, POST, ...
  path: string; // exactly as in the swagger, e.g. '/items/v3/...'
  operationId: string;
  summary: string;
  tags: string[];
  operation: Record<string, unknown>;
}

let INDEX: OperationEntry[] | null = null;

/** Build the in-memory index of every (method, path) operation across swaggers/. */
function loadIndex(): OperationEntry[] {
  if (INDEX) return INDEX;
  if (!existsSync(SWAGGERS_DIR)) {
    logger.warn({ SWAGGERS_DIR }, 'lookup: swaggers dir not found, index empty');
    INDEX = [];
    return INDEX;
  }
  const files = readdirSync(SWAGGERS_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  const ops: OperationEntry[] = [];
  for (const f of files) {
    const full = join(SWAGGERS_DIR, f);
    // Defensive: refuse to walk outside the swaggers dir.
    const rel = relative(SWAGGERS_DIR, resolve(full));
    if (rel === '..' || rel.startsWith(`..${sep}`)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      logger.warn({ file: f, err }, 'lookup: failed to parse swagger');
      continue;
    }
    const paths = (parsed.paths ?? {}) as Record<string, Record<string, unknown>>;
    for (const [p, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== 'object') continue;
      for (const [m, op] of Object.entries(methods)) {
        if (!HTTP_METHODS.has(m.toLowerCase())) continue;
        if (!op || typeof op !== 'object') continue;
        const o = op as Record<string, unknown>;
        const tags = Array.isArray(o.tags) ? (o.tags as unknown[]).map((t) => String(t)) : [];
        ops.push({
          source: f,
          method: m.toUpperCase(),
          path: p,
          operationId: typeof o.operationId === 'string' ? o.operationId : '',
          summary: typeof o.summary === 'string' ? o.summary : '',
          tags,
          operation: o,
        });
      }
    }
  }
  INDEX = ops;
  logger.info({ count: ops.length, files: files.length }, 'lookup: swagger index built');
  return INDEX;
}

/**
 * Walk `op` and substitute every `$ref: "#/a/b/..."` with the target from `root`
 * (the parent swagger). Single-level resolution: if the substituted value itself
 * contains `$ref`, we leave it as-is (matches MissiaL semantics — gives the
 * caller the referenced schema verbatim, no recursion).
 */
function resolveRefsOneLevel(op: unknown, root: Record<string, unknown>): unknown {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      if (typeof obj.$ref === 'string' && obj.$ref.startsWith('#/')) {
        const segs = obj.$ref.slice(2).split('/');
        let cur: unknown = root;
        let ok = true;
        for (const seg of segs) {
          if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[seg];
          } else {
            ok = false;
            break;
          }
        }
        if (ok) return cur;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = visit(v);
      return out;
    }
    return node;
  };
  return visit(op);
}

function matchOp(needle: string, op: OperationEntry): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  if (op.summary.toLowerCase().includes(q)) return true;
  if (op.path.toLowerCase().includes(q)) return true;
  if (op.operationId.toLowerCase().includes(q)) return true;
  return op.tags.some((t) => t.toLowerCase().includes(q));
}

/** Substring search with single 2-char stem-fallback (MissiaL algorithm). */
function searchOps(
  query: string,
  limit: number,
): {
  effective_query: string;
  results: OperationEntry[];
  stem_fallback_used: boolean;
} {
  const index = loadIndex();
  const trimmed = query.trim();
  let results = index.filter((op) => matchOp(trimmed, op));
  let stemFallback = false;
  let effective = trimmed;
  if (results.length === 0 && trimmed.length > 2) {
    effective = trimmed.slice(0, -2);
    results = index.filter((op) => matchOp(effective, op));
    stemFallback = true;
  }
  return { effective_query: effective, results: results.slice(0, limit), stem_fallback_used: stemFallback };
}

// Sentinel `method` + `path` for ToolSpec — required even when customExecute
// bypasses HTTP. Surfaces in the live manifest and dry-run preview.
const LOOKUP_SENTINEL_PATH = '/internal/lookup/swagger';

// ──────────────────────────────────────────────────────────────────────────────
// Domain registration
// ──────────────────────────────────────────────────────────────────────────────
export const register: DomainRegister = (server, _ctx) => {
  loadIndex();

  defineTool(server, _ctx, {
    name: 'lookup_search',
    title: 'Авито: поиск эндпоинта в swagger-каталоге',
    risk: 'read',
    domain: 'lookup',
    description:
      'Searches Avito API endpoints by substring across path, summary, tags, and ' +
      'operationId in all bundled swagger files. If no results are found and the ' +
      'query is longer than 2 characters, repeats the search with the last 2 ' +
      'characters removed — a simple stem fallback that covers common Russian ' +
      'word endings. Faithful port of MissiaL/lookup_endpoint.py::search().',
    method: 'GET',
    path: LOOKUP_SENTINEL_PATH,
    input: {
      query: z.string().min(1).describe('Search substring (Cyrillic is OK).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Maximum number of results (default 50, like MissiaL).'),
    },
    customExecute: async (args, _ctx): Promise<RequestResponse<unknown>> => {
      const limit = (args.limit as number | undefined) ?? 50;
      const out = searchOps(String(args.query), limit);
      return {
        status: 200,
        data: {
          count: out.results.length,
          truncated: out.results.length >= limit,
          stem_fallback_used: out.stem_fallback_used,
          effective_query: out.effective_query,
          results: out.results.map((r) => ({
            method: r.method,
            path: r.path,
            summary: r.summary,
            tags: r.tags,
            source: r.source,
          })),
        },
        headers: new Headers(),
      };
    },
  });

  defineTool(server, _ctx, {
    name: 'lookup_show',
    title: 'Авито: полная схема эндпоинта (с разрешёнными $ref)',
    risk: 'read',
    domain: 'lookup',
    description:
      'Returns the full OpenAPI operation object for a given (path, method) pair. ' +
      'All $ref values in the operation are resolved one level deep: the target ' +
      'from components.* is inlined, but no further recursion is performed. Use ' +
      'after lookup_search to obtain request/response schemas and parameters. ' +
      'Faithful port of MissiaL/lookup_endpoint.py::show().',
    method: 'GET',
    path: LOOKUP_SENTINEL_PATH,
    input: {
      path: z
        .string()
        .min(1)
        .describe('Path from search results, e.g. "/messenger/v1/accounts/{userId}/chats".'),
      method: z
        .string()
        .min(1)
        .describe('HTTP method in any case: get / post / put / patch / delete.'),
    },
    customExecute: async (args, _ctx): Promise<RequestResponse<unknown>> => {
      const index = loadIndex();
      const methodNorm = String(args.method).toLowerCase();
      const pathNorm = String(args.path);
      const matches = index.filter(
        (op) => op.path === pathNorm && op.method.toLowerCase() === methodNorm,
      );
      if (matches.length === 0) {
        return {
          status: 404,
          data: { error: 'not_found', path: pathNorm, method: args.method },
          headers: new Headers(),
        };
      }
      const items = matches.map((m) => {
        const fullPath = join(SWAGGERS_DIR, m.source);
        let root: Record<string, unknown> = {};
        try {
          root = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
        } catch {
          /* unreachable: file was readable at index build time */
        }
        return {
          method: m.method,
          path: m.path,
          summary: m.summary,
          tags: m.tags,
          source: m.source,
          operation: resolveRefsOneLevel(m.operation, root),
        };
      });
      return {
        status: 200,
        data: { count: items.length, items },
        headers: new Headers(),
      };
    },
  });
};

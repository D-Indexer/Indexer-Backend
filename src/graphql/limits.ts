import { badRequest } from '../http/errors';

/**
 * Static query guards for the read-only /graphql endpoint. They run on the
 * parsed document *before* execution, so an abusive query never reaches a
 * resolver or the database.
 *
 * The limits are deliberately conservative: the read model is small and the
 * REST API stays the primary interface (see docs/api.md).
 */
export const MAX_QUERY_DEPTH = 8;
export const MAX_QUERY_COMPLEXITY = 200;

/** Minimal structural view of a GraphQL AST node (avoids a hard dependency on `graphql` types). */
type AstNode = {
  kind: string;
  name?: { value: string };
  selectionSet?: { selections: AstNode[] };
  arguments?: { name: { value: string }; value: AstNode }[];
};

/** Cost of a connection field: `first`/`last` multiplies the nested cost. */
const CONNECTION_FIELDS = new Set(['folders', 'portfolios', 'templates', 'events', 'admins']);
const DEFAULT_PAGE_SIZE = 20;

function argumentInt(node: AstNode, name: string): number | null {
  const arg = node.arguments?.find((a) => a.name.value === name);
  if (!arg) return null;
  const value = arg.value as { kind: string; value?: string };
  if (value.kind !== 'IntValue' || value.value === undefined) return null;
  const parsed = Number(value.value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectionCost(selectionSet: AstNode['selectionSet']): number {
  if (!selectionSet) return 0;
  let cost = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      cost += 1;
      const multiplier = CONNECTION_FIELDS.has(selection.name?.value ?? '')
        ? Math.max(1, argumentInt(selection, 'first') ?? argumentInt(selection, 'last') ?? DEFAULT_PAGE_SIZE)
        : 1;
      cost += multiplier * selectionCost(selection.selectionSet);
    } else if (selection.kind === 'InlineFragment') {
      cost += selectionCost(selection.selectionSet);
    } else if (selection.kind === 'FragmentSpread') {
      // Fragment spreads are counted as leaves; the depth guard still applies.
      cost += 1;
    }
  }
  return cost;
}

function maxDepth(selectionSet: AstNode['selectionSet'], depth: number): number {
  if (!selectionSet) return depth;
  let deepest = depth;
  for (const selection of selectionSet.selections) {
    const child = maxDepth(selection.selectionSet, depth + 1);
    if (child > deepest) deepest = child;
  }
  return deepest;
}

export type QueryMetrics = { depth: number; complexity: number };

/** Measure a parsed operation. Fragment spreads are counted as leaves. */
export function measureQuery(operation: AstNode): QueryMetrics {
  return {
    depth: maxDepth(operation.selectionSet, 0),
    complexity: selectionCost(operation.selectionSet, 0),
  };
}

/**
 * Reject a query that is too deep or too expensive. Throws a 400 HttpError so
 * the response matches the REST error envelope.
 */
export function assertWithinLimits(metrics: QueryMetrics): void {
  if (metrics.depth > MAX_QUERY_DEPTH) {
    throw badRequest(`Query depth ${metrics.depth} exceeds the limit of ${MAX_QUERY_DEPTH}`);
  }
  if (metrics.complexity > MAX_QUERY_COMPLEXITY) {
    throw badRequest(`Query complexity ${metrics.complexity} exceeds the limit of ${MAX_QUERY_COMPLEXITY}`);
  }
}

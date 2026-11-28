#!/usr/bin/env node
/**
 * `doctor` command: diagnoses configuration and dependencies end to end.
 *
 * Usage:
 *   npm run doctor            # human-readable table
 *   npm run doctor -- --json  # stable machine-readable JSON
 *
 * Exit codes:
 *   0 - all checks passed (warnings allowed)
 *   1 - one or more checks failed
 *   2 - unexpected internal error
 *
 * Secrets are never printed. URLs are redacted (credentials stripped, host
 * partially masked) before being included in output.
 */

import { createRequire } from 'node:module';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  /** Stable identifier for the check (used in JSON output). */
  id: string;
  /** Human-readable name. */
  name: string;
  status: CheckStatus;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Short message describing the outcome. */
  message: string;
  /** Actionable hint shown when the check does not pass. */
  hint?: string;
  /** Optional structured details (already redacted). */
  details?: Record<string, unknown>;
}

export interface CheckContext {
  env: NodeJS.ProcessEnv;
  /** Injected dependencies; tests stub these. */
  deps: DoctorDeps;
}

export interface DoctorDeps {
  /** Validate environment variables. Returns list of problems. */
  validateEnv: (env: NodeJS.ProcessEnv) => EnvValidationResult;
  /** Query the database. */
  db: DbProbe;
  /** Query the RPC endpoint. */
  rpc: RpcProbe;
  /** Query the Kubo (IPFS) node. */
  kubo: KuboProbe;
  /** Query indexer state. */
  indexer: IndexerProbe;
  /** Clock for deterministic timing in tests. */
  now: () => number;
}

export interface EnvValidationResult {
  ok: boolean;
  problems: string[];
  /** Names of required variables that are present (values never included). */
  present: string[];
}

export interface DbProbe {
  connect(): Promise<void>;
  schemaVersion(): Promise<string>;
  rolePrivileges(): Promise<{ role: string; canRead: boolean; canWrite: boolean }>;
}

export interface RpcProbe {
  reachable(): Promise<{ version: string; networkPassphrase: string }>;
  contractExists(contractId: string): Promise<boolean>;
  retentionWindow(): Promise<{ oldestLedger: number; latestLedger: number }>;
}

export interface KuboProbe {
  reachable(): Promise<{ version: string }>;
  authOk(): Promise<boolean>;
}

export interface IndexerProbe {
  state(): Promise<{
    status: string;
    lastIndexedLedger: number;
    latestLedger: number;
    openGaps: number;
    rejectedEvents: number;
  }>;
}

export interface DoctorOptions {
  json?: boolean;
  /** Override dependencies (used by tests). */
  deps?: Partial<DoctorDeps>;
  env?: NodeJS.ProcessEnv;
  /** Output stream; defaults to process.stdout. */
  out?: NodeJS.WritableStream;
}

/* -------------------------------------------------------------------------- */
/* Redaction helpers                                                          */
/* -------------------------------------------------------------------------- */

const SECRET_ENV_PATTERN = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|KEY|CREDENTIAL|AUTH)/i;

/**
 * Redact a URL: strip userinfo, query string and fragment, and mask the host
 * so operators can identify the target without leaking infrastructure details.
 */
export function redactUrl(raw: string | undefined): string {
  if (!raw) return '<unset>';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '<invalid-url>';
  }
  const host = url.hostname;
  const maskedHost =
    host.length <= 4
      ? '***'
      : `${host.slice(0, 2)}***${host.slice(-2)}`;
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${maskedHost}${port}${url.pathname}`;
}

/** Redact a secret value entirely. */
export function redactSecret(value: string | undefined): string {
  if (!value) return '<unset>';
  return `<redacted:${value.length}>`;
}

/** Redact any secret-looking values from a free-form message. */
export function redactMessage(message: string, env: NodeJS.ProcessEnv): string {
  let out = message;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 4) continue;
    if (SECRET_ENV_PATTERN.test(key)) {
      out = out.split(value).join('<redacted>');
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Default dependency implementations                                         */
/* -------------------------------------------------------------------------- */

const require = createRequire(import.meta.url);

function loadOptional<T>(moduleName: string): T | undefined {
  try {
    return require(moduleName) as T;
  } catch {
    return undefined;
  }
}

export function createDefaultDeps(env: NodeJS.ProcessEnv): DoctorDeps {
  return {
    now: () => Date.now(),
    validateEnv: defaultValidateEnv,
    db: createDefaultDbProbe(env),
    rpc: createDefaultRpcProbe(env),
    kubo: createDefaultKuboProbe(env),
    indexer: createDefaultIndexerProbe(env),
  };
}

const REQUIRED_ENV = [
  'DATABASE_URL',
  'RPC_URL',
  'NETWORK_PASSPHRASE',
  'CONTRACT_ID',
  'KUBO_URL',
] as const;

export function defaultValidateEnv(env: NodeJS.ProcessEnv): EnvValidationResult {
  const problems: string[] = [];
  const present: string[] = [];
  for (const name of REQUIRED_ENV) {
    const value = env[name];
    if (!value || value.trim() === '') {
      problems.push(`missing required env var ${name}`);
    } else {
      present.push(name);
    }
  }
  if (env.DATABASE_URL && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL)) {
    problems.push('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }
  if (env.RPC_URL) {
    try {
      new URL(env.RPC_URL);
    } catch {
      problems.push('RPC_URL is not a valid URL');
    }
  }
  if (env.KUBO_URL) {
    try {
      new URL(env.KUBO_URL);
    } catch {
      problems.push('KUBO_URL is not a valid URL');
    }
  }
  return { ok: problems.length === 0, problems, present };
}

function createDefaultDbProbe(env: NodeJS.ProcessEnv): DbProbe {
  const pg = loadOptional<{ Client: new (cfg: { connectionString: string }) => any }>('pg');
  const connectionString = env.DATABASE_URL ?? '';
  const getClient = async () => {
    if (!pg) throw new Error('pg module not installed');
    const client = new pg.Client({ connectionString });
    await client.connect();
    return client;
  };
  return {
    async connect() {
      const client = await getClient();
      try {
        await client.query('SELECT 1');
      } finally {
        await client.end();
      }
    },
    async schemaVersion() {
      const client = await getClient();
      try {
        const res = await client.query(
          'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
        );
        return res.rows?.[0]?.version ?? 'unknown';
      } finally {
        await client.end();
      }
    },
    async rolePrivileges() {
      const client = await getClient();
      try {
        const res = await client.query(
          `SELECT current_user AS role,
                  has_table_privilege(current_user, 'events', 'SELECT') AS can_read,
                  has_table_privilege(current_user, 'events', 'INSERT') AS can_write`,
        );
        const row = res.rows?.[0] ?? {};
        return {
          role: String(row.role ?? 'unknown'),
          canRead: Boolean(row.can_read),
          canWrite: Boolean(row.can_write),
        };
      } finally {
        await client.end();
      }
    },
  };
}

function createDefaultRpcProbe(env: NodeJS.ProcessEnv): RpcProbe {
  const rpcUrl = env.RPC_URL ?? '';
  const contractId = env.CONTRACT_ID ?? '';
  const call = async (method: string, params: unknown): Promise<any> => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as any;
    if (body.error) throw new Error(`RPC error: ${body.error.message ?? 'unknown'}`);
    return body.result;
  };
  return {
    async reachable() {
      const info = await call('getNetwork', {});
      return {
        version: String(info?.protocolVersion ?? info?.version ?? 'unknown'),
        networkPassphrase: String(info?.passphrase ?? info?.networkPassphrase ?? ''),
      };
    },
    async contractExists(id: string) {
      try {
        const res = await call('getLedgerEntries', {
          keys: [{ contract: id || contractId }],
        });
        return Array.isArray(res?.entries) && res.entries.length > 0;
      } catch {
        return false;
      }
    },
    async retentionWindow() {
      const info = await call('getHealth', {});
      return {
        oldestLedger: Number(info?.oldestLedger ?? 0),
        latestLedger: Number(info?.latestLedger ?? 0),
      };
    },
  };
}

function createDefaultKuboProbe(env: NodeJS.ProcessEnv): KuboProbe {
  const base = (env.KUBO_URL ?? '').replace(/\/$/, '');
  const headers: Record<string, string> = {};
  if (env.KUBO_AUTH) headers.authorization = `Bearer ${env.KUBO_AUTH}`;
  return {
    async reachable() {
      const res = await fetch(`${base}/api/v0/version`, { method: 'POST', headers });
      if (!res.ok) throw new Error(`Kubo HTTP ${res.status}`);
      const body = (await res.json()) as any;
      return { version: String(body?.Version ?? 'unknown') };
    },
    async authOk() {
      const res = await fetch(`${base}/api/v0/id`, { method: 'POST', headers });
      return res.ok;
    },
  };
}

function createDefaultIndexerProbe(env: NodeJS.ProcessEnv): IndexerProbe {
  const base = (env.INDEXER_URL ?? '').replace(/\/$/, '');
  return {
    async state() {
      const res = await fetch(`${base}/status`);
      if (!res.ok) throw new Error(`Indexer HTTP ${res.status}`);
      const body = (await res.json()) as any;
      return {
        status: String(body?.status ?? 'unknown'),
        lastIndexedLedger: Number(body?.lastIndexedLedger ?? 0),
        latestLedger: Number(body?.latestLedger ?? 0),
        openGaps: Number(body?.openGaps ?? 0),
        rejectedEvents: Number(body?.rejectedEvents ?? 0),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Check registry                                                             */
/* -------------------------------------------------------------------------- */

export interface Check {
  id: string;
  name: string;
  run: (ctx: CheckContext) => Promise<Omit<CheckResult, 'id' | 'name' | 'durationMs'>>;
}

async function timed(
  check: Check,
  ctx: CheckContext,
): Promise<CheckResult> {
  const start = ctx.deps.now();
  try {
    const partial = await check.run(ctx);
    const durationMs = ctx.deps.now() - start;
    return {
      id: check.id,
      name: check.name,
      durationMs,
      ...partial,
      message: redactMessage(partial.message, ctx.env),
      hint: partial.hint ? redactMessage(partial.hint, ctx.env) : undefined,
    };
  } catch (err) {
    const durationMs = ctx.deps.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: check.id,
      name: check.name,
      status: 'fail',
      durationMs,
      message: redactMessage(message, ctx.env),
      hint: 'Check the dependency is running and reachable; see docs/operations.md.',
    };
  }
}

export const checks: Check[] = [
  {
    id: 'env',
    name: 'Environment validation',
    async run({ env, deps }) {
      const result = deps.validateEnv(env);
      if (result.ok) {
        return {
          status: 'pass',
          message: `all required env vars present (${result.present.length})`,
          details: { present: result.present },
        };
      }
      return {
        status: 'fail',
        message: `${result.problems.length} problem(s): ${result.problems.join('; ')}`,
        hint: 'Copy .env.example to .env and fill in the required values.',
        details: { problems: result.problems },
      };
    },
  },
  {
    id: 'db.connectivity',
    name: 'Database connectivity',
    async run({ env, deps }) {
      await deps.db.connect();
      return {
        status: 'pass',
        message: `connected to ${redactUrl(env.DATABASE_URL)}`,
      };
    },
  },
  {
    id: 'db.schema',
    name: 'Database schema version',
    async run({ deps }) {
      const version = await deps.db.schemaVersion();
      if (version === 'unknown' || version === '') {
        return {
          status: 'fail',
          message: 'schema_migrations table missing or empty',
          hint: 'Run `npm run migrate` to apply migrations.',
        };
      }
      return { status: 'pass', message: `schema version ${version}`, details: { version } };
    },
  },
  {
    id: 'db.privileges',
    name: 'Database role privileges',
    async run({ deps }) {
      const priv = await deps.db.rolePrivileges();
      if (!priv.canRead || !priv.canWrite) {
        return {
          status: 'fail',
          message: `role ${priv.role} lacks ${!priv.canRead ? 'SELECT' : ''}${
            !priv.canRead && !priv.canWrite ? ' and ' : ''
          }${!priv.canWrite ? 'INSERT' : ''} on events`,
          hint: 'Grant the configured role SELECT and INSERT on the events table.',
          details: priv,
        };
      }
      return { status: 'pass', message: `role ${priv.role} has read/write`, details: priv };
    },
  },
  {
    id: 'rpc.reachability',
    name: 'RPC reachability',
    async run({ env, deps }) {
      const info = await deps.rpc.reachable();
      return {
        status: 'pass',
        message: `reachable at ${redactUrl(env.RPC_URL)} (version ${info.version})`,
        details: { version: info.version },
      };
    },
  },
  {
    id: 'rpc.passphrase',
    name: 'RPC network passphrase',
    async run({ env, deps }) {
      const info = await deps.rpc.reachable();
      const expected = env.NETWORK_PASSPHRASE ?? '';
      if (!expected) {
        return {
          status: 'fail',
          message: 'NETWORK_PASSPHRASE not configured',
          hint: 'Set NETWORK_PASSPHRASE to match the target network.',
        };
      }
      if (info.networkPassphrase !== expected) {
        return {
          status: 'fail',
          message: 'network passphrase mismatch',
          hint: 'Ensure NETWORK_PASSPHRASE matches the RPC endpoint network.',
        };
      }
      return { status: 'pass', message: 'passphrase matches RPC network' };
    },
  },
  {
    id: 'rpc.contract',
    name: 'RPC contract existence',
    async run({ env, deps }) {
      const contractId = env.CONTRACT_ID ?? '';
      if (!contractId) {
        return {
          status: 'fail',
          message: 'CONTRACT_ID not configured',
          hint: 'Set CONTRACT_ID to the deployed contract.',
        };
      }
      const exists = await deps.rpc.contractExists(contractId);
      if (!exists) {
        return {
          status: 'fail',
          message: `contract ${contractId} not found on RPC`,
          hint: 'Verify CONTRACT_ID and that the contract is deployed on this network.',
        };
      }
      return { status: 'pass', message: `contract ${contractId} exists` };
    },
  },
  {
    id: 'rpc.retention',
    name: 'RPC retention window',
    async run({ deps }) {
      const win = await deps.rpc.retentionWindow();
      const span = win.latestLedger - win.oldestLedger;
      if (span <= 0) {
        return {
          status: 'warn',
          message: 'retention window is empty or unknown',
          hint: 'Confirm the RPC node is fully synced.',
          details: win,
        };
      }
      return {
        status: 'pass',
        message: `retention window ${span} ledgers (${win.oldestLedger}..${win.latestLedger})`,
        details: win,
      };
    },
  },
  {
    id: 'kubo.reachability',
    name: 'Kubo reachability',
    async run({ env, deps }) {
      const info = await deps.kubo.reachable();
      return {
        status: 'pass',
        message: `reachable at ${redactUrl(env.KUBO_URL)} (version ${info.version})`,
        details: { version: info.version },
      };
    },
  },
  {
    id: 'kubo.auth',
    name: 'Kubo auth',
    async run({ deps }) {
      const ok = await deps.kubo.authOk();
      if (!ok) {
        return {
          status: 'fail',
          message: 'Kubo rejected the request (auth failure)',
          hint: 'Check KUBO_AUTH / API credentials and that the API is enabled.',
        };
      }
      return { status: 'pass', message: 'Kubo auth accepted' };
    },
  },
  {
    id: 'indexer.state',
    name: 'Indexer state',
    async run({ deps }) {
      const state = await deps.indexer.state();
      const lag = state.latestLedger - state.lastIndexedLedger;
      const problems: string[] = [];
      if (state.status !== 'running' && state.status !== 'ok') {
        problems.push(`status=${state.status}`);
      }
      if (state.openGaps > 0) problems.push(`openGaps=${state.openGaps}`);
      if (state.rejectedEvents > 0) problems.push(`rejectedEvents=${state.rejectedEvents}`);
      const details = { ...state, lag };
      if (problems.length > 0) {
        return {
          status: 'warn',
          message: `lag=${lag} ledgers; ${problems.join(', ')}`,
          hint: 'Inspect indexer logs; resolve open gaps and rejected events.',
          details,
        };
      }
      return {
        status: 'pass',
        message: `running, lag=${lag} ledgers, no gaps`,
        details,
      };
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export async function runDoctor(options: DoctorOptions = {}): Promise<{
  results: CheckResult[];
  exitCode: number;
}> {
  const env = options.env ?? process.env;
  const baseDeps = createDefaultDeps(env);
  const deps: DoctorDeps = { ...baseDeps, ...options.deps };
  const ctx: CheckContext = { env, deps };

  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await timed(check, ctx));
  }

  const failed = results.some((r) => r.status === 'fail');
  const exitCode = failed ? 1 : 0;

  const out = options.out ?? process.stdout;
  if (options.json) {
    out.write(`${JSON.stringify({ checks: results, exitCode }, null, 2)}\n`);
  } else {
    out.write(renderTable(results));
  }

  return { results, exitCode };
}

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

export function renderTable(results: CheckResult[]): string {
  const headers = ['STATUS', 'CHECK', 'TIME', 'MESSAGE'];
  const rows = results.map((r) => [
    STATUS_LABEL[r.status],
    r.name,
    `${r.durationMs}ms`,
    r.message,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const fmt = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  const lines: string[] = [];
  lines.push(fmt(headers));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) lines.push(fmt(row));

  const hints = results.filter((r) => r.hint && r.status !== 'pass');
  if (hints.length > 0) {
    lines.push('');
    lines.push('Hints:');
    for (const r of hints) lines.push(`  - ${r.name}: ${r.hint}`);
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  lines.push('');
  lines.push(
    `${results.length} checks, ${failed} failed, ${warned} warnings`,
  );
  return `${lines.join('\n')}\n`;
}

/* -------------------------------------------------------------------------- */
/* CLI entry                                                                  */
/* -------------------------------------------------------------------------- */

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes('--json');
  try {
    const { exitCode } = await runDoctor({ json });
    return exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`doctor: internal error: ${message}\n`);
    return 2;
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  /doctor\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (isDirectRun) {
  main().then((code) => {
    process.exitCode = code;
  });
}
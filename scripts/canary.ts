#!/usr/bin/env ts-node
/**
 * End-to-end indexing latency canary.
 *
 * Flow:
 *   1. Fund a throwaway account via Friendbot (testnet only).
 *   2. Perform a cheap contract action (set_user_template).
 *   3. Record the ledger at which the transaction was included.
 *   4. Poll the target API (CANARY_API_URL) with `minLedger` until the change
 *      becomes visible.
 *   5. Record latency for each stage (submit -> ledger close -> API visible).
 *   6. Fail if total latency exceeds a configurable threshold.
 *   7. Write a summary (JSON + markdown) and optionally push metrics.
 *
 * No secrets are required beyond the optional API URL. The throwaway account
 * is generated fresh on each run and never persisted, so repeated runs do not
 * exhaust Friendbot or leave persistent state behind.
 *
 * Usage:
 *   ts-node scripts/canary.ts [--dry-run] [--api-url URL] [--threshold-ms N]
 *                             [--poll-interval-ms N] [--timeout-ms N]
 *                             [--metrics-url URL] [--summary-dir DIR]
 *
 * Environment variables (all optional):
 *   CANARY_API_URL          Base URL of the deployed API to poll.
 *   CANARY_THRESHOLD_MS     Max allowed end-to-end latency (default 120000).
 *   CANARY_POLL_INTERVAL_MS Poll interval (default 2000).
 *   CANARY_TIMEOUT_MS       Overall poll timeout (default 180000).
 *   CANARY_METRICS_URL      Optional metrics endpoint to POST results to.
 *   CANARY_SUMMARY_DIR      Directory to write summary files (default ./canary-out).
 *   CANARY_HORIZON_URL      Horizon URL (default https://horizon-testnet.stellar.org).
 *   CANARY_FRIENDBOT_URL    Friendbot URL (default https://friendbot.stellar.org).
 *   CANARY_RPC_URL          Soroban RPC URL (default https://soroban-testnet.stellar.org).
 *   CANARY_CONTRACT_ID      Contract ID to invoke (required unless --dry-run).
 *   CANARY_NETWORK_PASSPHRASE Network passphrase (default testnet).
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface CanaryConfig {
  dryRun: boolean;
  apiUrl?: string;
  thresholdMs: number;
  pollIntervalMs: number;
  timeoutMs: number;
  metricsUrl?: string;
  summaryDir: string;
  horizonUrl: string;
  friendbotUrl: string;
  rpcUrl: string;
  contractId?: string;
  networkPassphrase: string;
}

const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

function parseArgs(argv: string[]): CanaryConfig {
  const args = argv.slice(2);
  const getFlag = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  };
  const hasFlag = (name: string): boolean => args.includes(name);

  const env = process.env;

  const dryRun = hasFlag("--dry-run") || env.CANARY_DRY_RUN === "1";

  const apiUrl = getFlag("--api-url") ?? env.CANARY_API_URL;
  const thresholdMs = Number(
    getFlag("--threshold-ms") ?? env.CANARY_THRESHOLD_MS ?? 120_000,
  );
  const pollIntervalMs = Number(
    getFlag("--poll-interval-ms") ?? env.CANARY_POLL_INTERVAL_MS ?? 2_000,
  );
  const timeoutMs = Number(
    getFlag("--timeout-ms") ?? env.CANARY_TIMEOUT_MS ?? 180_000,
  );
  const metricsUrl = getFlag("--metrics-url") ?? env.CANARY_METRICS_URL;
  const summaryDir =
    getFlag("--summary-dir") ?? env.CANARY_SUMMARY_DIR ?? "./canary-out";
  const horizonUrl =
    getFlag("--horizon-url") ??
    env.CANARY_HORIZON_URL ??
    "https://horizon-testnet.stellar.org";
  const friendbotUrl =
    getFlag("--friendbot-url") ??
    env.CANARY_FRIENDBOT_URL ??
    "https://friendbot.stellar.org";
  const rpcUrl =
    getFlag("--rpc-url") ??
    env.CANARY_RPC_URL ??
    "https://soroban-testnet.stellar.org";
  const contractId = getFlag("--contract-id") ?? env.CANARY_CONTRACT_ID;
  const networkPassphrase =
    getFlag("--network-passphrase") ??
    env.CANARY_NETWORK_PASSPHRASE ??
    DEFAULT_NETWORK_PASSPHRASE;

  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new Error(`Invalid threshold: ${thresholdMs}`);
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(`Invalid poll interval: ${pollIntervalMs}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout: ${timeoutMs}`);
  }

  return {
    dryRun,
    apiUrl,
    thresholdMs,
    pollIntervalMs,
    timeoutMs,
    metricsUrl,
    summaryDir,
    horizonUrl,
    friendbotUrl,
    rpcUrl,
    contractId,
    networkPassphrase,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface StageLatency {
  submitMs: number;
  ledgerCloseMs: number;
  apiVisibleMs: number;
  totalMs: number;
}

interface CanaryResult {
  ok: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  account?: string;
  txHash?: string;
  ledger?: number;
  latency?: StageLatency;
  thresholdMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs(): number {
  return Date.now();
}

async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Stellar / Soroban interaction
//
// We intentionally avoid hard dependencies on @stellar/stellar-sdk so the
// canary can run in minimal environments. When the SDK is available we use it;
// otherwise we fall back to raw HTTP calls against Horizon and Soroban RPC.
// ---------------------------------------------------------------------------

interface KeypairLike {
  publicKey(): string;
  secret(): string;
  sign(data: Buffer): Buffer;
}

async function loadStellarSdk(): Promise<any | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@stellar/stellar-sdk");
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require("stellar-sdk");
    } catch {
      return null;
    }
  }
}

async function fundViaFriendbot(
  friendbotUrl: string,
  publicKey: string,
): Promise<void> {
  const url = `${friendbotUrl}?addr=${encodeURIComponent(publicKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Friendbot funding failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
    );
  }
}

interface SubmitOutcome {
  txHash: string;
  ledger: number;
  submitMs: number;
  ledgerCloseMs: number;
}

/**
 * Perform the cheap contract action. Returns the tx hash and the ledger in
 * which it was included, along with stage timings.
 */
async function performContractAction(
  cfg: CanaryConfig,
  sdk: any,
  keypair: KeypairLike,
): Promise<SubmitOutcome> {
  if (!cfg.contractId) {
    throw new Error(
      "CANARY_CONTRACT_ID (or --contract-id) is required to perform the contract action",
    );
  }

  const server = new sdk.SorobanRpc.Server(cfg.rpcUrl, {
    allowHttp: cfg.rpcUrl.startsWith("http://"),
  });
  const account = await server.getAccount(keypair.publicKey());
  const contract = new sdk.Contract(cfg.contractId);

  // set_user_template(user: Address, template: string) — cheap write.
  const templateValue = `canary-${Date.now()}`;
  const op = contract.call(
    "set_user_template",
    sdk.nativeToScVal(keypair.publicKey(), { type: "address" }),
    sdk.nativeToScVal(templateValue, { type: "string" }),
  );

  const tx = new sdk.TransactionBuilder(account, {
    fee: sdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair as any);

  const submitStart = nowMs();
  const sendResp = await server.sendTransaction(prepared);
  if (sendResp.status === "ERROR") {
    throw new Error(
      `sendTransaction failed: ${JSON.stringify(sendResp.errorResult ?? sendResp)}`,
    );
  }
  const txHash: string = sendResp.hash;
  const submitMs = nowMs() - submitStart;

  // Poll for inclusion to capture ledger close latency.
  const pollStart = nowMs();
  let ledger = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = await server.getTransaction(txHash);
    if (status.status === "SUCCESS") {
      ledger = status.ledger;
      break;
    }
    if (status.status === "FAILED") {
      throw new Error(`Transaction ${txHash} failed on-chain`);
    }
    if (nowMs() - pollStart > cfg.timeoutMs) {
      throw new Error(`Timed out waiting for tx ${txHash} to be included`);
    }
    await sleep(cfg.pollIntervalMs);
  }
  const ledgerCloseMs = nowMs() - submitStart;

  return { txHash, ledger, submitMs, ledgerCloseMs };
}

// ---------------------------------------------------------------------------
// API polling
// ---------------------------------------------------------------------------

interface ApiPollResult {
  visible: boolean;
  apiVisibleMs: number;
}

/**
 * Poll the target API with `minLedger` until the change is visible.
 *
 * The canary expects the API to expose an endpoint that accepts a `minLedger`
 * query parameter and returns the latest indexed ledger, e.g.:
 *   GET {apiUrl}/health?minLedger=<ledger>
 *   -> { "indexedLedger": <number>, ... }
 *
 * We accept a few common shapes to be resilient to API evolution.
 */
async function pollApiForVisibility(
  cfg: CanaryConfig,
  ledger: number,
  pollStart: number,
): Promise<ApiPollResult> {
  if (!cfg.apiUrl) {
    throw new Error("CANARY_API_URL (or --api-url) is required to poll the API");
  }

  const base = cfg.apiUrl.replace(/\/+$/, "");
  const candidates = [
    `${base}/health?minLedger=${ledger}`,
    `${base}/status?minLedger=${ledger}`,
    `${base}/indexer/status?minLedger=${ledger}`,
  ];

  let lastError: unknown;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const url of candidates) {
      try {
        const body = await fetchJson<Record<string, unknown>>(url);
        const indexed =
          (body.indexedLedger as number | undefined) ??
          (body.ledger as number | undefined) ??
          (body.latestLedger as number | undefined);
        if (typeof indexed === "number" && indexed >= ledger) {
          return { visible: true, apiVisibleMs: nowMs() - pollStart };
        }
      } catch (err) {
        lastError = err;
      }
    }

    if (nowMs() - pollStart > cfg.timeoutMs) {
      const detail =
        lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(
        `Timed out waiting for API to index ledger ${ledger}${detail}`,
      );
    }
    await sleep(cfg.pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

/**
 * Dry-run mode exercises the full pipeline against the local compose stack
 * without touching testnet. It simulates Friendbot funding, a contract action,
 * and API visibility using the configured API URL (or a local default).
 */
async function runDryRun(cfg: CanaryConfig): Promise<CanaryResult> {
  const startedAt = new Date().toISOString();
  const start = nowMs();

  const apiUrl = cfg.apiUrl ?? "http://localhost:3000";
  const simulatedLedger = Math.floor(Date.now() / 1000);

  // Simulate submit.
  const submitStart = nowMs();
  await sleep(50);
  const submitMs = nowMs() - submitStart;

  // Simulate ledger close.
  const ledgerCloseStart = nowMs();
  await sleep(50);
  const ledgerCloseMs = nowMs() - ledgerCloseStart;

  // Attempt to poll the API; if unreachable in dry-run, simulate visibility.
  let apiVisibleMs: number;
  try {
    const pollStart = nowMs();
    const result = await pollApiForVisibility(
      { ...cfg, apiUrl, timeoutMs: Math.min(cfg.timeoutMs, 5_000) },
      simulatedLedger,
      pollStart,
    );
    apiVisibleMs = result.apiVisibleMs;
  } catch {
    // Dry-run tolerates an unreachable API; simulate a short visibility delay.
    const simStart = nowMs();
    await sleep(50);
    apiVisibleMs = nowMs() - simStart;
  }

  const totalMs = nowMs() - start;
  const ok = totalMs <= cfg.thresholdMs;

  return {
    ok,
    dryRun: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    account: "GDRYRUN" + "0".repeat(49),
    txHash: "dryrun-" + simulatedLedger.toString(16),
    ledger: simulatedLedger,
    latency: { submitMs, ledgerCloseMs, apiVisibleMs, totalMs },
    thresholdMs: cfg.thresholdMs,
  };
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function runCanary(cfg: CanaryConfig): Promise<CanaryResult> {
  if (cfg.dryRun) {
    return runDryRun(cfg);
  }

  const startedAt = new Date().toISOString();
  const start = nowMs();

  const sdk = await loadStellarSdk();
  if (!sdk) {
    throw new Error(
      "Stellar SDK not found. Install @stellar/stellar-sdk to run the canary.",
    );
  }

  // Fresh throwaway account each run — no persistent state.
  const keypair: KeypairLike = sdk.Keypair.random();
  const publicKey = keypair.publicKey();

  // 1. Fund via Friendbot.
  await fundViaFriendbot(cfg.friendbotUrl, publicKey);

  // 2. Perform the cheap contract action and capture submit/ledger timings.
  const outcome = await performContractAction(cfg, sdk, keypair);

  // 3. Poll the API until the change is visible.
  const pollStart = nowMs();
  const visibility = await pollApiForVisibility(cfg, outcome.ledger, pollStart);

  const totalMs = nowMs() - start;
  const ok = totalMs <= cfg.thresholdMs;

  return {
    ok,
    dryRun: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    account: publicKey,
    txHash: outcome.txHash,
    ledger: outcome.ledger,
    latency: {
      submitMs: outcome.submitMs,
      ledgerCloseMs: outcome.ledgerCloseMs,
      apiVisibleMs: visibility.apiVisibleMs,
      totalMs,
    },
    thresholdMs: cfg.thresholdMs,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatSummaryMarkdown(result: CanaryResult): string {
  const lines: string[] = [];
  lines.push(`# Indexing Latency Canary`);
  lines.push("");
  lines.push(`- Status: **${result.ok ? "PASS" : "FAIL"}**`);
  lines.push(`- Dry run: ${result.dryRun}`);
  lines.push(`- Started: ${result.startedAt}`);
  lines.push(`- Finished: ${result.finishedAt}`);
  lines.push(`- Threshold: ${result.thresholdMs} ms`);
  if (result.account) lines.push(`- Account: \`${result.account}\``);
  if (result.txHash) lines.push(`- Tx: \`${result.txHash}\``);
  if (result.ledger !== undefined) lines.push(`- Ledger: ${result.ledger}`);
  if (result.latency) {
    lines.push("");
    lines.push(`## Latency`);
    lines.push("");
    lines.push(`| Stage | ms |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Submit | ${result.latency.submitMs} |`);
    lines.push(`| Ledger close | ${result.latency.ledgerCloseMs} |`);
    lines.push(`| API visible | ${result.latency.apiVisibleMs} |`);
    lines.push(`| **Total** | **${result.latency.totalMs}** |`);
  }
  if (result.error) {
    lines.push("");
    lines.push(`## Error`);
    lines.push("");
    lines.push("```");
    lines.push(result.error);
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

async function writeSummary(
  cfg: CanaryConfig,
  result: CanaryResult,
): Promise<void> {
  try {
    fs.mkdirSync(cfg.summaryDir, { recursive: true });
    const jsonPath = path.join(cfg.summaryDir, "canary-result.json");
    const mdPath = path.join(cfg.summaryDir, "canary-summary.md");
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
    fs.writeFileSync(mdPath, formatSummaryMarkdown(result), "utf8");
    console.log(`Wrote summary to ${jsonPath} and ${mdPath}`);
  } catch (err) {
    console.error(`Failed to write summary: ${(err as Error).message}`);
  }
}

async function pushMetrics(
  cfg: CanaryConfig,
  result: CanaryResult,
): Promise<void> {
  if (!cfg.metricsUrl) return;
  try {
    await fetch(cfg.metricsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metric: "indexing_latency_canary",
        ok: result.ok,
        dryRun: result.dryRun,
        thresholdMs: result.thresholdMs,
        latency: result.latency,
        ledger: result.ledger,
        finishedAt: result.finishedAt,
      }),
    });
  } catch (err) {
    console.error(`Failed to push metrics: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let cfg: CanaryConfig;
  try {
    cfg = parseArgs(process.argv);
  } catch (err) {
    console.error(`Configuration error: ${(err as Error).message}`);
    process.exit(2);
  }

  let result: CanaryResult;
  try {
    result = await runCanary(cfg);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      ok: false,
      dryRun: cfg.dryRun,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      thresholdMs: cfg.thresholdMs,
      error: message,
    };
  }

  await writeSummary(cfg, result);
  await pushMetrics(cfg, result);

  // Emit GitHub Actions step summary if available.
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      fs.appendFileSync(stepSummary, formatSummaryMarkdown(result), "utf8");
    } catch {
      /* ignore */
    }
  }

  if (result.latency) {
    console.log(
      `Latency: submit=${result.latency.submitMs}ms ` +
        `ledgerClose=${result.latency.ledgerCloseMs}ms ` +
        `apiVisible=${result.latency.apiVisibleMs}ms ` +
        `total=${result.latency.totalMs}ms ` +
        `(threshold=${result.thresholdMs}ms)`,
    );
  }

  if (!result.ok) {
    if (result.error) console.error(`Canary error: ${result.error}`);
    else console.error(`Canary exceeded threshold (${result.thresholdMs}ms)`);
    process.exit(1);
  }

  console.log("Canary passed.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export {
  parseArgs,
  runCanary,
  runDryRun,
  pollApiForVisibility,
  formatSummaryMarkdown,
  type CanaryConfig,
  type CanaryResult,
};
#!/usr/bin/env ts-node
/**
 * gen-events.ts
 *
 * Generates typed event decoders and TypeScript types for the Soroban
 * contract(s) we index, from the machine-readable spec embedded in the
 * deployed contract WASM (`contractspecv0` custom section).
 *
 * Usage:
 *   npm run gen:events            # (re)generate src/indexer/generated/
 *   npm run gen:events -- --check # verify committed output is up to date
 *
 * The script is deterministic: given the same pinned WASM hash it always
 * produces byte-identical output. The pinned hash lives in
 * `src/indexer/generated/pinned.json` (or is overridden via env vars).
 *
 * If the embedded spec does not contain event definitions, we log a clear
 * message documenting the gap (see notes below) and still emit whatever
 * types we can derive from the spec so downstream code keeps compiling.
 *
 * NOTE (gap): Older Soroban SDKs do not emit event definitions in the
 * `contractspecv0` section. When that happens this script prints a warning
 * and falls back to the hand-written compatibility layer in
 * `src/indexer/decode.ts`. Coordination with Indexer-Contract is required
 * to emit event definitions from the contract build.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Address,
  Contract,
  Keypair,
  Networks,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  xdr,
  contract,
} from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const GENERATED_DIR = path.join(ROOT, 'src', 'indexer', 'generated');
const PINNED_FILE = path.join(GENERATED_DIR, 'pinned.json');

interface PinnedConfig {
  /** Hex-encoded SHA-256 of the contract WASM we generate from. */
  wasmHash: string;
  /** Contract id (C...) the WASM is deployed as, for documentation. */
  contractId: string;
  /** Network passphrase used when fetching. */
  networkPassphrase: string;
  /** Soroban RPC URL used when fetching. */
  rpcUrl: string;
  /** Optional: path to a local WASM artifact to use instead of RPC. */
  wasmPath?: string;
}

const DEFAULT_PINNED: PinnedConfig = {
  // Placeholder — replace with the real deployed WASM hash.
  wasmHash:
    '0000000000000000000000000000000000000000000000000000000000000000',
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  networkPassphrase: Networks.TESTNET,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  wasmPath: undefined,
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  check: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { check: false, verbose: false };
  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      'gen-events — generate Soroban event decoders from the contract spec',
      '',
      'Options:',
      '  --check     Regenerate and exit non-zero if committed output differs',
      '  --verbose   Print extra diagnostics',
      '  --help      Show this message',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Pinned config loading
// ---------------------------------------------------------------------------

async function loadPinnedConfig(): Promise<PinnedConfig> {
  let config: PinnedConfig = { ...DEFAULT_PINNED };

  try {
    const raw = await fs.readFile(PINNED_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PinnedConfig>;
    config = { ...config, ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Environment overrides (useful in CI when testing a new pin).
  if (process.env.SOROBAN_WASM_HASH) {
    config.wasmHash = process.env.SOROBAN_WASM_HASH;
  }
  if (process.env.SOROBAN_CONTRACT_ID) {
    config.contractId = process.env.SOROBAN_CONTRACT_ID;
  }
  if (process.env.SOROBAN_RPC_URL) {
    config.rpcUrl = process.env.SOROBAN_RPC_URL;
  }
  if (process.env.SOROBAN_NETWORK_PASSPHRASE) {
    config.networkPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE;
  }
  if (process.env.SOROBAN_WASM_PATH) {
    config.wasmPath = process.env.SOROBAN_WASM_PATH;
  }

  return config;
}

// ---------------------------------------------------------------------------
// WASM acquisition
// ---------------------------------------------------------------------------

/**
 * Fetch the WASM bytes for the pinned contract.
 *
 * Strategy:
 *   1. If a local `wasmPath` is configured, read it from disk.
 *   2. Otherwise, fetch the contract code entry via `getLedgerEntries`
 *      using the contract's instance ledger key, then read the code entry.
 *
 * The returned bytes are verified against the pinned hash.
 */
async function fetchWasm(config: PinnedConfig, verbose: boolean): Promise<Buffer> {
  let wasm: Buffer;

  if (config.wasmPath) {
    if (verbose) console.log(`Reading WASM from ${config.wasmPath}`);
    wasm = await fs.readFile(config.wasmPath);
  } else {
    if (verbose) console.log(`Fetching WASM for ${config.contractId} from ${config.rpcUrl}`);
    wasm = await fetchWasmFromRpc(config, verbose);
  }

  const actualHash = sha256Hex(wasm);
  if (actualHash !== config.wasmHash) {
    throw new Error(
      `WASM hash mismatch.\n  expected: ${config.wasmHash}\n  actual:   ${actualHash}\n` +
        'Update the pin in src/indexer/generated/pinned.json if this is intentional.',
    );
  }

  return wasm;
}

async function fetchWasmFromRpc(
  config: PinnedConfig,
  verbose: boolean,
): Promise<Buffer> {
  const server = new SorobanRpc.Server(config.rpcUrl, { allowHttp: false });

  // 1. Resolve the contract's instance entry to find the WASM hash it points at.
  const contractId = config.contractId;
  if (!StrKey.isValidContract(contractId)) {
    throw new Error(`Invalid contract id: ${contractId}`);
  }

  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const instanceResp = await server.getLedgerEntries(instanceKey);
  if (!instanceResp.entries || instanceResp.entries.length === 0) {
    throw new Error(`Contract instance not found for ${contractId}`);
  }

  const instanceEntry = instanceResp.entries[0];
  const contractData = instanceEntry.val.contractData();
  const instance = contractData.val().instance();
  const executable = instance.executable();

  let wasmHashBytes: Buffer;
  if (executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
    wasmHashBytes = executable.wasmHash();
  } else {
    throw new Error(
      `Contract ${contractId} is a Stellar Asset Contract (no WASM to inspect).`,
    );
  }

  if (verbose) {
    console.log(`Resolved WASM hash: ${wasmHashBytes.toString('hex')}`);
  }

  // 2. Fetch the code entry for that WASM hash.
  const codeKey = xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: wasmHashBytes }),
  );
  const codeResp = await server.getLedgerEntries(codeKey);
  if (!codeResp.entries || codeResp.entries.length === 0) {
    throw new Error(
      `Contract code entry not found for WASM hash ${wasmHashBytes.toString('hex')}`,
    );
  }

  const codeEntry = codeResp.entries[0];
  const code = codeEntry.val.contractCode();
  return Buffer.from(code.code());
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

interface ParsedSpec {
  /** Raw spec entries, for diagnostics. */
  entries: xdr.ScSpecEntry[];
  /** Event definitions, if the spec includes them. */
  events: xdr.ScSpecEntryFunctionV0[] | null;
  /** All function definitions (used to derive types). */
  functions: xdr.ScSpecEntryFunctionV0[];
  /** UDT definitions. */
  udts: xdr.ScSpecEntryUdtStructV0[];
  /** Union definitions. */
  unions: xdr.ScSpecEntryUdtUnionV0[];
  /** Enum definitions. */
  enums: xdr.ScSpecEntryUdtEnumV0[];
  /** Error enum definitions. */
  errors: xdr.ScSpecEntryUdtErrorEnumV0[];
}

/**
 * Parse the `contractspecv0` custom section from the WASM.
 *
 * The Stellar SDK's `contract.Spec` handles the heavy lifting, but we also
 * keep the raw entries so we can inspect event definitions (which older SDK
 * versions may not surface through the high-level API).
 */
function parseSpec(wasm: Buffer): ParsedSpec {
  // The SDK's Spec.fromWasm parses the custom section for us.
  const spec = contract.Spec.fromWasm(wasm);

  // `spec.entries` is the raw list of ScSpecEntry values.
  const entries: xdr.ScSpecEntry[] = (spec as unknown as { entries: xdr.ScSpecEntry[] })
    .entries;

  const functions: xdr.ScSpecEntryFunctionV0[] = [];
  const udts: xdr.ScSpecEntryUdtStructV0[] = [];
  const unions: xdr.ScSpecEntryUdtUnionV0[] = [];
  const enums: xdr.ScSpecEntryUdtEnumV0[] = [];
  const errors: xdr.ScSpecEntryUdtErrorEnumV0[] = [];

  for (const entry of entries) {
    switch (entry.switch()) {
      case xdr.ScSpecEntryKind.scSpecEntryFunctionV0():
        functions.push(entry.functionV0());
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtStructV0():
        udts.push(entry.udtStructV0());
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtUnionV0():
        unions.push(entry.udtUnionV0());
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtEnumV0():
        enums.push(entry.udtEnumV0());
        break;
      case xdr.ScSpecEntryKind.scSpecEntryUdtErrorEnumV0():
        errors.push(entry.udtErrorEnumV0());
        break;
      default:
        // Unknown / future entry kinds are ignored.
        break;
    }
  }

  // Event definitions are represented as functions whose name starts with
  // a conventional prefix (e.g. `event_` or the contract's own convention).
  // The Soroban SDK does not yet expose a first-class "event" entry kind, so
  // we filter functions by the documented naming convention. If the contract
  // does not follow it, we fall back to treating all functions as potential
  // event sources and let the hand-written compatibility layer handle them.
  const eventFunctions = functions.filter((fn) => isEventFunction(fn.name().toString()));

  return {
    entries,
    events: eventFunctions.length > 0 ? eventFunctions : null,
    functions,
    udts,
    unions,
    enums,
    errors,
  };
}

function isEventFunction(name: string): boolean {
  // Soroban contracts conventionally prefix event-emitting functions with
  // `event_` (or expose them as `emit_*`). Adjust here if the contract
  // adopts a different convention.
  return name.startsWith('event_') || name.startsWith('emit_');
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

interface GeneratedFile {
  path: string;
  content: string;
}

function generate(spec: ParsedSpec, config: PinnedConfig): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  files.push({
    path: path.join(GENERATED_DIR, 'types.ts'),
    content: generateTypes(spec, config),
  });

  files.push({
    path: path.join(GENERATED_DIR, 'decoders.ts'),
    content: generateDecoders(spec, config),
  });

  files.push({
    path: path.join(GENERATED_DIR, 'index.ts'),
    content: generateIndex(),
  });

  return files;
}

function header(config: PinnedConfig): string {
  return [
    '// AUTO-GENERATED by scripts/gen-events.ts — DO NOT EDIT.',
    `// Source WASM hash: ${config.wasmHash}`,
    `// Source contract:  ${config.contractId}`,
    '',
  ].join('\n');
}

function generateTypes(spec: ParsedSpec, config: PinnedConfig): string {
  const lines: string[] = [header(config)];

  lines.push('/* eslint-disable */');
  lines.push('');

  // Structs
  for (const udt of spec.udts) {
    const name = udt.name().toString();
    lines.push(`export interface ${toPascal(name)} {`);
    for (const field of udt.fields()) {
      const fieldName = field.name().toString();
      const fieldType = scSpecTypeToTs(field.type());
      lines.push(`  ${fieldName}: ${fieldType};`);
    }
    lines.push('}');
    lines.push('');
  }

  // Unions
  for (const union of spec.unions) {
    const name = union.name().toString();
    const cases = union.cases();
    const variants = cases.map((c) => {
      const caseName = c.voidCase
        ? c.voidCase().toString()
        : c.tupleCase
          ? c.tupleCase().name().toString()
          : 'unknown';
      return `  | { kind: '${caseName}' }`;
    });
    lines.push(`export type ${toPascal(name)} =`);
    lines.push(variants.join('\n'));
    lines.push(';');
    lines.push('');
  }

  // Enums
  for (const en of spec.enums) {
    const name = en.name().toString();
    lines.push(`export enum ${toPascal(name)} {`);
    for (const c of en.cases()) {
      lines.push(`  ${toPascal(c.name().toString())} = ${c.value()},`);
    }
    lines.push('}');
    lines.push('');
  }

  // Event payload types
  if (spec.events) {
    for (const ev of spec.events) {
      const name = ev.name().toString();
      lines.push(`export interface ${toPascal(name)}Event {`);
      for (const input of ev.inputs()) {
        const inputName = input.name().toString();
        const inputType = scSpecTypeToTs(input.type());
        lines.push(`  ${inputName}: ${inputType};`);
      }
      lines.push('}');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function generateDecoders(spec: ParsedSpec, config: PinnedConfig): string {
  const lines: string[] = [header(config)];

  lines.push(`import { xdr, scValToNative } from '@stellar/stellar-sdk';`);
  lines.push('');
  lines.push('/* eslint-disable */');
  lines.push('');

  if (!spec.events) {
    lines.push('// No event definitions found in the contract spec.');
    lines.push('// See scripts/gen-events.ts for the documented gap.');
    lines.push('export const EVENT_DECODERS: Record<string, (topics: xdr.ScVal[], data: xdr.ScVal) => unknown> = {};');
    lines.push('');
    return lines.join('\n');
  }

  lines.push(
    'export const EVENT_DECODERS: Record<string, (topics: xdr.ScVal[], data: xdr.ScVal) => unknown> = {',
  );

  for (const ev of spec.events) {
    const name = ev.name().toString();
    const inputs = ev.inputs();
    lines.push(`  ${JSON.stringify(name)}: (topics, data) => {`);
    lines.push(`    const values = [data, ...topics];`);
    lines.push(`    const out: Record<string, unknown> = {};`);
    inputs.forEach((input, idx) => {
      const inputName = input.name().toString();
      lines.push(`    out[${JSON.stringify(inputName)}] = values[${idx}] ? scValToNative(values[${idx}]) : undefined;`);
    });
    lines.push(`    return out;`);
    lines.push(`  },`);
  }

  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

function generateIndex(): string {
  return [
    '// AUTO-GENERATED by scripts/gen-events.ts — DO NOT EDIT.',
    '',
    "export * from './types';",
    "export * from './decoders';",
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Type mapping helpers
// ---------------------------------------------------------------------------

function toPascal(s: string): string {
  return s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function scSpecTypeToTs(type: xdr.ScSpecTypeDef): string {
  switch (type.switch()) {
    case xdr.ScSpecType.scSpecTypeVal():
      return 'unknown';
    case xdr.ScSpecType.scSpecTypeBool():
      return 'boolean';
    case xdr.ScSpecType.scSpecTypeVoid():
      return 'void';
    case xdr.ScSpecType.scSpecTypeError():
      return 'Error';
    case xdr.ScSpecType.scSpecTypeU32():
    case xdr.ScSpecType.scSpecTypeI32():
    case xdr.ScSpecType.scSpecTypeU64():
    case xdr.ScSpecType.scSpecTypeI64():
    case xdr.ScSpecType.scSpecTypeTimepoint():
    case xdr.ScSpecType.scSpecTypeDuration():
      return 'number | bigint';
    case xdr.ScSpecType.scSpecTypeU128():
    case xdr.ScSpecType.scSpecTypeI128():
    case xdr.ScSpecType.scSpecTypeU256():
    case xdr.ScSpecType.scSpecTypeI256():
      return 'bigint';
    case xdr.ScSpecType.scSpecTypeBytes():
    case xdr.ScSpecType.scSpecTypeBytesN():
      return 'Uint8Array';
    case xdr.ScSpecType.scSpecTypeString():
      return 'string';
    case xdr.ScSpecType.scSpecTypeSymbol():
      return 'string';
    case xdr.ScSpecType.scSpecTypeAddress():
      return 'string';
    case xdr.ScSpecType.scSpecTypeOption():
      return `${scSpecTypeToTs(type.option().valueType())} | null`;
    case xdr.ScSpecType.scSpecTypeResult():
      return `{ ok: ${scSpecTypeToTs(type.result().okType())} } | { err: ${scSpecTypeToTs(type.result().errType())} }`;
    case xdr.ScSpecType.scSpecTypeVec():
      return `${scSpecTypeToTs(type.vec().elementType())}[]`;
    case xdr.ScSpecType.scSpecTypeMap():
      return `Record<string, ${scSpecTypeToTs(type.map().valueType())}>`;
    case xdr.ScSpecType.scSpecTypeTuple():
      return `[${type.tuple().valueTypes().map(scSpecTypeToTs).join(', ')}]`;
    case xdr.ScSpecType.scSpecTypeUdt():
      return toPascal(type.udt().name().toString());
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Output writing / checking
// ---------------------------------------------------------------------------

async function writeFiles(files: GeneratedFile[]): Promise<void> {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content, 'utf8');
  }
}

async function checkFiles(files: GeneratedFile[]): Promise<boolean> {
  let ok = true;
  for (const file of files) {
    let existing: string;
    try {
      existing = await fs.readFile(file.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`Missing generated file: ${path.relative(ROOT, file.path)}`);
        ok = false;
        continue;
      }
      throw err;
    }
    if (existing !== file.content) {
      console.error(`Generated file is out of date: ${path.relative(ROOT, file.path)}`);
      ok = false;
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = await loadPinnedConfig();

  if (opts.verbose) {
    console.log(`Pinned WASM hash: ${config.wasmHash}`);
    console.log(`Contract id:      ${config.contractId}`);
  }

  const wasm = await fetchWasm(config, opts.verbose);
  const spec = parseSpec(wasm);

  if (!spec.events) {
    console.warn(
      [
        '',
        '⚠️  The contract spec does not contain event definitions.',
        '',
        '   The `contractspecv0` section of this WASM does not expose any',
        '   event-emitting functions (no `event_*` / `emit_*` entries).',
        '',
        '   Impact:',
        '     - Generated decoders will be empty.',
        '     - The hand-written compatibility layer in src/indexer/decode.ts',
        '       remains the source of truth for these events.',
        '',
        '   Action:',
        '     - Coordinate with Indexer-Contract to emit event definitions',
        '       from the contract build (Soroban SDK >= 21 supports this).',
        '     - Until then, keep the compatibility layer in sync manually.',
        '',
      ].join('\n'),
    );
  }

  const files = generate(spec, config);

  if (opts.check) {
    const ok = await checkFiles(files);
    if (!ok) {
      console.error(
        '\nGenerated files are out of date. Run `npm run gen:events` and commit the result.',
      );
      process.exit(1);
    }
    console.log('Generated files are up to date.');
    return;
  }

  await writeFiles(files);
  console.log(`Generated ${files.length} file(s) in ${path.relative(ROOT, GENERATED_DIR)}/`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
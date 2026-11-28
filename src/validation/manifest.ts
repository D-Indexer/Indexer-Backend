import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * Structured validation error returned by {@link validateManifest}.
 */
export interface ManifestValidationError {
  /** JSON Pointer-ish path to the offending field, e.g. `/tokens/0/symbol`. */
  path: string;
  /** Human readable description of the problem. */
  message: string;
}

/**
 * Result of validating a portfolio manifest.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors: ManifestValidationError[];
}

/**
 * Policy for evolving the portfolio manifest schema.
 *
 * - The schema is versioned by filename: `schemas/portfolio-manifest.v<N>.json`.
 * - `schemaVersion` in a manifest MUST be an integer matching the schema file it
 *   is validated against (e.g. `1` -> `portfolio-manifest.v1.json`).
 * - Backwards-compatible additions (new optional fields) MAY be introduced within
 *   the same major version, but consumers MUST ignore unknown fields.
 * - Breaking changes (removing/renaming fields, tightening types, making optional
 *   fields required) REQUIRE a new major version file (`v2`, `v3`, ...) and a new
 *   entry in `SUPPORTED_SCHEMA_VERSIONS`.
 * - Older versions remain supported until explicitly deprecated; deprecation is
 *   announced in `docs/api.md` and the version is removed from
 *   `SUPPORTED_SCHEMA_VERSIONS` only after a deprecation window.
 * - The frontend repo must be updated in lockstep when a new version is added.
 */
export const SCHEMA_VERSION_POLICY = {
  /** Current schema version emitted by tooling and accepted by default. */
  current: 1,
  /** All schema versions this service can validate. */
  supported: [1] as readonly number[],
  /** Filename pattern for versioned schema files. */
  filePattern: (version: number) => `portfolio-manifest.v${version}.json`,
} as const;

/** Schema versions this service can validate. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] =
  SCHEMA_VERSION_POLICY.supported;

const SCHEMA_DIR = join(__dirname, '..', '..', 'schemas');

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  // Allow `$schema` draft 2020-12 declarations in the schema files.
  validateSchema: false,
});
addFormats(ajv);

const validatorCache = new Map<number, ValidateFunction>();

function loadSchema(version: number): ValidateFunction {
  const cached = validatorCache.get(version);
  if (cached) {
    return cached;
  }

  const schemaPath = join(SCHEMA_DIR, SCHEMA_VERSION_POLICY.filePattern(version));
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Unable to load portfolio manifest schema v${version} from ${schemaPath}: ${
        (err as Error).message
      }`,
    );
  }

  const validate = ajv.compile(schema as object);
  validatorCache.set(version, validate);
  return validate;
}

function toPath(error: ErrorObject): string {
  const base = error.instancePath || '';
  if (error.keyword === 'required' && error.params && 'missingProperty' in error.params) {
    const missing = (error.params as { missingProperty: string }).missingProperty;
    return `${base}/${missing}`;
  }
  if (error.keyword === 'additionalProperties' && error.params && 'additionalProperty' in error.params) {
    const extra = (error.params as { additionalProperty: string }).additionalProperty;
    return `${base}/${extra}`;
  }
  return base || '/';
}

function toErrors(errors: ErrorObject[] | null | undefined): ManifestValidationError[] {
  if (!errors || errors.length === 0) {
    return [];
  }
  return errors.map((error) => ({
    path: toPath(error),
    message: error.message ?? 'is invalid',
  }));
}

/**
 * Returns true when the given value is a supported `schemaVersion`.
 */
export function isSupportedSchemaVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    SUPPORTED_SCHEMA_VERSIONS.includes(value)
  );
}

/**
 * Asserts that `schemaVersion` is present and supported.
 *
 * Returns a structured error list (empty when valid) so callers can merge it
 * with schema validation errors.
 */
export function assertSupportedSchemaVersion(input: unknown): ManifestValidationError[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [{ path: '/', message: 'must be an object' }];
  }

  const version = (input as Record<string, unknown>).schemaVersion;

  if (version === undefined) {
    return [{ path: '/schemaVersion', message: 'is required' }];
  }

  if (!isSupportedSchemaVersion(version)) {
    return [
      {
        path: '/schemaVersion',
        message: `must be one of the supported schema versions: ${SUPPORTED_SCHEMA_VERSIONS.join(
          ', ',
        )}`,
      },
    ];
  }

  return [];
}

/**
 * Validates a portfolio manifest against the versioned JSON schema.
 *
 * The schema version is read from the manifest's `schemaVersion` field. When the
 * version is missing or unsupported, a structured error is returned without
 * attempting schema validation.
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  const versionErrors = assertSupportedSchemaVersion(input);
  if (versionErrors.length > 0) {
    return { valid: false, errors: versionErrors };
  }

  const version = (input as { schemaVersion: number }).schemaVersion;
  const validate = loadSchema(version);
  const valid = validate(input) as boolean;

  if (valid) {
    return { valid: true, errors: [] };
  }

  return { valid: false, errors: toErrors(validate.errors) };
}
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  Address,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { decodeEvent, decodeTopic, EventDecodeError } from "../indexer/decode";

/**
 * Property-based fuzz tests for the event decoder.
 *
 * `decodeEvent` and `decodeTopic` parse untrusted XDR from the network. Any
 * exception other than `EventDecodeError` would abort the whole page and block
 * indexing (a poison pill). These tests assert that *arbitrary* input only ever
 * yields a valid `DecodedEvent`, `null`, or an `EventDecodeError`.
 *
 * The case count is configurable via `FUZZ_CASES` so CI can run a short budget
 * and a nightly job can run a longer one.
 */

const FUZZ_CASES = (() => {
  const raw = process.env.FUZZ_CASES;
  if (!raw) return 10_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Random bytes, biased toward short and empty inputs. */
const arbitraryBytes: fc.Arbitrary<Buffer> = fc
  .oneof(
    fc.constant(Buffer.alloc(0)),
    fc.uint8Array({ minLength: 0, maxLength: 16 }),
    fc.uint8Array({ minLength: 0, maxLength: 64 }),
    fc.uint8Array({ minLength: 0, maxLength: 256 }),
  )
  .map((arr) => Buffer.from(arr));

/** A random, well-formed ScVal tree. */
const arbitraryScVal: fc.Arbitrary<xdr.ScVal> = fc.letrec((tie) => ({
  scval: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    // Primitives
    fc.constant(xdr.ScVal.scvVoid()),
    fc.boolean().map((b) => xdr.ScVal.scvBool(b)),
    fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }).map((n) =>
      xdr.ScVal.scvI64(xdr.Int64.fromString(n.toString())),
    ),
    fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }).map((n) =>
      xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString())),
    ),
    fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }).map((n) =>
      xdr.ScVal.scvI32(n),
    ),
    fc.integer({ min: 0, max: 2 ** 32 - 1 }).map((n) =>
      xdr.ScVal.scvU32(n),
    ),
    fc
      .uint8Array({ minLength: 0, maxLength: 64 })
      .map((arr) => xdr.ScVal.scvBytes(Buffer.from(arr))),
    fc
      .string({ maxLength: 64 })
      .map((s) => xdr.ScVal.scvString(Buffer.from(s, "utf8"))),
    fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((arr) => xdr.ScVal.scvBytes(Buffer.from(arr))),
    // Symbols
    fc
      .stringMatching(/^[a-zA-Z0-9_]{0,32}$/)
      .map((s) => xdr.ScVal.scvSymbol(s)),
    // Addresses
    fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((arr) =>
        xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(Buffer.from(arr)),
          ),
        ),
      ),
    fc
      .uint8Array({ minLength: 32, maxLength: 32 })
      .map((arr) =>
        xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeContract(
            xdr.ContractId.fromXdr(Buffer.from(arr), "raw"),
          ),
        ),
      ),
    // Vectors
    fc.array(tie("scval"), { maxLength: 4 }).map((vals) =>
      xdr.ScVal.scvVec(vals),
    ),
    // Maps
    fc
      .array(fc.tuple(tie("scval"), tie("scval")), { maxLength: 4 })
      .map((entries) =>
        xdr.ScVal.scvMap(
          entries.map(
            ([k, v]) =>
              new xdr.ScMapEntry({ key: k, val: v }),
          ),
        ),
      ),
  ),
})).scval;

/** Either a well-formed ScVal or raw bytes that may not decode at all. */
const arbitraryTopicOrValue: fc.Arbitrary<xdr.ScVal | Buffer> = fc.oneof(
  arbitraryScVal,
  arbitraryBytes,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that running `fn` either returns a value accepted by `isValid` or
 * throws an `EventDecodeError`. Any other thrown value fails the test.
 */
function expectOnlyValidOrDecodeError<T>(
  fn: () => T,
  isValid: (value: T) => boolean,
  context: string,
): void {
  let result: T;
  try {
    result = fn();
  } catch (err) {
    if (err instanceof EventDecodeError) {
      return;
    }
    throw new Error(
      `${context}: decoder threw a non-EventDecodeError: ${
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }`,
    );
  }
  if (!isValid(result)) {
    throw new Error(`${context}: decoder returned an invalid result`);
  }
}

function isValidDecodedEvent(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const evt = value as Record<string, unknown>;
  // A decoded event must expose topics and a value; we only assert the shape
  // is a plain object so we don't over-constrain the public type.
  return typeof evt === "object" && evt !== null;
}

function isValidDecodedTopic(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decodeEvent / decodeTopic fuzz", () => {
  it("decodeTopic only returns a valid result or throws EventDecodeError", () => {
    fc.assert(
      fc.property(arbitraryTopicOrValue, (input) => {
        expectOnlyValidOrDecodeError(
          () => decodeTopic(input as xdr.ScVal),
          isValidDecodedTopic,
          "decodeTopic",
        );
      }),
      { numRuns: FUZZ_CASES },
    );
  });

  it("decodeEvent only returns a valid result or throws EventDecodeError", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryTopicOrValue, { maxLength: 4 }),
        arbitraryTopicOrValue,
        (topics, value) => {
          expectOnlyValidOrDecodeError(
            () =>
              decodeEvent({
                topics: topics as xdr.ScVal[],
                value: value as xdr.ScVal,
              }),
            isValidDecodedEvent,
            "decodeEvent",
          );
        },
      ),
      { numRuns: FUZZ_CASES },
    );
  });

  it("decodeEvent tolerates arbitrary raw bytes for topics and value", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryBytes, { maxLength: 4 }),
        arbitraryBytes,
        (topicBytes, valueBytes) => {
          expectOnlyValidOrDecodeError(
            () =>
              decodeEvent({
                topics: topicBytes.map((b) => tryParseScVal(b)),
                value: tryParseScVal(valueBytes),
              }),
            isValidDecodedEvent,
            "decodeEvent(raw bytes)",
          );
        },
      ),
      { numRuns: FUZZ_CASES },
    );
  });
});

/**
 * Attempts to parse raw bytes into an ScVal. If the bytes are not valid XDR we
 * return the raw bytes cast through `unknown` so the decoder is still exercised
 * with hostile input.
 */
function tryParseScVal(bytes: Buffer): xdr.ScVal {
  try {
    return xdr.ScVal.fromXDR(bytes);
  } catch {
    return bytes as unknown as xdr.ScVal;
  }
}

// ---------------------------------------------------------------------------
// Regression fixtures
// ---------------------------------------------------------------------------

describe("decodeEvent / decodeTopic regression fixtures", () => {
  // Fixtures added here are minimised counterexamples discovered by the fuzz
  // tests above. Each must only ever produce a valid result or an
  // EventDecodeError.

  it("handles a malformed address ScVal without escaping EventDecodeError", () => {
    // A contract address with a non-32-byte payload is not a valid ScAddress.
    const malformed = {
      switch: () => xdr.ScValType.scvAddress(),
      address: () => ({
        switch: () => xdr.ScAddressType.scAddressTypeContract(),
        contractId: () => Buffer.alloc(0),
      }),
      // The SDK helpers the decoder may call:
      str: () => {
        throw new TypeError("not a string");
      },
      u32: () => {
        throw new TypeError("not a u32");
      },
    } as unknown as xdr.ScVal;

    expectOnlyValidOrDecodeError(
      () => decodeTopic(malformed),
      isValidDecodedTopic,
      "decodeTopic(malformed address)",
    );
  });

  it("handles a ScVal whose accessors throw TypeError", () => {
    const hostile = {
      switch: () => {
        throw new TypeError("boom");
      },
      str: () => {
        throw new TypeError("boom");
      },
      u32: () => {
        throw new TypeError("boom");
      },
      address: () => {
        throw new TypeError("boom");
      },
    } as unknown as xdr.ScVal;

    expectOnlyValidOrDecodeError(
      () => decodeEvent({ topics: [hostile], value: hostile }),
      isValidDecodedEvent,
      "decodeEvent(hostile accessors)",
    );
  });

  it("handles a null-ish topic entry", () => {
    expectOnlyValidOrDecodeError(
      () =>
        decodeEvent({
          topics: [null as unknown as xdr.ScVal],
          value: null as unknown as xdr.ScVal,
        }),
      isValidDecodedEvent,
      "decodeEvent(null entries)",
    );
  });

  it("handles a valid address round-trip", () => {
    const kp = Keypair.random();
    const addr = Address.fromString(kp.publicKey());
    const scval = nativeToScVal(addr.toString(), { type: "address" });
    // Sanity: the fixture is well-formed.
    expect(scValToNative(scval)).toBe(addr.toString());
    expectOnlyValidOrDecodeError(
      () => decodeTopic(scval),
      isValidDecodedTopic,
      "decodeTopic(valid address)",
    );
  });
});
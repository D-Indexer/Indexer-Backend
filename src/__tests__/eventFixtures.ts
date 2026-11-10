import { Address, xdr } from '@stellar/stellar-sdk';
import type { RawEvent } from '../indexer/rpc';
import fixture from './fixtures/testnet-events.json';

export const TESTNET_CONTRACT = 'CDDQK74SMH4RB4HYLHM6BYZPTAMDMRISHW5Q274KADVZVFD57K43O6KV';
export const OWNER = 'GAPAMTTVHB7RZ5DQHEINZN3GQYRCXXWNCQNQSY5YAU6RKQUYX2QJT2CM';
export const ADMIN = 'GCFADTAQUXYFXUW7G65YXIQTTDORMT72FFTUYFEEUXJZDNAYTD2RXMBZ';

/** Real events emitted by the deployed testnet contract. */
export const testnetEvents: RawEvent[] = fixture.events;

export const sym = (s: string) => xdr.ScVal.scvSymbol(s);
export const str = (s: string) => xdr.ScVal.scvString(s);
export const u32 = (n: number) => xdr.ScVal.scvU32(n);
export const addr = (a: string) => new Address(a).toScVal();

let seq = 0;

/** Build a synthetic RPC event with the contract's encoding: Symbol topic, ScVec data. */
export function makeEvent(
  topic: string,
  fields: xdr.ScVal[] | xdr.ScVal,
  overrides: Partial<RawEvent> = {}
): RawEvent {
  seq++;
  const ledger = overrides.ledger ?? 1000 + seq;
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: '2026-11-09T22:17:47Z',
    contractId: TESTNET_CONTRACT,
    id: `${(BigInt(ledger) << 32n).toString().padStart(19, '0')}-${String(seq).padStart(10, '0')}`,
    txHash: 'ab'.repeat(32),
    topic: [sym(topic).toXDR('base64')],
    value: (Array.isArray(fields) ? xdr.ScVal.scvVec(fields) : fields).toXDR('base64'),
    ...overrides,
  };
}

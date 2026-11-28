import { Address, xdr } from '@stellar/stellar-base';
import type { RawEvent } from './rpc';
import { GENERATED_DECODERS } from './generated/events';

/**
 * Decoders for the Folder contract events documented in Indexer-Contract
 * docs/EVENTS.md. Every event has a single Symbol topic and an ScVec of data
 * fields. Fields are decoded positionally; trailing fields we don't know about
 * are ignored, as the contract only ever appends fields.
 */

/** Thrown when an event can't be decoded. The event is stored as `rejected`. */
export class EventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventDecodeError';
  }
}

export type DecodedEvent =
  | { topic: 'init'; admin: string }
  | { topic: 'adm_add'; admin: string; newAdmin: string }
  | { topic: 'adm_rm'; admin: string; target: string }
  | { topic: 'folder_cl'; owner: string; folderName: string }
  | { topic: 'tmpl_reg'; templateId: number; metadataUri: string; creator: string | null }
  | { topic: 'tmpl_set'; owner: string; templateId: number }
  | { topic: 'port_mint'; owner: string; templateId: number; ipfsCid: string }
  | { topic: 'port_upd'; owner: string; ipfsCid: string };

export type KnownTopic = DecodedEvent['topic'];

function parseScVal(base64: string, what: string): xdr.ScVal {
  try {
    return xdr.ScVal.fromXDR(base64, 'base64');
  } catch {
    throw new EventDecodeError(`${what} is not valid ScVal XDR`);
  }
}

/** Returns topics[0] as a string, or null when it isn't a Symbol. */
export function decodeTopic(event: Pick<RawEvent, 'topic'>): string | null {
  const firstTopic = event.topic[0];
  if (firstTopic === undefined) return null;
  const first = parseScVal(firstTopic, 'topic[0]');
  return first.switch().name === 'scvSymbol' ? first.sym().toString() : null;
}

class Fields {
  constructor(
    private readonly topic: string,
    private readonly values: xdr.ScVal[]
  ) {}

  private at(index: number, name: string): xdr.ScVal {
    const value = this.values[index];
    if (value === undefined) {
      throw new EventDecodeError(`${this.topic}: missing field ${index} (${name})`);
    }
    return value;
  }

  private expect(index: number, name: string, kind: string): xdr.ScVal {
    const value = this.at(index, name);
    if (value.switch().name !== kind) {
      throw new EventDecodeError(
        `${this.topic}: field ${index} (${name}) is ${value.switch().name}, expected ${kind}`
      );
    }
    return value;
  }

  has(index: number): boolean {
    return index < this.values.length;
  }

  address(index: number, name: string): string {
    return Address.fromScVal(this.expect(index, name, 'scvAddress')).toString();
  }

  u32(index: number, name: string): number {
    return this.expect(index, name, 'scvU32').u32();
  }

  string(index: number, name: string): string {
    return this.expect(index, name, 'scvString').str().toString();
  }
}

function dataFields(topic: string, valueXdr: string): Fields {
  const value = parseScVal(valueXdr, `${topic} data`);
  if (value.switch().name !== 'scvVec') {
    throw new EventDecodeError(`${topic}: data is ${value.switch().name}, expected scvVec`);
  }
  return new Fields(topic, value.vec() ?? []);
}

/**
 * Hand-written compatibility layer for legacy event shapes that predate the
 * embedded contract spec (e.g. `tmpl_reg` emitted before `creator` was added).
 * Applied after the generated decoder so the generated output stays canonical.
 */
function applyCompat(decoded: DecodedEvent, f: Fields): DecodedEvent {
  if (decoded.topic === 'tmpl_reg' && !f.has(2)) {
    return { ...decoded, creator: null };
  }
  return decoded;
}

/**
 * Decode a raw RPC event. Returns null for topics this indexer doesn't handle
 * (stored as `ignored`); throws EventDecodeError for malformed known topics.
 */
export function decodeEvent(event: Pick<RawEvent, 'topic' | 'value'>): DecodedEvent | null {
  const topic = decodeTopic(event);
  if (topic === null) return null;
  const generated = GENERATED_DECODERS[topic];
  if (!generated) return null;
  const f = dataFields(topic, event.value);
  return applyCompat(generated(f) as DecodedEvent, f);
}

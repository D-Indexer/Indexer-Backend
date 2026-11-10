import { Address, xdr } from '@stellar/stellar-sdk';
import type { RawEvent } from './rpc';

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
  if (event.topic.length === 0) return null;
  const first = parseScVal(event.topic[0], 'topic[0]');
  return first.switch().name === 'scvSymbol' ? first.sym().toString() : null;
}

class Fields {
  constructor(
    private readonly topic: string,
    private readonly values: xdr.ScVal[]
  ) {}

  private at(index: number, name: string): xdr.ScVal {
    const value = this.values[index];
    if (!value) {
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
 * Decode a raw RPC event. Returns null for topics this indexer doesn't handle
 * (stored as `ignored`); throws EventDecodeError for malformed known topics.
 */
export function decodeEvent(event: Pick<RawEvent, 'topic' | 'value'>): DecodedEvent | null {
  const topic = decodeTopic(event);
  switch (topic) {
    case 'init': {
      const f = dataFields(topic, event.value);
      return { topic, admin: f.address(0, 'admin') };
    }
    case 'adm_add': {
      const f = dataFields(topic, event.value);
      return { topic, admin: f.address(0, 'admin'), newAdmin: f.address(1, 'new_admin') };
    }
    case 'adm_rm': {
      const f = dataFields(topic, event.value);
      return { topic, admin: f.address(0, 'admin'), target: f.address(1, 'target') };
    }
    case 'folder_cl': {
      const f = dataFields(topic, event.value);
      return { topic, owner: f.address(0, 'owner'), folderName: f.string(1, 'folder_name') };
    }
    case 'tmpl_reg': {
      const f = dataFields(topic, event.value);
      return {
        topic,
        templateId: f.u32(0, 'template_id'),
        metadataUri: f.string(1, 'metadata_uri'),
        // `creator` was appended later; older deployments emit two fields.
        creator: f.has(2) ? f.address(2, 'creator') : null,
      };
    }
    case 'tmpl_set': {
      const f = dataFields(topic, event.value);
      return { topic, owner: f.address(0, 'owner'), templateId: f.u32(1, 'template_id') };
    }
    case 'port_mint': {
      const f = dataFields(topic, event.value);
      return {
        topic,
        owner: f.address(0, 'owner'),
        templateId: f.u32(1, 'template_id'),
        ipfsCid: f.string(2, 'ipfs_cid'),
      };
    }
    case 'port_upd': {
      const f = dataFields(topic, event.value);
      return { topic, owner: f.address(0, 'owner'), ipfsCid: f.string(1, 'ipfs_cid') };
    }
    default:
      return null;
  }
}

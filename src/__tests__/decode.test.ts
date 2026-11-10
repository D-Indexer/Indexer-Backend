import { decodeEvent, EventDecodeError } from '../indexer/decode';
import { addr, ADMIN, makeEvent, OWNER, str, testnetEvents, u32 } from './eventFixtures';

describe('decodeEvent', () => {
  it('decodes every event the deployed testnet contract emitted', () => {
    const decoded = testnetEvents.map(decodeEvent);

    expect(decoded.map((e) => e?.topic)).toEqual([
      'init',
      'tmpl_reg',
      'tmpl_reg',
      'tmpl_reg',
      'folder_cl',
      'port_mint',
      'port_upd',
      'folder_cl',
      'port_mint',
      'port_upd',
    ]);
    expect(decoded[0]).toEqual({ topic: 'init', admin: ADMIN });
    expect(decoded[1]).toEqual({
      topic: 'tmpl_reg',
      templateId: 1,
      metadataUri: 'ipfs://bafkreiejxg6d3gqvi3737mcwxkv4u7gismaraxgv5zfoqtfuc3nbdgve7i',
      creator: ADMIN,
    });
    expect(decoded[7]).toEqual({ topic: 'folder_cl', owner: OWNER, folderName: 'smoke-1794262900.folder' });
    expect(decoded[8]).toEqual({
      topic: 'port_mint',
      owner: OWNER,
      templateId: 1,
      ipfsCid: 'bafkreie33ewzcjvpo3gldpvqgevtoy4oaygkqri3cwxqr6o6lsqc4jqvwu',
    });
    expect(decoded[9]).toEqual({
      topic: 'port_upd',
      owner: OWNER,
      ipfsCid: 'bafkreifwfa7v77kn2om36djjtqiwqykldpady3ytsfbqkqgcrfilhjqtnu',
    });
  });

  it('decodes tmpl_set and admin events', () => {
    expect(decodeEvent(makeEvent('tmpl_set', [addr(OWNER), u32(2)]))).toEqual({
      topic: 'tmpl_set',
      owner: OWNER,
      templateId: 2,
    });
    expect(decodeEvent(makeEvent('adm_add', [addr(ADMIN), addr(OWNER)]))).toEqual({
      topic: 'adm_add',
      admin: ADMIN,
      newAdmin: OWNER,
    });
    expect(decodeEvent(makeEvent('adm_rm', [addr(ADMIN), addr(OWNER)]))).toEqual({
      topic: 'adm_rm',
      admin: ADMIN,
      target: OWNER,
    });
  });

  it('accepts tmpl_reg without the appended creator field', () => {
    expect(decodeEvent(makeEvent('tmpl_reg', [u32(4), str('ipfs://x')]))).toMatchObject({
      templateId: 4,
      creator: null,
    });
  });

  it('ignores trailing fields appended in future contract versions', () => {
    expect(decodeEvent(makeEvent('port_upd', [addr(OWNER), str('bafy'), u32(9)]))).toEqual({
      topic: 'port_upd',
      owner: OWNER,
      ipfsCid: 'bafy',
    });
  });

  it('returns null for topics the indexer does not handle', () => {
    expect(decodeEvent(makeEvent('something_new', [u32(1)]))).toBeNull();
  });

  it('rejects a missing field', () => {
    expect(() => decodeEvent(makeEvent('folder_cl', [addr(OWNER)]))).toThrow(
      new EventDecodeError('folder_cl: missing field 1 (folder_name)')
    );
  });

  it('rejects a field of the wrong type', () => {
    expect(() => decodeEvent(makeEvent('port_mint', [addr(OWNER), str('1'), str('cid')]))).toThrow(
      /field 1 \(template_id\) is scvString, expected scvU32/
    );
  });

  it('rejects data that is not a vec', () => {
    expect(() => decodeEvent(makeEvent('init', addr(ADMIN)))).toThrow(/expected scvVec/);
  });

  it('rejects invalid XDR', () => {
    expect(() => decodeEvent({ ...makeEvent('init', [addr(ADMIN)]), value: 'not-xdr' })).toThrow(
      EventDecodeError
    );
  });
});

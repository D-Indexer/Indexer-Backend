import { corsOrigin } from '../app';

describe('corsOrigin', () => {
  it('allows any origin when unset or *', () => {
    expect(corsOrigin({ CORS_ORIGIN: undefined })).toBe(true);
    expect(corsOrigin({ CORS_ORIGIN: '*' })).toBe(true);
  });

  it('returns the allow-list, and denies all for an empty list', () => {
    expect(corsOrigin({ CORS_ORIGIN: 'https://a.app, https://b.app' })).toEqual(['https://a.app', 'https://b.app']);
    expect(corsOrigin({ CORS_ORIGIN: ' , ' })).toBe(false);
  });
});

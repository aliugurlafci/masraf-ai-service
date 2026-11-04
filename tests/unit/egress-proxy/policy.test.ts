import { describe, expect, it } from 'vitest';
import {
  createProxyAuthenticator,
  proxyAuthorizationHeader,
} from '../../../apps/egress-proxy/src/auth.js';
import {
  createHostMatcher,
  isPublicAddress,
  parseConnectTarget,
  parseIPv6,
} from '../../../apps/egress-proxy/src/policy.js';

describe('parseConnectTarget', () => {
  it('accepts authority-form host:port and normalises case and the trailing dot', () => {
    expect(parseConnectTarget('API.Anthropic.com:443')).toEqual({
      host: 'api.anthropic.com',
      port: 443,
      hostType: 'name',
    });
    expect(parseConnectTarget('api.anthropic.com.:443')?.host).toBe('api.anthropic.com');
  });

  it('accepts IPv4 and bracketed IPv6 literals', () => {
    expect(parseConnectTarget('160.79.104.10:443')).toEqual({
      host: '160.79.104.10',
      port: 443,
      hostType: 'ipv4',
    });
    expect(parseConnectTarget('[2606:4700::1111]:443')).toEqual({
      host: '2606:4700::1111',
      port: 443,
      hostType: 'ipv6',
    });
  });

  it.each([
    undefined,
    '',
    'api.anthropic.com',
    'api.anthropic.com:',
    'api.anthropic.com:0',
    'api.anthropic.com:65536',
    'api.anthropic.com:443/path',
    'user@api.anthropic.com:443',
    'api.anthropic.com:44 3',
    '-bad.example.com:443',
    'under_score.example.com:443',
    '2130706433:443',
    '127.1:443',
    '0x7f.0x1:443',
    '[fe80::1%eth0]:443',
    '[::1]443',
    '::1:443',
    `${'a'.repeat(64)}.com:443`,
    `${'a.'.repeat(140)}com:443`,
  ])('rejects %j', (target) => {
    expect(parseConnectTarget(target)).toBeNull();
  });
});

describe('createHostMatcher', () => {
  const matches = createHostMatcher(['api.anthropic.com', '*.example.org', ' Upper.Case.TEST ']);

  it('matches exact entries only', () => {
    expect(matches('api.anthropic.com')).toBe(true);
    expect(matches('API.ANTHROPIC.COM')).toBe(true);
    expect(matches('upper.case.test')).toBe(true);
    expect(matches('evilapi.anthropic.com')).toBe(false);
    expect(matches('x.api.anthropic.com')).toBe(false);
    expect(matches('api.anthropic.com.evil.net')).toBe(false);
    expect(matches('anthropic.com')).toBe(false);
  });

  it('matches *.domain against sub-domains but not the apex or look-alikes', () => {
    expect(matches('a.example.org')).toBe(true);
    expect(matches('a.b.example.org')).toBe(true);
    expect(matches('example.org')).toBe(false);
    expect(matches('badexample.org')).toBe(false);
    expect(matches('example.org.evil.net')).toBe(false);
  });

  it('allows nothing when the list is empty', () => {
    expect(createHostMatcher([])('api.anthropic.com')).toBe(false);
  });
});

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.2.10',
    '192.168.65.2',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '100::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b::192.168.1.1',
    '2001::1',
    '2001:db8::1',
    '2002:c000:0204::1',
    '3fff::1',
    '::127.0.0.1',
  ])('treats %s as non-public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '160.79.104.10',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('treats %s as public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it('rejects anything that is not an IP literal', () => {
    expect(isPublicAddress('api.anthropic.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
    expect(isPublicAddress('1.1.1')).toBe(false);
  });
});

describe('parseIPv6', () => {
  it('expands compressed and dotted forms', () => {
    expect(Array.from(parseIPv6('::1') ?? [])).toEqual([...new Array<number>(15).fill(0), 1]);
    expect(Array.from(parseIPv6('1:2:3:4:5:6:1.2.3.4') ?? [])).toEqual([
      0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 1, 2, 3, 4,
    ]);
    expect(Array.from(parseIPv6('::ffff:1.2.3.4') ?? []).slice(10)).toEqual([
      0xff, 0xff, 1, 2, 3, 4,
    ]);
    expect(Array.from(parseIPv6('64:ff9b::1.2.3.4') ?? []).slice(0, 4)).toEqual([
      0, 0x64, 0xff, 0x9b,
    ]);
  });

  it('returns null for invalid input', () => {
    expect(parseIPv6('1.2.3.4')).toBeNull();
    expect(parseIPv6('fe80::1%eth0')).toBeNull();
    expect(parseIPv6('not-an-ip')).toBeNull();
  });
});

describe('createProxyAuthenticator', () => {
  const token = 'tok_0123456789abcdefABCDEF-_xyz';
  const check = createProxyAuthenticator(token);

  it('accepts Basic orc:<token>', () => {
    expect(check(proxyAuthorizationHeader(token))).toBe(true);
    expect(check(`basic ${Buffer.from(`orc:${token}`).toString('base64')}`)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['wrong token', proxyAuthorizationHeader(`${token}x`)],
    ['wrong user', `Basic ${Buffer.from(`admin:${token}`).toString('base64')}`],
    ['token without user', `Basic ${Buffer.from(token).toString('base64')}`],
    ['bearer scheme', `Bearer ${token}`],
    ['malformed base64', 'Basic ***'],
    ['array value', [proxyAuthorizationHeader(token)]],
    ['oversized', `Basic ${'A'.repeat(2000)}`],
  ])('rejects %s', (_name, header) => {
    expect(check(header)).toBe(false);
  });

  it('accepts everything when no token is configured (development only)', () => {
    expect(createProxyAuthenticator(null)(undefined)).toBe(true);
  });
});

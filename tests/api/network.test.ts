import type { NetworkInterfaceInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isLocalNetworkAddress, isPrivateIPv4, lanAddresses, lanHostList } from '../../src/api/network.ts';

describe('local network rules', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.8.9.10', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.79.16', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.169.0.1', false],
    ['8.8.8.8', false],
    ['169.254.1.1', false],
    ['100.64.0.1', false],
    ['256.168.0.1', false],
    ['192.168.1', false],
    ['', false],
  ])('treats %s as private: %s', (address, expected) => {
    expect(isPrivateIPv4(address)).toBe(expected);
  });

  it.each([
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:192.168.1.20', true],
    ['192.168.1.20', true],
    ['::FFFF:10.1.2.3', true],
    ['::ffff:8.8.8.8', false],
    ['8.8.8.8', false],
    ['2001:db8::1', false],
    [undefined, false],
  ])('lets client %s in: %s', (remote, expected) => {
    expect(isLocalNetworkAddress(remote)).toBe(expected);
  });

  const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceInfo =>
    ({ address, family, internal, netmask: '', mac: '', cidr: null }) as NetworkInterfaceInfo;

  it("lists only the machine's private IPv4 addresses, once each", () => {
    const addresses = lanAddresses({
      'Wi-Fi': [iface('192.168.79.16'), iface('fe80::1', 'IPv6')],
      Loopback: [iface('127.0.0.1', 'IPv4', true)],
      'vEthernet (WSL)': [iface('172.20.224.1')],
      Public: [iface('85.100.1.2')],
      Copy: [iface('192.168.79.16')],
      Empty: undefined,
    });
    expect(addresses).toEqual(['192.168.79.16', '172.20.224.1']);
  });

  it('reads the addresses again after a while, so a new Wi-Fi address works without a restart', () => {
    let clock = 0;
    let current = ['192.168.1.20'];
    const hosts = lanHostList(['Masraf-PC.local'], 30_000, () => current, () => clock);
    expect(hosts()).toEqual(['192.168.1.20', 'masraf-pc.local']);
    current = ['192.168.1.33'];
    clock = 10_000;
    expect(hosts()).toEqual(['192.168.1.20', 'masraf-pc.local']);
    clock = 40_001;
    expect(hosts()).toEqual(['192.168.1.33', 'masraf-pc.local']);
  });
});

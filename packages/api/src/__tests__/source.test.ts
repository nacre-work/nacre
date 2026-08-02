import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'

import { clientSource } from '../source.js'

/**
 * Which client a request came from.
 *
 * The whole value of this is that it cannot be chosen by the caller, so the
 * tests are mostly about a hostile `X-Forwarded-For`: the header is a request
 * header, and a per-client limit keyed on a value the client picks is worse
 * than no limit at all.
 */

const request = (address: string | undefined, xff?: string | string[]): IncomingMessage =>
  ({
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: address },
  }) as unknown as IncomingMessage

describe('clientSource', () => {
  it('uses the socket address and ignores the header by default', () => {
    // The default is trustProxy 0, and this is the case that matters: a client
    // talking straight to the process can put anything in the header.
    expect(clientSource(request('203.0.113.7', '198.51.100.1'), { trustProxy: 0 })).toBe('203.0.113.7')
  })

  it('takes the trusted hop from the right, not the left', () => {
    // Each proxy appends, so the rightmost entries are the ones added by
    // infrastructure and the leftmost is whatever the client sent. Reading
    // hops[0] — the common shorthand — reads exactly the attacker's value.
    const forged = request('10.0.0.1', '1.1.1.1, 2.2.2.2, 203.0.113.7')
    expect(clientSource(forged, { trustProxy: 1 })).toBe('203.0.113.7')
    expect(clientSource(forged, { trustProxy: 2 })).toBe('2.2.2.2')
  })

  it('cannot be pushed past the start of the list', () => {
    // More trusted proxies configured than hops present. Clamped rather than
    // wrapping to undefined: over-restricting is the safe direction.
    expect(clientSource(request('10.0.0.1', '203.0.113.7'), { trustProxy: 4 })).toBe('203.0.113.7')
  })

  it('falls back to the socket when a trusted proxy sent no header', () => {
    // It means the request did not come through the proxy, and then the socket
    // address is the only thing that is true.
    expect(clientSource(request('203.0.113.7'), { trustProxy: 1 })).toBe('203.0.113.7')
    expect(clientSource(request('203.0.113.7', ''), { trustProxy: 1 })).toBe('203.0.113.7')
  })

  it('folds IPv6 to a /64', () => {
    // A single subscriber is handed a /64. Counting whole IPv6 addresses means
    // an attacker with one allocation has more buckets than there are requests
    // in the universe, and the limit does not exist.
    const a = clientSource(request('2001:db8:1234:5678:1:2:3:4'), { trustProxy: 0 })
    const b = clientSource(request('2001:db8:1234:5678:9:a:b:c'), { trustProxy: 0 })
    expect(a).toBe(b)
    expect(a).toBe('2001:db8:1234:5678::/64')

    // And a different /64 is a different bucket.
    expect(clientSource(request('2001:db8:1234:9999::1'), { trustProxy: 0 })).not.toBe(a)
  })

  it('unwraps IPv4-mapped addresses so one client is one bucket', () => {
    // A dual-stack listener reports ::ffff:203.0.113.7 for an IPv4 client.
    // Left wrapped, the same client reaches two buckets depending on how the
    // listener was bound.
    expect(clientSource(request('::ffff:203.0.113.7'), { trustProxy: 0 })).toBe('203.0.113.7')
  })

  it('is undefined when there is nothing to key on', () => {
    // Not a shared bucket. One bucket for every unidentifiable client is a
    // denial of service with extra steps.
    expect(clientSource(request(undefined), { trustProxy: 0 })).toBeUndefined()
  })

  it('handles a repeated header, which node presents as an array', () => {
    expect(clientSource(request('10.0.0.1', ['1.1.1.1', '203.0.113.7']), { trustProxy: 1 })).toBe(
      '203.0.113.7',
    )
  })

  it('drops a zone index, which is not part of the address', () => {
    expect(clientSource(request('fe80::1%eth0'), { trustProxy: 0 })).toBe('fe80:0:0:0::/64')
  })

  it('expands :: into the middle, not into the next position', () => {
    // `fe80::1` splits on ':' into three pieces and the `1` belongs to the END
    // of the address. Treating the pieces as positions puts it at index 2 and
    // yields fe80:0:1:0 — a different /64 from `fe80::2`, when the two are the
    // same subscriber. This is the bug the naive split has.
    expect(clientSource(request('fe80::1'), { trustProxy: 0 })).toBe('fe80:0:0:0::/64')
    expect(clientSource(request('fe80::2'), { trustProxy: 0 })).toBe('fe80:0:0:0::/64')
    expect(clientSource(request('::1'), { trustProxy: 0 })).toBe('0:0:0:0::/64')
  })

  it('is not fooled by two spellings of one group', () => {
    // Leading zeros and case are both optional in the notation. Two spellings
    // must not be two buckets, or the fold is bypassed by writing the address
    // differently every request.
    expect(clientSource(request('2001:0DB8:0000:0001::5'), { trustProxy: 0 })).toBe(
      clientSource(request('2001:db8:0:1::9'), { trustProxy: 0 }),
    )
  })

  it('keeps an unparseable address as its own key rather than guessing', () => {
    // Still a stable key, which is all this has to be. Inventing a prefix for
    // something that is not an address would merge unrelated clients.
    expect(clientSource(request('1::2::3'), { trustProxy: 0 })).toBe('1::2::3')
  })

  it('bounds a header value before it becomes a cache key', () => {
    // With trustProxy set, this string came from a header on an unauthenticated
    // request. A megabyte of X-Forwarded-For must not become a megabyte Redis
    // key, and it must not be truncated either — truncation collapses every
    // long value sharing a prefix into one bucket, which is a way to
    // rate-limit somebody else by guessing their prefix.
    const long = 'a'.repeat(100_000)
    const key = clientSource(request('10.0.0.1', long), { trustProxy: 1 })
    expect(key).toMatch(/^x:[0-9a-f]{24}$/)

    // Same input, same key: it is still a limit and not a random value.
    expect(clientSource(request('10.0.0.1', long), { trustProxy: 1 })).toBe(key)

    // A different value sharing the prefix is a different bucket.
    expect(clientSource(request('10.0.0.1', `${long}b`), { trustProxy: 1 })).not.toBe(key)
  })

  it('leaves a real address alone rather than hashing everything', () => {
    // The point of not hashing is that an operator diagnosing a flood can read
    // the key. An address is not a credential and this is not an email.
    expect(clientSource(request('10.0.0.1', '203.0.113.7'), { trustProxy: 1 })).toBe('203.0.113.7')
  })
})

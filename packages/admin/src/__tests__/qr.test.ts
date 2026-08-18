import * as jsqr from 'jsqr'
import { describe, expect, it } from 'vitest'

import { qrMatrix } from '../qr.js'

/**
 * The encoder, read back by a decoder that did not come from here.
 *
 * ## Why not assert on the matrix
 *
 * A QR encoder checked against its own output agrees with itself and with no
 * phone anybody owns — the fixture-written-to-match-the-code shape this
 * repository has recorded three times. A stored matrix would be worse: it would
 * pin whatever the encoder produced on the day it was written, so a mask chosen
 * differently for a good reason is a failing test and a bit placed one column
 * over is a passing one, forever.
 *
 * So the claim is the one that matters — *a scanner reads back what went in* —
 * and `jsqr` is what makes it. It is a dev-only dependency of a private package
 * and reaches no shipped artifact: the console bundles `packages/admin/src`,
 * and this file is not in it.
 *
 * `jsqr` is a real decoder rather than a mirror of the encoder. It finds the
 * finder patterns, reads the format information, undoes the mask, runs
 * Reed–Solomon over the blocks and reassembles the interleaving. Every one of
 * those is a place this encoder could be wrong, and each would show up here as
 * a decode that fails or returns something else.
 *
 * ## Pixels, because that is what a decoder takes
 *
 * The matrix is scaled to whole pixels with a quiet zone, which is also the one
 * property no unit assertion covers: a symbol with no quiet zone decodes
 * perfectly in an array and not at all through a camera.
 */

/** The matrix as RGBA pixels, scaled, with the four-module quiet zone. */
function pixels(matrix: readonly (readonly boolean[])[], scale = 4, quiet = 4) {
  const size = matrix.length
  const side = (size + quiet * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(0xff)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!matrix[y]![x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (x + quiet) * scale + dx
          const py = (y + quiet) * scale + dy
          const at = (py * side + px) * 4
          data[at] = 0
          data[at + 1] = 0
          data[at + 2] = 0
        }
      }
    }
  }
  return { data, side }
}

/**
 * `jsqr` is CommonJS, and this package compiles under `module: NodeNext` with
 * no `esModuleInterop` — so the compiler types the synthetic default as the
 * whole `module.exports` object while the runner hands over the function. The
 * two genuinely disagree, so the assertion says which one is true at run time
 * and spells out the signature this file depends on rather than inheriting it.
 */
const decodeQr = jsqr.default as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null

const decode = (text: string): string | undefined => {
  const { data, side } = pixels(qrMatrix(text))
  return decodeQr(data, side, side)?.data
}

describe('a QR code this console draws', () => {
  /**
   * The one the feature exists for, at the length a real one has: an issuer
   * that is a URL, an account that is an address, and a base32 secret.
   */
  it('reads back as the otpauth URL that went in', () => {
    const url =
      'otpauth://totp/https%3A%2F%2Fplayground.nacre.work:dana%40example.com' +
      '?secret=UVGOBGZUXKFMVIMNET65LHE3ERGYVCYP&issuer=https%3A%2F%2Fplayground.nacre.work'
    expect(decode(url)).toBe(url)
  })

  /**
   * Version selection, across the two places it changes shape. Eight bytes is
   * version 1; the boundary between an eight-bit and a sixteen-bit length
   * field is between versions 9 and 10, and getting that wrong shifts every
   * bit after it — which still produces a symbol a scanner reads, saying
   * something else. These lengths straddle it.
   */
  it.each([1, 8, 14, 100, 120, 130, 220, 300, 700])('survives %i bytes', (length) => {
    const text = 'nacre'.repeat(200).slice(0, length)
    expect(decode(text)).toBe(text)
  })

  /**
   * A version past 9, which is where the alignment patterns multiply and the
   * version information block appears. Asserted by size rather than by reading
   * a private field: 4v+17, so version 10 is 57 modules.
   */
  it('grows to the version the payload needs', () => {
    expect(qrMatrix('x'.repeat(10)).length).toBe(21)
    expect(qrMatrix('x'.repeat(213)).length).toBe(57)
  })

  /**
   * UTF-8, because an account label is an email address and a display name is
   * whatever somebody is called. Byte mode carries the bytes; the length field
   * counts bytes and not characters, which is the mistake worth pinning.
   */
  it('carries text that is not ASCII', () => {
    const text = 'otpauth://totp/Nacre:дана@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Nacre'
    expect(decode(text)).toBe(text)
  })

  /** Refused rather than truncated, which would be a symbol saying less than it was given. */
  it('refuses what does not fit at all', () => {
    expect(() => qrMatrix('x'.repeat(3000))).toThrow(/does not fit/)
  })
})

import { describe, expect, it } from 'vitest'

import {
  generatePassword,
  PASSWORD_ENTROPY_BITS,
  PASSWORD_WORD_COUNT,
  PASSWORD_WORDS,
} from '../passwords.js'

/**
 * The one generated password, and the number that describes it.
 *
 * `lint:password` asserts there is one implementation. This asserts what that
 * one is worth — and asserts it against the *computed* value rather than a
 * number in a comment, because a comment is exactly what went wrong: the
 * stronger of the two generators this replaced described itself as "roughly 70
 * bits" and was 41.9, and the weaker one, which is the door an administrator
 * onboards a colleague through, was 35.3 and said nothing at all.
 */
describe('generatePassword', () => {
  it('is worth at least 43 bits, computed from the list rather than claimed', () => {
    // A floor rather than an equality, so growing the list is not a test to
    // fix. Shrinking it below what the two old lists managed is.
    expect(PASSWORD_ENTROPY_BITS).toBeGreaterThanOrEqual(43)
    // And the floor is about the list, not about this constant: if somebody
    // deletes half the words the constant moves with them, which is the point
    // of deriving it.
    expect(PASSWORD_WORDS.length).toBeGreaterThanOrEqual(64)
  })

  it('is six words and a two-digit number, all from the list', () => {
    for (let i = 0; i < 200; i += 1) {
      const parts = generatePassword().split('-')
      expect(parts).toHaveLength(PASSWORD_WORD_COUNT + 1)
      for (const word of parts.slice(0, PASSWORD_WORD_COUNT)) {
        expect(PASSWORD_WORDS as readonly string[]).toContain(word)
      }
      const suffix = parts[PASSWORD_WORD_COUNT] as string
      expect(suffix).toMatch(/^[1-9][0-9]$/)
    }
  })

  it('has no duplicate words, or the list is smaller than it looks', () => {
    // The list is the union of two that overlapped by seventeen words. A
    // duplicate left in would make `PASSWORD_ENTROPY_BITS` an overstatement of
    // exactly the kind this whole change is about.
    expect(new Set(PASSWORD_WORDS).size).toBe(PASSWORD_WORDS.length)
  })

  it('does not repeat itself', () => {
    // Not a randomness test — that is `randomInt`'s job. This catches the
    // mistake of drawing once and reusing the draw, which reads correctly and
    // collapses the strength to a sixth.
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()))
    expect(seen.size).toBe(500)
  })
})

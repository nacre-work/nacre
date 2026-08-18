import { describe, expect, it } from 'vitest'

import { message } from '../mail.js'

/**
 * Both parts of a message, from one description.
 *
 * The cases here are the ways two renderings of one thing go wrong: one part
 * saying something the other does not, text somebody wrote arriving as markup,
 * and a link that is not a link.
 */

const LINK = 'https://nacre.example/#/reset?token=abc.def&x=1'

describe('a message', () => {
  it('says the same things in both parts', () => {
    const sent = message('dana@example.com', 'Reset your Nacre password', [
      { kind: 'say', text: 'Somebody asked to reset the password for this address.' },
      { kind: 'link', url: LINK, label: 'Reset your password' },
      { kind: 'caution', text: 'If it was not you, nothing has changed.' },
    ])

    for (const said of [
      'Somebody asked to reset the password for this address.',
      'If it was not you, nothing has changed.',
    ]) {
      expect(sent.text).toContain(said)
      expect(sent.html).toContain(said)
    }
  })

  /**
   * The link is in the text part on a line of its own, which is what the
   * recovery suite extracts and what a plain-text reader clicks. Asserted as a
   * whole line rather than as a substring: a URL wrapped across two lines is a
   * URL nobody can follow, and a substring test cannot tell.
   */
  it('puts the link on its own line, unwrapped', () => {
    const sent = message('dana@example.com', 'Reset', [
      { kind: 'say', text: 'x'.repeat(200) },
      { kind: 'link', url: LINK, label: 'Reset your password' },
    ])
    expect(sent.text.split('\n')).toContain(LINK)
  })

  /**
   * And in the HTML part **twice** — once as the button's target and once as
   * text a reader can look at before pressing it. That second one is the whole
   * answer to "an HTML mail is the shape a phishing mail has", so it is a case
   * rather than a comment.
   */
  it('shows the link as well as linking it', () => {
    const sent = message('dana@example.com', 'Reset', [
      { kind: 'link', url: LINK, label: 'Reset your password' },
    ])
    // `&` is escaped in both places, which is what makes this two and not four.
    const escaped = LINK.replace(/&/gu, '&amp;')
    expect(sent.html.split(escaped)).toHaveLength(3)
    expect(sent.html).toContain(`href="${escaped}"`)
  })

  /**
   * Text is text in both parts. Nothing interpolates a caller's string into a
   * message today, which is exactly why this is worth pinning: the message that
   * carries a layer's name or an organization's is the one somebody writes
   * next, and it will go through this function.
   */
  it('escapes what somebody wrote rather than rendering it', () => {
    const nasty = '<img src=x onerror="alert(1)"> & \'quoted\''
    const sent = message('dana@example.com', `A <script> in ${nasty}`, [
      { kind: 'say', text: nasty },
      { kind: 'caution', text: nasty },
    ])

    expect(sent.html).not.toContain('<img')
    expect(sent.html).not.toContain('<script>')
    // The attribute form, not the substring: `onerror=&quot;` appears as text
    // in the escaped output and is inert, so asserting on `onerror=` alone
    // fails on the correct answer.
    expect(sent.html).not.toMatch(/onerror\s*=\s*["']/u)
    expect(sent.html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    // The subject reaches the `<title>` and the heading, so both are escaped.
    expect(sent.html).toContain('A &lt;script&gt; in')

    // And the plain part is plain: it carries what was written, unescaped and
    // unrendered, because there is nothing there to render.
    expect(sent.text).toContain(nasty)
  })

  /**
   * A refusal rather than a silent drop. Nothing passes one of these today —
   * every URL comes from `consoleUrl` — which is when a bound is worth writing,
   * because the caller that does is the one nobody has written yet.
   */
  it.each(['javascript:alert(1)', 'data:text/html,<script>x</script>', 'ftp://host/x', '/#/reset'])(
    'refuses %s as a link',
    (url) => {
      expect(() =>
        message('dana@example.com', 'Reset', [{ kind: 'link', url, label: 'Go' }]),
      ).toThrow(/must be http or https/)
    },
  )

  /**
   * The inbox preview line, which is the first thing a person reads and the
   * moment they decide whether the message is real. With none, a client shows
   * the wordmark — which says nothing.
   */
  it('carries the first sentence as the preview line', () => {
    const sent = message('dana@example.com', 'Your Nacre password was changed', [
      { kind: 'say', text: 'The password for this account was just changed.' },
      { kind: 'caution', text: 'If this was not you, somebody knew your password.' },
    ])
    const preheader = /opacity:0">(.*?)<\/div>/u.exec(sent.html)
    expect(preheader?.[1]).toBe('The password for this account was just changed.')
  })

  /** A paragraph is wrapped for the plain part, which is what a terminal reads. */
  it('wraps the plain part and leaves the markup to the client', () => {
    const long = 'word '.repeat(60).trim()
    const sent = message('dana@example.com', 'Long', [{ kind: 'say', text: long }])
    for (const line of sent.text.split('\n')) expect(line.length).toBeLessThanOrEqual(72)
    // One paragraph in the HTML, wrapped by the client and not by us: a hard
    // break inside a `<td>` is a line that does not reflow on a phone.
    expect(sent.html).toContain(long)
  })

  /**
   * No `style` attribute ends early.
   *
   * The font stacks are interpolated into one, and CSS's usual spelling of a
   * family name uses the same quote the attribute does — so `"Instrument Sans"`
   * closed the attribute at `Instrument` and truncated every declaration after
   * `font-family`. Nothing threw and the markup still parsed; what was lost was
   * the size, the leading and the colour of every paragraph.
   *
   * A `style` value containing a quote character is that defect and nothing
   * else, so it is the assertion.
   */
  it('keeps every style attribute intact', () => {
    const sent = message('dana@example.com', 'Reset', [
      { kind: 'say', text: 'A sentence.' },
      { kind: 'link', url: LINK, label: 'Go' },
      { kind: 'caution', text: 'A warning.' },
    ])
    const styles = [...sent.html.matchAll(/style="([^"]*)"/gu)].map((m) => m[1] ?? '')
    expect(styles.length).toBeGreaterThan(5)
    for (const style of styles) {
      expect(style).not.toContain('"')
      // A truncated one ends on a property name with nothing after the colon.
      expect(style).not.toMatch(/:\s*$/u)
    }
  })

  /** The two parts are rendered, so there is no way to write one and not the other. */
  it('has both parts on every message', () => {
    const sent = message('dana@example.com', 'Anything', [{ kind: 'say', text: 'Something.' }])
    expect(sent.text.length).toBeGreaterThan(0)
    expect(sent.html).toMatch(/^<!doctype html>/u)
    expect(sent.html).toContain('</html>')
  })
})

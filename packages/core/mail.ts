/**
 * Sending a person an email, and doing nothing at all where none is configured.
 *
 * ## Why the core has this
 *
 * A password nobody can reset is a `psql` session, and that is the shape this
 * repository keeps closing: the model offers something and the product gives no
 * route to it. Per-organization SMTP — a tenant's own relay, its own sender
 * domain, its own branding — is a commercial concern and is not here. One
 * installation-wide sender is what a self-hoster needs to have a working
 * account recovery, so it is what the open core carries.
 *
 * ## Unconfigured is a supported state, and it is structural
 *
 * With no `NACRE_SMTP_URL` there is no sender, `mailer` is `undefined`, and the
 * routes that would send are **not mounted**: a caller gets `404` and the
 * console shows no recovery link. Deliberately not a control that is present
 * and fails — a button that answers "email is not configured" is a button that
 * tells an unauthenticated stranger about the deployment, and a screen that
 * offers what the server refuses is a defect this console has already shipped.
 *
 * ## Why a dependency, in a package with two
 *
 * `nodemailer` has **no dependencies of its own**, which is the whole argument.
 * The alternative is two hundred lines of SMTP here — EHLO, STARTTLS, AUTH,
 * dot-stuffing, quoted-printable, and header encoding over addresses that come
 * out of the database. Header injection on that last one is a real defect with
 * a real name, and trading a zero-dependency package for the chance to write it
 * myself is not a trade this file is willing to make. It is the same reasoning
 * that put `pdf-inspector` in the parser: the dependency surface is what is
 * being minimised, not the dependency count.
 *
 * ## Both parts, from one description
 *
 * This file used to carry an argument for plain text and no HTML part: that
 * every message is one sentence and one link, that an HTML part doubles what
 * has to be escaped, and that a link in an HTML mail is the shape a phishing
 * filter and a suspicious reader both distrust.
 *
 * The last of those is the only one that was ever about the reader, and it is
 * answered rather than avoided — **the link is shown as its own URL**, in the
 * message, beside the button. A reader can see where it goes before pressing
 * anything, which is more than the plain-text version offered and is the exact
 * habit a phishing mail cannot survive. The first two are answered by there
 * being one description and one escaper: a `Message` is a list of blocks, and
 * `message()` renders both parts from it. Neither part can drift from the other
 * because neither is written.
 *
 * That is not tidiness. Every message this product sends was assembled at its
 * call site out of an array of lines, so an HTML part written beside each would
 * be one copy of a template per message with nothing that knew how many there
 * were — this repository's most repeated defect. A `Message` carries a brand
 * only this module can apply, so the next one cannot be assembled by hand with
 * one part missing: it will not typecheck.
 *
 * **The number is deliberately not written here, because the first draft of
 * this paragraph got it wrong.** It said four messages from three call sites,
 * having counted `mailer.send` and not the messages — and the brand is what
 * found the fifth, as a compile error on a `send` that was still handing over
 * `{ to, subject, text }`. A claim about how many there are is the thing that
 * goes stale; the compiler is not.
 */
import { createTransport, type Transporter } from 'nodemailer'

import { logger } from './logging.js'

/**
 * The brand palette, by the token each value comes from.
 *
 * An email cannot load a stylesheet and cannot resolve a custom property, so
 * these are literals — the one place in this repository where a colour is
 * written out rather than named. `lint:mail-palette` is what keeps them honest:
 * it reads the brand mirror the console ships and refuses a value that has
 * moved, so a colour changed in the brand repository fails here instead of
 * leaving the product's mail behind the product's screens.
 *
 * The **light row**, and only the light row. The brand's own rule is that the
 * ink row is a separate file rather than a runtime filter, and email is where
 * that is most true: a client that forces dark does it to the rendered message
 * whatever a media query says, and a half-working second palette is worse than
 * one that is always itself. `color-scheme` asks politely and that is all it
 * can do.
 */
const PALETTE = {
  /** `--n-pearl-100`, the light theme background. */
  page: '#F1F5F6',
  /** `--n-pearl-000`, a raised surface. */
  card: '#FFFFFF',
  /** `--n-pearl-200`, borders on light. */
  line: '#E4EBED',
  /** `--n-ink-900`, primary text on light. */
  text: '#0A1017',
  /** `--n-ink-500`, secondary text. */
  muted: '#3A4A59',
  /**
   * `--n-strata-2-dense`, which is the console's own `--n-accent` on light.
   * The dense row because the brand requires it under 48px, and a link in a
   * paragraph is well under it.
   */
  accent: '#17706B',
  /**
   * `--n-error`. Deliberately **not** `--n-deny`, which is the same hex and a
   * different meaning: deny is one of four permission semantics the brand says
   * must not be reassigned, and "somebody may have your password" is a status
   * rather than a permission. The console's `.warn` reached for `--n-deny` and
   * was corrected in the same change — zero pixels, since the two values are
   * identical, and one fewer place where a permission colour means something
   * else.
   */
  caution: '#C8455F',
} as const

/**
 * The brand's stacks, named in full so a client that has the face uses it.
 *
 * **Single quotes, which is not a style preference.** These are interpolated
 * into a `style="…"` attribute, and CSS's usual spelling — `"Instrument Sans"`
 * — closes that attribute at the first character of the family name. The first
 * version did exactly that, and the effect is worse than a wrong font: the
 * declaration list ends there, so every paragraph loses its size, its leading
 * and its colour. Single quotes are equally valid CSS and survive a
 * double-quoted attribute untouched.
 *
 * Found by reading a failing test's diff rather than by the assertion that
 * failed, which was about something else entirely — and pinned since, in the
 * preview pass, by asking a browser what a paragraph actually computes to.
 */
const FONTS = {
  display: "'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', sans-serif",
  body: "'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
} as const

/**
 * A paragraph, the one thing the message is asking for, or a caution.
 *
 * Three kinds and no more. Every message this product sends is a statement, at
 * most one action, and a sentence about what to do if it was not you — so a
 * richer vocabulary would be blocks with no writer, and each one is a second
 * thing both renderers have to agree about.
 */
export type Block =
  | { readonly kind: 'say'; readonly text: string }
  | { readonly kind: 'link'; readonly url: string; readonly label: string }
  | { readonly kind: 'caution'; readonly text: string }

/**
 * The brand. Not exported, so a `Message` can only come from `message()`.
 *
 * Structural rather than a check, for the same reason the payload's `meta`
 * namespace is: a rule that cannot be written wrongly needs nothing to notice
 * that it was. A hand-assembled `{ to, subject, text, html }` does not
 * typecheck, so the two parts cannot be written to disagree.
 */
declare const rendered: unique symbol

export interface Message {
  readonly to: string
  readonly subject: string
  /** What a client that refuses HTML reads. Rendered, never written. */
  readonly text: string
  /** The same blocks, in the brand. Rendered, never written. */
  readonly html: string
  readonly [rendered]: true
}

/** `& < > " '`, which is every character that can leave an attribute or a tag. */
const escape = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')

/**
 * A link this module will emit, or nothing.
 *
 * Every URL here is built by `consoleUrl` from configuration, so this cannot
 * fire today — which is exactly when a bound is worth writing, because the
 * caller that passes a `javascript:` URL is the one nobody has written yet. A
 * refusal rather than a silent drop: a message whose action quietly vanished is
 * a message that arrives making no sense.
 */
function checkedUrl(url: string): string {
  if (!/^https?:\/\//iu.test(url)) {
    throw new Error(`a message link must be http or https, and this one is ${url.slice(0, 24)}`)
  }
  return url
}

/** Wrap a paragraph for the plain-text part. Never a URL, which must stay one line. */
function wrap(text: string, width = 72): string {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/u)) {
    if (line === '') line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line !== '') lines.push(line)
  return lines.join('\n')
}

function renderText(body: readonly Block[]): string {
  return body
    .map((block) => (block.kind === 'link' ? block.url : wrap(block.text)))
    .join('\n\n')
}

/**
 * The same blocks as a message a client will render.
 *
 * Tables and inline styles, which is not a stylistic preference: a `<style>`
 * block is dropped by several clients and `<div>` layout is unreliable in
 * Outlook's Word renderer, so the shape that works everywhere is the shape from
 * fifteen years ago. One table for the page, one for the card.
 *
 * **The masthead is a wordmark and a lamella, and not the mark.** An SVG is
 * stripped by most clients, and a remote PNG is a tracking pixel with a logo on
 * it — which a message about somebody's account must not be. Not the
 * iridescent ramp either: the brand reserves that for "permitted" or "in
 * progress" and never for decoration. One stratum rule at `--n-lamella`
 * thickness is the signature element, and it is a table cell with a
 * background, which every client can draw.
 *
 * **`color-scheme` asks a client not to invert the palette.** It is a request
 * and not a guarantee, which is why there is one palette rather than two.
 *
 * **The URL goes under the button, in full.** A reader taught to look at a
 * link before pressing it can, which is the whole answer to "an HTML mail is
 * the shape a phishing mail has" — and it is more than the plain-text version
 * offered, where the link was the only thing on its line and nothing said
 * where it went.
 *
 * Nothing explains itself *inside* the markup. A comment here is bytes in
 * every message and internal reasoning in a stranger's inbox — and the first
 * version put three of them there, one of which quoted `--n-lamella` in
 * backticks and **ended the template literal**. The sibling repository has
 * recorded that exact defect eight times; this file managed it on the first
 * attempt, and `node --check` caught it only because the count was odd.
 */
function renderHtml(subject: string, body: readonly Block[]): string {
  // The inbox preview line. Clients show whatever text comes first, so with no
  // preheader they show the wordmark — which tells a reader nothing at the one
  // moment they are deciding whether this message is real.
  const first = body.find((block) => block.kind === 'say')
  const preheader = first === undefined ? '' : escape(first.text)

  const blocks = body.map((block) => {
    if (block.kind === 'link') {
      const url = escape(checkedUrl(block.url))
      return `
        <tr><td style="padding:8px 0 0">
          <a href="${url}" style="display:inline-block;background:${PALETTE.accent};color:${PALETTE.card};font-family:${FONTS.body};font-size:15.5px;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:3px">${escape(block.label)}</a>
        </td></tr>
        <tr><td style="padding:14px 0 20px">
          <span style="font-family:${FONTS.body};font-size:12.5px;color:${PALETTE.muted}">Or paste this into your browser:</span><br>
          <span style="font-family:${FONTS.mono};font-size:12.5px;color:${PALETTE.muted};word-break:break-all">${url}</span>
        </td></tr>`
    }
    if (block.kind === 'caution') {
      return `
        <tr><td style="padding:4px 0 16px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td width="3" style="background:${PALETTE.caution};width:3px;font-size:0;line-height:0">&nbsp;</td>
              <td style="padding-left:12px;font-family:${FONTS.body};font-size:14px;line-height:1.55;color:${PALETTE.text}">${escape(block.text)}</td>
            </tr>
          </table>
        </td></tr>`
    }
    return `
        <tr><td style="padding:0 0 16px;font-family:${FONTS.body};font-size:15.5px;line-height:1.55;color:${PALETTE.text}">${escape(block.text)}</td></tr>`
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PALETTE.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PALETTE.page}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:100%;max-width:560px;background:${PALETTE.card};border:1px solid ${PALETTE.line};border-radius:3px">
      <tr><td style="padding:32px 32px 24px">

        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="font-family:${FONTS.display};font-size:18px;font-weight:700;letter-spacing:-0.03em;color:${PALETTE.text};padding-bottom:6px">Nacre</td></tr>
          <tr><td style="background:${PALETTE.accent};height:2px;font-size:0;line-height:0">&nbsp;</td></tr>
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%">
          <tr><td style="padding:24px 0 12px;font-family:${FONTS.display};font-size:23px;font-weight:700;letter-spacing:-0.03em;line-height:1.2;color:${PALETTE.text}">${escape(subject)}</td></tr>
${blocks.join('\n')}
        </table>

      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>
`
}

/**
 * A message, both parts, from one description.
 *
 * The only way to make a `Message`. See the brand above for why that is the
 * design and not a convenience.
 */
export function message(to: string, subject: string, body: readonly Block[]): Message {
  return {
    to,
    subject,
    text: renderText(body),
    html: renderHtml(subject, body),
  } as Message
}

/**
 * What the API is handed, so a test can hand it something else.
 */
export interface Mailer {
  send(message: Message): Promise<void>
}

export interface MailConfig {
  /** `smtp://user:pass@host:587` or `smtps://…`; see `docs/config.md`. */
  readonly url: string
  /** `From:`. A relay will refuse a sender it does not own. */
  readonly from: string
}

/**
 * The address a link in a message points at.
 *
 * Read from configuration rather than from the request, and that is the
 * security property: a `Host` header is an attacker's field, and a recovery
 * link built from one is a recovery link pointing at their server. This is the
 * same reason `NACRE_CANONICAL_URL` exists for the OAuth documents.
 */
export const consoleUrl = (base: string, hash: string): string =>
  `${base.replace(/\/+$/u, '')}/${hash.startsWith('#') ? hash : `#${hash}`}`

class SmtpMailer implements Mailer {
  private readonly transport: Transporter

  constructor(private readonly config: MailConfig) {
    this.transport = createTransport(config.url)
  }

  async send(message: Message): Promise<void> {
    // Both parts, so the message is `multipart/alternative` and a client that
    // refuses HTML — or a person who has turned it off — reads the text one.
    // `nodemailer` builds the container; passing only `html` would leave that
    // reader with nothing.
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
  }
}

/**
 * The sender, or none.
 *
 * Failures are the caller's to decide about, and the two callers decide
 * differently: a recovery request answers the same `204` whether or not the
 * message went — saying otherwise would tell a stranger which addresses have
 * accounts — while a notice about a password having changed is logged and
 * dropped, because refusing the password change over it would be worse.
 */
export function createMailer(config: MailConfig | undefined): Mailer | undefined {
  if (config === undefined) return undefined
  const mailer = new SmtpMailer(config)
  return {
    async send(message) {
      try {
        await mailer.send(message)
      } catch (cause) {
        // The address is logged and the body never is: a message this product
        // sends carries a single-use token, and a log line carrying one is a
        // credential in a place nobody is watching.
        logger.warn('could not send a message', {
          to: message.to,
          subject: message.subject,
          error: String(cause).slice(0, 200),
        })
        throw cause
      }
    },
  }
}

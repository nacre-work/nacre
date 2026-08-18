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
 */
import { createTransport, type Transporter } from 'nodemailer'

import { logger } from './logging.js'

export interface Message {
  readonly to: string
  readonly subject: string
  /** Plain text only. See `Mailer` for why there is no HTML part. */
  readonly text: string
}

/**
 * What the API is handed, so a test can hand it something else.
 *
 * Plain text and no HTML part, which is a decision rather than an omission.
 * Every message this product sends is one sentence and one link; an HTML part
 * would double what has to be escaped, and a link in an HTML mail is the exact
 * shape a phishing filter and a suspicious reader both distrust.
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
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
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

import type { WebAuthnAssertion, WebAuthnAssertionOptions, WebAuthnRegistrationOptions } from '@nacre.work/sdk'

/**
 * The browser half of a WebAuthn ceremony.
 *
 * Everything here is encoding. The server speaks base64url, because that is
 * what a browser reports and what Postgres stores, and `navigator.credentials`
 * speaks `ArrayBuffer` — so this module is the one place the two meet. Two
 * places would be two spellings of the same conversion, and the half that got
 * it wrong would fail as "your key was not recognised".
 *
 * ## A secure context, or nothing
 *
 * `PublicKeyCredential` does not exist outside one, and this console is served
 * over plain HTTP on a private network more often than not. So `usable()` is
 * asked before a control is drawn rather than after it is pressed: a button
 * that throws `navigator.credentials is undefined` reads as a broken
 * application, and "this needs HTTPS" is a deployment fact somebody can act on.
 */

/**
 * base64url to bytes, over an `ArrayBuffer` this function owns.
 *
 * The buffer is allocated rather than inferred because `BufferSource` excludes
 * a `SharedArrayBuffer` and `Uint8Array.from` promises only `ArrayBufferLike` —
 * so the obvious spelling type-checks everywhere except against the DOM's own
 * signatures, which is where it has to hold.
 */
const un64 = (s: string): Uint8Array<ArrayBuffer> => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const b64 = (buffer: ArrayBuffer): string => {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The same allocation, for a string the specification wants as bytes. */
const un8 = (s: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(s)
  const bytes = new Uint8Array(new ArrayBuffer(encoded.length))
  bytes.set(encoded)
  return bytes
}

/** Whether this page can run a ceremony at all. */
export function usable(): boolean {
  return window.isSecureContext && typeof window.PublicKeyCredential === 'function'
}

/** Ask the authenticator to make a credential. */
export async function create(
  options: WebAuthnRegistrationOptions,
): Promise<{ challenge: string; attestationObject: string; clientDataJSON: string }> {
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: un64(options.challenge),
      rp: { id: options.rp.id, name: options.rp.name },
      user: {
        // A uuid, as its own bytes. The specification wants an opaque handle
        // and this is one — an authenticator shows `name` and `displayName`,
        // never this.
        id: un8(options.user.id),
        name: options.user.name,
        displayName: options.user.displayName,
      },
      pubKeyCredParams: options.algorithms.map((alg) => ({ type: 'public-key', alg })),
      excludeCredentials: options.excludeCredentials.map((id) => ({ type: 'public-key', id: un64(id) })),
      timeout: options.timeoutMs,
      // Neither a platform authenticator nor a roaming one is asked for: a
      // person's key is whatever they have, and narrowing it here would refuse
      // half of them for no reason this product has.
      authenticatorSelection: { userVerification: 'preferred', residentKey: 'discouraged' },
      // `none`, because nothing here reads an attestation statement. Asking for
      // one would mean a consent prompt about the make of somebody's key in
      // exchange for a field this server ignores.
      attestation: 'none',
    },
  })) as PublicKeyCredential | null
  if (credential === null) throw new Error('The authenticator produced nothing.')

  const response = credential.response as AuthenticatorAttestationResponse
  return {
    // Echoed rather than re-derived: the server compares it against what is in
    // `clientDataJSON` and spends it in the database, and both halves are real
    // only if this is the value it issued.
    challenge: options.challenge,
    attestationObject: b64(response.attestationObject),
    clientDataJSON: b64(response.clientDataJSON),
  }
}

/** Ask the authenticator to sign a challenge. */
export async function get(options: WebAuthnAssertionOptions): Promise<WebAuthnAssertion> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: un64(options.challenge),
      rpId: options.rpId,
      allowCredentials: options.allowCredentials.map((id) => ({ type: 'public-key', id: un64(id) })),
      timeout: options.timeoutMs,
      userVerification: 'preferred',
    },
  })) as PublicKeyCredential | null
  if (credential === null) throw new Error('The authenticator produced nothing.')

  const response = credential.response as AuthenticatorAssertionResponse
  return {
    credentialId: credential.id,
    authenticatorData: b64(response.authenticatorData),
    clientDataJSON: b64(response.clientDataJSON),
    signature: b64(response.signature),
    challenge: options.challenge,
  }
}

/**
 * What to show when a ceremony fails, which is mostly not an error.
 *
 * `NotAllowedError` is what a browser reports for a cancelled prompt, a
 * timeout, and a key the account does not hold — one name for three things a
 * person does routinely. Reporting it verbatim reads as a fault.
 */
export function describe(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'The request was cancelled or timed out. Try again.'
    if (error.name === 'InvalidStateError') return 'This key is already enrolled on this account.'
    if (error.name === 'SecurityError') return 'This page is not served from the address this installation registers keys for.'
  }
  return error instanceof Error ? error.message : String(error)
}

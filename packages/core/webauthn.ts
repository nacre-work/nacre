/**
 * WebAuthn, as far as the arithmetic goes.
 *
 * The same split `totp.ts` has: this file knows nothing about a database and
 * everything about bytes, so it can be checked against a real authenticator's
 * output; `packages/api/src/second-factor.ts` holds the storage and the bounds.
 *
 * ## Why there is no dependency
 *
 * `@simplewebauthn/server` is the obvious answer and is a good library. It is
 * not the answer here, and the reason is the same one the multipart parser
 * gives: **this is attacker-supplied binary on the authentication path**, which
 * is the one place a dependency's parser bugs become ours. The parser took
 * `pdf-inspector` because a PDF is a format nobody can write a reader for in an
 * afternoon; what a second factor needs is much smaller than that, and it is
 * bounded by a specification that says the encoding is *canonical*.
 *
 * Two things make it small enough to be worth writing:
 *
 * - **`node:crypto` imports a JWK.** COSE keys map onto JWK field for field, so
 *   ES256, RS256 and EdDSA all verify with no ASN.1 and no DER assembly.
 *   Checked by round-tripping a generated key of each kind before a line of
 *   this was written.
 * - **CTAP2 says canonical CBOR**, which is definite-length only, no tags, no
 *   floats. So the decoder below is a subset and every absence is a *refusal*
 *   rather than a gap — an indefinite-length map is not "unsupported here", it
 *   is a thing a conforming authenticator does not send.
 *
 * The obligation that comes with the choice is strictness, exactly as it is for
 * multipart: every bound is a refusal and never a truncation, because a
 * truncation is a silent disagreement between what was sent and what was
 * verified. On this path that disagreement is somebody's second factor.
 *
 * ## What this deliberately does not do
 *
 * **Attestation is not verified, and `none` is what the server asks for.** This
 * is a *second* factor: the person has already produced a password, and what
 * this adds is proof of possession. Attestation answers a different question —
 * "which model of authenticator is this" — which an enterprise buying
 * hardware-key policy cares about and a self-hoster does not. Verifying it
 * means a trust anchor list to keep current, and a list nobody updates is worse
 * than no list. The registration path therefore reads the attestation object
 * for its `authData` and ignores `attStmt` entirely, which is what makes the
 * CBOR subset small.
 *
 * **Passwordless is not offered.** A discoverable credential used as a first
 * factor changes what an account is, and `docs/authz.md` says a second factor
 * decides whether a session *starts* and grants nothing. Widening that is a
 * change to the specification and belongs there first.
 */
import { createHash, createPublicKey, createVerify, verify as verifySignature } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/* ────────────────────────────── CBOR, the subset ────────────────────────────
 *
 * Enough of RFC 8949 to read an attestation object and a COSE key, and nothing
 * else. Every bound below is chosen against what a conforming authenticator
 * actually sends, so exceeding one is a refusal rather than a limit somebody
 * will meet honestly.
 */

/** No structure here nests past four: attObj → attStmt → x5c → bytes. */
const MAX_DEPTH = 8
/** A COSE key has six entries; an attestation object has three. */
const MAX_ENTRIES = 64
/** An RSA modulus is 512 bytes. Nothing here is larger by an order. */
const MAX_BYTES = 8192

export class CborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CborError'
  }
}

type CborValue = number | bigint | string | Uint8Array | CborValue[] | Map<number | string, CborValue> | boolean | null

interface Reader {
  readonly bytes: Uint8Array
  offset: number
}

function need(r: Reader, n: number): void {
  if (r.offset + n > r.bytes.length) throw new CborError('ran off the end of the input')
}

/**
 * The head of an item: its major type and its argument.
 *
 * Indefinite length (`additional === 31`) is refused rather than supported.
 * CTAP2 canonical CBOR is definite-length, so an indefinite one is not an
 * authenticator being flexible — it is input that did not come from one.
 */
function head(r: Reader): { major: number; arg: number } {
  need(r, 1)
  const initial = r.bytes[r.offset]!
  r.offset += 1
  const major = initial >> 5
  const additional = initial & 0x1f

  if (additional < 24) return { major, arg: additional }
  if (additional === 24) {
    need(r, 1)
    const arg = r.bytes[r.offset]!
    r.offset += 1
    return { major, arg }
  }
  if (additional === 25) {
    need(r, 2)
    const arg = (r.bytes[r.offset]! << 8) | r.bytes[r.offset + 1]!
    r.offset += 2
    return { major, arg }
  }
  if (additional === 26) {
    need(r, 4)
    const view = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.offset, 4)
    const arg = view.getUint32(0)
    r.offset += 4
    return { major, arg }
  }
  // 27 is a 64-bit argument and 28-30 are reserved; 31 is indefinite length.
  throw new CborError(
    `unsupported CBOR argument ${String(additional)} for major type ${String(major)}; ` +
      'this reader accepts the canonical, definite-length encoding CTAP2 requires',
  )
}

function item(r: Reader, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new CborError(`nested past ${String(MAX_DEPTH)} levels`)
  const { major, arg } = head(r)

  switch (major) {
    case 0:
      return arg
    case 1:
      // -1 - arg. Negative integers are how COSE labels its key parameters.
      return -1 - arg
    case 2: {
      if (arg > MAX_BYTES) throw new CborError(`byte string of ${String(arg)} bytes is over the limit`)
      need(r, arg)
      const out = r.bytes.subarray(r.offset, r.offset + arg)
      r.offset += arg
      return out
    }
    case 3: {
      if (arg > MAX_BYTES) throw new CborError(`text string of ${String(arg)} bytes is over the limit`)
      need(r, arg)
      const out = new TextDecoder('utf-8', { fatal: true }).decode(r.bytes.subarray(r.offset, r.offset + arg))
      r.offset += arg
      return out
    }
    case 4: {
      if (arg > MAX_ENTRIES) throw new CborError(`array of ${String(arg)} items is over the limit`)
      const out: CborValue[] = []
      for (let i = 0; i < arg; i += 1) out.push(item(r, depth + 1))
      return out
    }
    case 5: {
      if (arg > MAX_ENTRIES) throw new CborError(`map of ${String(arg)} entries is over the limit`)
      const out = new Map<number | string, CborValue>()
      for (let i = 0; i < arg; i += 1) {
        const key = item(r, depth + 1)
        if (typeof key !== 'number' && typeof key !== 'string') {
          throw new CborError('map keys here are integers or text strings')
        }
        // A repeated key is not a conforming encoding, and picking one of the
        // two would be this reader deciding something the sender did not.
        if (out.has(key)) throw new CborError(`duplicate map key ${String(key)}`)
        out.set(key, item(r, depth + 1))
      }
      return out
    }
    case 7: {
      if (arg === 20) return false
      if (arg === 21) return true
      if (arg === 22) return null
      throw new CborError(`unsupported simple value ${String(arg)}`)
    }
    default:
      // 6 is tags. Nothing in an attestation object or a COSE key is tagged.
      throw new CborError(`unsupported CBOR major type ${String(major)}`)
  }
}

/**
 * Decode one item, and **refuse trailing bytes**.
 *
 * A decoder that stops at the end of the first item and ignores what follows
 * lets two different inputs verify identically, which is the shape of a
 * signature-malleability bug. What is signed here is the whole buffer.
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const r: Reader = { bytes, offset: 0 }
  const value = item(r, 0)
  if (r.offset !== bytes.length) {
    throw new CborError(`${String(bytes.length - r.offset)} trailing byte(s) after the CBOR item`)
  }
  return value
}

/* ─────────────────────────── authenticator data ───────────────────────────── */

export interface AuthenticatorFlags {
  /** User present — somebody touched it. */
  readonly userPresent: boolean
  /** User verified — a PIN or a biometric, not only a touch. */
  readonly userVerified: boolean
  readonly attestedCredentialData: boolean
  readonly extensionData: boolean
}

export interface AttestedCredential {
  readonly aaguid: Uint8Array
  readonly id: Uint8Array
  readonly coseKey: Map<number | string, CborValue>
}

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array
  readonly flags: AuthenticatorFlags
  readonly signCount: number
  readonly credential?: AttestedCredential
}

/**
 * The fixed-layout half: 32 bytes of RP id hash, a flags byte, a counter, and
 * then the attested credential where the flag says there is one.
 *
 * The credential's public key is CBOR and is *not* length-prefixed — the spec
 * says it runs to the end unless extensions follow. So this decodes it with the
 * reader above and uses how far that got, which is also what refuses a key with
 * junk appended.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new CborError(`authenticator data is ${String(bytes.length)} bytes; 37 is the minimum`)

  const rpIdHash = bytes.subarray(0, 32)
  const raw = bytes[32]!
  const flags: AuthenticatorFlags = {
    userPresent: (raw & 0x01) !== 0,
    userVerified: (raw & 0x04) !== 0,
    attestedCredentialData: (raw & 0x40) !== 0,
    extensionData: (raw & 0x80) !== 0,
  }
  const signCount = new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0)

  if (!flags.attestedCredentialData) return { rpIdHash, flags, signCount }

  if (bytes.length < 55) throw new CborError('attested credential data is truncated')
  const aaguid = bytes.subarray(37, 53)
  const idLength = (bytes[53]! << 8) | bytes[54]!
  // 1023 is the ceiling WebAuthn puts on a credential id.
  if (idLength > 1023) throw new CborError(`credential id claims ${String(idLength)} bytes; 1023 is the maximum`)
  if (bytes.length < 55 + idLength) throw new CborError('credential id is truncated')
  const id = bytes.subarray(55, 55 + idLength)

  const r: Reader = { bytes, offset: 55 + idLength }
  const coseKey = item(r, 0)
  if (!(coseKey instanceof Map)) throw new CborError('the credential public key is not a CBOR map')

  // Extensions may follow, and nothing here reads one — but bytes that are
  // neither a key nor an extension are input this did not understand.
  if (!flags.extensionData && r.offset !== bytes.length) {
    throw new CborError(`${String(bytes.length - r.offset)} byte(s) after the public key, with no extension flag`)
  }

  return { rpIdHash, flags, signCount, credential: { aaguid, id, coseKey } }
}

/* ───────────────────────────── COSE, as a JWK ─────────────────────────────── */

/**
 * The algorithms this accepts, and why the list is short.
 *
 * ES256 is what every platform authenticator produces and is the one a
 * deployment will actually see. RS256 is what older Windows Hello and some
 * enterprise tokens produce. EdDSA is what a few hardware keys produce. Nothing
 * else is offered: an algorithm this server does not name in
 * `pubKeyCredParams` is one no authenticator will choose, so accepting it at
 * registration would be accepting something we did not ask for.
 */
export const SUPPORTED_ALGORITHMS = [-7, -257, -8] as const
export type Algorithm = (typeof SUPPORTED_ALGORITHMS)[number]

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export interface PublicKey {
  readonly alg: Algorithm
  /** A JWK, which is what `node:crypto` imports without any ASN.1 here. */
  readonly jwk: Record<string, string>
}

function bytesAt(key: Map<number | string, CborValue>, label: number, what: string): Uint8Array {
  const value = key.get(label)
  if (!(value instanceof Uint8Array)) throw new CborError(`the COSE key has no ${what}`)
  return value
}

/**
 * A COSE key becomes a JWK, which `node:crypto` imports directly.
 *
 * This is the whole reason there is no ASN.1 in this file. COSE and JWK are the
 * same parameters under different names — `crv`, `x`, `y` for an EC key; `n`
 * and `e` for RSA — so the conversion is a field mapping and the DER assembly
 * that a WebAuthn implementation usually carries does not exist here.
 */
export function coseToPublicKey(key: Map<number | string, CborValue>): PublicKey {
  const kty = key.get(1)
  const named = key.get(3)
  if (typeof named !== 'number' || !(SUPPORTED_ALGORITHMS as readonly number[]).includes(named)) {
    throw new CborError(
      `algorithm ${String(named)} is not one this server asked for (ES256, RS256 or EdDSA)`,
    )
  }
  const alg = named as Algorithm

  if (alg === -7) {
    if (kty !== 2) throw new CborError('ES256 needs an EC2 key')
    // -1 is the curve; 1 is P-256, and it is the only one ES256 is defined over.
    if (key.get(-1) !== 1) throw new CborError('ES256 needs curve P-256')
    return {
      alg,
      jwk: { kty: 'EC', crv: 'P-256', x: b64url(bytesAt(key, -2, 'x coordinate')), y: b64url(bytesAt(key, -3, 'y coordinate')) },
    }
  }

  if (alg === -8) {
    if (kty !== 1) throw new CborError('EdDSA needs an OKP key')
    if (key.get(-1) !== 6) throw new CborError('EdDSA here means Ed25519')
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64url(bytesAt(key, -2, 'public key')) } }
  }

  if (kty !== 3) throw new CborError('RS256 needs an RSA key')
  return {
    alg,
    jwk: { kty: 'RSA', n: b64url(bytesAt(key, -1, 'modulus')), e: b64url(bytesAt(key, -2, 'exponent')) },
  }
}

const keyObject = (key: PublicKey): KeyObject =>
  // `jwk` is a plain record here because that is what this file builds; the
  // type `createPublicKey` wants is structurally the same thing.
  createPublicKey({ key: key.jwk as Parameters<typeof createPublicKey>[0] extends { key: infer K } ? K : never, format: 'jwk' })

/* ───────────────────────────── what the client sent ───────────────────────── */

export interface ClientData {
  readonly type: string
  readonly challenge: string
  readonly origin: string
  readonly crossOrigin?: boolean
}

/**
 * `clientDataJSON`, parsed and checked.
 *
 * The origin is compared for **equality** against what the deployment
 * configured, never by suffix. `evil-nacre.work` ends with `nacre.work`, and an
 * origin check that admits it is not a check.
 */
export function readClientData(
  json: Uint8Array,
  expect: { type: string; challenge: string; origin: readonly string[] },
): ClientData {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json))
  } catch {
    throw new CborError('clientDataJSON is not valid UTF-8 JSON')
  }
  const data = parsed as Partial<ClientData>
  if (data.type !== expect.type) throw new CborError(`clientDataJSON says "${String(data.type)}"; expected "${expect.type}"`)
  if (typeof data.challenge !== 'string' || data.challenge !== expect.challenge) {
    throw new CborError('the challenge does not match the one this server issued')
  }
  if (typeof data.origin !== 'string' || !expect.origin.includes(data.origin)) {
    throw new CborError(`origin ${String(data.origin)} is not one this deployment serves`)
  }
  return data as ClientData
}

/* ──────────────────────────────── registration ────────────────────────────── */

export interface Registration {
  readonly credentialId: Uint8Array
  readonly publicKey: PublicKey
  readonly signCount: number
  readonly userVerified: boolean
  readonly aaguid: Uint8Array
}

export interface RegistrationInput {
  readonly attestationObject: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly challenge: string
  readonly rpId: string
  readonly origins: readonly string[]
}

/**
 * Verify a registration, and store what comes back.
 *
 * `attStmt` is read and discarded: see the header for why attestation is not
 * verified here. What *is* checked is everything that decides whether the
 * credential belongs to this deployment and this ceremony — the challenge, the
 * origin, the RP id, and that somebody was present at the authenticator.
 */
export function verifyRegistration(input: RegistrationInput): Registration {
  readClientData(input.clientDataJSON, {
    type: 'webauthn.create',
    challenge: input.challenge,
    origin: input.origins,
  })

  const attestation = decodeCbor(input.attestationObject)
  if (!(attestation instanceof Map)) throw new CborError('the attestation object is not a CBOR map')
  const authDataBytes = attestation.get('authData')
  if (!(authDataBytes instanceof Uint8Array)) throw new CborError('the attestation object carries no authData')

  const authData = parseAuthenticatorData(authDataBytes)
  const expectedRpIdHash = createHash('sha256').update(input.rpId).digest()
  if (!expectedRpIdHash.equals(Buffer.from(authData.rpIdHash))) {
    throw new CborError('the credential was made for a different relying party')
  }
  // User presence is the whole of what a second factor asserts: somebody with
  // the authenticator in hand did something. A credential registered without it
  // would be one a page could mint silently.
  if (!authData.flags.userPresent) throw new CborError('the authenticator reports nobody was present')
  if (authData.credential === undefined) throw new CborError('the registration carries no credential')

  return {
    credentialId: authData.credential.id,
    publicKey: coseToPublicKey(authData.credential.coseKey),
    signCount: authData.signCount,
    userVerified: authData.flags.userVerified,
    aaguid: authData.credential.aaguid,
  }
}

/* ───────────────────────────────── assertion ──────────────────────────────── */

export interface AssertionInput {
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly signature: Uint8Array
  readonly challenge: string
  readonly rpId: string
  readonly origins: readonly string[]
  readonly publicKey: PublicKey
  readonly storedSignCount: number
}

export interface Assertion {
  readonly signCount: number
  readonly userVerified: boolean
}

/**
 * Verify an assertion.
 *
 * The signature is over `authenticatorData || sha256(clientDataJSON)`, which is
 * what binds the challenge and the origin into the signed message rather than
 * leaving them as things this code merely looked at.
 *
 * **The counter is checked and a stuck counter is allowed.** A counter that
 * went backwards is the signal WebAuthn offers for a cloned authenticator, so
 * it is a refusal. A counter that stays at zero is what every platform
 * authenticator — Touch ID, Windows Hello, a passkey in a password manager —
 * actually does, so refusing that would refuse the authenticators most people
 * have.
 */
export function verifyAssertion(input: AssertionInput): Assertion {
  readClientData(input.clientDataJSON, {
    type: 'webauthn.get',
    challenge: input.challenge,
    origin: input.origins,
  })

  const authData = parseAuthenticatorData(input.authenticatorData)
  const expectedRpIdHash = createHash('sha256').update(input.rpId).digest()
  if (!expectedRpIdHash.equals(Buffer.from(authData.rpIdHash))) {
    throw new CborError('the assertion is for a different relying party')
  }
  if (!authData.flags.userPresent) throw new CborError('the authenticator reports nobody was present')

  const signed = Buffer.concat([
    Buffer.from(input.authenticatorData),
    createHash('sha256').update(input.clientDataJSON).digest(),
  ])

  const key = keyObject(input.publicKey)
  const ok =
    input.publicKey.alg === -8
      ? // EdDSA takes no digest name: the algorithm names its own.
        verifySignature(null, signed, key, input.signature)
      : createVerify('sha256').update(signed).verify(key, input.signature)
  if (!ok) throw new CborError('the signature does not verify against the stored credential')

  if (authData.signCount !== 0 && authData.signCount <= input.storedSignCount) {
    throw new CborError(
      `the signature counter went from ${String(input.storedSignCount)} to ${String(authData.signCount)}, ` +
        'which is what a cloned authenticator looks like',
    )
  }

  return { signCount: authData.signCount, userVerified: authData.flags.userVerified }
}

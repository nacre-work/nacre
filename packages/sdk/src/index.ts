/**
 * @nacre.work/sdk — the TypeScript client.
 *
 * ```ts
 * import { NacreClient } from '@nacre.work/sdk'
 *
 * const nacre = new NacreClient({ baseUrl: 'https://api.nacre.work', token })
 *
 * const { jobId } = await nacre.documents.add({
 *   layer: 'handbook',
 *   externalId: 'onboarding-2026',
 *   content: 'The layer grows around whatever got inside.',
 * })
 * await nacre.jobs.wait(jobId)
 *
 * for (const hit of await nacre.search('onboarding')) {
 *   console.log(hit.title, hit.score)
 * }
 * ```
 *
 * The token carries the organization, so no method takes one — see the note on
 * `NacreClient`.
 *
 * `auth.login` is the exception, because it is what a caller has *instead* of a
 * token:
 *
 * ```ts
 * const tokens = await new NacreClient({ baseUrl, token: 'unused' })
 *   .auth.login({ email, password })
 * const nacre = new NacreClient({ baseUrl, token: tokens.accessToken })
 * ```
 *
 * **Every operation in `docs/openapi.yaml` is reachable from here**, and
 * `__tests__/coverage.test.ts` is what keeps that true: adding a path to the
 * contract without adding it here fails, and the fix is a method or a written
 * reason. Two are deliberately absent — the `/.well-known` documents, which are
 * unauthenticated and read by an OAuth client rather than by an application.
 *
 * Contract: docs/api.md, machine-readable in docs/openapi.yaml.
 */

export { NacreClient, type ClientOptions } from './client.js'
export { NacreError, NacreTransportError, type Problem } from './errors.js'
export type {
  BegunSecondFactor,
  SecondFactor,
  SecondFactorKind,
  ConfirmedSecondFactor,
  SecondFactorEnrolmentRequired,
  SecondFactorRequired,
  WebAuthnAssertion,
  WebAuthnAssertionOptions,
  WebAuthnRegistrationOptions,
  SignIn,
  Connection,
  Self,
  AuditPage,
  AuditQuery,
  AuditRecord,
  CreatedServiceAccount,
  CreatedUser,
  Document,
  Effect,
  // The return type of `providers.list` and `providers.byModel`; it was the
  // one module export a consumer could receive and not name.
  EmbeddingProvider,
  Grant,
  GrantInput,
  Group,
  GroupMember,
  IngestOutcome,
  IngestRequest,
  Job,
  JobStatus,
  Layer,
  LayerInput,
  Permission,
  PrincipalType,
  RecallCheck,
  ReferenceQuery,
  ReferenceQueryInput,
  ReindexStatus,
  ReindexStatusName,
  ScopeType,
  SearchHit,
  SearchOptions,
  ServiceAccount,
  Tokens,
  User,
  UserRole,
  Workspace,
} from './types.js'

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
 * `NacreClient`. Contract: docs/api.md, machine-readable in docs/openapi.yaml.
 */

export { NacreClient, type ClientOptions } from './client.js'
export { NacreError, NacreTransportError, type Problem } from './errors.js'
export type {
  CreatedServiceAccount,
  Document,
  Effect,
  Grant,
  GrantInput,
  IngestOutcome,
  IngestRequest,
  Job,
  JobStatus,
  Layer,
  LayerInput,
  Permission,
  PrincipalType,
  ScopeType,
  SearchHit,
  SearchOptions,
  ServiceAccount,
} from './types.js'

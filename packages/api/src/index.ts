export { createApi } from './server.js'
export type {
  ApiOptions,
  AuditEvent,
  AuditSink,
  DocumentView,
  Documents,
  GrantInput,
  GrantRecord,
  Grants,
  Ingest,
  IngestOutcome,
  IngestRequest,
  Job,
  Jobs,
  Layer,
  LayerOutcome,
  Layers,
  SearchHit,
  SearchService,
  ServiceAccountPort,
  ServiceAccountView,
} from './server.js'
export { authenticate, findTenantOverride, rejectTenantOverride } from './auth.js'
export type { AuthContext, VerifyOptions } from './auth.js'
export { Problem, badRequest, forbidden, internal, notFound, unauthorized } from './errors.js'
export {
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresDocuments,
  PostgresGrants,
  PostgresJobs,
  PostgresLayers,
} from './adapters.js'
export type { DocumentTombstone, Embedder, IngestDeps, SearchDeps } from './adapters.js'
export {
  generateKey,
  hashOf,
  KEY_PREFIX,
  looksLikeServiceKey,
  PostgresServiceAccounts,
  PostgresServiceKeys,
  prefixOf,
} from './service-keys.js'
export type { ServiceAccount, ServiceAccounts, ServiceKeyResolver } from './service-keys.js'

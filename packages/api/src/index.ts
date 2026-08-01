export { createApi } from './server.js'
export type {
  ApiOptions,
  AuditEvent,
  AuditSink,
  Documents,
  Ingest,
  IngestOutcome,
  IngestRequest,
  SearchService,
} from './server.js'
export { authenticate, findTenantOverride, rejectTenantOverride } from './auth.js'
export type { AuthContext, VerifyOptions } from './auth.js'
export { Problem, badRequest, forbidden, internal, notFound, unauthorized } from './errors.js'
export { HttpEmbedder, NacreIngest, NacreSearchService, PostgresAudit, PostgresDocuments } from './adapters.js'
export type { Embedder, SearchDeps } from './adapters.js'

export { createApi } from './server.js'
export type {
  ApiOptions,
  AuditEvent,
  AuditQuery,
  AuditReader,
  AuditRecord,
  Reindex,
  ReindexOutcome,
  ReindexStatus,
  ReferenceQueries,
  ReferenceQuery,
  RecallCheck,
  AuditWriter,
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
  SearchOptions,
  SearchService,
  ServiceAccountPort,
  ServiceAccountView,
} from './server.js'
export { authenticate, findTenantOverride, rejectTenantOverride } from './auth.js'
export type { AuthContext, Delegations, VerifyOptions } from './auth.js'
export { postgresVerification } from './verification.js'
export {
  PostgresDelegations,
  PostgresOAuthAuthorizations,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
} from './oauth-store.js'
export type {
  Consent,
  ConsentSubject,
  MintRequest,
  OAuthAuthorizations,
  OAuthClients,
  OAuthConsents,
  OAuthRefreshTokens,
  PendingAuthorization,
  RegisteredClient,
} from './oauth-store.js'
export { Problem, badRequest, forbidden, internal, notFound, unauthorized } from './errors.js'
export {
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresAuditReader,
  PostgresDocuments,
  PostgresGrants,
  PostgresJobs,
  PostgresLayers,
  PostgresWorkspaces,
  PostgresReferenceQueries,
  PostgresReindex,
} from './adapters.js'
export type {
  DocumentTombstone,
  Embedder,
  IngestDeps,
  ObjectStore,
  PrincipalsCache,
  SearchDeps,
} from './adapters.js'
export { PostgresGroups, PostgresUsers, generatePassword, looksLikeEmail } from './principals.js'
export type { GroupMember, Groups, GroupView, Users, UserView } from './principals.js'
export { applyRanking, HttpReranker, rerankerFor } from './rerank.js'
export type { Reranker } from './rerank.js'
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
// The limiter, so the MCP transport can share it rather than growing a second
// one. Two limiters would be two buckets, and a caller out of budget on one
// surface would simply use the other — which is what happened before this was
// exported: NACRE_RATE_* applied to REST only.
export { auditFormat, auditJson, readAuditQuery, toCsv, toNdjson } from './audit-export.js'
export type { AuditFormat } from './audit-export.js'
export { limitHeaders, RateLimiter } from './limits.js'
export type { LimitDecision, LimitPolicy, Resource } from './limits.js'
export { clientSource } from './source.js'
export { Login } from './login.js'
export type { LoginDeps, LoginRequest, Tokens } from './login.js'

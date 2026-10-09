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
  GrantFilter,
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
export {
  administers,
  administersTenants,
  authenticate,
  delegationPermits,
  findTenantOverride,
  rejectTenantOverride,
  delegatedLayers,
  withinDelegation,
} from './auth.js'
export type { AuthContext, Delegations, VerifyOptions } from './auth.js'
export { postgresVerification } from './verification.js'
export { oauthMinter } from './oauth-mint.js'
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
  RedeemedAuthorization,
  ConsentSurface,
  RegisteredClient,
} from './oauth-store.js'
export { Problem, badRequest, forbidden, internal, notFound, unauthorized } from './errors.js'
export { MAX_REACH_LAYERS, PostgresAccess } from './access.js'
export type { AccessSubject, EffectiveAccess, Reach } from './access.js'
export {
  AUDIT_GROUPINGS,
  contextFor,
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresAuditReader,
  PostgresDocuments,
  PostgresGrants,
  PostgresJobs,
  PostgresEmbeddingProviders,
  PostgresLayers,
  PostgresWorkspaces,
  PostgresReferenceQueries,
  PostgresReindex,
} from './adapters.js'
export type {
  AuditBucket,
  AuditGrouping,
  DocumentTombstone,
  Embedder,
  IngestDeps,
  ObjectStore,
  PrincipalsCache,
  SearchDeps,
} from './adapters.js'
export { PostgresGroups, PostgresUsers, looksLikeEmail } from './principals.js'
export { INSTRUCTIONS_SKILL_LIMIT, PostgresSkills } from './skills.js'
export { CEILING_VALUES, ceilingOffers, isCeilingValue } from './skill-ceiling.js'
export type { CeilingValue } from './skill-ceiling.js'
export { decodeCursor, encodeCursor, MAX_LIMIT } from './pagination.js'
export type {
  EffectiveBase,
  SkillEntry,
  SkillLevel,
  Skills,
  SkillSurface,
  SkillVersion,
  SkillVersionMeta,
  SkillWrite,
} from './skills.js'
// Re-exported rather than defined here. It moved to the core when the second
// copy of its word list was found; this keeps an existing importer working and
// makes it visibly one function rather than two agreeing.
export { generatePassword } from '@nacre.work/core'
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
export { RedisUploadTickets, TICKET_TTL_SECONDS, uploadDescriptor } from './uploads.js'
export type { UploadDescriptor, UploadTicket, UploadTicketStore } from './uploads.js'

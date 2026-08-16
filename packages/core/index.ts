export * from './types.js'
export * from './authz/index.js'
export {
  parseFilters,
  parseMetadata,
  MetadataError,
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_LIST,
  MAX_METADATA_VALUE_LENGTH,
} from './metadata.js'
export type { Metadata } from './metadata.js'
export { loadConfig, loadJwtKeys, loadJwtVerification, keyFingerprint, ConfigError } from './config.js'
export { protectedResourceMetadata, PROTECTED_RESOURCE_PATH, JWKS_PATH } from './oauth.js'
export {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  CODE_TTL_MS,
  REGISTER_PATH,
  TOKEN_PATH,
  authorizationServerMetadata,
  consentRedirect,
  generateClientId,
  generateCode,
  hashCode,
  redirectAllowed,
  verifierMatches,
} from './authserver.js'
export type { AuthorizationServerMetadata } from './authserver.js'
export {
  activeResolver,
  admitIngest,
  ADMIN_PREFIX,
  adminRoutes,
  auditSinks,
  authProviders,
  loadModules,
  loadedExtensions,
  mountAdminRoutes,
  registerAuditSink,
  registerAuthProvider,
  registerAuthzResolver,
  registerIngestGate,
  resetExtensionsForTests,
  withAuditSinks,
  withLoadingModuleForTests,
} from './extensions.js'
export type {
  AdminRequest,
  AdminResponse,
  AdminRoute,
  AuditEvent,
  AuditSink,
  AuditWriter,
  AuthProvider,
  AuthzResolver,
  IngestContext,
  IngestGate,
  IngestRefusal,
  IngestVerdict,
  ResolvedPrincipal,
} from './extensions.js'
export type { ProtectedResourceMetadata } from './oauth.js'
export type { JwtKeys, JwtVerification } from './config.js'
export type { Config } from './config.js'
export { acrossOrganizations, createPool, whileAuthenticating, withOrg } from './db/client.js'
export type { DbOptions, WithOrgOptions } from './db/client.js'
export { migrate, loadMigrations, migrationNames, pendingMigrations } from './db/migrate.js'
export { organizationSlugError, provisionInPostgres, provisionOrganization } from './provision.js'
export type { ProviderSpec, ProvisionOptions, ProvisionResult } from './provision.js'
export { loadGrants, loadGroupsVersion, loadScopeTree, PostgresGroupGraph } from './authz/store.js'
export {
  explainQdrant,
  MetadataIndexer,
  METADATA_INDEX_LIMIT,
  VectorStore,
  vectorStoreOptions,
} from './vector/search.js'
export { MAX_AUDITED_QUERY, queryAudit } from './audit.js'
export {
  MAX_PARTS,
  MAX_PART_HEADER_BYTES,
  MultipartError,
  multipartBoundary,
  parseMultipart,
} from './multipart.js'
export type { MultipartPart } from './multipart.js'
export type { QueryAudit } from './audit.js'
export { configureLogging, createLogger, logger } from './logging.js'
export type { Logger, LoggerOptions, LogFormat, LogLevel } from './logging.js'
export {
  DEFAULT_EMBED_BATCH,
  embedInBatches,
  endpointReason,
  endpointUrl,
  modelEndpointRefused,
} from './endpoint.js'
export { documentKey, S3, S3Error } from './s3.js'
export type { S3Options } from './s3.js'
export type { Hit, SearchRequest, VectorStoreOptions } from './vector/search.js'
export { buildHybridQuery, collectionConfig, collectionName, PAYLOAD_INDEXES, vectorName } from './vector/query.js'
export type { Branch, CollectionShape, HybridQuery } from './vector/query.js'
export { encodeDocument, encodeQuery, isEmpty, SPARSE_VECTOR_NAME, tokenize } from './text/bm25.js'
export type { SparseVector } from './text/bm25.js'
export {
  DEFAULT_EMBED_MAX_TOKENS,
  estimateTokens,
  refusedForLength,
  TOKEN_RESERVE,
  tokenBudget,
} from './text/tokens.js'
export { Counter, Gauge, Histogram, Registry, createMetrics } from './metrics.js'
export type { Labels, Metrics } from './metrics.js'
export { collectDatabaseGauges } from './observability.js'
export { Redis, RedisError } from './redis.js'
export type { RedisOptions } from './redis.js'
export { reindexProgress, toStateJson, toCheckJson, fromStateJson } from './reindex.js'
export type { ReindexState, ReindexCheck } from './reindex.js'
export {
  generatePassword,
  hashingLoad,
  hashPassword,
  needsRehash,
  PASSWORD_ENTROPY_BITS,
  PASSWORD_WORD_COUNT,
  PASSWORD_WORDS,
  spendVerificationTime,
  TooBusy,
  verifyPassword,
} from './passwords.js'
export { installGuards, onListenError } from './lifecycle.js'
export type { Guards } from './lifecycle.js'

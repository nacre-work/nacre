/**
 * What `initialize` and `server/discover` report as the server's version.
 *
 * Both transports reported `0.0.0` on every connection until this went in,
 * because `serverVersion` was optional and neither entry point passed one — a
 * field that was carried, threaded through an option, and never given a value.
 * The reading itself is the core's, which the API asks as well.
 */
export { packageVersion } from '@nacre.work/core'

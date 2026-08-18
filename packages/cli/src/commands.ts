import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { NacreClient, type Job, type SearchHit } from '@nacre.work/sdk'

import { flag, integer, option, UsageError, type Parsed } from './args.js'
import { loadSession, saveSession, type Session } from './config.js'
import type { Outcome } from './run.js'

/**
 * The commands.
 *
 * Each one returns text; nothing here writes to stdout directly, so a command
 * is testable without capturing a stream and `--json` is one branch rather than
 * a rule every command has to remember.
 */

export interface Context {
  readonly parsed: Parsed
  readonly env: NodeJS.ProcessEnv
  /** Injected so the tests do not have to run a terminal. */
  readonly prompt: (question: string, hidden: boolean) => Promise<string>
  readonly clientFor: (session: Session) => NacreClient
}

const UNAUTHENTICATED = 'unauthenticated'

/**
 * The one message for "there is no session".
 *
 * It names both ways in, because the two readers want different halves: on a
 * laptop it is `nacre login`, and in CI it is the variables, where there is no
 * terminal to log in from and nowhere to write a config file that survives.
 */
const NO_SESSION =
  'Not signed in. Run `nacre login --url https://your-installation` — or set ' +
  'NACRE_API_URL and NACRE_TOKEN, which is what a service account in CI uses.'

export function requireSession(context: Context): Session {
  const session = loadSession(context.env)
  if (session === undefined) throw new Error(NO_SESSION)
  return session
}

export function requireClient(context: Context): NacreClient {
  return context.clientFor(requireSession(context))
}

/** `--json` prints the object; otherwise the caller's own rendering. */
export function render(context: Context, value: unknown, human: () => string): string {
  return flag(context.parsed, 'json') ? JSON.stringify(value, null, 2) : human()
}

export async function login(context: Context): Promise<string> {
  const url = option(context.parsed, 'url') ?? context.env.NACRE_API_URL
  if (url === undefined) {
    throw new UsageError('nacre login --url <https://your-installation>')
  }

  const email = option(context.parsed, 'email') ?? (await context.prompt('Email: ', false))
  const password = await context.prompt('Password: ', true)
  const organization = option(context.parsed, 'org')

  const bare = context.clientFor({ baseUrl: url, token: UNAUTHENTICATED })
  const tokens = await bare.auth.login({
    email,
    password,
    ...(organization === undefined ? {} : { organization }),
  })

  // `undefined` is a refused sign-in, and it does not say which of the several
  // reasons applied — that is invariant 4 reaching the login endpoint, and the
  // CLI must not invent a more helpful message than the server was willing to
  // give.
  if (tokens === undefined) throw new Error('Sign-in refused.')

  /*
   * A correct password and a second factor still to produce.
   *
   * Asked for here rather than left to a flag, because the alternative is a
   * command that succeeds at signing in and fails at everything afterwards. The
   * prompt hides what is typed for the same reason the password one does: a
   * code is short-lived but a recovery code is not, and this prompt takes
   * either.
   *
   * **A security key is deliberately not offered here, and cannot be.** A
   * WebAuthn ceremony needs `navigator.credentials`, which is a browser API;
   * there is no terminal equivalent to fall back to. Somebody whose only second
   * factor is a key signs in here with a recovery code — which is what those
   * are for, and is why the prompt says so rather than asking for "the code"
   * and meeting a person who has no such thing.
   */
  const session =
    'secondFactorRequired' in tokens
      ? await bare.auth.secondFactor({
          challenge: tokens.challenge,
          code: (
            await context.prompt('Code from your authenticator, or a recovery code: ', true)
          ).trim(),
        })
      : tokens
  if (session === undefined) throw new Error('Sign-in refused.')

  /*
   * A gate wants a second factor this account does not have.
   *
   * Refused here rather than walked through, and that is a limit of this
   * surface rather than an omission. Enrolling TOTP means showing a QR code or
   * a secret to type into a phone, and enrolling a key needs
   * `navigator.credentials` — the same reason a key cannot be used to sign in
   * from a terminal. So this says where the flow exists instead of half-running
   * it: the console does the enrolment, and this command works afterwards.
   */
  if ('secondFactorEnrolmentRequired' in session) {
    throw new Error(
      `${session.reason}\nEnrol one in the admin console at ${url}, then sign in here again.`,
    )
  }

  const path = saveSession(
    { baseUrl: url, token: session.accessToken, refreshToken: session.refreshToken },
    context.env,
  )
  const who = await context.clientFor({ baseUrl: url, token: session.accessToken }).me()

  return `Signed in to ${url} as ${who.principalId} (${who.role}) in ${who.organization}.\nSession written to ${path}, readable only by you.`
}

export async function whoami(context: Context): Promise<string> {
  const session = requireSession(context)
  const self = await context.clientFor(session).me()

  return render(context, self, () =>
    [
      `endpoint      ${session.baseUrl}`,
      `organization  ${self.organization}`,
      `principal     ${self.principalId} (${self.principalType})`,
      `role          ${self.role}`,
    ].join('\n'),
  )
}

export async function layers(context: Context): Promise<string> {
  const client = requireClient(context)
  const [verb] = context.parsed.positional.slice(1)

  if (verb === 'create') return createLayer(context, client)
  if (verb !== undefined) throw new UsageError(`Unknown: nacre layers ${verb}`)

  const list = await client.layers.list()

  return render(context, list, () => {
    // Not an error and not an empty table: a caller with no readable layer is
    // the ordinary state of a member nobody has granted anything yet, and the
    // useful thing to say is what to do about it.
    if (list.length === 0) return 'No layers you can read. An org_admin grants access with `nacre grant`.'

    const width = Math.max(...list.map((layer) => layer.slug.length))
    return list
      .map((layer) => {
        const failed = layer.failedCount > 0 ? `, ${layer.failedCount} failed` : ''
        return `${layer.slug.padEnd(width)}  ${layer.documentCount} docs${failed}  ${layer.name}`
      })
      .join('\n')
  })
}

async function createLayer(context: Context, client: NacreClient): Promise<string> {
  const slug = context.parsed.positional[2]
  if (slug === undefined) throw new UsageError('nacre layers create <slug> [--name ...] [--workspace <slug>]')

  const wanted = option(context.parsed, 'workspace')
  const workspaces = await client.workspaces.list()

  // The gap this closes: creating a layer takes a workspace id, and the only
  // way to have one used to be the line `init` printed. Naming one is optional
  // here because almost every installation has exactly one — and where there
  // are several, guessing is refused rather than resolved by picking the first.
  const workspace =
    wanted === undefined
      ? workspaces.length === 1
        ? workspaces[0]
        : undefined
      : workspaces.find((candidate) => candidate.slug === wanted)

  if (workspace === undefined) {
    const known = workspaces.map((candidate) => candidate.slug).join(', ')
    throw new UsageError(
      wanted === undefined
        ? `This organization has ${workspaces.length} workspaces, so --workspace is required: ${known}`
        : `No workspace ${JSON.stringify(wanted)} you can reach. Yours: ${known || 'none'}`,
    )
  }

  const created = await client.layers.create({
    workspaceId: workspace.id,
    slug,
    name: option(context.parsed, 'name') ?? slug,
    ...(option(context.parsed, 'description') === undefined
      ? {}
      : { description: option(context.parsed, 'description') as string }),
    ...(option(context.parsed, 'provider') === undefined
      ? {}
      : { providerId: option(context.parsed, 'provider') as string }),
  })

  // A `404` here is the workspace being invisible or the caller not holding
  // admin on it, and those are deliberately the same answer.
  if (created === undefined) throw new Error(`Refused: no workspace ${workspace.slug} you may create a layer in.`)

  return render(context, created, () => `Created layer ${created.slug} in ${workspace.slug}.`)
}

export async function grant(context: Context): Promise<string> {
  const client = requireClient(context)
  const [, permission, scope] = context.parsed.positional
  const to = option(context.parsed, 'to')

  if (permission === undefined || scope === undefined || to === undefined) {
    throw new UsageError(
      'nacre grant <read|write|admin> <layer:slug|workspace:slug|document:id> --to <user|group|service_account>:<id>',
    )
  }
  if (permission !== 'read' && permission !== 'write' && permission !== 'admin') {
    throw new UsageError(`Permission is read, write or admin — not ${JSON.stringify(permission)}.`)
  }

  const [scopeType, scopeRef] = split(scope, 'scope', ['workspace', 'layer', 'document'])
  const [principalType, principalId] = split(to, '--to', ['user', 'group', 'service_account'])

  // A slug is what a person has and an id is what the API takes, for the two
  // scope types that have slugs. Resolving it here rather than making the
  // reader run a listing first is most of why this command exists.
  const scopeId = await resolveScope(client, scopeType, scopeRef)

  const issued = await client.grants.issue({
    principalType: principalType as 'user' | 'group' | 'service_account',
    principalId,
    scopeType: scopeType as 'workspace' | 'layer' | 'document',
    scopeId,
    permission,
  })

  if (issued === undefined) {
    throw new Error(
      `Refused: no ${scopeType} ${JSON.stringify(scopeRef)} you hold admin on. ` +
        'Not finding it and not being allowed to grant on it are the same answer here.',
    )
  }

  return render(context, issued, () => `Granted ${permission} on ${scope} to ${to}.`)
}

function split(value: string, what: string, allowed: readonly string[]): [string, string] {
  const at = value.indexOf(':')
  const type = at === -1 ? '' : value.slice(0, at)
  const rest = at === -1 ? '' : value.slice(at + 1)
  if (!allowed.includes(type) || rest === '') {
    throw new UsageError(`${what} is <${allowed.join('|')}>:<slug or id>, not ${JSON.stringify(value)}`)
  }
  return [type, rest]
}

async function resolveScope(client: NacreClient, type: string, ref: string): Promise<string> {
  if (type === 'document') return ref

  if (type === 'layer') {
    const found = (await client.layers.list()).find((layer) => layer.slug === ref || layer.id === ref)
    if (found === undefined) throw new Error(`No layer ${JSON.stringify(ref)} you can see.`)
    return found.id
  }

  const found = (await client.workspaces.list()).find((one) => one.slug === ref || one.id === ref)
  if (found === undefined) throw new Error(`No workspace ${JSON.stringify(ref)} you can see.`)
  return found.id
}

/**
 * Whether a path is one this command would have ingested.
 *
 * Split out because the watcher needs the same answer for a single path that
 * `collect` reaches by walking, and two spellings of "is this a file we index"
 * is how a watcher comes to index a `.git` object nobody asked for.
 */
export function eligible(path: string): boolean {
  const parts = path.split(sep)
  if (parts.includes('.git') || parts.includes('node_modules')) return false
  return TEXT.has(extensionOf(basename(path)))
}

/** Extensions read as text. Everything else is refused rather than mangled. */
const TEXT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.csv', '.json', '.yaml', '.yml', '.html'])

export function collect(target: string): readonly { path: string; externalId: string }[] {
  const stats = statSync(target)

  if (stats.isFile()) {
    return [{ path: target, externalId: basename(target) }]
  }

  const found: { path: string; externalId: string }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Not a general ignore file: the two that matter are a checkout's own
      // metadata and an installed dependency tree, and both are large enough
      // that indexing them by accident is the difference between a minute and
      // an afternoon.
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (TEXT.has(extensionOf(entry.name))) {
        // Relative and slash-separated, so the same tree ingested from Windows
        // and from Linux produces the same external ids — and ingest is
        // idempotent on (layer, external id), so getting that wrong means a
        // second copy of every document rather than an error.
        found.push({ path, externalId: relative(target, path).split(sep).join('/') })
      }
    }
  }
  walk(target)
  return found.sort((a, b) => a.externalId.localeCompare(b.externalId))
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

export async function ingest(context: Context): Promise<Outcome> {
  const client = requireClient(context)
  const layer = option(context.parsed, 'layer')
  const targets = context.parsed.positional.slice(1)

  if (layer === undefined || targets.length === 0) {
    throw new UsageError('nacre ingest <file or directory>... --layer <slug>')
  }

  const files = targets.flatMap((target) => collect(target))
  if (files.length === 0) {
    throw new UsageError(
      `Nothing to ingest: no text files under ${targets.join(', ')}. ` +
        `Read as text: ${[...TEXT].sort().join(' ')}. A PDF goes through POST /v1/documents as multipart, which this command does not do yet.`,
    )
  }

  // Submitted in order and waited on afterwards, rather than each one driven to
  // `indexed` before the next is sent. The worker is the thing that scales out
  // here, so serialising the whole pipeline behind one client would leave every
  // replica but one idle — and sending them all at once is how a directory of a
  // thousand files meets the ingest rate limit as a wall of 429s.
  const queued: { externalId: string; jobId: string }[] = []
  let unchanged = 0

  for (const file of files) {
    const outcome = await client.documents.add({
      layer,
      externalId: file.externalId,
      title: basename(file.path),
      content: readFileSync(file.path, 'utf8'),
    })
    if (outcome.unchanged) unchanged += 1
    else queued.push({ externalId: file.externalId, jobId: outcome.jobId })
  }

  const results = await Promise.all(
    queued.map(async (item) => ({ ...item, job: await client.jobs.wait(item.jobId) })),
  )

  const failed = results.filter((item) => item.job?.status !== 'indexed')

  const output = render(
    context,
    { indexed: results.length - failed.length, unchanged, failed: failed.map(describe) },
    () => {
      const lines = [
        `${results.length - failed.length} indexed, ${unchanged} unchanged, ${failed.length} failed.`,
      ]
      // Every failure by name. A count alone is the version of this that gets
      // ignored, and the reason is on the job rather than in a log the person
      // running a CLI has no access to.
      for (const item of failed) lines.push(`  ${item.externalId}: ${reasonOf(item.job)}`)
      return lines.join('\n')
    },
  )

  if (flag(context.parsed, 'watch')) {
    const directories = targets.filter((target) => statSync(target).isDirectory())
    if (directories.length === 0) {
      throw new UsageError('--watch needs a directory to watch, not only files')
    }
    return watch(context, client, layer, directories, output)
  }

  // **A failed document is a non-zero exit**, and finding that out is what
  // running this against a real stack was for: a misconfigured embedding
  // provider failed every document in the directory, the summary said `2
  // failed`, and the process exited 0. A pipeline that ingests a corpus
  // nightly and checks the exit code would have reported success for weeks
  // while the index stayed empty — which is the shape of defect this
  // repository has found more often than any other.
  //
  // The summary still goes to stdout: it is the answer, and a script needs to
  // read which documents failed rather than only that some did.
  return failed.length === 0 ? output : { output, code: 1 }
}

/**
 * Keep ingesting a directory as it changes.
 *
 * The gap between "no connectors" — which is the right decision and stays — and
 * "write your own ingest", which is what everybody trying this actually has to
 * do first. It is not a connector: no Confluence, no Drive, no credentials for
 * somebody else's system. It is the directory already on the machine.
 *
 * **It never deletes.** A file disappearing looks identical to the first half
 * of how every editor saves — write a temporary file, rename it over the
 * original — so a watcher that removed a document on an unlink event would
 * delete documents on save, intermittently, depending on the editor. Removing a
 * document is `DELETE /v1/documents/{id}`, deliberately by hand.
 *
 * Re-ingest of unchanged bytes is free: ingest is idempotent on
 * `(layer, external_id)` plus the content hash, so a save that changes nothing
 * costs one request and no embedding.
 */
async function watch(
  context: Context,
  client: NacreClient,
  layer: string,
  directories: readonly string[],
  first: string,
): Promise<Outcome> {
  const { watch: watchDirectory } = await import('node:fs')
  const lines = [first, `Watching ${directories.join(', ')} for changes. Ctrl-C to stop.`]

  // Editors emit several events for one save — the temporary file, the rename,
  // a metadata touch — so a pass is scheduled rather than run per event, and a
  // second event inside the window joins the pass already coming.
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | undefined

  const flush = async () => {
    timer = undefined
    const batch = [...pending]
    pending.clear()

    for (const path of batch) {
      const target = directories.find((dir) => path.startsWith(dir + sep) || path.startsWith(dir))
      if (target === undefined) continue
      try {
        const outcome = await client.documents.add({
          layer,
          externalId: relative(target, path).split(sep).join('/'),
          title: basename(path),
          content: readFileSync(path, 'utf8'),
        })
        if (outcome.unchanged) continue
        const job = await client.jobs.wait(outcome.jobId)
        process.stderr.write(
          `${job?.status === 'indexed' ? 'indexed' : `failed: ${reasonOf(job)}`}  ${relative(target, path)}\n`,
        )
      } catch (error) {
        // A file removed between the event and the read is the ordinary case,
        // and so is a partially written one. Neither is worth stopping a
        // watcher that is meant to run all day.
        process.stderr.write(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }

  for (const directory of directories) {
    watchDirectory(directory, { recursive: true }, (_event, name) => {
      if (name === null) return
      const path = join(directory, name.toString())
      if (!eligible(path)) return
      pending.add(path)
      if (timer === undefined) timer = setTimeout(() => void flush(), 300)
    })
  }

  // Progress goes to stderr above, so this resolves only on Ctrl-C and the
  // summary of the first pass stays the thing on stdout.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve())
    process.on('SIGTERM', () => resolve())
  })

  return lines.join('\n')
}

const describe = (item: { externalId: string; job: Job | undefined }) => ({
  externalId: item.externalId,
  status: item.job?.status ?? 'unknown',
  error: item.job?.error ?? null,
})

const reasonOf = (job: Job | undefined): string =>
  job === undefined ? 'the job disappeared' : (job.error ?? job.status)

export async function search(context: Context): Promise<string> {
  const client = requireClient(context)
  const query = context.parsed.positional.slice(1).join(' ')
  if (query === '') throw new UsageError('nacre search <query> [--layer <slug>] [--top-k <n>]')

  const layer = option(context.parsed, 'layer')
  const hits = await client.search(query, {
    ...(integer(context.parsed, 'top-k') === undefined ? {} : { topK: integer(context.parsed, 'top-k') as number }),
    ...(layer === undefined ? {} : { layers: [layer] }),
  })

  return render(context, hits, () => {
    // An empty result is an answer, not an error: it is what a caller with no
    // grant on anything matching sees, and it is indistinguishable from there
    // being nothing to match. Saying so is invariant 4 in a terminal.
    if (hits.length === 0) return 'No results you can see.'
    return hits.map(one).join('\n\n')
  })
}

/**
 * Score a layer's reference query set, from outside the worker.
 *
 * The same measurement the reindex gate makes and for a different purpose. That
 * one asks "can the new model still answer?" at a moment nobody chose; this
 * asks "how is retrieval doing?" at a moment somebody did — before and after a
 * chunking change, a reranker being switched on, a corpus growing by a
 * quarter. Until now the answer to "what is your recall?" was a number that
 * existed only inside a migration nobody was running.
 *
 * **Recall@k against documents the deployment picked**, averaged per query,
 * which is the core's definition and deliberately not agreement with a previous
 * model — a better model disagrees with the worse one it replaces.
 *
 * It is a read-only measurement: nothing here writes a verdict, moves a layer
 * or touches the index. A number leaves, and that is all.
 */
export async function evaluate(context: Context): Promise<Outcome> {
  const client = requireClient(context)
  const slug = option(context.parsed, 'layer')
  if (slug === undefined) throw new UsageError('nacre eval --layer <slug> [--top-k <n>] [--floor <0..1>]')

  const layer = (await client.layers.list()).find((one) => one.slug === slug || one.id === slug)
  if (layer === undefined) throw new Error(`No layer ${JSON.stringify(slug)} you can see.`)

  const queries = await client.layers.referenceQueries(layer.id)
  if (queries === undefined || queries.length === 0) {
    // Not an error and not a zero. A layer without a reference set has no gate
    // by design — the core says so — and reporting 0.00 would read as terrible
    // retrieval rather than as no measurement.
    throw new UsageError(
      `Layer ${slug} has no reference queries, so there is nothing to score. ` +
        'Write a set with PUT /v1/layers/{id}/reference-queries, or on the layer screen in the admin UI.',
    )
  }

  const topK = integer(context.parsed, 'top-k') ?? 10
  const floor = Number(option(context.parsed, 'floor') ?? '0')
  if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
    throw new UsageError('--floor is a fraction between 0 and 1')
  }

  const scored = await Promise.all(
    queries.map(async (query) => {
      const hits = await client.search(query.query, { topK, layers: [layer.slug] })

      // Hits carry document ids and a reference set names external ids, so the
      // two are joined by reading the documents back. That read is why
      // `external_id` had to stop being write-only: a client could name a
      // document on the way in and never ask about it by that name again.
      const found = new Set(
        (
          await Promise.all(
            [...new Set(hits.map((hit) => hit.documentId))].map(async (id) =>
              (await client.documents.get(id))?.externalId ?? undefined,
            ),
          )
        ).filter((id): id is string => id !== undefined),
      )

      const hit = query.expected.filter((id) => found.has(id))
      return {
        query: query.query,
        expected: query.expected.length,
        found: hit.length,
        // A query expecting nothing scores zero rather than one. The core's
        // gate makes the same choice: an empty expectation is a reference set
        // that was not finished, and calling it perfect hides that.
        recall: query.expected.length === 0 ? 0 : hit.length / query.expected.length,
        missing: query.expected.filter((id) => !found.has(id)),
      }
    }),
  )

  // The mean is over queries, not over documents. Otherwise one query naming
  // ten documents outvotes five naming one each, which is the core's argument
  // and it is the same arithmetic here.
  const recall = scored.reduce((total, item) => total + item.recall, 0) / scored.length

  const output = render(context, { layer: layer.slug, topK, recall, queries: scored }, () => {
    const lines = [`recall@${topK} ${recall.toFixed(3)} over ${scored.length} quer${scored.length === 1 ? 'y' : 'ies'}`]
    for (const item of scored) {
      lines.push(`  ${item.recall.toFixed(2)}  ${item.found}/${item.expected}  ${item.query}`)
      // The missing documents by name, because "0.60" tells nobody what to
      // look at and the whole point of running this is to look at something.
      if (item.missing.length > 0) lines.push(`        missing: ${item.missing.join(', ')}`)
    }
    return lines.join('\n')
  })

  // `--floor` makes it a gate: exit 1 below the number, so this can be the step
  // in a pipeline that refuses to promote an index. Without one it only
  // reports, because a bare `nacre eval` failing on a corpus somebody is still
  // building would teach them to stop running it.
  return floor > 0 && recall < floor ? { output, code: 1 } : output
}

function one(hit: SearchHit): string {
  const head = `${hit.score.toFixed(3)}  ${hit.layer}  ${hit.title ?? hit.documentId}`
  const body = hit.text.replace(/\s+/g, ' ').trim()
  return `${head}\n  ${body.length > 240 ? `${body.slice(0, 240)}…` : body}`
}

export interface Terminal {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => void }
  readonly output: NodeJS.WritableStream
}

/**
 * Ask for something, and for a password ask without echoing it.
 *
 * The first version of this drove `readline` with `terminal: true` and
 * intercepted its private `_writeToOutput`. It printed the password. Found by
 * running it rather than by reading it: `terminal: true` makes readline echo
 * whatever it reads, the interception is against an API with a leading
 * underscore for a reason, and the case it failed on is the one a script uses —
 * stdin is a pipe, where readline echoes the piped bytes back out because it
 * was told there was a terminal.
 *
 * So readline is not involved in the hidden path at all. A pipe does not echo
 * on its own, and a terminal does it in the driver, which raw mode turns off —
 * two cases, each handled by the mechanism that actually governs it.
 *
 * This is not a security control. Anyone who can read this process can read the
 * password whatever it does. What it buys is that the password is not in the
 * scrollback, not in a screen recording, and not on the projector.
 */
export async function ask(
  question: string,
  hidden: boolean,
  io: Terminal = { input: process.stdin, output: process.stderr },
): Promise<string> {
  // The prompt goes to stderr, never stdout: `nacre search q --json | jq` has
  // to work, and a prompt in that stream is a parse error.
  io.output.write(question)

  if (!hidden) {
    const rl = createInterface({ input: io.input, output: io.output, terminal: io.input.isTTY === true })
    try {
      return (await rl.question('')).trim()
    } finally {
      rl.close()
    }
  }

  const answer = await readSecret(io)
  io.output.write('\n')
  return answer.trim()
}

function readSecret(io: Terminal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const raw = io.input.isTTY === true && typeof io.input.setRawMode === 'function'
    if (raw) io.input.setRawMode?.(true)

    let collected = ''
    const done = (finish: () => void) => {
      io.input.off('data', onData)
      io.input.off('end', onEnd)
      if (raw) io.input.setRawMode?.(false)
      io.input.pause()
      finish()
    }

    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\n' || character === '\r') return done(() => resolve(collected))
        // Raw mode means this process sees Ctrl-C rather than a signal, so it
        // has to be honoured here or the prompt cannot be got out of.
        if (character === '') return done(() => reject(new Error('Cancelled.')))
        if (character === '' || character === '\b') collected = collected.slice(0, -1)
        else if (character >= ' ') collected += character
      }
    }
    const onEnd = () => done(() => resolve(collected))

    io.input.on('data', onData)
    io.input.on('end', onEnd)
    io.input.resume()
  })
}

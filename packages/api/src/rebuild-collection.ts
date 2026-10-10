import {
  ConfigError,
  createPool,
  loadConfig,
  readRebuildSchema,
  rebuildOrganizationIndex,
  VectorStore,
  vectorStoreOptions,
} from '@nacre.work/core'
import { pathToFileURL } from 'node:url'

/**
 * Rebuild an organization's Qdrant collection from what Postgres still knows.
 *
 * The disaster this is for: the vector store is gone — a lost volume, a deleted
 * collection, a restore that brought Postgres back and not Qdrant — and there
 * was no command to put it back. `init` is the wrong tool twice over. It builds
 * `org_{slug}` with a single slot from the process configuration, and after a
 * reindex the name lives in `organizations.vector_collection` and no longer
 * follows the slug, while the slots are one per embedding model the layers use.
 * Both of those are in the database; none of them are in `init`'s arguments.
 *
 * So this reads the real name and the real slots from Postgres, recreates the
 * collection with them, and requeues every document — the worker re-embeds them,
 * because the vectors are the one thing Postgres does not hold. It is a one-shot
 * command run where the operator already has credentials, the same shape as
 * `init` and `migrate`, and it is deliberately not an endpoint: recreating a
 * collection and requeuing an organization's documents is not a request the API
 * should take from the network.
 *
 * It **refuses when the collection still exists** unless `--replace` says so —
 * `VectorStore.rebuildCollection` does, because rebuilding over a live one
 * deletes every vector in it. `--replace` is for the other disaster: Postgres was
 * restored and the vector store was not, so the collection is there and no longer
 * matches it. See `packages/core/rebuild.ts`, which is the whole of the logic;
 * this file is its command line.
 */

interface Args {
  readonly org: string
  readonly replace: boolean
}

export const USAGE =
  'usage: rebuild-collection --org <slug> [--replace]\n' +
  '  --replace drops the collection first — for a vector store that survived a\n' +
  '  restore of the database and no longer matches it. Without it, a collection\n' +
  '  that exists is refused.'

export function parseArgs(argv: readonly string[]): Args | string {
  let org: string | undefined
  let replace = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--org') {
      org = argv[++i]
    } else if (arg === '--replace') {
      replace = true
    } else {
      return `unexpected argument: ${String(arg)}`
    }
  }
  if (org === undefined || org === '') return '--org <slug> is required'
  return { org, replace }
}

async function main(): Promise<void> {
  const say = (msg: string, extra?: Record<string, unknown>): void => {
    process.stdout.write(extra === undefined ? `${msg}\n` : `${msg} ${JSON.stringify(extra)}\n`)
  }

  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n\n${USAGE}\n`)
    process.exit(2)
  }

  const config = loadConfig()
  const pool = createPool({ connectionString: config.pgUrl, max: 2 })

  try {
    // Read first and print it, so an operator sees which collection and which
    // slots are about to be created before anything is dropped.
    const schema = await readRebuildSchema(pool, parsed.org)
    if (typeof schema === 'string') {
      process.stderr.write(`${schema}\n`)
      process.exit(1)
    }
    say('read the schema from Postgres', {
      collection: schema.collection,
      slots: schema.slots.map((s) => `${s.name}:${s.size}`),
      metadata_keys: schema.metadataKeys.length,
      documents: schema.documents,
      replace: parsed.replace,
    })

    const vectors = new VectorStore(vectorStoreOptions(config))
    const done = await rebuildOrganizationIndex({ pool, vectors, slug: parsed.org, replace: parsed.replace })
    if (typeof done === 'string') {
      process.stderr.write(`${done}\n`)
      process.exit(1)
    }
    say('collection rebuilt', { collection: done.collection })
    say('documents requeued for re-indexing', { documents: done.requeued })
    say(
      `Done. The worker will re-embed ${done.requeued} document${done.requeued === 1 ? '' : 's'} into ` +
        `${done.collection}; watch them reach "indexed".`,
    )
  } finally {
    await pool.end()
  }
}

// Run only when executed directly, so importing this module in a test does not
// try to connect to anything — the same guard `init` uses.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  })
}

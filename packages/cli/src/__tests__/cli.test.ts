import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { flag, integer, option, parse, UsageError } from '../args.js'
import { ask, collect, eligible } from '../commands.js'
import { configPath, loadSession, saveSession } from '../config.js'
import { run } from '../run.js'

/**
 * The CLI exists to remove four `curl` invocations from the quickstart, so what
 * these cases are about is the argument surface and the session — the parts a
 * person gets wrong, and the parts that are this program's rather than the
 * SDK's. The requests themselves are the SDK's and are covered where it is.
 */

const scratch = () => mkdtempSync(join(tmpdir(), 'nacre-cli-'))

describe('parsing', () => {
  it('reads --key value and --key=value the same way', () => {
    expect(option(parse(['--layer', 'handbook']), 'layer')).toBe('handbook')
    expect(option(parse(['--layer=handbook']), 'layer')).toBe('handbook')
  })

  it('treats a bare --flag as true and does not eat the next command', () => {
    const parsed = parse(['search', 'query', '--json'])
    expect(flag(parsed, 'json')).toBe(true)
    expect(parsed.positional).toEqual(['search', 'query'])
  })

  it('keeps everything after -- positional, because a query can start with a dash', () => {
    const parsed = parse(['search', '--', '--layer', 'is a literal here'])
    expect(parsed.positional).toEqual(['search', '--layer', 'is a literal here'])
    expect(option(parsed, 'layer')).toBeUndefined()
  })

  it('refuses a --top-k that is not a positive whole number', () => {
    expect(() => integer(parse(['--top-k', 'ten']), 'top-k')).toThrow(UsageError)
    expect(() => integer(parse(['--top-k', '0']), 'top-k')).toThrow(UsageError)
    expect(() => integer(parse(['--top-k', '2.5']), 'top-k')).toThrow(UsageError)
    expect(integer(parse(['--top-k', '5']), 'top-k')).toBe(5)
  })
})

describe('exit codes', () => {
  // A script that cannot tell "I called this wrong" from "the server refused"
  // retries the first one forever.
  it('exits 2 with no command, and 0 when help was asked for', async () => {
    expect((await run([])).code).toBe(2)
    expect((await run(['help'])).code).toBe(0)
    expect((await run(['--help'])).code).toBe(0)
  })

  it('exits 2 on an unknown command, and says what it did not understand', async () => {
    const result = await run(['reticulate'])
    expect(result.code).toBe(2)
    expect(result.output).toContain('reticulate')
  })

  it('exits 2 when the invocation is incomplete, not 1', async () => {
    const env = { HOME: scratch(), NACRE_API_URL: 'https://x', NACRE_TOKEN: 't' }
    // No --layer.
    expect((await run(['ingest', 'somewhere'], { env })).code).toBe(2)
    // No query.
    expect((await run(['search'], { env })).code).toBe(2)
  })

  it('exits 1 with one message naming both ways in when there is no session', async () => {
    const result = await run(['whoami'], { env: { HOME: scratch() } })

    expect(result.code).toBe(1)
    expect(result.output).toContain('nacre login')
    // The CI half. Leaving it out is how somebody in a pipeline reads "run
    // nacre login" and has no terminal to run it from.
    expect(result.output).toContain('NACRE_TOKEN')
  })
})

describe('the session', () => {
  it('is written where nobody else can read it', () => {
    const env = { HOME: scratch() }
    const path = saveSession({ baseUrl: 'https://x', token: 'a', refreshToken: 'b' }, env)

    // A refresh token renews itself, so it outlives the access token beside it.
    // On a shared machine a default umask would leave this world readable.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(env.HOME, '.config', 'nacre')).mode & 0o777).toBe(0o700)
  })

  it('stays 0600 on a second write, which is the one a umask would decide', () => {
    const env = { HOME: scratch() }
    saveSession({ baseUrl: 'https://x', token: 'a' }, env)
    const path = saveSession({ baseUrl: 'https://x', token: 'b' }, env)

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('honours XDG_CONFIG_HOME', () => {
    const home = scratch()
    expect(configPath({ HOME: home, XDG_CONFIG_HOME: join(home, 'elsewhere') })).toBe(
      join(home, 'elsewhere', 'nacre', 'config.json'),
    )
  })

  it('lets the environment win, and does not pair it with a stored refresh token', () => {
    const env: NodeJS.ProcessEnv = { HOME: scratch() }
    saveSession({ baseUrl: 'https://stored', token: 'stored', refreshToken: 'stored-refresh' }, env)

    const session = loadSession({ ...env, NACRE_TOKEN: 'from-env' })

    expect(session?.token).toBe('from-env')
    // The environment cannot be renewed — nothing here would have anywhere to
    // write the new token — so carrying the file's refresh token alongside it
    // would be a second credential in play for no benefit.
    expect(session?.refreshToken).toBeUndefined()
  })

  it('reports no session rather than throwing when the file is corrupt', () => {
    const home = scratch()
    const path = configPath({ HOME: home })
    mkdirSync(join(home, '.config', 'nacre'), { recursive: true })
    writeFileSync(path, 'not json at all')

    expect(loadSession({ HOME: home })).toBeUndefined()
  })
})

describe('eval', () => {
  const env = { HOME: '/nonexistent', NACRE_API_URL: 'https://x', NACRE_TOKEN: 't' }

  /**
   * A client with two documents and a reference set, where search returns
   * `returns` for every query. Enough to pin the arithmetic, which is what this
   * command is: the requests themselves are the SDK's.
   */
  const clientWith = (queries: unknown[], returns: string[]) =>
    ({
      layers: {
        list: async () => [{ id: 'l1', slug: 'handbook', name: '', description: '', documentCount: 2, failedCount: 0 }],
        referenceQueries: async () => queries,
      },
      search: async () => returns.map((id) => ({ documentId: id, chunkId: 'c', score: 1, text: '', layer: 'handbook', title: null })),
      documents: { get: async (id: string) => ({ documentId: id, externalId: `ext-${id}`, layer: 'handbook', title: null, status: 'indexed', chunkCount: 1, updatedAt: '' }) },
    }) as never

  it('averages over queries, not over documents', async () => {
    // One query naming ten documents must not outvote five naming one each.
    // Same arithmetic as the core's gate, and the same reason.
    const result = await run(['eval', '--layer', 'handbook', '--json'], {
      env,
      clientFor: () =>
        clientWith(
          [
            { id: 'q1', query: 'a', expected: ['ext-d1'] },
            { id: 'q2', query: 'b', expected: ['ext-d1', 'ext-nope'] },
          ],
          ['d1'],
        ),
    })

    // 1.0 and 0.5 → 0.75. Over documents it would be 2/3.
    expect(JSON.parse(result.output).recall).toBeCloseTo(0.75)
    expect(result.code).toBe(0)
  })

  it('scores a query expecting nothing as zero, not as perfect', async () => {
    // An empty expectation is a reference set somebody did not finish. Calling
    // it 1.0 hides that behind a number that looks healthy.
    const result = await run(['eval', '--layer', 'handbook', '--json'], {
      env,
      clientFor: () => clientWith([{ id: 'q1', query: 'a', expected: [] }], ['d1']),
    })

    expect(JSON.parse(result.output).recall).toBe(0)
  })

  it('is a gate only when given a floor, and reports on stdout when it fails', async () => {
    const queries = [{ id: 'q1', query: 'a', expected: ['ext-d1', 'ext-missing'] }]

    const reporting = await run(['eval', '--layer', 'handbook'], {
      env,
      clientFor: () => clientWith(queries, ['d1']),
    })
    // Without a floor it only reports: a bare eval failing on a corpus somebody
    // is still building teaches them to stop running it.
    expect(reporting.code).toBe(0)

    const gating = await run(['eval', '--layer', 'handbook', '--floor', '0.9'], {
      env,
      clientFor: () => clientWith(queries, ['d1']),
    })
    expect(gating.code).toBe(1)
    expect(gating.stdout).toBe(true)
    // And names what was missing, because "0.50" tells nobody what to look at.
    expect(gating.output).toContain('ext-missing')
  })

  it('refuses a layer with no reference set rather than scoring it zero', async () => {
    // A layer without a set has no gate by design. Reporting 0.00 would read as
    // terrible retrieval rather than as no measurement.
    const result = await run(['eval', '--layer', 'handbook'], {
      env,
      clientFor: () => clientWith([], []),
    })

    expect(result.code).toBe(2)
    expect(result.output).toContain('no reference queries')
  })
})

describe('the password prompt', () => {
  const fake = () => {
    const input = new PassThrough()
    let written = ''
    const output = { write: (text: string) => ((written += text), true) } as unknown as NodeJS.WritableStream
    return { io: { input, output }, input, seen: () => written }
  }

  it('never writes the password to the output stream', async () => {
    // The defect this pins, found by running the CLI rather than by reading it:
    // the first version drove readline with `terminal: true` and printed the
    // password to the screen on the piped path, which is the path a script and
    // a demo both take.
    const { io, input, seen } = fake()
    const answer = ask('Password: ', true, io)
    input.write('correct-horse-battery-staple\n')

    expect(await answer).toBe('correct-horse-battery-staple')
    expect(seen()).toBe('Password: \n')
    expect(seen()).not.toContain('horse')
  })

  it('takes a password that arrives in pieces, as a slow pipe delivers one', async () => {
    const { io, input, seen } = fake()
    const answer = ask('Password: ', true, io)
    input.write('corr')
    input.write('ect-horse')
    input.write('\n')

    expect(await answer).toBe('correct-horse')
    expect(seen()).not.toContain('horse')
  })

  it('ends on end-of-input rather than hanging, which is an empty stdin', async () => {
    const { io, input } = fake()
    const answer = ask('Password: ', true, io)
    input.end()

    expect(await answer).toBe('')
  })
})

describe('collecting files to ingest', () => {
  const tree = () => {
    const root = scratch()
    writeFileSync(join(root, 'readme.md'), '# hi')
    mkdirSync(join(root, 'guides'))
    writeFileSync(join(root, 'guides', 'onboarding.md'), 'day one')
    writeFileSync(join(root, 'logo.png'), 'not text')
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'left-pad', 'readme.md'), 'no')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'COMMIT_EDITMSG.md'), 'no')
    return root
  }

  it('walks a directory, skipping a checkout and an installed dependency tree', () => {
    const found = collect(tree()).map((file) => file.externalId)

    expect(found).toEqual(['guides/onboarding.md', 'readme.md'])
  })

  it('gives a file its own name as the external id', () => {
    const root = scratch()
    writeFileSync(join(root, 'handbook.md'), 'x')

    expect(collect(join(root, 'handbook.md'))).toEqual([
      { path: join(root, 'handbook.md'), externalId: 'handbook.md' },
    ])
  })

  it('answers the same question for one path as the walk does for a tree', () => {
    // The watcher sees single paths and `collect` sees a tree, and two
    // spellings of "is this a file we index" is how a watcher comes to index a
    // `.git` object nobody asked for.
    expect(eligible(join('docs', 'readme.md'))).toBe(true)
    expect(eligible(join('docs', 'logo.png'))).toBe(false)
    expect(eligible(join('.git', 'COMMIT_EDITMSG.md'))).toBe(false)
    expect(eligible(join('node_modules', 'left-pad', 'readme.md'))).toBe(false)
  })

  it('--watch needs a directory, since a single file has nothing to watch for', async () => {
    const root = scratch()
    writeFileSync(join(root, 'one.md'), 'x')

    const result = await run(['ingest', join(root, 'one.md'), '--layer', 'x', '--watch'], {
      env: { HOME: scratch(), NACRE_API_URL: 'https://x', NACRE_TOKEN: 't' },
      clientFor: () =>
        ({
          documents: { add: async () => ({ documentId: 'd', jobId: 'j', unchanged: true }) },
          jobs: { wait: async () => ({ jobId: 'j', documentId: 'd', status: 'indexed', error: null }) },
        }) as never,
    })

    expect(result.code).toBe(2)
    expect(result.output).toContain('directory')
  })

  it('refuses to guess at a binary rather than mangling it', async () => {
    const root = scratch()
    writeFileSync(join(root, 'contract.pdf'), '%PDF-1.4')

    const result = await run(['ingest', root, '--layer', 'x'], {
      env: { HOME: scratch(), NACRE_API_URL: 'https://x', NACRE_TOKEN: 't' },
    })

    expect(result.code).toBe(2)
    // Naming the route that does take one, because "nothing to ingest" on a
    // directory of PDFs reads as a bug in the walk.
    expect(result.output).toContain('multipart')
  })
})

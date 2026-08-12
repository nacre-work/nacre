import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { flag, integer, option, parse, UsageError } from '../args.js'
import { ask, collect } from '../commands.js'
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

import { describe, expect, it } from 'vitest'

import { parseArgs } from '../init.js'

/**
 * The `init` command's own half.
 *
 * What a new organization is *made of* moved to `provisionOrganization` in the
 * core, and its tests went with it — this command is one caller and not the
 * definition. What is left here is what only a terminal has: an argument list,
 * and the refusals that stop a slug reaching a Qdrant collection name.
 */
describe('parseArgs', () => {
  it('requires an organization and an email', () => {
    expect(parseArgs([])).toMatch(/usage/)
    expect(parseArgs(['--org', 'acme'])).toMatch(/usage/)
    expect(parseArgs(['--email', 'a@b.test'])).toMatch(/usage/)
  })

  it('defaults the display name and the workspace', () => {
    const parsed = parseArgs(['--org', 'acme', '--email', 'a@b.test'])
    expect(parsed).toMatchObject({ slug: 'acme', name: 'acme', workspace: 'default' })
  })

  it('refuses a slug that would not survive being a collection name', () => {
    // The slug becomes the Qdrant collection, so this is not a matter of taste.
    // A slug with a slash or a quote in it reaches a URL path and a JSON body.
    for (const bad of ['Acme', 'a', 'has space', 'has/slash', '-leading', 'trailing-', 'x'.repeat(41)]) {
      expect(parseArgs(['--org', bad, '--email', 'a@b.test']), bad).toMatch(/--org must be/)
    }
    for (const good of ['ac', 'acme', 'acme-corp', 'a1-b2', 'x'.repeat(40)]) {
      expect(parseArgs(['--org', good, '--email', 'a@b.test']), good).toMatchObject({ slug: good })
    }
  })

  it('refuses an address that is not one, and an odd argument list', () => {
    expect(parseArgs(['--org', 'acme', '--email', 'nobody'])).toMatch(/does not look like/)
    expect(parseArgs(['--org'])).toMatch(/usage/)
    expect(parseArgs(['acme', 'a@b.test'])).toMatch(/usage/)
  })
})

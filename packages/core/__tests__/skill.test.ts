import { crc32, deflateRawSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { DEFAULT_SKILL } from '../default-skill.js'
import { checkSkill, readFrontmatter, readSkillZip, skillBody, SKILL_LIMITS, writeSkillZip } from '../skill.js'

const md = (front: string, body = 'Do the thing.\n'): string => `---\n${front}\n---\n\n${body}`
const ok = (files: Record<string, string>) => {
  const r = checkSkill(files)
  if (r.kind !== 'skill') throw new Error(`expected a skill, got ${JSON.stringify(r)}`)
  return r.skill
}
const reason = (files: unknown): string => {
  const r = checkSkill(files)
  if (r.kind !== 'refused') throw new Error(`expected a refusal, got ${r.kind}`)
  return r.reason
}

describe('the skill format', () => {
  it('reads name and description, and keeps the files exactly as written', () => {
    const files = { 'SKILL.md': md('name: handbook-layer\ndescription: What the handbook holds.\nlicense: MIT'), 'references/naming.md': '# Naming\n' }
    const skill = ok(files)
    expect(skill.name).toBe('handbook-layer')
    expect(skill.description).toBe('What the handbook holds.')
    expect(skill.files).toEqual(files)
    expect(skill.hasScripts).toBe(false)
    expect(skillBody(skill)).toBe('Do the thing.')
  })

  it('reads quoted values and folded and literal blocks', () => {
    expect(readFrontmatter(md('name: "a-b"\ndescription: \'it\'\'s quoted\''))).toMatchObject({ fields: { name: 'a-b', description: "it's quoted" } })
    expect(readFrontmatter(md('name: a\ndescription: >\n  one\n  two'))).toMatchObject({ fields: { description: 'one two' } })
    expect(readFrontmatter(md('name: a\ndescription: |\n  one\n  two'))).toMatchObject({ fields: { description: 'one\ntwo' } })
  })

  it('marks a skill carrying scripts — they run on the agent, and the marker is what makes that visible', () => {
    expect(ok({ 'SKILL.md': md('name: a\ndescription: d'), 'scripts/run.sh': 'echo hi\n' }).hasScripts).toBe(true)
  })

  it('clears on no files, and on a SKILL.md with frontmatter and no body', () => {
    expect(checkSkill({}).kind).toBe('cleared')
    expect(checkSkill({ 'SKILL.md': md('name: a\ndescription: d', '   \n') }).kind).toBe('cleared')
  })

  it("refuses what Claude refuses, so an export from here is one Claude accepts", () => {
    expect(reason({ 'SKILL.md': md('name: Handbook\ndescription: d') })).toMatch(/lower case/)
    expect(reason({ 'SKILL.md': md(`name: ${'a'.repeat(65)}\ndescription: d`) })).toMatch(/64/)
    expect(reason({ 'SKILL.md': md('name: my-claude-helper\ndescription: d') })).toMatch(/anthropic|claude/)
    expect(reason({ 'SKILL.md': md('name: a\ndescription: use <b>this</b>') })).toMatch(/XML/)
    expect(reason({ 'SKILL.md': md(`name: a\ndescription: ${'x'.repeat(1025)}`) })).toMatch(/1024/)
    expect(reason({ 'SKILL.md': md('name: a') })).toMatch(/no description/)
    expect(reason({ 'SKILL.md': 'no frontmatter here' })).toMatch(/frontmatter/)
    expect(reason({ 'SKILL.md': '---\nname: a\n' })).toMatch(/never closes/)
  })

  it('refuses a folder that is not a skill', () => {
    expect(reason({ 'references/x.md': 'x' })).toMatch(/needs SKILL\.md/)
    expect(reason([])).toMatch(/object/)
    expect(reason({ 'SKILL.md': 3 })).toMatch(/text/)
    expect(reason({ 'SKILL.md': md('name: a\ndescription: d', ''), 'x.md': 'x' })).toMatch(/no body/)
  })

  it('refuses a path that would land outside the folder on the machine that unpacks it', () => {
    const skill = md('name: a\ndescription: d')
    for (const bad of ['../x.md', 'references/../../x.md', '/etc/x', 'a\\b.md', 'a//b.md', './x.md', 'a\u0000b']) {
      expect(reason({ 'SKILL.md': skill, [bad]: 'x' }), bad).toBeTruthy()
    }
  })

  it('refuses every bound rather than truncating', () => {
    const skill = md('name: a\ndescription: d')
    expect(reason({ 'SKILL.md': skill, 'big.md': 'x'.repeat(SKILL_LIMITS.fileBytes + 1) })).toMatch(/KiB/)
    const many: Record<string, string> = { 'SKILL.md': skill }
    for (let i = 0; i < SKILL_LIMITS.files; i += 1) many[`r/${String(i)}.md`] = 'x'
    expect(reason(many)).toMatch(/at most 64 files/)
    const heavy: Record<string, string> = { 'SKILL.md': skill }
    for (let i = 0; i < 5; i += 1) heavy[`r/${String(i)}.md`] = 'x'.repeat(250 * 1024)
    expect(reason(heavy)).toMatch(/in all/)
    expect(reason({ 'SKILL.md': skill, 'bin.dat': 'a\u0000b' })).toMatch(/binary/)
  })

  it('accepts the default skill it ships — the default is never a skill the format would refuse', () => {
    const skill = ok({ ...DEFAULT_SKILL })
    expect(skill.name).toBe('nacre-index')
    expect(Buffer.byteLength(DEFAULT_SKILL['SKILL.md'] ?? '', 'utf8')).toBeLessThan(16 * 1024)
  })
})

describe('the skill zip', () => {
  const files = { 'SKILL.md': md('name: handbook-layer\ndescription: d'), 'references/a b.md': 'привет\n', 'scripts/x.sh': 'echo\n' }

  it('round-trips: a written zip reads back to the same files, without the top folder', () => {
    const zip = writeSkillZip('handbook-layer', files)
    expect(readSkillZip(zip)).toEqual({ files })
  })

  it('writes the same bytes for the same skill', () => {
    expect(writeSkillZip('a', files).equals(writeSkillZip('a', { ...files }))).toBe(true)
  })

  /** A zip made the way other tools make them: deflated entries, Mac junk, one top folder. */
  const foreign = (entries: Record<string, Buffer | string>, opts: { lieAboutSize?: number } = {}): Buffer => {
    const parts: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const [name, value] of Object.entries(entries)) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
      const packed = deflateRawSync(data)
      const n = Buffer.from(name, 'utf8')
      const size = opts.lieAboutSize ?? data.length
      const h = Buffer.alloc(30)
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8)
      h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(n.length, 26)
      parts.push(h, n, packed)
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10)
      c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(size, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
      central.push(c, n)
      offset += h.length + n.length + packed.length
    }
    const dir = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10)
    end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
    return Buffer.concat([...parts, dir, end])
  }

  it('reads deflated entries, unwraps one top folder, and skips what a Mac adds', () => {
    const zip = foreign({ 'my-skill/SKILL.md': files['SKILL.md'], 'my-skill/references/x.md': 'x\n', '__MACOSX/my-skill/._SKILL.md': 'junk', 'my-skill/.DS_Store': 'junk' })
    expect(readSkillZip(zip)).toEqual({ files: { 'SKILL.md': files['SKILL.md'], 'references/x.md': 'x\n' } })
  })

  it('refuses an entry that inflates past what it declares — a bomb stops at the byte that crosses the line', () => {
    const zip = foreign({ 'SKILL.md': 'x'.repeat(200_000) }, { lieAboutSize: 1000 })
    expect(readSkillZip(zip)).toMatchObject({ error: expect.stringMatching(/size it declares|larger than it declares/) })
  })

  it('refuses binary content and things that are not zips', () => {
    expect(readSkillZip(foreign({ 'SKILL.md': Buffer.from([0xff, 0xfe, 0x00, 0x81]) }))).toMatchObject({ error: expect.stringMatching(/binary/) })
    expect(readSkillZip(Buffer.from('not a zip'))).toMatchObject({ error: 'not a zip archive' })
  })

  it('reads a path a hostile zip carries, and checkSkill is what refuses it', () => {
    const read = readSkillZip(foreign({ 'SKILL.md': files['SKILL.md'], '../escape.md': 'x' }))
    expect('files' in read && checkSkill(read.files).kind).toBe('refused')
  })
})

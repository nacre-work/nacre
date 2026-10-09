/**
 * A skill, in Claude's folder format: what it is, what is refused, and how it
 * travels as a zip.
 *
 * docs/skills.md is the specification. This module is the one place the format
 * is decided — the API, the MCP tools, the console and the panel all hand a
 * folder to `checkSkill` and get back either a skill or one sentence saying why
 * not, so a skill accepted by one surface is accepted by every other.
 *
 * **Compatible means Claude accepts it.** The frontmatter rules are Claude's:
 * `name` lower case letters, digits and hyphens, at most 64 characters, and not
 * naming Anthropic or Claude; `description` 1 to 1024 characters and no XML
 * tags. A folder this accepts is one Claude Code and claude.ai accept, and an
 * export from here is one they accept — which is the property a skill moved
 * between them depends on.
 *
 * Every bound is a refusal, never a truncation. A truncated skill is
 * instructions that stop mid-sentence, which an agent then follows.
 */
import { crc32, inflateRawSync } from 'node:zlib'

export const SKILL_FILE = 'SKILL.md'

export const SKILL_LIMITS = {
  files: 64,
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  pathLength: 256,
  nameLength: 64,
  descriptionLength: 1024,
} as const

/** `{ "SKILL.md": "…", "references/x.md": "…" }`, exactly as written. */
export type SkillFiles = Readonly<Record<string, string>>

export interface Skill {
  readonly name: string
  readonly description: string
  /** Anything under `scripts/` — code the agent may run on its own side. */
  readonly hasScripts: boolean
  readonly files: SkillFiles
}

/**
 * What `checkSkill` decided.
 *
 * `cleared` is a real outcome rather than an error: no files at all, or a
 * `SKILL.md` whose body is empty, is how a level is cleared so the one above
 * applies again.
 */
export type SkillCheck =
  | { readonly kind: 'skill'; readonly skill: Skill }
  | { readonly kind: 'cleared' }
  | { readonly kind: 'refused'; readonly reason: string }

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const RESERVED = /anthropic|claude/
const XML_TAG = /<\/?[A-Za-z][^>]*>/

const refused = (reason: string): SkillCheck => ({ kind: 'refused', reason })

/**
 * A path inside a skill, or the reason it is not one.
 *
 * Relative, forward slashes, no `.` or `..` segment, no empty segment. The
 * paths become keys of a JSON object and entries of a zip somebody else
 * unpacks, so a `..` here is a file written outside the folder on the machine
 * that extracts it.
 */
export function skillPathError(path: string): string | undefined {
  if (path.length === 0) return 'a file has an empty path'
  if (path.length > SKILL_LIMITS.pathLength) return `${path.slice(0, 40)}…: a path is at most ${String(SKILL_LIMITS.pathLength)} characters`
  if (path.startsWith('/')) return `${path}: paths are relative to the skill's folder`
  if (path.includes('\\')) return `${path}: paths use forward slashes`
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(path)) return `${path}: a path carries a control character`
  for (const segment of path.split('/')) {
    if (segment === '') return `${path}: a path has an empty segment`
    if (segment === '.' || segment === '..') return `${path}: a path may not contain "${segment}"`
  }
  return undefined
}

/**
 * The frontmatter at the top of `SKILL.md`, and the body after it.
 *
 * A small subset of YAML, because that is all a skill's frontmatter is:
 * `key: value` lines, quoted or plain, and `|` / `>` blocks for a description
 * that runs over several lines. Keys this does not use are kept in the file as
 * written — nothing here rewrites a skill — and only `name` and `description`
 * are read.
 */
export function readFrontmatter(
  text: string,
): { readonly fields: Readonly<Record<string, string>>; readonly body: string } | { readonly error: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { error: 'SKILL.md must open with frontmatter: a line of "---", name and description, and "---"' }
  }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return { error: 'SKILL.md opens frontmatter and never closes it with "---"' }
  const afterClose = normalized.indexOf('\n', end + 4)
  const body = afterClose === -1 ? '' : normalized.slice(afterClose + 1)

  const lines = normalized.slice(4, end).split('\n')
  const fields: Record<string, string> = {}
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^\s/.test(line)) continue // a nested value under a key this does not read
    const colon = line.indexOf(':')
    if (colon <= 0) return { error: `SKILL.md frontmatter line ${String(i + 2)} is not "key: value"` }
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()

    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1] ?? '') || (lines[i + 1] ?? '') === '')) {
        i += 1
        block.push((lines[i] ?? '').trim())
      }
      value = value.startsWith('|') ? block.join('\n').trim() : block.filter((b) => b !== '').join(' ').trim()
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.startsWith('"')
        ? value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
        : value.slice(1, -1).replace(/''/g, "'")
    }
    fields[key] = value
  }
  return { fields, body }
}

/**
 * A folder, checked: a skill, a clearing, or one sentence saying why not.
 *
 * Takes `unknown` because every caller is handing it something a client sent —
 * a JSON body, a tool argument, the entries of a zip — and the shape is part of
 * what is checked.
 */
export function checkSkill(input: unknown): SkillCheck {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return refused('files must be an object of path to text')
  }
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return { kind: 'cleared' }
  if (entries.length > SKILL_LIMITS.files) {
    return refused(`a skill has at most ${String(SKILL_LIMITS.files)} files, and this has ${String(entries.length)}`)
  }

  const files: Record<string, string> = {}
  let total = 0
  for (const [path, content] of entries) {
    const pathError = skillPathError(path)
    if (pathError !== undefined) return refused(pathError)
    if (typeof content !== 'string') return refused(`${path}: a file's content must be text`)
    // NUL is the one character no text file carries and every binary one does.
    if (content.includes('\u0000')) return refused(`${path}: binary files are not accepted, only text`)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > SKILL_LIMITS.fileBytes) {
      return refused(`${path}: a file is at most ${String(SKILL_LIMITS.fileBytes / 1024)} KiB, and this is ${String(Math.ceil(bytes / 1024))} KiB`)
    }
    total += bytes
    files[path] = content
  }
  if (total > SKILL_LIMITS.totalBytes) {
    return refused(`a skill is at most ${String(SKILL_LIMITS.totalBytes / 1024)} KiB in all, and this is ${String(Math.ceil(total / 1024))} KiB`)
  }

  const main = files[SKILL_FILE]
  if (main === undefined) return refused(`a skill needs ${SKILL_FILE} at the top of its folder`)

  const read = readFrontmatter(main)
  if ('error' in read) return refused(read.error)
  if (read.body.trim() === '' && entries.length === 1) return { kind: 'cleared' }
  if (read.body.trim() === '') return refused(`${SKILL_FILE} has no body, but the folder has other files; an empty skill is cleared by sending no files`)

  const name = read.fields['name'] ?? ''
  if (name === '') return refused(`${SKILL_FILE} frontmatter has no name`)
  if (name.length > SKILL_LIMITS.nameLength) return refused(`name is at most ${String(SKILL_LIMITS.nameLength)} characters`)
  if (!NAME.test(name)) return refused('name is lower case letters, digits and single hyphens, like "handbook-layer"')
  if (RESERVED.test(name)) return refused('name may not contain "anthropic" or "claude" — Claude refuses such a skill')

  const description = read.fields['description'] ?? ''
  if (description === '') return refused(`${SKILL_FILE} frontmatter has no description, and it is what an agent reads to decide to use the skill`)
  if (description.length > SKILL_LIMITS.descriptionLength) {
    return refused(`description is at most ${String(SKILL_LIMITS.descriptionLength)} characters`)
  }
  if (XML_TAG.test(description)) return refused('description may not contain XML tags — Claude refuses such a skill')

  const hasScripts = Object.keys(files).some((p) => p.startsWith('scripts/'))
  return { kind: 'skill', skill: { name, description, hasScripts, files } }
}

/** The body of `SKILL.md`, without its frontmatter. */
export function skillBody(skill: Skill): string {
  const read = readFrontmatter(skill.files[SKILL_FILE] ?? '')
  return 'error' in read ? '' : read.body.trim()
}

// ─── zip ─────────────────────────────────────────────────────────────────────
//
// By hand rather than a dependency, on the parser's argument: this reads bytes
// a client uploaded, and a library's parser bugs become ours on that path. The
// subset is small — stored and deflated entries, no encryption, no ZIP64 — and
// every bound is checked while reading rather than after, so a zip bomb is
// refused at the byte that crosses the line.

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50

/** A folder as a zip, entries under `folder/` and stored uncompressed. */
export function writeSkillZip(folder: string, files: SkillFiles): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const time = 0
  const date = (1 << 5) | 1 // 1980-01-01: reproducible bytes for the same skill

  for (const [path, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = Buffer.from(`${folder}/${path}`, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END, 0)
  const count = Object.keys(files).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/**
 * The files of a skill zip, or the reason it is not one.
 *
 * A zip made by Finder or by Claude's own export has the skill inside one top
 * folder; that folder is removed, so `my-skill/SKILL.md` and `SKILL.md` read the
 * same. `__MACOSX/` and `.DS_Store` are skipped, because every zip made on a Mac
 * carries them and none of them is part of a skill.
 */
export function readSkillZip(zip: Uint8Array): { readonly files: Record<string, string> } | { readonly error: string } {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
  const fail = (error: string): { error: string } => ({ error })

  // The end record is in the last 64 KiB + 22 bytes; a comment can push it back.
  let endAt = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === END) {
      endAt = i
      break
    }
  }
  if (endAt === -1) return fail('not a zip archive')
  const count = buf.readUInt16LE(endAt + 10)
  const dirSize = buf.readUInt32LE(endAt + 12)
  const dirOffset = buf.readUInt32LE(endAt + 16)
  if (count === 0xffff || dirOffset === 0xffffffff) return fail('ZIP64 archives are not accepted')
  if (dirOffset + dirSize > endAt) return fail('the archive directory points outside the file')
  if (count > SKILL_LIMITS.files * 4) return fail(`the archive has ${String(count)} entries; a skill has at most ${String(SKILL_LIMITS.files)} files`)

  const raw: Record<string, string> = {}
  let total = 0
  let at = dirOffset
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) return fail('the archive directory is damaged')
    const flags = buf.readUInt16LE(at + 8)
    const method = buf.readUInt16LE(at + 10)
    // The central directory's checksum, not the local header's: an entry written
    // with a data descriptor (flag bit 3) carries zero in the local header.
    const expectedCrc = buf.readUInt32LE(at + 16)
    const compressed = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const localOffset = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store') continue
    if ((flags & 1) !== 0) return fail(`${name}: encrypted entries are not accepted`)
    if (method !== 0 && method !== 8) return fail(`${name}: compression method ${String(method)} is not supported; use stored or deflate`)
    if (size > SKILL_LIMITS.fileBytes) return fail(`${name}: a file is at most ${String(SKILL_LIMITS.fileBytes / 1024)} KiB`)
    total += size
    if (total > SKILL_LIMITS.totalBytes) return fail(`a skill is at most ${String(SKILL_LIMITS.totalBytes / 1024)} KiB in all`)

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) return fail(`${name}: entry header is damaged`)
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataStart + compressed > buf.length) return fail(`${name}: entry runs past the end of the archive`)
    const stored = buf.subarray(dataStart, dataStart + compressed)

    let data: Buffer
    if (method === 0) {
      data = stored
    } else {
      try {
        // One byte over the declared size, so an entry lying about its size is
        // caught by the length check rather than inflated without bound.
        data = inflateRawSync(stored, { maxOutputLength: size + 1 })
      } catch {
        return fail(`${name}: entry does not decompress, or is larger than it declares`)
      }
    }
    if (data.length !== size) return fail(`${name}: entry is not the size it declares`)
    if (crc32(data) !== expectedCrc) {
      return fail(`${name}: entry is damaged (checksum mismatch)`)
    }
    try {
      raw[name] = decoder.decode(data)
    } catch {
      return fail(`${name}: binary files are not accepted, only UTF-8 text`)
    }
  }

  // One top folder holding SKILL.md, and nothing at the root: unwrap it.
  const names = Object.keys(raw)
  const tops = new Set(names.map((p) => p.split('/')[0]))
  if (names.length > 0 && !names.includes(SKILL_FILE) && tops.size === 1 && names.every((p) => p.includes('/'))) {
    const top = `${[...tops][0] ?? ''}/`
    const unwrapped: Record<string, string> = {}
    for (const [path, content] of Object.entries(raw)) unwrapped[path.slice(top.length)] = content
    return { files: unwrapped }
  }
  return { files: raw }
}

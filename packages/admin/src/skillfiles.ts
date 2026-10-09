/**
 * The pure half of loading a skill from a folder, and of describing one.
 *
 * Kept out of the view so it can be asked without a browser: which paths a
 * picked folder becomes, what is left out and why, and what a principal is
 * called. Each of those is a place where being wrong is silent — a folder
 * loaded one level too deep is a skill with no `SKILL.md`, and the server's
 * refusal would then blame the person's file rather than this screen.
 */

export interface PickedFile {
  /** As the browser gives it for a folder: `webkitRelativePath`, root folder first. */
  readonly path: string
  readonly text: string
}

export interface Folder {
  readonly files: Readonly<Record<string, string>>
  /** Left out, with the reason — said on the screen before anything is written. */
  readonly skipped: readonly { readonly path: string; readonly why: string }[]
}

/**
 * A picked folder as a skill's files.
 *
 * The folder's own name is dropped, because a skill's paths are relative to
 * its root — `handbook/SKILL.md` is `SKILL.md`. Anything under a dot-name is
 * left out (`.DS_Store`, `.git/`), since no skill carries one and the server
 * would refuse the binary ones with a message about a file nobody chose; and a
 * file containing a NUL is left out for the same reason, said by name.
 */
export function folderFiles(picked: readonly PickedFile[]): Folder {
  const files: Record<string, string> = {}
  const skipped: { path: string; why: string }[] = []
  for (const file of picked) {
    const parts = file.path.split('/').filter((p) => p !== '')
    const relative = parts.length > 1 ? parts.slice(1) : parts
    const path = relative.join('/')
    if (relative.some((p) => p.startsWith('.'))) {
      skipped.push({ path, why: 'hidden' })
      continue
    }
    if (file.text.includes('\u0000')) {
      skipped.push({ path, why: 'not text' })
      continue
    }
    files[path] = file.text
  }
  return { files, skipped }
}

/** Anything under `scripts/` — code an agent runs on its own side. */
export const carriesScripts = (paths: readonly string[]): boolean =>
  paths.some((p) => p === 'scripts' || p.startsWith('scripts/'))

/** `SKILL.md` first, then the rest in order, the way a folder reads. */
export function orderPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => {
    if (a === 'SKILL.md') return -1
    if (b === 'SKILL.md') return 1
    return a.localeCompare(b)
  })
}

/**
 * Who wrote a version, as a person reads it.
 *
 * `principal` is `{type}:{id}`, as the access log writes it. A resolved name
 * where the directory has one; otherwise the kind as a word — never the stored
 * string, which would put a uuid exactly where the name was missing.
 */
export function writtenBy(principal: string, names: ReadonlyMap<string, string>): string {
  const at = principal.indexOf(':')
  const type = at === -1 ? principal : principal.slice(0, at)
  const id = at === -1 ? '' : principal.slice(at + 1)
  const known = names.get(id)
  if (known !== undefined) return known
  switch (type) {
    case 'user':
      return 'a person'
    case 'service_account':
      return 'a service account'
    default:
      return type === '' ? 'somebody' : type.replace(/_/g, ' ')
  }
}

export type TreeNode =
  | { readonly kind: 'file'; readonly name: string; readonly path: string }
  | { readonly kind: 'dir'; readonly name: string; readonly path: string; readonly children: readonly TreeNode[] }

/**
 * The paths as the folder they came from.
 *
 * A skill keeps its main file short by putting reference material in
 * subfolders — `reference/`, `scripts/`, `templates/` — and a flat list of
 * `reference/teams/finance.md` strings hides exactly that shape. In each folder
 * the files come first and then the folders, each in order; at the top
 * `SKILL.md` leads, because it is what an agent reads first.
 */
export function fileTree(paths: readonly string[]): TreeNode[] {
  interface Dir { files: string[]; dirs: Map<string, Dir> }
  const root: Dir = { files: [], dirs: new Map() }
  for (const path of paths) {
    const parts = path.split('/').filter((p) => p !== '')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (next === undefined) {
        next = { files: [], dirs: new Map() }
        dir.dirs.set(part, next)
      }
      dir = next
    }
    const name = parts[parts.length - 1]
    if (name !== undefined) dir.files.push(name)
  }
  const build = (dir: Dir, prefix: string): TreeNode[] => [
    ...orderPaths(dir.files).map((name): TreeNode => ({ kind: 'file', name, path: `${prefix}${name}` })),
    ...[...dir.dirs.keys()].sort((a, b) => a.localeCompare(b)).map((name): TreeNode => ({
      kind: 'dir',
      name,
      path: `${prefix}${name}`,
      children: build(dir.dirs.get(name) as Dir, `${prefix}${name}/`),
    })),
  ]
  return build(root, '')
}

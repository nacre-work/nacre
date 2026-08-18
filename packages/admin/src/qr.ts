/**
 * A QR code, encoded here rather than fetched or depended on.
 *
 * ## Why the console has one
 *
 * Enrolling an authenticator means getting a thirty-two character base32 secret
 * from this screen into an app on a phone. Typing it is the step people give up
 * on, and it is the step they get wrong: base32 has no `0`, `1` or `8`, so a
 * mistyped character is six digits that never work and no way to tell which
 * half is broken. A camera does not make that mistake.
 *
 * ## Why it is not a dependency
 *
 * This package has one runtime dependency and it is the SDK. The page is served
 * with `script-src 'self'`, so a CDN is not an option and a bundled library is
 * the alternative — and the thing being drawn here is a *credential*. A QR
 * encoder is arithmetic with no I/O and a specification anybody can check
 * against, which makes it the rare case where writing it is cheaper than
 * auditing somebody else's on every upgrade.
 *
 * The obligation that comes with that choice is that it is checked against
 * something that did not come from here. `__tests__/qr.test.ts` renders the
 * matrix to pixels and hands them to an independent decoder, as a dev-only
 * dependency — a QR encoder tested against its own output agrees with itself
 * and with no phone anybody owns, which is the fixture-written-to-match-the-code
 * shape this repository keeps finding.
 *
 * ## What it does and does not do
 *
 * Byte mode only. An `otpauth://` URL has lowercase letters, `?`, `=` and `&`,
 * none of which alphanumeric mode admits, so the other modes would be code with
 * no caller.
 *
 * Error correction level M, which is the level a screen wants: L saves a
 * version at the sizes involved here and gives up the redundancy that absorbs a
 * reflection or a thumb, and Q and H buy nothing back from a camera held twenty
 * centimetres from a monitor.
 *
 * Versions 1 to 40, chosen by capacity. Refusing above a smaller ceiling would
 * be a bound on how long an issuer and an account label may be, decided here,
 * and discovered by whoever picked a long one.
 */

/** Error correction level M: 15% of codewords, and the format bits that say so. */
const EC_FORMAT_BITS = 0

/**
 * Error correction codewords per block, and blocks per version, for level M.
 *
 * Indexed by version, 1 to 40, with a hole at zero. These two arrays are the
 * only part of the specification that cannot be computed — everything else here
 * is derived, so there is nothing else to mistype.
 */
const EC_CODEWORDS_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
  26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
]
const EC_BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14,
  16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
]

const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

/** The side of a version's symbol, in modules. */
const sizeOf = (version: number): number => version * 4 + 17

/**
 * How many modules a version has left for data, before error correction.
 *
 * The whole symbol minus everything that is not payload: the three finder
 * patterns with their separators, the two timing lines, the alignment patterns
 * — which overlap the timing lines, hence the closed form rather than a count —
 * and, from version 7, the two version-information blocks.
 */
function dataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2
    result -= (25 * aligns - 10) * aligns - 55
    if (version >= 7) result -= 36
  }
  return result
}

const totalCodewords = (version: number): number => Math.floor(dataModules(version) / 8)

const dataCodewords = (version: number): number =>
  totalCodewords(version) - EC_CODEWORDS_PER_BLOCK[version]! * EC_BLOCKS[version]!

/**
 * The width of the character-count field, which is a function of version.
 *
 * Byte mode: eight bits up to version 9 and sixteen from version 10. Getting
 * this wrong shifts every bit after it, and the symbol still *scans* — it
 * decodes to something else, which is the failure worth naming.
 */
const countBits = (version: number): number => (version <= 9 ? 8 : 16)

/** The smallest version that holds this many bytes at level M. */
function versionFor(length: number): number {
  for (let version = 1; version <= 40; version++) {
    const capacity = dataCodewords(version) * 8 - 4 - countBits(version)
    if (length * 8 <= capacity) return version
  }
  throw new Error(`${length} bytes does not fit in a QR code at error correction level M`)
}

// ---------------------------------------------------------------------------
// GF(256), for Reed–Solomon
// ---------------------------------------------------------------------------

/**
 * Multiplication in GF(256) with the QR specification's primitive polynomial,
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D). Russian-peasant, so there is no log table
 * to build and no zero case to special-case wrongly.
 */
function gfMul(a: number, b: number): number {
  let result = 0
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d)
    result ^= ((b >>> i) & 1) * a
  }
  return result & 0xff
}

/** The generator polynomial of the given degree, coefficients high to low. */
function generator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < degree) result[j]! ^= result[j + 1]!
    }
    root = gfMul(root, 2)
  }
  return result
}

/** The error correction codewords for one block. */
function remainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coefficient, i) => {
      result[i]! ^= gfMul(coefficient, factor)
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// The bit stream
// ---------------------------------------------------------------------------

/**
 * Mode, length, payload, terminator, padding — the codewords before error
 * correction.
 */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }

  push(0b0100, 4)
  push(bytes.length, countBits(version))
  for (const byte of bytes) push(byte, 8)

  const capacity = dataCodewords(version) * 8
  // The terminator is up to four zero bits and is allowed to be shorter when
  // the symbol is nearly full, which is why it is a minimum and not a constant.
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)

  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!
    codewords.push(byte)
  }
  // The specification's pad bytes, alternating, until the block is full.
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) {
    codewords.push(pad)
  }
  return codewords
}

/**
 * Split into blocks, add error correction, interleave.
 *
 * Interleaving is what makes a scratch across the symbol survivable: a burst of
 * damage lands one or two codewords in each block rather than destroying one
 * block outright, and each block corrects its own share independently.
 */
function withErrorCorrection(data: readonly number[], version: number): number[] {
  const blockCount = EC_BLOCKS[version]!
  const eccLength = EC_CODEWORDS_PER_BLOCK[version]!
  const raw = totalCodewords(version)
  // The blocks are not all the same length. The short ones come first, and the
  // rest carry one codeword more.
  const shortBlocks = blockCount - (raw % blockCount)
  const shortLength = Math.floor(raw / blockCount)

  const divisor = generator(eccLength)
  const blocks: number[][] = []
  for (let i = 0, at = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1)
    const block = data.slice(at, at + length)
    at += length
    const ecc = remainder(block, divisor)
    // A placeholder so every block is the same length while interleaving, and
    // skipped again on the way out. Simpler than an index that knows which
    // blocks are short.
    if (i < shortBlocks) block.push(0)
    blocks.push([...block, ...ecc])
  }

  const result: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]!)
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------

type Grid = boolean[][]

/** Where the alignment patterns go, in both axes. Version 1 has none. */
function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  // Version 32 is the one place the spacing formula disagrees with the
  // specification's table, and the specification wins.
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = sizeOf(version) - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

/**
 * The function patterns, and a parallel grid marking which modules they own.
 *
 * The second grid is not bookkeeping for its own sake: the data is laid out by
 * walking the whole symbol and skipping what is already spoken for, and the
 * masking has to leave those modules alone too. Deciding that from coordinates
 * at each step is the same rule written twice.
 */
function functionPatterns(version: number): { modules: Grid; reserved: Grid } {
  const size = sizeOf(version)
  const modules: Grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved: Grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))

  const set = (x: number, y: number, dark: boolean): void => {
    modules[y]![x] = dark
    reserved[y]![x] = true
  }

  // Timing patterns, drawn first and overwritten by whatever crosses them.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  // The three finder patterns, each with its separator and the format
  // information strip beside it. Drawn as one 9x9 block per corner, clipped.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= size || y < 0 || y >= size) continue
        set(x, y, distance !== 2 && distance !== 4)
      }
    }
  }

  // Alignment patterns at every crossing of the positions except the three
  // corners, which are finder patterns. Excluded by *index* and deliberately
  // not by "this module is already spoken for": position 6 is the timing line,
  // so from version 7 the legitimate patterns sitting on it would be skipped
  // too — a symbol missing an alignment pattern still draws and does not
  // decode.
  const positions = alignmentPositions(version)
  const last = positions.length - 1
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)
      if (corner) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(positions[j]! + dx, positions[i]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // Version information, twice, for versions that carry it.
  if (version >= 7) {
    let bits = version
    for (let i = 0; i < 12; i++) bits = (bits << 1) ^ ((bits >>> 11) * 0x1f25)
    const word = (version << 12) | bits
    for (let i = 0; i < 18; i++) {
      const dark = ((word >>> i) & 1) !== 0
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, dark)
      set(b, a, dark)
    }
  }

  // The format strip, reserved rather than written: the mask it names is not
  // chosen yet, and every mask is tried against a laid-out symbol. Reserving it
  // is what keeps the data placement and the masking out of it.
  for (const copy of formatPositions(size)) for (const [x, y] of copy) set(x, y, false)

  // The dark module, which is always dark and is not part of anything.
  set(8, size - 8, true)

  return { modules, reserved }
}

/** Lay the interleaved codewords out, bottom-right to top-left, in a zigzag. */
function placeCodewords(modules: Grid, reserved: Grid, codewords: readonly number[]): void {
  const size = modules.length
  let bit = 0
  // Two columns at a time, right to left, skipping the vertical timing line.
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let column = 0; column < 2; column++) {
        const x = right - column
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (reserved[y]![x]) continue
        if (bit < codewords.length * 8) {
          modules[y]![x] = ((codewords[bit >>> 3]! >>> (7 - (bit & 7))) & 1) !== 0
          bit++
        }
        // Anything past the last codeword stays light: the specification's
        // remainder bits are always zero.
      }
    }
  }
}

/** The eight mask patterns, by number. */
const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/**
 * Where each of the fifteen format bits goes, in both copies.
 *
 * One table rather than a placement loop and a reservation loop, because the
 * format strip is the one region that has to be described twice — reserved
 * before the data is laid out, written after a mask is chosen — and two lists
 * of the same coordinates is two chances to disagree. The disagreement is
 * silent: a strip that is written but not reserved gets data laid into it and
 * then masked, and the symbol still draws.
 */
function formatPositions(size: number): readonly (readonly [number, number])[][] {
  const first: [number, number][] = []
  for (let i = 0; i <= 5; i++) first.push([8, i])
  first.push([8, 7], [8, 8], [7, 8])
  for (let i = 9; i < 15; i++) first.push([14 - i, 8])

  const second: [number, number][] = []
  for (let i = 0; i < 8; i++) second.push([size - 1 - i, 8])
  for (let i = 8; i < 15; i++) second.push([8, size - 15 + i])

  return [first, second]
}

/** Write the format information, which says the level and the mask. */
function placeFormat(modules: Grid, mask: number): void {
  const data = (EC_FORMAT_BITS << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  // The constant is the specification's, and it is what stops an all-zero
  // format — level M with mask 0 — from being unreadable.
  const bits = (((data << 10) | rem) ^ 0x5412) >>> 0

  for (const copy of formatPositions(modules.length)) {
    copy.forEach(([x, y], i) => {
      modules[y]![x] = ((bits >>> i) & 1) !== 0
    })
  }
}

/** Flip the modules a mask selects, leaving the function patterns alone. */
function applyMask(modules: Grid, reserved: Grid, mask: number): void {
  const test = MASKS[mask]!
  for (let y = 0; y < modules.length; y++) {
    for (let x = 0; x < modules.length; x++) {
      if (!reserved[y]![x] && test(x, y)) modules[y]![x] = !modules[y]![x]
    }
  }
}

/**
 * The specification's penalty score, which is how a mask gets chosen.
 *
 * Four rules, and each is about a camera rather than about tidiness: long runs
 * of one colour are hard to count, 2x2 blocks make a grid ambiguous, a
 * finder-like sequence anywhere else is a false corner, and a symbol far from
 * half dark loses contrast headroom. The mask with the lowest total wins.
 */
function penalty(modules: Grid): number {
  const size = modules.length
  let result = 0

  const countFinders = (history: readonly number[]): number => {
    const n = history[1]!
    const core =
      n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    )
  }
  const addRun = (length: number, history: number[]): void => {
    // The quiet zone outside the symbol counts as light, so the first run is
    // longer than it looks. Without this a finder pattern on the edge is
    // scored as if it were in the middle.
    if (history[0] === 0) length += size
    history.pop()
    history.unshift(length)
  }
  const finish = (dark: boolean, length: number, history: number[]): number => {
    if (dark) {
      addRun(length, history)
      length = 0
    }
    addRun(length + size, history)
    return countFinders(history)
  }

  for (const axis of ['row', 'column'] as const) {
    for (let a = 0; a < size; a++) {
      let dark = false
      let run = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let b = 0; b < size; b++) {
        const module = axis === 'row' ? modules[a]![b]! : modules[b]![a]!
        if (module === dark) {
          run++
          if (run === 5) result += PENALTY_N1
          else if (run > 5) result++
        } else {
          addRun(run, history)
          if (!dark) result += countFinders(history) * PENALTY_N3
          dark = module
          run = 1
        }
      }
      result += finish(dark, run, history) * PENALTY_N3
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x]
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) {
        result += PENALTY_N2
      }
    }
  }

  let dark = 0
  for (const row of modules) for (const module of row) if (module) dark++
  const total = size * size
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_N4
  return result
}

/**
 * The module grid for a string, `true` where a module is dark.
 *
 * DOM-free on purpose: this is the half that can be checked, and a function
 * that reaches for `document` cannot be handed to a decoder in a test process.
 */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const version = versionFor(bytes.length)
  const codewords = withErrorCorrection(encodeData(bytes, version), version)

  const { modules, reserved } = functionPatterns(version)
  placeCodewords(modules, reserved, codewords)

  // Every mask is applied, scored and undone. Trying them is cheaper than
  // reasoning about them, and the specification asks for the best rather than
  // for a good one.
  let best = 0
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, reserved, mask)
    placeFormat(modules, mask)
    const score = penalty(modules)
    if (score < bestScore) {
      bestScore = score
      best = mask
    }
    applyMask(modules, reserved, mask)
  }
  applyMask(modules, reserved, best)
  placeFormat(modules, best)

  return modules
}

/**
 * The same grid as an inline `<svg>`.
 *
 * One `<path>` rather than a rectangle per module: a version 6 symbol is over
 * seventeen hundred modules, and that many elements is a page a phone lays out
 * visibly slowly.
 *
 * **Black on white, and that is not a palette decision.** Everything else this
 * console draws resolves to a brand token, and `lint:tokens` holds the
 * stylesheet to it. A QR code is read by a camera and a threshold, so its two
 * values are a scanning requirement — and inverting it for a dark theme is how
 * a symbol stops working on the scanners that still expect dark on light. The
 * quiet zone is four modules on every side for the same reason: it is part of
 * the symbol, not margin, and a decoder that cannot find it does not try.
 */
export function qrSvg(text: string, label: string): SVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const modules = qrMatrix(text)
  const size = modules.length
  const quiet = 4
  const side = size + quiet * 2

  const svg = document.createElementNS(NS, 'svg')
  for (const [key, value] of Object.entries({
    viewBox: `0 0 ${side} ${side}`,
    width: '208', height: '208',
    class: 'qr',
    role: 'img',
    'aria-label': label,
  })) svg.setAttribute(key, value)

  const background = document.createElementNS(NS, 'rect')
  for (const [key, value] of Object.entries({
    x: '0', y: '0', width: String(side), height: String(side), fill: '#fff',
  })) background.setAttribute(key, value)
  svg.append(background)

  // Runs rather than single modules, which roughly halves the path.
  const parts: string[] = []
  for (let y = 0; y < size; y++) {
    let run = 0
    for (let x = 0; x <= size; x++) {
      if (x < size && modules[y]![x]) {
        run++
        continue
      }
      if (run > 0) parts.push(`M${x - run + quiet} ${y + quiet}h${run}v1h-${run}z`)
      run = 0
    }
  }

  const path = document.createElementNS(NS, 'path')
  path.setAttribute('d', parts.join(''))
  path.setAttribute('fill', '#000')
  svg.append(path)

  return svg
}

#!/usr/bin/env node
/**
 * The chart's copies of the embedding adapter's vendor tables are the adapter's.
 *
 * Two tables, because the adapter does two jobs: `VENDORS` routes embeddings by
 * model and `RERANKERS` is the one cross-encoder vendor an adapter may be given.
 * Both are copied into `_helpers.tpl` and both are held here.
 *
 * **Route *syntax* is not held here and deliberately so.** The form a route may
 * take — `model=vendor`, and since core 0.13.0 `model=vendor:upstream-model` —
 * is proven by `deploy/helm/values/full.yaml` using both and the `helm` job rendering
 * it: a chart parser that refuses the second form fails that job on a value the
 * container accepts. A check here would be a third implementation of the
 * grammar, which is the defect this file exists to prevent rather than a way to
 * catch it.
 *
 * The adapter refuses at startup on a route it cannot serve — an unknown
 * vendor, a vendor whose credential or whose settings are unset. The chart
 * refuses the same things at render time, because a container that refuses to
 * start is a CrashLoopBackOff and a chart that refuses is an error naming the
 * value. That is the right trade and it costs a second copy of the table:
 * `_helpers.tpl` lists the vendors, and `nacre.embeddingAdapterEnv` lists the
 * variables each one needs.
 *
 * Two copies with nothing that knows they are two is this project's most
 * repeated defect, and the symptom here is precise rather than vague. Add a
 * vendor to the adapter and this chart refuses a route that the container would
 * have served — `helm install` fails on a correct value. Rename a variable and
 * the chart sets one the container does not read, so a routed vendor is
 * configured, apparently in use, and refuses every request for a credential
 * that is right there in its environment.
 *
 * So the table is read from the adapter itself, in this tree. It used to be
 * fetched from the core at the version the chart's `appVersion` named, because
 * the chart lived in another repository; it lives beside the adapter now, so a
 * pull request that adds a vendor there and not here fails on itself rather than
 * on a scheduled run the next morning.
 */

import { readFileSync } from 'node:fs'

const HELPERS = 'deploy/helm/nacre/templates/_helpers.tpl'
const SOURCE = 'services/embedding_adapter/app.py'

/**
 * The adapter's VENDORS table: name -> { keys: [inline, file], settings: {k: VAR} }.
 *
 * A literal parse rather than an import, and it works only because the adapter
 * spells every variable name out instead of composing it from the vendor's —
 * which it does for exactly this reason, stated in its own comment: `lint:config`
 * in the core cannot see an f-string either.
 */
function parseVendors(python, table = 'VENDORS') {
  const block = python.match(new RegExp(`^${table}\\s*=\\s*\\{\\n([\\s\\S]*?)^\\}`, 'm'))
  if (block === null) throw new Error(`no ${table} table in ${SOURCE}`)

  const vendors = new Map()
  const entries = block[1].split(/^ {4}"([a-z0-9-]+)":\s*\{$/m)
  // split() with one capture group yields [before, name, body, name, body, …].
  for (let i = 1; i < entries.length; i += 2) {
    const name = entries[i]
    const body = entries[i + 1]
    const key = body.match(/"key":\s*\(\s*"([A-Z0-9_]+)",\s*"([A-Z0-9_]+)"/)
    if (key === null) throw new Error(`${table} vendor ${name} has no "key" pair`)
    const settingsBlock = body.match(/"settings":\s*\{([^}]*)\}/)
    if (settingsBlock === null) throw new Error(`${table} vendor ${name} has no "settings" mapping`)
    const settings = new Map(
      [...settingsBlock[1].matchAll(/"([a-z_]+)":\s*"([A-Z0-9_]+)"/g)].map((m) => [m[1], m[2]]),
    )
    vendors.set(name, { keys: [key[1], key[2]], settings })
  }
  if (vendors.size === 0) throw new Error(`the ${table} table in ${SOURCE} parsed to nothing`)
  return vendors
}

/** The chart's copy: the `$vendors` or `$rerankers` dict in nacre.validate. */
function parseChartVendors(helpers, name = 'vendors') {
  const block = helpers.match(new RegExp(`\\$${name}\\s*:=\\s*dict\\n([\\s\\S]*?)-\\}\\}`))
  if (block === null) {
    console.error(`::error file=${HELPERS}::no $${name} dict; this check compared nothing`)
    process.exit(1)
  }
  const chart = new Map()
  // The dict literal is column-aligned, so every gap is `\s+` and not a space.
  const line = /"([a-z0-9-]+)"\s+\(dict\s+"values"\s+"([A-Za-z]+)"\s+"settings"\s+\(list([^)]*)\)\)/g
  for (const [, name, valuesKey, settings] of block[1].matchAll(line)) {
    chart.set(name, {
      valuesKey,
      settings: new Set([...settings.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])),
    })
  }
  return chart
}

const source = readFileSync(SOURCE, 'utf8')

const helpers = readFileSync(HELPERS, 'utf8')

let failed = false
const fail = (message, file = HELPERS) => {
  console.error(`::error file=${file}::${message}`)
  failed = true
}

/**
 * One table against its copy.
 *
 * `prefix` is the variable family the chart is allowed to set for this job, and
 * `mine` filters that family down to the adapter's own: the chart also sets the
 * *core's* `NACRE_RERANKER_ENABLED`, `NACRE_RERANKER_ENDPOINT` and
 * `NACRE_RERANK_CANDIDATES` on the api and worker, and those are read by the
 * search path rather than by this sidecar. Without that filter this check would
 * report three variables the adapter has never heard of, every run, and the
 * usual thing would happen to a check that is noisy.
 */
function compare({ label, table, dict, prefix, always, mine }) {
  let adapter
  try {
    adapter = parseVendors(source, table)
  } catch (error) {
    console.error(`::error::could not read the adapter's ${table} table: ${error.message}`)
    console.error('This check fails rather than passing unchecked: the table moved or its shape changed.')
    process.exit(1)
  }
  const chart = parseChartVendors(helpers, dict)

  // 1. The same vendors, in both directions.
  for (const name of adapter.keys()) {
    if (!chart.has(name)) {
      fail(
        `the adapter offers the ${label} vendor \`${name}\` and this chart does ` +
          'not know it. A `helm install` would refuse a value the container would have served. ' +
          `Add it to the $${dict} dict, to nacre.embeddingAdapterEnv, and to values.yaml.`,
      )
    }
  }
  for (const name of chart.keys()) {
    if (!adapter.has(name)) {
      fail(
        `this chart offers the ${label} vendor \`${name}\` and the adapter has no ` +
          'such vendor. The container would refuse it at startup.',
      )
    }
  }

  // 2. The same settings per vendor — these are the values.yaml keys the
  //    validation reads, so a new one is a value an operator is never asked for.
  for (const [name, spec] of adapter) {
    const here = chart.get(name)
    if (here === undefined) continue
    for (const setting of spec.settings.keys()) {
      if (!here.settings.has(setting)) {
        fail(
          `the ${label} vendor ${name} requires \`${setting}\` (${spec.settings.get(setting)}) ` +
            'and the chart does not ask for it. Naming it would render and then refuse to start.',
        )
      }
    }
    for (const setting of here.settings) {
      if (!spec.settings.has(setting)) {
        fail(
          `the chart asks for \`${setting}\` on the ${label} vendor ${name} and the adapter ` +
            'reads nothing by that name.',
        )
      }
    }
  }

  // 3. The variables. The chart uses the inline form of each credential; the
  //    adapter's `_FILE` alternative is for a platform that projects secrets as
  //    files, and a chart setting both would be refused by the adapter itself.
  const required = new Set(always)
  for (const spec of adapter.values()) {
    required.add(spec.keys[0])
    for (const variable of spec.settings.values()) required.add(variable)
  }

  const set = new Set(
    [...helpers.matchAll(new RegExp(`${prefix}[A-Z0-9_]+`, 'g'))].map((m) => m[0]).filter(mine),
  )

  for (const variable of required) {
    if (!set.has(variable)) {
      fail(`${variable} is required by the adapter and this chart never sets it.`)
    }
  }
  for (const variable of set) {
    if (required.has(variable)) continue
    const isFileForm = [...adapter.values()].some((s) => s.keys[1] === variable)
    fail(
      isFileForm
        ? `${variable} is the file form of a credential; the chart supplies the env form through secretKeyRef. Setting both is refused by the adapter.`
        : `this chart sets ${variable} and the adapter reads nothing by that name — a variable configured and never read.`,
    )
  }

  return { vendors: adapter.size, variables: required.size, names: [...adapter.keys()].sort() }
}

/**
 * The core's own reranking variables, which the chart sets on api and worker.
 *
 * Written out rather than matched by shape, so adding one to the core is a
 * failure here that names it — a new `NACRE_RERANK_*` is far more likely to be
 * the adapter's than the core's, and guessing wrong in the silent direction is
 * how a check stops holding anything.
 */
const CORES = new Set(['NACRE_RERANKER_ENABLED', 'NACRE_RERANKER_ENDPOINT', 'NACRE_RERANK_CANDIDATES'])

const embedding = compare({
  label: 'embedding',
  table: 'VENDORS',
  dict: 'vendors',
  prefix: 'NACRE_EMBED_',
  always: ['NACRE_EMBED_ROUTES'],
  mine: () => true,
})

const rerank = compare({
  label: 'rerank',
  table: 'RERANKERS',
  dict: 'rerankers',
  prefix: 'NACRE_RERANK_',
  always: ['NACRE_RERANK_VENDOR', 'NACRE_RERANK_MODEL'],
  mine: (variable) => !CORES.has(variable),
})

if (!failed) {
  console.log(
    `embedding: ${embedding.vendors} vendor(s), ${embedding.variables} variable(s) — ` +
      embedding.names.join(', '),
  )
  console.log(
    `rerank: ${rerank.vendors} vendor(s), ${rerank.variables} variable(s) — ` + rerank.names.join(', '),
  )
  console.log(`both agree with the adapter`)
}
process.exit(failed ? 1 : 0)

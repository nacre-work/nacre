#!/usr/bin/env node
/**
 * Every workload the chart deploys is named by the NetworkPolicy set.
 *
 * `networkPolicy.strict` renders a default-deny that selects **every pod of the
 * release** and then grants back what a working deployment needs. So a workload
 * added to the chart after those rules were written is, by default, a pod that
 * can resolve DNS and do nothing else — and nothing anywhere asks whether the
 * new one was covered.
 *
 * That already happened. `web` — the console — landed after the policy and was
 * named by none of its rules, so a strict deployment came up with every
 * workload healthy and a console the ingress controller could not reach,
 * proxying `/v1` to an API it could not reach either. It was found by adding the
 * *next* workload and asking the question by hand, which is not a mechanism.
 *
 * The shape is the one this project keeps re-deriving: a property that has to
 * hold in two places — the templates that create pods, and the policy that
 * decides what those pods may do — with nothing that knows about the second.
 * The response is a check rather than a second fix.
 *
 * "Named" means one of two things, both of which take a real policy to satisfy:
 * the component appears in a `values: [...]` list on a `matchExpressions`
 * selector, or a policy is named `{{ fullname }}-{component}`. A label on some
 * other object does not count — the point is that a rule selects it.
 *
 * "Named" alone turned out to be half the question. The parser had an
 * *ingress* policy from the day the set was written — it is the workload whose
 * reachability is a security property — so this check counted it covered while
 * strict mode gave it no egress at all: DNS and nothing outbound, and every
 * ingest-by-URL failed silently in the worker. So the check asks the two
 * directions separately now: every workload is selected by an Egress-type rule
 * as well, where the default-deny and the DNS rule do not count — both select
 * every pod, which is exactly how an uncovered one hides.
 *
 * What this cannot check is whether the rule is *right*: `helm template` plus
 * kubeconform proves the objects are valid, and only a cluster proves the
 * traffic flows. It checks that a decision was made and written down, which is
 * exactly what was missing.
 */

import { readdirSync, readFileSync } from 'node:fs'

const TEMPLATES = 'deploy/helm/nacre/templates'
const POLICY = `${TEMPLATES}/networkpolicy.yaml`

/**
 * Workloads that deliberately need no rule, each with the reason. Empty, and
 * that is the state to keep it in — an entry here is a workload somebody has
 * argued does not need to reach anything or be reached, which for a pod in a
 * default-deny namespace is a strong claim.
 */
const NEEDS_NOTHING = new Map()

const files = readdirSync(TEMPLATES).filter((f) => f.endsWith('.yaml') && f !== 'networkpolicy.yaml')
if (files.length === 0) {
  console.error(`::error::no templates under ${TEMPLATES}/; this check compared nothing`)
  process.exit(1)
}

/** component -> the template that creates its pods. */
const workloads = new Map()
for (const file of files) {
  const text = readFileSync(`${TEMPLATES}/${file}`, 'utf8')
  // Only templates that actually create pods. `pdb.yaml` and
  // `servicemonitor.yaml` name components too and select nothing.
  if (!/kind:\s*(Deployment|StatefulSet|DaemonSet|Job)\b/.test(text)) continue
  for (const [, component] of text.matchAll(/app\.kubernetes\.io\/component:\s*([a-z0-9-]+)/g)) {
    if (!workloads.has(component)) workloads.set(component, file)
  }
}

if (workloads.size === 0) {
  console.error(`::error::no workload templates found under ${TEMPLATES}/; this check found nothing`)
  process.exit(1)
}

const policy = readFileSync(POLICY, 'utf8')

/** Components named in a `values: [a, b, c]` list on a matchExpressions selector. */
const selected = new Set()
for (const [, list] of policy.matchAll(/values:\s*\[([^\]]*)\]/g)) {
  for (const name of list.split(',')) {
    const trimmed = name.trim()
    if (trimmed) selected.add(trimmed)
  }
}

/** Components with a policy of their own: `name: {{ … }}-{component}`. */
const named = new Set()
for (const [, suffix] of policy.matchAll(/^\s*name:\s*\{\{[^}]*\}\}-([a-z0-9-]+)\s*$/gm)) {
  named.add(suffix)
}

let failed = false

/**
 * Components selected by a policy whose policyTypes include Egress — the
 * direction "named" could not see. Parsed per policy document: the default-deny
 * and the DNS rule select every pod and grant nothing a workload can do its
 * job with, so they are excluded by name rather than counted as coverage.
 */
const egressCovered = new Set()
for (const doc of policy.split(/^---$/m)) {
  if (!/policyTypes:.*Egress/.test(doc)) continue
  if (/-default-deny|-dns\b|allow-dns/.test(doc)) continue
  // Only the policy's own podSelector — the slice between `podSelector:` and
  // `policyTypes:`. The first version read the whole document, and the whole
  // document names components as *destinations* too: removing the parser's
  // egress rule stayed green because `allow-egress` routes *to* the parser,
  // and a pod something else may reach is not a pod that may reach anything.
  // The narrow-projection defect, produced inside the check written against it.
  const at = doc.indexOf('podSelector:')
  const upTo = doc.indexOf('policyTypes:')
  if (at === -1 || upTo === -1 || upTo < at) continue
  const selector = doc.slice(at, upTo)
  for (const [, list] of selector.matchAll(/values:\s*\[([^\]]*)\]/g)) {
    for (const name of list.split(',')) {
      const trimmed = name.trim()
      if (trimmed) egressCovered.add(trimmed)
    }
  }
  for (const [, comp] of selector.matchAll(/app\.kubernetes\.io\/component:\s*([a-z0-9-]+)/g)) {
    egressCovered.add(comp)
  }
}
if (egressCovered.size === 0) {
  console.error(`::error file=${POLICY}::no Egress-type policy selects any component; this half compared nothing`)
  failed = true
}

for (const [component, file] of [...workloads].sort()) {
  if (NEEDS_NOTHING.has(component)) {
    console.log(`  ${component}: no rule, on purpose — ${NEEDS_NOTHING.get(component)}`)
    continue
  }
  if (!egressCovered.has(component)) {
    console.error(
      `::error file=${POLICY}::${TEMPLATES}/${file} creates pods labelled ` +
        `app.kubernetes.io/component: ${component}, and no Egress-type NetworkPolicy selects ` +
        'them (the default-deny and DNS rules do not count — they select every pod). Under ' +
        '`networkPolicy.strict` this workload resolves names and reaches nothing, which is ' +
        'how the parser shipped with ingest-by-URL silently broken while its ingress rule ' +
        'made it look covered.',
    )
    failed = true
  }
  if (selected.has(component) || named.has(component)) continue

  console.error(
    `::error file=${POLICY}::${TEMPLATES}/${file} creates pods labelled ` +
      `app.kubernetes.io/component: ${component}, and no NetworkPolicy names them. Under ` +
      '`networkPolicy.strict` the default-deny selects every pod of the release, so this ' +
      'workload gets DNS and nothing else — it starts, it reports healthy, and it reaches ' +
      'nothing. Add a rule that selects it (a `values: [...]` entry, or a policy named ' +
      `\`{{ fullname }}-${component}\`), or add it to NEEDS_NOTHING in this script with the ` +
      'reason it needs neither direction.',
  )
  failed = true
}

if (!failed) {
  console.log(
    `${workloads.size} workload component(s), each named by ${POLICY}: ` +
      `${[...workloads.keys()].sort().join(', ')}`,
  )
}
process.exit(failed ? 1 : 0)

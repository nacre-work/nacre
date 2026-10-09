import type { Endpoints } from '@nacre.work/sdk'

import { client } from './api.js'
import { copyControl, h } from './dom.js'

/**
 * Where a client connects, and what a request looks like.
 *
 * The console showed what was connected and never where to connect: the MCP
 * endpoint and the REST base were in `docs/quickstart.md` and in an operator's
 * `.env`, so a person handed a login had to ask somebody for an address the
 * server already knew. The addresses come from `GET /v1/endpoints` rather than
 * from `location.origin`, because the page's own origin is the answer only
 * where the console, the API and the MCP transport share one, and the operator
 * has already told the server which addresses are the public ones.
 *
 * The examples are real requests against those addresses — the shapes in
 * `docs/openapi.yaml`, with this organization's first layer where one is
 * needed — so what is copied runs. The whole contract is linked at the version
 * the server was built from, not at `main`.
 */

/** A labelled address with the control that takes it. */
function address(label: string, url: string, note: string): HTMLElement[] {
  const copy = copyControl(url, url, `Copy the ${label} address`)
  return [
    h('dt', {}, label),
    h('dd', {},
      h('div', { class: 'secretrow' }, h('code', { class: 'endpoint' }, url), copy.button),
      copy.note,
      h('p', { class: 'hint' }, note),
    ),
  ]
}

/** A request somebody can paste, with a copy control and a line saying what comes back. */
function example(title: string, text: string, answer?: string): HTMLElement {
  const copy = copyControl(text, 'the example', `Copy: ${title}`)
  return h('div', { class: 'example' },
    h('h4', {}, title),
    h('div', { class: 'secretrow' }, h('pre', { class: 'example-code' }, text), copy.button),
    copy.note,
    ...(answer === undefined ? [] : [h('p', { class: 'hint' }, answer)]),
  )
}

/** The REST base without `/v1`, which is what the SDK and the `nacre` command take. */
const origin = (api: string): string => api.replace(/\/v1\/?$/, '')

export function examples(e: Endpoints, layer: string): HTMLElement[] {
  const auth = '  -H "Authorization: Bearer $NACRE_TOKEN"'
  const json = '  -H "Content-Type: application/json"'
  return [
    example(
      'Add Nacre to Claude Code',
      `claude mcp add --transport http nacre ${e.mcp}`,
      'Any MCP client that takes a remote server over HTTP works the same way: the first request is refused with a pointer to this installation, and the client opens a page here to sign in and approve.',
    ),
    example(
      'Or in a client’s configuration file',
      JSON.stringify({ mcpServers: { nacre: { type: 'http', url: e.mcp } } }, null, 2),
    ),
    example(
      'Search',
      [`curl -s ${e.api}/search \\`, `${auth} \\`, `${json} \\`, `  -d '{"query": "on-call rotation", "top_k": 5}'`].join('\n'),
      'Answers {"items": [{"doc_id", "layer", "title", "score", "text"}, …]} — only what the token may read, and exactly top_k of it.',
    ),
    example(
      'Add a document',
      [
        `curl -s ${e.api}/documents \\`,
        `${auth} \\`,
        `${json} \\`,
        `  -d '{"layer": "${layer}", "external_id": "on-call.md", "title": "On-call", "content": "Who is on call and how to page them."}'`,
      ].join('\n'),
      'Answers 202 with {"job_id", "document_id", "status": "queued"}. Queued is not indexed: ask GET /v1/jobs/{job_id} until it says indexed. The same external_id again replaces the document.',
    ),
    example(
      'Upload a file',
      [`curl -s ${e.api}/documents \\`, `${auth} \\`, `  -F layer=${layer} \\`, '  -F file=@q3-plan.pdf'].join('\n'),
      'A PDF or an Office document needs object storage configured; text and Markdown do not.',
    ),
    example(
      'The nacre command and the SDK read the same two values',
      [`export NACRE_API_URL=${origin(e.api)}`, 'export NACRE_TOKEN=nacre_sk_…', 'nacre search "on-call rotation"'].join('\n'),
    ),
  ]
}

/**
 * The panel, filled once the server has answered. An older API answers `404`
 * here, and then the panel says nothing rather than guessing an address.
 *
 * Whether to offer the administrative MCP is the server's answer too: it sends
 * `mcp_admin` only to somebody who administers the organization, because that
 * connection's consent screen refuses everybody else.
 */
export function connectPanel(): HTMLElement {
  const panel = h('section', { class: 'panel connect', hidden: '' })
  void (async () => {
    let e: Endpoints
    try {
      e = await client().endpoints()
    } catch {
      return
    }
    let layer = 'handbook'
    try {
      layer = (await client().layers.list())[0]?.slug ?? layer
    } catch {
      // The example keeps a layer name of its own; it is an example.
    }
    const facts = h('dl', { class: 'facts' },
      ...address('MCP', e.mcp,
        'For agents. Add it to an MCP client as a remote server over HTTP — the client sends you here to sign in and choose what it may do.'),
      ...(e.mcpAdmin !== undefined
        ? address('Admin MCP', e.mcpAdmin,
          'Administering this organization from an agent. It reads how things are set up, and a change it proposes waits for you to apply it.')
        : []),
      ...address('REST API', e.api,
        'For applications and scripts. A token goes in the Authorization header: a service account key, or a session.'),
    )
    panel.append(
      h('h2', {}, 'Connect a client'),
      facts,
      h('details', { class: 'examples' },
        h('summary', {}, 'Example requests'),
        ...examples(e, layer),
        h('p', { class: 'hint' },
          'Every operation, with its fields and its answers: ',
          h('a', { href: e.contract, target: '_blank', rel: 'noopener noreferrer' }, `the API contract for ${e.version}`),
          '.'),
      ),
    )
    panel.hidden = false
  })()
  return panel
}

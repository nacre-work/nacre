import type { EmbeddingProvider } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h } from '../dom.js'

/**
 * The embedding models this organization can put a layer on.
 *
 * `POST /v1/embedding-providers` has existed since the schema carried
 * `embedding_providers.org_id`, and until now no screen reached it — an
 * `org_admin` who wanted a second model, or their own hosted embedder, dropped
 * to `curl`. That is the model-offers-it-and-the-product-gives-no-route shape,
 * on the surface that decides where document text goes.
 *
 * The screen is drawn only where `GET /v1/me` reports `manages_embedders`:
 * `org_admin`, and `NACRE_EMBED_TENANT_PROVIDERS` on. A managed platform turns
 * the switch off, embedding becomes a service the platform provides, and this
 * screen goes with it — the router leaves it out of the nav rather than drawing
 * one whose write answers `404`.
 *
 * The endpoint is a real widening and the lede says so: the text of documents
 * in a layer on this provider is POSTed to it. The server refuses an internal
 * address that is not the installation's embedder — that guard is not this
 * screen's to repeat — so a bad endpoint comes back as the server's own `400`.
 */
export async function modelsView(root: HTMLElement): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Models'),
        h('p', { class: 'lede' },
          'The embedding models a layer can be put on. Adding one decides what a layer can be ' +
          'migrated onto — and, for an endpoint of your own, where the text of its documents is ' +
          'sent. Point the endpoint at your embedder, or at the embedding adapter to reach a ' +
          'hosted vendor.'),
      ),
      h('button', { class: 'btn btn-primary', onclick: () => openCreate(root) }, 'Add a model'),
    ),
  )

  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  root.append(body)
  await load(body)
}

async function load(body: HTMLElement): Promise<void> {
  clear(body)
  let providers: readonly EmbeddingProvider[]
  try {
    providers = await client().embeddingProviders.list()
  } catch (error) {
    body.append(h('div', { class: 'error' }, explain(error)))
    return
  }

  if (providers.length === 0) {
    body.append(h('p', { class: 'muted' }, 'No models yet.'))
    return
  }

  const rows = h('tbody', {})
  for (const provider of providers) {
    // The installation default belongs to every tenant and is not this
    // organization's to remove — the server refuses (`404`), and the screen
    // says why rather than offering a button that fails.
    const actions = h('td', { class: 'right' })
    if (!provider.isDefault) {
      const remove = h('button', { class: 'btn', onclick: () => void del(body, provider) }, 'Remove')
      actions.append(remove)
    } else {
      actions.append(h('span', { class: 'muted' }, 'installation default'))
    }
    rows.append(
      h('tr', {},
        h('td', { class: 'named' },
          h('div', {}, provider.name),
          h('div', { class: 'muted mono' }, `${provider.model} · ${String(provider.dimensions)} dims`)),
        actions),
    )
  }
  body.append(
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', { class: 'right' }, ''))),
      rows),
  )
}

async function del(body: HTMLElement, provider: EmbeddingProvider): Promise<void> {
  const outcome = await client().embeddingProviders.remove(provider.id).catch((error: unknown) => {
    body.append(h('div', { class: 'error' }, explain(error)))
    return 'error' as const
  })
  if (outcome === 'removed') {
    await load(body)
    return
  }
  if (outcome === 'in-use') {
    // A layer still names it. The server's rule, said on the screen: move those
    // layers onto another model — the reindex on the Layers screen — first.
    body.append(h('div', { class: 'error' },
      `${provider.name} is still used by a layer. Move those layers onto another model first.`))
    return
  }
  if (outcome === 'unreachable') {
    body.append(h('div', { class: 'error' }, `${provider.name} could not be removed.`))
  }
}

function openCreate(root: HTMLElement): void {
  const dialog = h('dialog', { class: 'dialog' })
  const name = h('input', { class: 'input', placeholder: 'A name for this model' })
  const endpoint = h('input', { class: 'input', placeholder: 'https://your-embedder.example.com/v1' })
  const model = h('input', { class: 'input', placeholder: 'The model name the endpoint expects' })
  const dimensions = h('input', { class: 'input narrow', type: 'number', min: '1', max: '16384' })
  const error = h('div', {})
  const save = h('button', { class: 'btn btn-primary' }, 'Add')

  const field = (label: string, control: HTMLElement) =>
    h('label', { class: 'field' }, h('span', {}, label), control)

  save.addEventListener('click', () => {
    void submit(root, dialog, error, save, {
      name: name.value.trim(),
      endpoint: endpoint.value.trim(),
      model: model.value.trim(),
      dimensions: Number(dimensions.value),
    })
  })

  dialog.append(
    h('h2', {}, 'Add a model'),
    h('p', { class: 'muted' },
      'The dimensions must match what the model returns — a wrong number is a layer that ' +
      'accepts documents and fails every one of them.'),
    field('Name', name),
    field('Endpoint', endpoint),
    field('Model', model),
    field('Dimensions', dimensions),
    error,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
      save),
  )
  root.append(dialog)
  dialog.showModal()
}

async function submit(
  root: HTMLElement,
  dialog: HTMLDialogElement,
  error: HTMLElement,
  save: HTMLButtonElement,
  input: { name: string; endpoint: string; model: string; dimensions: number },
): Promise<void> {
  if (input.name === '' || input.endpoint === '' || input.model === '' || !Number.isInteger(input.dimensions)) {
    clear(error)
    error.append(h('div', { class: 'error' }, 'Every field is required.'))
    return
  }
  save.disabled = true
  clear(error)
  try {
    const provider = await client().embeddingProviders.create(input)
    if (provider === undefined) {
      // `undefined` is the SDK's `404` — this caller may not manage providers.
      error.append(h('div', { class: 'error' }, 'You may not add a model here.'))
      save.disabled = false
      return
    }
    dialog.close()
    // Re-render the whole screen so the new model is in the list.
    await modelsView(root)
  } catch (err) {
    // The server's own words — a refused endpoint (the egress guard), a
    // duplicate name (409), a wrong dimension — rather than a message invented
    // here.
    error.append(h('div', { class: 'error' }, explain(err)))
    save.disabled = false
  }
}

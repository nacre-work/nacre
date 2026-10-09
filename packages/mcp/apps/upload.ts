/**
 * `ui://nacre/upload.html` — a file into a layer, from inside the
 * conversation, and never through the model.
 *
 * The model opens this with `upload_file`; the person picks the file. The
 * view asks the server for a ticket through the host (`request_upload`, so
 * the write is checked where it is always checked), sends the bytes straight
 * to the ticket URL — the one request a view makes on its own, which is why
 * the resource's CSP names the API's origin — and then reads `ingest_status`
 * until the document is indexed or has failed. What the model learns is the
 * outcome, through `updateModelContext`: a document id, a job id, a status,
 * and never the file.
 *
 * The layer is a text field with the readable layers as suggestions, not a
 * list to pick from. `list_layers` answers with what the caller may *read*,
 * and rule 6 makes `write` a separate fact: an ingest-only account holds
 * `write` on a layer it cannot list, and a `<select>` built from the listing
 * offered that account nothing. The suggestions are a convenience; the name
 * is the input, and the write is checked where it always is, on the ticket.
 */
import { call, clear, connect, el, layers, mount, status, type LayerRow } from './shared.js'

interface Descriptor {
  url: string
  method: string
  max_size: number
  accepts: string[]
}

interface Job {
  job_id: string
  document_id: string
  status: string
  chunk_count?: number
  reason?: string
  error?: string
}

async function main(): Promise<void> {
  const root = mount()
  const app = await connect('nacre-upload')

  let preset: string | undefined
  app.ontoolinput = (params) => {
    const layer = (params.arguments as { layer?: unknown } | undefined)?.layer
    if (typeof layer === 'string') preset = layer
    render()
  }

  const select = el('input', { list: 'layers', type: 'text', 'aria-label': 'Layer', placeholder: 'layer slug', autocomplete: 'off', spellcheck: 'false' })
  const suggestions = el('datalist', { id: 'layers' })
  const file = el('input', { type: 'file', 'aria-label': 'File' })
  const button = el('button', { type: 'button' }, 'Upload')
  const bar = el('progress', { hidden: '', max: '3', value: '0' })
  let known: LayerRow[]

  function render(): void {
    clear(root)
    root.append(
      el('div', { class: 'row' }, el('label', {}, 'Layer ', select), suggestions),
      el('div', { class: 'row' }, file, button),
      bar,
    )
    if (preset !== undefined) select.value = preset
  }
  render()
  status(root, 'Loading the layers you may read, as suggestions…')

  try {
    known = await layers(app)
  } catch (error) {
    status(root, `Could not list layers: ${String(error)}`, 'error')
    return
  }
  clear(suggestions)
  for (const layer of known) {
    suggestions.append(el('option', { value: layer.slug }, `${layer.name} (${layer.slug})`))
  }
  if (preset !== undefined) select.value = preset
  else if (known.length === 1 && known[0] !== undefined) select.value = known[0].slug
  status(
    root,
    known.length === 0
      ? 'Type the slug of a layer you may write to, then pick a file. (You can read no layer, so none is suggested.)'
      : 'Pick a file.',
  )

  button.addEventListener('click', () => {
    const picked = file.files?.[0]
    const layer = select.value.trim()
    if (layer === '') {
      status(root, 'Name the layer first.', 'error')
      return
    }
    if (picked === undefined) {
      status(root, 'Pick a file first.', 'error')
      return
    }
    void upload(picked, layer)
  })

  async function upload(picked: File, layer: string): Promise<void> {
    button.disabled = true
    bar.hidden = false
    bar.value = 0
    status(root, `Asking for an upload ticket for ${layer}…`)

    const ticket = await call(app, 'request_upload', { layer, external_id: picked.name })
    if (!ticket.ok) {
      status(root, `No ticket: ${ticket.message}`, 'error')
      button.disabled = false
      return
    }
    const descriptor = ticket.value as Descriptor
    if (picked.size > descriptor.max_size) {
      status(root, `${picked.name} is ${picked.size} bytes; the limit is ${descriptor.max_size}.`, 'error')
      button.disabled = false
      return
    }
    bar.value = 1
    status(root, `Sending ${picked.name} (${picked.size} bytes)…`)

    const type = picked.type || 'text/plain'
    let accepted: Job
    try {
      const response = await fetch(descriptor.url, {
        method: descriptor.method,
        headers: { 'content-type': type },
        body: picked,
      })
      const body = (await response.json().catch(() => null)) as (Job & { detail?: string }) | null
      if (!response.ok) {
        status(root, `Refused (${response.status}): ${body?.detail ?? 'no detail'}`, 'error')
        button.disabled = false
        return
      }
      accepted = body as Job
    } catch (error) {
      status(root, `The upload did not reach the server: ${String(error)}`, 'error')
      button.disabled = false
      return
    }
    bar.value = 2

    // Indexing happens in the worker, afterwards. Read the job until it
    // settles, and tell the model what settled — not the file.
    let job: Job = accepted
    for (let i = 0; i < 60 && (job.status === 'queued' || job.status === 'parsing' || job.status === 'embedding'); i += 1) {
      status(root, `Accepted as ${job.document_id}; ${job.status}…`)
      await new Promise((r) => setTimeout(r, 2000))
      const read = await call(app, 'ingest_status', { job_id: accepted.job_id })
      if (!read.ok) break
      job = read.value as Job
    }
    bar.value = 3
    const settled =
      job.status === 'indexed'
        ? `${picked.name} is indexed in ${layer} as ${job.document_id}` +
          (job.chunk_count === 0 ? ', but parsed to no text and is not searchable' : '') +
          '.'
        : job.status === 'failed'
          ? `${picked.name} failed to index (${job.reason ?? 'unknown'}): ${job.error ?? ''}`
          : `${picked.name} was accepted as ${job.document_id} and is still ${job.status}.`
    status(root, settled, job.status === 'failed' ? 'error' : 'info')
    await app.updateModelContext({ content: [{ type: 'text', text: settled }] }).catch(() => undefined)
    button.disabled = false
  }
}

void main()

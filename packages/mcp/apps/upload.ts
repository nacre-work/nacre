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

  const select = el('select', { 'aria-label': 'Layer' })
  const file = el('input', { type: 'file', 'aria-label': 'File' })
  const button = el('button', { type: 'button' }, 'Upload')
  const bar = el('progress', { hidden: '', max: '3', value: '0' })
  let known: LayerRow[] = []

  function render(): void {
    clear(root)
    root.append(
      el('div', { class: 'row' }, el('label', {}, 'Layer ', select)),
      el('div', { class: 'row' }, file, button),
      bar,
    )
    if (preset !== undefined && known.some((l) => l.slug === preset)) select.value = preset
  }
  render()
  status(root, 'Loading the layers you may write to…')

  try {
    known = await layers(app)
  } catch (error) {
    status(root, `Could not list layers: ${String(error)}`, 'error')
    return
  }
  clear(select)
  for (const layer of known) {
    select.append(el('option', { value: layer.slug }, `${layer.name} (${layer.slug})`))
  }
  if (preset !== undefined) select.value = preset
  status(root, known.length === 0 ? 'No layers are available to you.' : 'Pick a file.')
  button.disabled = known.length === 0

  button.addEventListener('click', () => {
    const picked = file.files?.[0]
    if (picked === undefined) {
      status(root, 'Pick a file first.', 'error')
      return
    }
    void upload(picked, select.value)
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

/**
 * What `initialize` tells a client about this server.
 *
 * The MCP specification has a field for this and we sent nothing in it — the
 * same shape as every other gap this repository keeps finding: the protocol
 * offers something and the product gives no route to it. A client's model gets
 * tool schemas and no idea that a `404` here is deliberate, so it retries,
 * rephrases, and eventually tells somebody the server is broken.
 *
 * **One string, used by both transports.** Streamable HTTP and STDIO each build
 * their own `initialize` result, and this is exactly the shape that produced
 * `serverVersion` being carried by two transports and passed by neither entry
 * point. `transport-parity.test.ts` asks both.
 *
 * What belongs here is what is true of **this server** — the permission model's
 * observable behaviour, and how to address things. What does not belong is a
 * workflow: "how to onboard a team" spans this product and others, changes on a
 * different clock, and would rot here.
 *
 * Short on purpose. This is prepended to a context window on every connection,
 * and a page of prose is a page of somebody's budget.
 */
export const INSTRUCTIONS = `Nacre is a knowledge index with per-principal access control.

Searching returns only what the calling principal is permitted to read, and the
filter is applied inside the index traversal — so a search for 10 results
returns 10 permitted results, not 10 minus what was removed. An empty result
means nothing you may see matched. It is not an error and retrying will not
change it.

A document you may not see and a document that does not exist answer the same
way: not found. That is deliberate, so do not treat one as a transient failure
or try a different phrasing of the same request to tell them apart.

Permissions are not a ladder. Write does not imply read: a principal may be able
to add a document to a layer and unable to search it. If a write succeeds and a
search then finds nothing, both answers are correct.

Layers are addressed by slug. Restricting a search to layers you were not
granted returns nothing rather than an error.

If you are acting on somebody's behalf through an authorized connection, you
reach exactly what that person reaches, re-checked on every request — and they
may have restricted this connection to some of their layers or to reading only.
Access can be withdrawn at any time and takes effect on the next request.`

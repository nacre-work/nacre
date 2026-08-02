# @nacre.work/admin

The community admin UI. One organization, four screens, no framework.

```
pnpm --filter @nacre.work/admin build   # -> dist/, static files
```

## What it is

A static directory. `dist/` is `index.html`, one ES module, one stylesheet, and
the brand assets — nothing to deploy, nothing to run. `docs/architecture.md`
puts nginx in front of the API and this together, which is the arrangement it is
written for: **the UI and the API on one origin**, so there is no CORS to
configure and no second hostname to get a certificate for.

An operator who serves it elsewhere can point it at another API from the sign-in
screen. That is a real deployment and a slightly worse one.

## What is deliberately missing

**A framework.** Four screens, no client-side state worth reconciling, and a
container whose selling point is that it has no supply chain to speak of. React
here would be the largest dependency in the repository, and it would be carrying
four tables. `esbuild` is the only build dependency and exists solely because a
browser cannot resolve a bare `@nacre.work/sdk` specifier.

**A global admin.** Organizations, quotas, and cross-organization anything are
commercial — see `docs/licensing.md`. This screen is scoped to the organization
in the token and has no way to express another one.

**A login.** There is none in the product yet, so the sign-in screen takes a
token or a service account key directly and says where each comes from. It is
kept in `sessionStorage` and gone when the tab closes: a bearer credential with
no server-side session behind it cannot be invalidated from anywhere, so that is
the only sign-out this build can honestly offer.

## Deployment notes

`frame-ancestors` is absent from the CSP meta tag on purpose — a browser ignores
that directive when it arrives in a meta element, so including it would be a
clickjacking defence that reports itself as present and does nothing. Serve this
directory with a real header:

```
add_header X-Frame-Options DENY always;
add_header Content-Security-Policy "frame-ancestors 'none'" always;
```

Everything else in the policy works from the meta tag and is there.

## The brand assets

`public/brand/` is a mirror of the private brand repository. **Do not edit in
place** — change the brand first and re-sync, or the edit is lost and the other
mirrors quietly disagree. The mirror table in that repository lists every copy.

`admin.css` invents no hex value: every colour resolves to a token, and the six
strata are read through `--n-s1`…`--n-s6` so the "dense row on light, ink row on
dark" rule lives in one place instead of at every use.

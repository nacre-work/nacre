# Nacre Contributor License Agreement

**Version 1.0**

> **This document has not been reviewed by a lawyer.** It is adapted from the
> Apache Software Foundation's Individual Contributor License Agreement v2.0,
> which is the most widely used and most widely litigated-around template of its
> kind, with the changes described in [Notes on this
> adaptation](#notes-on-this-adaptation) at the end. Two fields in it are
> deliberately unresolved and are marked where they appear: the **legal identity
> of the Owner** and the **governing law**. Both must be settled before this
> agreement governs a real contribution — an agreement with no identifiable
> counterparty is not obviously enforceable, which would defeat the only reason
> to have one.

## Why this exists

Nacre's core is Apache 2.0 and stays Apache 2.0. This agreement does not change
that, and it is not a copyright assignment: **you keep the copyright in
everything you write.**

What it does is give the Owner the rights needed to keep distributing your
contribution as part of Nacre, including under terms other than Apache 2.0 in
the future. That last part is the whole reason this is a CLA rather than a
Developer Certificate of Origin, and it is worth being direct about it: if Nacre
ever has to change the licence of its core — the usual reason being a third
party reselling it as a managed service — that decision must not require
tracking down every past contributor for permission. Under a DCO it would.

Nothing here lets the Owner take away rights you or anyone else already has. The
Apache 2.0 grant on every release already made is perpetual and irrevocable, and
this agreement cannot and does not revoke it. A licence change would apply to
future releases only.

## Agreement

You accept and agree to the following terms for Your present and future
Contributions submitted to Nacre. Except for the licences granted here to the
Owner and to recipients of software distributed by the Owner, **You reserve all
right, title and interest in and to Your Contributions.**

### 1. Definitions

**"You"** (or **"Your"**) means the copyright owner, or the legal entity
authorised by the copyright owner, that is entering into this agreement. For a
legal entity, the entity making a Contribution and all other entities that
control, are controlled by, or are under common control with that entity are
considered a single Contributor. "Control" means (i) the power, direct or
indirect, to cause the direction or management of such entity, whether by
contract or otherwise, (ii) ownership of fifty percent (50%) or more of the
outstanding shares, or (iii) beneficial ownership of such entity.

**"Owner"** means Nacre, the copyright holder identified in the `LICENSE` and
`NOTICE` files of this repository.

> **Unresolved.** "Nacre" is a project name, not yet a stated legal entity. Before
> this agreement is used, the Owner must be identified as a natural person or a
> registered company. Section 9 is written so that incorporating later does not
> invalidate signatures collected before.

**"Contribution"** means any original work of authorship, including any
modifications or additions to an existing work, that is intentionally submitted
by You to the Owner for inclusion in, or documentation of, any of the products
owned or managed by the Owner (the **"Work"**). "Submitted" means any form of
electronic, verbal, or written communication sent to the Owner or its
representatives, including but not limited to communication on electronic
mailing lists, source code control systems, and issue tracking systems that are
managed by, or on behalf of, the Owner for the purpose of discussing and
improving the Work — but excluding communication that is conspicuously marked or
otherwise designated in writing by You as "Not a Contribution".

### 2. Grant of copyright licence

Subject to the terms and conditions of this agreement, You hereby grant to the
Owner and to recipients of software distributed by the Owner a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright licence
to reproduce, prepare derivative works of, publicly display, publicly perform,
**sublicense**, and distribute Your Contributions and such derivative works.

The right to sublicense is the operative one. It is what allows the Owner to
distribute Your Contribution under a licence other than Apache 2.0 — in a
commercial module, or in a future release of the core under different terms —
without returning to You for permission. It does not allow the Owner to withdraw
any licence already granted to anyone, including to You.

### 3. Grant of patent licence

Subject to the terms and conditions of this agreement, You hereby grant to the
Owner and to recipients of software distributed by the Owner a perpetual,
worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except as stated
in this section) patent licence to make, have made, use, offer to sell, sell,
import, and otherwise transfer the Work.

This licence applies only to those patent claims licensable by You that are
necessarily infringed by Your Contribution alone or by combination of Your
Contribution with the Work to which You submitted it.

If any entity institutes patent litigation against You or any other entity
alleging that Your Contribution, or the Work to which You have contributed,
constitutes direct or contributory patent infringement, then any patent licences
granted to that entity under this agreement for that Contribution or Work
terminate as of the date such litigation is filed.

### 4. You have the right to grant this

You represent that You are legally entitled to grant the above licences.

If Your employer has rights to intellectual property that You create — which
includes work You do on Your own time in many jurisdictions and under many
employment contracts — You represent that You have received permission to make
Contributions on behalf of that employer, that Your employer has waived such
rights for Your Contributions to the Owner, or that Your employer has executed a
separate corporate agreement with the Owner.

This clause is the one most often skipped and most often the problem. If You are
employed and unsure, ask before You sign rather than after.

### 5. It is Your own work

You represent that each of Your Contributions is Your original creation. You
represent that Your Contribution submissions include complete details of any
third-party licence or other restriction (including related patents and
trademarks) of which You are personally aware and which are associated with any
part of Your Contributions.

### 6. Work not Your own

Should You wish to submit work that is not Your original creation, You may
submit it to the Owner separately from any Contribution, identifying the
complete details of its source and of any licence or other restriction
(including related patents, trademarks, and licence agreements) of which You are
personally aware, and conspicuously marking the work as
`Submitted on behalf of a third-party: [named here]`.

### 7. No obligation of support

You are not expected to provide support for Your Contributions, except to the
extent You desire to provide support. You may provide support for free, for a
fee, or not at all. Unless required by applicable law or agreed to in writing,
You provide Your Contributions on an **"AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND**, either express or implied, including, without
limitation, any warranties or conditions of TITLE, NON-INFRINGEMENT,
MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE.

### 8. Tell us if something here stops being true

You agree to notify the Owner of any facts or circumstances of which You become
aware that would make these representations inaccurate in any respect.

### 9. Successors

The Owner may assign this agreement, and the rights granted under it, to a
successor in interest to the Work — including to a company later incorporated to
hold it. This section exists so that a signature collected today survives the
Owner becoming a legal entity tomorrow, and so that You do not have to sign
again for that reason.

### 10. Governing law

This agreement is governed by the laws of [**unresolved — see the note at the
top**], excluding its conflict-of-law provisions.

## How to sign

There is no third-party service, no account to create, and nothing that leaves
this repository. Signing is a pull request:

1. Read this document.
2. Add yourself to `.github/cla/signatures.json`:

   ```json
   {
     "github": "your-github-username",
     "name": "Your Full Name",
     "emails": ["the@address.you", "commit@with.example"],
     "version": "1.0",
     "date": "2026-08-02"
   }
   ```

   List **every** email address you author commits from. The check compares
   against commit metadata, and an address that is not listed reads as an
   unsigned contributor.

3. Open a pull request titled `chore: sign the CLA`, containing that change and
   nothing else, with this line in the body:

   > I have read the Nacre Contributor License Agreement version 1.0 and I agree
   > to it for my present and future Contributions to Nacre.

A pull request that touches only the signatures file is exempt from the CLA
check — otherwise signing would be impossible. That is safe because the check
reads the signature list from the base branch and never from the pull request,
so a contribution cannot approve itself. A maintainer merging your signature
pull request is what records the agreement, and the git history of that file is
the record.

Your normal contributions can be opened before or after; they will not merge
until the signature does.

## Notes on this adaptation

Kept from the Apache ICLA v2.0 essentially verbatim, because the wording has two
decades of use behind it: the definitions, the copyright grant, the patent grant
and its termination trigger, the employer clause, the third-party-work
procedure, the support disclaimer, and the notification duty.

Changed:

- **The counterparty is a project owner rather than a foundation.** Section 9
  was added for that reason: a foundation does not get incorporated later, and
  this project might.
- **The sublicence right is called out explicitly in prose**, in section 2 and in
  the opening. The Apache grant already contains it; leaving what it is *for*
  unstated is how a contributor ends up surprised by a licence change they
  technically permitted. Saying it plainly is the point of the whole document.
- **Governing law was added as an explicit unresolved field.** The Apache ICLA
  omits it; for a single owner rather than a foundation, leaving it silent means
  the answer is decided by whoever sues first.
- **The signing procedure is in-repository** rather than by scanned PDF or a
  hosted CLA service. This is a product whose pitch is that nothing phones home;
  the contribution process should not be the exception.

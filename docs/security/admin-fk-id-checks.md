# Admin-supplied foreign-key id existence checks

Companion guard to [`org-isolation-coverage.md`](./org-isolation-coverage.md)
and [`csrf-coverage.md`](./csrf-coverage.md).

## What this guards against

Several admin-facing routes accept a foreign-key id from the request
(`?organizationId`, body `locationId`, body `bowlerId`, etc.) and
forward it directly into a row insert / update. When the supplied id
doesn't exist, the only safety net used to be the database FK
constraint — which surfaces as a generic **HTTP 500** with a Postgres
error string in the logs.

Task #422 fixed the original case (`POST /api/bowlers?organizationId=`
on `bowlers.organization_id -> organizations.id`). Task #454 swept the
rest of the surface so the same shape of bug isn't waiting in the next
admin route to be discovered.

## Audit table

Every POST / PATCH route that accepts an admin-supplied id which lands
on a column with an FK constraint, with the path that gates it.

| Route | Admin-supplied id(s) | FK target | Status |
| --- | --- | --- | --- |
| `POST /api/bowlers` | `?organizationId` | `bowlers.organization_id -> organizations.id` | Existence check (#422). Pinned by `tests/api/bowler-creation-org-required.test.ts` |
| `POST /api/teams` | body `leagueId` | `teams.league_id -> leagues.id` | Existing 404 in `server/routes/teams.ts` |
| `PATCH /api/teams/:id` | none (id-from-row) | n/a | n/a |
| `POST /api/bowler-leagues` | body `bowlerId` / `leagueId` / `teamId` | `bowler_leagues.*_id` | `hasAccessToBowler` / `hasAccessToLeague` / `hasAccessToTeam` return false for missing rows -> 403 (no FK fallthrough). Pinned by `tests/api/bowler-leagues-bootstrap.test.ts` |
| `PATCH /api/bowler-leagues/:id` | optional body `teamId` | `bowler_leagues.team_id` | `hasAccessToTeam(update.teamId)` returns false for missing -> 403 |
| `POST /api/payment-schedules` | body `bowlerId` / `leagueId` | `payment_schedules.*_id` | `hasAccessToBowler` / `hasAccessToLeague` deny missing -> 403 |
| `POST /api/payments` | body `leagueId` / `bowlerId` | `payments.league_id` / `payments.bowler_id` | League existence: existing 404. Bowler existence: added in #454 (returns 404 NOT_FOUND) |
| `PATCH /api/payments/:id` | none (no FK columns updatable) | n/a | n/a |
| `POST /api/leagues` | body `organizationId` (system_admin) / body `locationId` | `leagues.organization_id` / `leagues.location_id` | Existence + same-tenant for `locationId` added in #454 (404 NOT_FOUND). Org existence verified for both session-derived and override branches. Pinned by `tests/api/admin-fk-id-existence.test.ts` (#518: missing-org, missing-location, cross-tenant location) |
| `PATCH /api/leagues/:id` | body `organizationId` (system_admin) / body `locationId` | `leagues.organization_id` / `leagues.location_id` | Existence checks added in #454. Non-system-admin org change still 403s. Pinned by `tests/api/admin-fk-id-existence.test.ts` (#518: missing-org, missing-location, cross-tenant location) |
| `POST /api/locations` | body `organizationId` (system_admin) | `locations.organization_id` | Existence check added in #454. Non-system-admin pinned to session org. Pinned by `tests/api/admin-fk-id-existence.test.ts` (#518: missing-org via system_admin override) |
| `POST /api/org-admin/users/:id/add` | body `organizationId` (system_admin) | `users.organization_id` | Existence check added in #454. Org-admin branch reuses session org. Pinned by `tests/api/admin-fk-id-existence.test.ts` (#518: missing-org via system_admin override) |
| `POST /api/org-admin/users/create` | body `organizationId` (system_admin) / body `locationId` | `users.organization_id` / `users.location_id` | Existence + same-tenant checks added in #454. Pinned by `tests/api/admin-fk-id-existence.test.ts` (#518: missing-org, missing-location, cross-tenant location) |
| `PATCH /api/org-admin/users/:id/location` | body `locationId` | `users.location_id` | Existence + same-tenant check added in #454. Pinned by `tests/api/admin-fk-id-existence.test.ts` (#454) |
| `POST /api/system-admin/orphaned-data/:type/:id/reassign` | body `organizationId` | `leagues.organization_id` / `users.organization_id` | `assertOrgExists` in `server/storage/orphaned-data.ts` -> 404 (`OrphanRowNotFoundError`) |
| `PATCH /api/system-admin/users/:userId/admin-status` | none (id-from-row) | n/a | n/a |
| `POST /api/payments-provider/apple-pay/register-domain` | body `locationId` | n/a (read-only path; not inserted) | Existence + same-org check already present (`location.organizationId === req.user.organizationId`). Pinned by `tests/api/admin-fk-id-existence.test.ts` (#543: missing-location and cross-tenant location both collapse to the same 403 FORBIDDEN response) |

Routes not listed here either don't accept an admin-supplied id (the
id comes from the URL path and is validated against the row before
the FK is touched), or operate exclusively on session-derived ids
(`req.user.organizationId`, `req.user.id`) which can't point at a
missing row by construction.

## Reference implementation

Task #422 set the pattern in `server/routes/bowlers.ts`:

```ts
if (adminSuppliedOrgId !== undefined) {
  const targetOrg = await storage.getOrganization(adminSuppliedOrgId);
  if (!targetOrg) {
    return sendError(res, "Organization not found", 404, 'NOT_FOUND');
  }
}
```

Task #454 applied the same shape (storage existence call + clean 404)
to every gap in the table above, and added regression tests at
`tests/api/admin-fk-id-existence.test.ts` for the highest-blast-radius
routes (the new bowler-id check on `POST /api/payments` and the new
location-id check on `PATCH /api/organization-admin/users/:id/location`)
to prove the missing-id case never reaches the DB constraint.

## How to extend

When adding a new POST / PATCH route that accepts an admin-supplied
foreign-key id:

1. Add a row to the audit table above.
2. Add the existence check at the route boundary using the storage
   helper for the target table (`storage.getOrganization`,
   `storage.getLocation`, `storage.getBowler`, etc).
3. Return a clean 404 (`NOT_FOUND`) — never let the FK constraint
   serve as the user-visible error.
4. If the FK is tenant-scoped (e.g. a location id stamped onto a
   user/league row), additionally compare `row.organizationId` to
   the target org and conflate "missing" + "wrong tenant" into the
   same 404 to avoid an existence-oracle.

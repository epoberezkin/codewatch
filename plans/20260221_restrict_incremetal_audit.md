# 20260221_01: Restrict Incremental Audits to Project Owners

## Problem

Non-owners can run incremental audits on any project, leaking unpublished findings. Attack chain:

1. `POST /api/estimate` returns `previousAudit.id` to anyone (no auth/ownership check)
2. `POST /api/audit/start` accepts `baseAuditId` without verifying requester owns the project
3. `runAudit` inherits all open findings (titles, descriptions, exploitation paths, code snippets, CVSS scores) from the base audit into the attacker's new audit

This bypasses the three-tier responsible disclosure system entirely.

## Solution

Three changes, each blocking a link in the attack chain:

1. **`POST /api/estimate`**: Only include `previousAudit` when requester is a verified owner
2. **`POST /api/audit/start`**: Reject `baseAuditId` with 403 when requester is not owner; validate `baseAuditId` belongs to the same project
3. **Client `estimate.ts`**: Defensive guard — only show incremental toggle when `project.ownership?.isOwner`

## Detailed Technical Design

### Change A: `POST /api/estimate` — gate `previousAudit` behind ownership

**File**: `src/server/routes/api.ts` (L812-940)

Currently has zero session/ownership handling. Use the same optional-auth pattern as `GET /api/projects/:id` (L534-548):

After the `repos.length === 0` check at L835, insert:

```typescript
// Resolve ownership to gate previousAudit visibility
const { rows: projRow } = await pool.query(
  'SELECT github_org FROM projects WHERE id = $1', [projectId]
);
const githubOrg = projRow[0]?.github_org;
let isOwner = false;
if (githubOrg) {
  const session = await getSessionInfo(pool, req.cookies?.session);
  if (session) {
    try {
      const ownership = await resolveOwnership(
        pool, session.userId, githubOrg,
        session.githubUsername, session.githubToken, session.hasOrgScope,
      );
      isOwner = ownership.isOwner;
    } catch { /* ignore */ }
  }
}
```

At L926, change condition from `if (prevAudits.length > 0)` to:

```typescript
if (prevAudits.length > 0 && isOwner) {
```

### Change B: `POST /api/audit/start` — reject non-owner incremental

**File**: `src/server/routes/api.ts` (L1248-1319)

`isOwner` is already resolved at L1280-1284. After component validation (L1298), before the INSERT, add:

```typescript
if (baseAuditId && !isOwner) {
  res.status(403).json({ error: 'Only project owners can run incremental audits' });
  return;
}

if (baseAuditId) {
  const { rows: baseRows } = await pool.query(
    'SELECT id FROM audits WHERE id = $1 AND project_id = $2 AND status = \'completed\'',
    [baseAuditId, projectId]
  );
  if (baseRows.length === 0) {
    res.status(400).json({ error: 'Invalid base audit for this project' });
    return;
  }
}
```

The second check (defense in depth) validates `baseAuditId` belongs to the same project AND is completed.

### Change C: Client `estimate.ts` — defensive ownership guard

**File**: `src/client/estimate.ts` (L108)

Change:
```typescript
if (estimate.previousAudit) {
```
To:
```typescript
if (estimate.previousAudit && project.ownership?.isOwner) {
```

Server-side already omits `previousAudit` for non-owners, but this prevents incremental mode if a future code change accidentally re-exposes it.

## Implementation Plan

### Step 1: Server — `POST /api/estimate`
- Edit `src/server/routes/api.ts`
- Insert ownership resolution block after L835
- Add `&& isOwner` to the `previousAudit` condition at L926

### Step 2: Server — `POST /api/audit/start`
- Edit `src/server/routes/api.ts`
- Insert ownership + project-membership validation after L1298

### Step 3: Client
- Edit `src/client/estimate.ts` L108
- Add `&& project.ownership?.isOwner` to the condition

### Step 4: Build and verify
- `npm run build`

### Step 5: Documentation updates

**`product/rules.md`** — Add after RULE-38:

```
### RULE-39: Only project owners can run incremental audits
**Rule:** Incremental audits (with `baseAuditId`) require verified GitHub ownership.
`POST /api/estimate` omits `previousAudit` for non-owners. `POST /api/audit/start`
rejects `baseAuditId` with 403 for non-owners. `baseAuditId` must reference a completed
audit belonging to the same project.
**Enforced by:** ...
**Tested by:** `[UNTESTED]`
**Spec:** [product/flows/audit-lifecycle.md](./flows/audit-lifecycle.md)
```

**`spec/api.md`** — Update both endpoint tables:
- `POST /api/estimate`: Auth → "Optional (ownership gates `previousAudit` visibility)"; add `previousAudit` ownership note to Business logic
- `POST /api/audit/start`: Add Response (403) for non-owner incremental; add `baseAuditId` validation to Validation row

**`spec/client/estimate.md`** — Update `previousAudit` condition description

**`product/views/estimate.md`** — Section 2 "Previous Audit Notice": add "Only shown to project owners"

**`product/flows/audit-lifecycle.md`** — Add access control note to Step 0c

**`product/gaps.md`** — Remove any stale GAP about estimate auth if present; the endpoint now has optional auth for ownership

### Step 6: Update line number references
- All `#Lxx-Lyy` refs in `spec/api.md` for both endpoints shift after insertions
- `spec/client/estimate.md` line refs shift by 1 (one line changed)

### Step 7: Adversarial self-review
- Verify all three layers coherent
- Two consecutive clean passes

## Key Files

| File | Change |
|------|--------|
| `src/server/routes/api.ts` | Gate `previousAudit`, reject non-owner `baseAuditId`, validate project membership |
| `src/client/estimate.ts` | Defensive ownership guard on incremental toggle |
| `product/rules.md` | RULE-39 |
| `spec/api.md` | Endpoint table updates |
| `spec/client/estimate.md` | Condition update |
| `product/views/estimate.md` | Visibility note |
| `product/flows/audit-lifecycle.md` | Access control note |

## Verification

1. Build: `npm run build` succeeds
2. Manual test as owner: estimate page shows incremental toggle, can start incremental audit
3. Manual test as non-owner: estimate page does NOT show incremental toggle, `previousAudit` absent from response
4. Manual test: `POST /api/audit/start` with `baseAuditId` as non-owner returns 403
5. Manual test: `POST /api/audit/start` with `baseAuditId` pointing to different project returns 400

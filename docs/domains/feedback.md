# In-App Feedback → GitHub Issues

The floating "Feedback" button in the bottom-right corner posts directly to the GitHub repo's Issues. No third-party service, no email — straight from the app to the repo via GitHub App auth.

## Surface

| Component | Purpose |
|---|---|
| `FeedbackButton` (mounted in `_app.tsx`) | Floating button → opens modal → posts on submit |
| `pages/api/feedback/index.ts` | Receives `{ title, body, screenshot? }`, creates the Issue |
| `lib/githubApp.ts` | JWT generation, installation-token caching |

## Auth flow (GitHub App, not PAT)

GitHub Apps authenticate via a two-step dance:

1. **JWT** signed with the app's private key (RS256). Short-lived (10 min). Identifies the app itself.
2. **Installation token** obtained by calling `POST /app/installations/{id}/access_tokens` with the JWT. Lasts 1 hour, scoped to the installation.

We do all Issue creation with the installation token. The JWT is only used to fetch a fresh installation token.

`lib/githubApp.ts` caches the installation token until 5 minutes before expiry. Stale tokens fall back to a refetch automatically.

## Required env vars

| Var | Notes |
|---|---|
| `GITHUB_APP_ID` | Numeric app ID from GitHub Settings → Developer settings → GitHub Apps |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key with literal `\n` for newlines (or actual newlines, both work) |
| `GITHUB_INSTALLATION_ID` | Numeric installation ID — where the app is installed on this org |
| `GITHUB_REPO_OWNER` | Set per deployment (Settings or env); no built-in default -- the GitHub org/user that owns the feedback repo. |
| `GITHUB_REPO_NAME` | Set per deployment (Settings or env); no built-in default -- the repo feedback issues are filed into |

The owner/name defaults are overridable so a future repo transfer is a config change, not a code change.

## Request shape (verified 2026-05-20)

`POST /api/feedback` accepts:

| Field | Required | Notes |
|---|---|---|
| `category` | yes | One of `bug`, `data`, `enhancement`, `question` (drives label + title prefix) |
| `description` | yes | Free-text body |
| `area` | no | Optional sub-area string (shown in title) |
| `pageUrl` | no | URL the user was on (auto-captured by the button) |
| `userAgent` | no | Browser UA (used by `parseDevice()` to surface iPad/iPhone/Android/Mac/Windows) |

## Title format

`[Bug] {area}: {first 80 chars of description}` (or `[Data]`, `[Feature]`, `[Question]` per category). Fallback prefix `[Feedback]` if category is unrecognized.

## Issue body format

The auto-generated body is markdown:

```
**Reported by:** {session.user.email}
**Category:** {category}
**Area:** {area}        (only if provided)
**Page:** {pageUrl or "N/A"}
**Device:** {parsed device}   (only if UA matched a known device)

---

{description}
```

No screenshot handling in this endpoint. Screenshots are NOT part of the current implementation.

## Labeling

Verified label map (`LABEL_MAP` in source):

| category | labels |
|---|---|
| `bug` | `["bug"]` |
| `data` | `["data"]` |
| `enhancement` | `["enhancement"]` |
| `question` | `["question"]` |

Unknown category → no labels. The hardcoded `from-app` label I previously claimed does NOT exist in code.

## Rate limit

**No `rateLimit()` call in the feedback endpoint** (verified 2026-05-20). The endpoint relies on NextAuth session auth as the only gate. If feedback-spam ever becomes a real problem, add `rateLimit()` per the pattern in `lib/rateLimit.ts`.

## Fallback when GitHub App isn't configured

`isConfigured()` checks for the env vars. If they're missing, the endpoint returns **201 with `{ fallback: true, message: "Feedback recorded (GitHub App not configured)" }`** instead of creating an Issue. This is a no-op fallback — the feedback is silently dropped from the operator's perspective.

That's a soft failure path worth knowing about: dev environments without the GitHub App configured will accept feedback without creating Issues. Don't rely on the dev-side feedback button for any real triage.

## Verification checklist (before touching feedback code)

- [ ] If adding rate limiting, use `rateLimit()` from `lib/rateLimit.ts` with reasonable limits (e.g. 10/min per session)
- [ ] Installation-token cache survives token expiry (test by mocking the clock)
- [ ] When adding a new `category`, update `LABEL_MAP` + `prefixMap` + this runbook
- [ ] Issue body sanitization — user-submitted text should not be able to break out of the markdown via crafted strings (today's body is markdown — a malformed description COULD include header syntax that affects rendering, but doesn't escape the markdown context)
- [ ] `isConfigured()` fallback behavior — silent feedback drop on misconfigured envs is by design but worth re-confirming any change

## Test coverage

| Surface | Coverage |
|---|---|
| JWT signing + token caching | Unit tests TBD — **gap** |
| `pages/api/feedback/index.ts` end-to-end | None |
| Screenshot upload + secure path validation | Covered by `secureUpload.ts` tests |

## Known gaps

- The endpoint DOES return `{ issueNumber, url }` on success (verified), so the UI CAN show "Issue #N created" — confirm the FeedbackButton component actually surfaces this
- No moderation queue — every submission creates an Issue immediately
- No deduplication — submitting the same complaint twice creates two Issues
- No rate limit — see "Rate limit" section above
- No screenshot upload despite earlier doc claim; if added, use `lib/secureUpload.ts` pattern

## Related

- See `docs/domains/staff-auth.md` for role-aware context attached to Issue bodies
- See `docs/domains/portal.md` for the only other secret-bearing public-ish endpoint (different threat model)

---
Last verified: 2026-05-20

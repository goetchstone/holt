# Secrets & credentials

How Holt handles secrets, and the one rule that keeps backups safe. The model
is the industry-standard one (GitLab, Rails, KMS/Vault all do this shape): it is
not "DB vs env" — it is **ciphertext vs. the key**.

## Principle: ciphertext vs. key

> Encrypted secrets may live next to data (DB columns, encrypted files, even in
> backups). The **encryption key** is the sacred thing: it lives in the deploy
> environment / a secret manager, is **never** in a data backup, and is
> re-injected on every deploy. "Destroy & redeploy" works because you bring the
> deployment back with the same key from your secret store and the encrypted data
> decrypts again. Lose the key → rotate the underlying credentials.

## Two kinds of secrets

1. **Platform secrets** — the deployment's own: `DATABASE_URL`, `NEXTAUTH_SECRET`,
   `APP_ENCRYPTION_KEY`, the platform Stripe key, etc. One set per deployment.
   These live in **env / a secret manager**, injected at boot. Never stored in the
   DB, never in a data backup. (You cannot store the DB password in the DB.)
2. **Connected-account credentials** — a deployment's (or, later, a tenant's) own
   third-party accounts: Stripe, Google OAuth, SMTP, Mailchimp, Axper, Okta/Azure
   SSO. These are stored **encrypted in the DB** (`IntegrationCredential`, keyed by
   `organizationId`) and configured in **Settings → Integrations**. Multi-tenant
   requires this — there is no env var per tenant. This is exactly how B2B SaaS
   stores per-tenant SSO/connected accounts.

## How Holt implements it (today)

- **Crypto**: `lib/secretCrypto.ts` — AES-256-GCM, key derived (scrypt) from
  `APP_ENCRYPTION_KEY`. Random IV per value; the key is never persisted; only
  ciphertext is stored. `lastFour` keeps a masked tail for display.
- **Storage**: `IntegrationCredential.ciphertext` (per org, provider, field).
  GET returns masked entries only — plaintext is never read back to the client.
- **Resolution**: `resolveCredential(provider, field, envVar)` — **DB-first,
  env-fallback**. Used by Stripe / Mailchimp / SMTP / Axper / GitHub clients AND
  by the auth providers (Google / Okta / Azure via `buildAuthProvidersAsync`), so
  a key entered in the UI takes effect without a redeploy, while env still works
  for bootstrap.
- **Key custody**: `APP_ENCRYPTION_KEY` is **env-only** — it is never written to
  the DB and is never captured by `pg_dump`.

## The one rule

**Protect `APP_ENCRYPTION_KEY`. Inject it on every deploy from your secret store.
Never put it in a data backup/dump.** Everything else follows:

- A `pg_dump` data backup contains only **inert ciphertext** for connected-account
  secrets — safe to move, email, or restore without exposing anything, because the
  key is not in the dump. (This is why the 414 MB production migration backup is
  already secret-safe.)
- On a new / restored deployment, connected-account secrets are either re-entered
  in Settings or fall back to env — the "destroyed and redeployed" model.

## Backups (data) vs. secret backup (the key)

- **Data backup** (`pg_dump`): includes the encrypted `IntegrationCredential`
  rows. Fine — inert without the key.
- **Secret backup**: back up `APP_ENCRYPTION_KEY` (and the other platform env
  secrets) **separately** from the data, in your secret store — exactly like
  GitLab's `gitlab-secrets.json` is backed up apart from the data dump. Restoring
  data with a *different* `APP_ENCRYPTION_KEY` leaves connected-account ciphertext
  undecryptable (you'd just re-enter those keys — acceptable, that's the model).

## Real-world references (same pattern)

- **GitLab** — encrypted DB columns + keys in `gitlab-secrets.json`, backed up
  separately; data restore without it loses encrypted columns.
- **Rails** — `config/credentials.yml.enc` (encrypted, committable) +
  `RAILS_MASTER_KEY` (env, never committed).
- **AWS/GCP KMS, HashiCorp Vault** — envelope encryption; master key in KMS, app
  never holds it.

## Grade-up path (multi-tenant / production SaaS)

Same code shape, stronger key custody — do these when going true multi-tenant:

1. Move `APP_ENCRYPTION_KEY` from a plain env var into **KMS / Vault**.
2. **Envelope encryption**: a per-tenant data key, wrapped by a KMS master key, so
   one key never decrypts all tenants and rotation/audit come for free.
3. `secretCrypto` swaps its key source (KMS) without changing call sites.

# Rotate secrets

Every 90 days (data-hosting §3), and at once on any suspected leak. Type every secret in your own shell or the provider's
UI. Never in chat or files.

| Secret | Where it lives | How to rotate |
|---|---|---|
| `<schema>_svc` DB password | the service's Vercel env `DATABASE_URL` | `ADMIN_DATABASE_URL=… node infra/scripts/rotate-db-password.mjs <service>` prints the new password once. Update the Vercel env and redeploy the service. Old connections close on their own; new ones use the new password. |
| `<schema>_migrator` DB password | GitHub Actions secret of the service (migrations) | Same script with `migrator`. Update the GitHub secret. |
| Cron secret (`X-Cron-Secret`) | Vercel env `CRON_SECRET` of the service **and** Vault `cron_secret_<schema>` | `openssl rand -hex 32`. Set the Vercel env and redeploy, then re-run `configure-environment.mjs` with the same value. Between the two steps, scheduler calls get 401 (alarm `invoke-failed`); they catch up within a minute. |
| Service-token signing key (web) | web DB, encrypted with `WEB_KEK` | Automatic: web job `signing-key-rotate` (daily check, rotates at 90 days, old key kept 1 h in JWKS). Force it by rotating `WEB_KEK` only on a suspected leak (web LLD §4.2). |
| Service client credentials (`X-Service-Credential`) | caller's Vercel env + hash in web | Admin settings in web (issue new → update caller env → revoke old). |
| Supabase `service_role` key | web Vercel env (invites) and GitHub `SUPABASE_SERVICE_ROLE_KEY` (backups) | Supabase dashboard → API → roll the JWT secret / key. Update both places. |
| `BACKUP_PASSPHRASE` | GitHub secret | **Keep the old passphrase** until the last backup made with it expires (14 days), because restores need it. Store both in your password manager. |
| Hugging Face token | intake + insight Vercel env `HF_TOKEN` | huggingface.co → Access Tokens → create a new fine-grained token (Inference Providers only) → update env → delete the old token. |
| Google OAuth client secret | Supabase Auth → Google provider | Google Cloud console → Credentials → add secret → update Supabase → delete the old secret. |
| Website API keys (listings) | hashed in listings | Admin settings → API keys → rotate (grace period, then `api-key-expire` ends it). |
| Alarm webhook URL | Vault `alarm_webhook_url` | Regenerate in the chat tool, then re-run `configure-environment.mjs` with the new `ALARM_WEBHOOK_URL`. |

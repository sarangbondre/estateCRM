# Runbook: provisioning the pilot (done together after implementation)

The product owner decided (2026-09-27) to set up all cloud accounts and secrets **together, after implementation**. Until
then everything runs on the **local stack** (Supabase CLI in Docker + contract mocks). This runbook is the exact sequence for
that session. You do every step that involves signing in, passwords or secrets. Claude runs the rest.

> **Never paste passwords, tokens or secrets into the chat.** You type them into the dashboards, your terminal or
> Vercel's environment-variable screen yourself.

## 1. Supabase project (≈ 10 minutes)
1. Open **https://supabase.com** → **Start your project** → sign in (GitHub or email).
2. **New organization:** name `11 Estates`, type *Personal*, plan **Free**.
3. **New project:**
   - Name: `11e-crm-pilot`
   - Database password: click **Generate a password**, then **save it in your password manager** (you'll type it once in step 7)
   - Region: **South Asia (Mumbai)**, i.e. `ap-south-1`
   - Plan: Free → **Create new project**. Wait until the status is *Healthy* (1–2 minutes).
4. ✅ Done 2026-09-27: project ref **`xzizchbnejzxkhemmpie`**. (**Project Settings → General:** copy the **Reference ID** (about 20 lowercase letters). This is the *project ref*. It's
   not secret, so you can send it in chat.)
5. **Database → Extensions:** search for and check that **pgmq**, **pg_cron** and **pg_net** are in the list (don't enable
   them; our migration does). If any is missing, tell Claude, because it triggers a CR (data-hosting §7).
6. **Nothing is installed on your Mac.** The database is set up by the GitHub Actions workflow **deploy-database**:
   1. Supabase → **Connect** (top bar) → **Session pooler** (port 5432, IPv4). Copy the connection string and replace
      `[YOUR-PASSWORD]` with the database password from step 3. If the password has special characters, URL-encode them.
   2. GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**: name `SUPABASE_DB_URL`, value =
      that string. Don't send it in chat.
   3. GitHub → **Actions → deploy-database → Run workflow**, type `pilot`, then Run. It applies the platform setup (schemas,
      roles, extensions, queues, schedules, alarms, buckets), then every service's migrations, then the platform checks.
      Re-run it for each release that changes the database.
7. Service role passwords (one per service, for the Vercel `<SERVICE>_DATABASE_URL`): Claude gives you one SQL snippet
   for **Supabase → SQL Editor** (`alter role records_svc password '…'` × 7); you type the passwords in the browser.
8. Later, for sign-in (section 3): **Authentication → URL Configuration**:
   - Site URL: `https://crm.11estates.in`
   - Redirect URLs: `http://localhost:3000/auth/callback`, `https://*-sarangbondre.vercel.app/auth/callback`,
     `https://crm.11estates.in/auth/callback`

## 2. Vercel (personal account) (≈ 10 minutes). One project with Vercel Services (CR-013)
1. Open **https://vercel.com/signup** → **Continue with GitHub** (the `sarangbondre` account) → *Hobby* plan.
2. **Add New → Project → import `sarangbondre/estateCRM`**. Leave Root Directory at the repository root and the framework on
   auto. The root `vercel.json` defines everything: 7 services (`web`, `intake`, `records`, `journeys`, `crm-engine`,
   `listings`, `insight`), region `bom1`, pnpm 12, a 60 s limit, the bindings and the public routes. Enable Services (Beta) if
   the dashboard asks.
3. What is public (everything else is internal and reachable only through bindings):

   | Public path | Service | Used by |
   |---|---|---|
   | `/public/v1/{listings,projects,demand-posts,changes}…` | listings (`/public` stripped) | 11estates.in website, `X-Api-Key` |
   | `/svc/<service>/internal/v1/{relay,drain/…,jobs/…}`, `/svc/<service>/health/…` | that service (`/svc/<service>` stripped) | Supabase pg_cron scheduler, `X-Cron-Secret` |
   | everything else | web | staff app + gateway |

4. **Environment variables** (Project → Settings → Environment Variables, Production and Preview). You type the secrets;
   Claude gives you the list. Don't set the binding variables (`RECORDS_URL`, `INTAKE_URL`, `JOURNEYS_URL`, `LISTINGS_URL`,
   `WEB_URL`, `SVC_<SERVICE>_URL`): Vercel injects them. Per-service values use the service prefix, e.g.
   `RECORDS_DATABASE_URL`, `RECORDS_CRON_SECRET` (the services read `<SERVICE>_<NAME>` as well as the plain name).
   **Variables are shared by all 7 services in one project: never set a plain `DATABASE_URL`, `CRON_SECRET`, `POOL_MAX` or
   `SERVICE_CREDENTIAL`.** The plain name wins over the prefixed one, so one value would reach every service.
5. Offline check: `vercel build` of the whole services project succeeds (2026-09-30). `vercel dev -L` (beta) couldn't start
   all 7 services locally (its dependency installer crashes), so use `pnpm dev` locally. The first preview deployment is the
   routing test.

## 3. Google sign-in (≈ 10 minutes)
1. Open **https://console.cloud.google.com** → create a project `11 Estates CRM`.
2. **APIs & Services → OAuth consent screen:**
   - User type: **External** (or *Internal* if you use a Google Workspace domain)
   - App name: `11estates CRM`, support email: yours
   - While in testing, add your own Google account under *Test users*
3. **Credentials → Create credentials → OAuth client ID:**
   - Application type: **Web application**
   - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
4. Copy the **Client ID** and **Client secret** into **Supabase → Authentication → Providers → Google** → enable → Save.
   You do this in the dashboards, not in chat.
5. Sign in to the pilot once with your Google account. Claude then makes that user **Admin**. You can then invite others
   from *Settings → Users* in the app.

## 4. Hugging Face token (≈ 3 minutes)
1. Open **https://huggingface.co** → sign up or sign in.
2. **Settings → Access Tokens → Create new token → Fine-grained:**
   - Name `11e-crm-pilot`
   - Permission: **Make calls to Inference Providers** (nothing else)
3. Paste it into Vercel as `HF_TOKEN` in the **intake** and **insight** projects (Production and Preview). For local runs,
   put it in `services/intake/.env.local` and `services/insight/.env.local`, which are git-ignored.

## 5. Alarm destination (≈ 2 minutes, optional; CR-008)
Pick where alarm messages should go: any **incoming webhook** URL, such as a Slack or Google Chat space webhook, or an
email-relay webhook. Messages contain only service, queue and job names and numbers, never personal data. Keep the URL
ready for the session. **Don't paste it in chat**; you'll type it into the shell yourself.

## 6. After provisioning (Claude, with you at the keyboard for secrets)
- Apply the platform migrations (`supabase db push`) and run `infra/scripts/verify-platform.mjs` against the pilot.
  This covers extensions, roles, queues, isolation and the scheduler.
- Deploy all 7 services, then configure the scheduler and alarms. **You** type the secrets into your own shell; they
  are never written to a file:
  ```bash
  ADMIN_DATABASE_URL=… ENVIRONMENT_NAME=pilot RECORDS_BASE_URL=https://<your-domain>/svc/records RECORDS_CRON_SECRET=… (one pair per service; base URL = https://<your-domain>/svc/<service>) \
  ALARM_WEBHOOK_URL=… SCHEDULES=on node infra/scripts/configure-environment.mjs
  ```
  Each `<SERVICE>_CRON_SECRET` is the same value as that Vercel project's `CRON_SECRET`. Generate each one with
  `openssl rand -hex 32`.
- Import the anonymised extractor master (2,155 rows) and run the smoke tests and benchmarks (QA-02, QA-03).
- Report to you: the pilot URL, results, and anything left open.

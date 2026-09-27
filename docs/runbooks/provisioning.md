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
6. In your terminal, in the project folder:
   ```bash
   npx supabase@2 login
   ```
   A browser window opens. Approve it. The access token is stored on your Mac, not in the repo.
7. Tell Claude the project ref. Claude then runs `npx supabase@2 link --project-ref <ref>`. **When the terminal asks for
   the database password, you type it.** Claude then applies the bootstrap (schemas, roles, extensions, Data API
   exposure off) and the migrations.
8. Later, for sign-in (section 3): **Authentication → URL Configuration**:
   - Site URL: `https://crm.11estates.in`
   - Redirect URLs: `http://localhost:3000/auth/callback`, `https://*-sarangbondre.vercel.app/auth/callback`,
     `https://crm.11estates.in/auth/callback`

## 2. Vercel (personal account) (≈ 5 minutes)
1. Open **https://vercel.com/signup** → **Continue with GitHub** (the `sarangbondre` account) → *Hobby* plan.
2. In your terminal: `npx vercel@60 login` → approve in the browser.
3. **Account Settings → Tokens → Create:** name `terraform-11e-crm`, scope your personal account, expiry 90 days. Copy it
   into your terminal only: `export VERCEL_API_TOKEN=…` (or 1Password). Don't send it in chat.
4. Claude creates the 7 projects (`web`, `intake`, `records`, `journeys`, `crm-engine`, `listings`, `insight`) in region
   `bom1` with Terraform and links them to the GitHub repo.
5. **Environment variables** that you enter yourself in each project's *Settings → Environment Variables*, when Claude
   tells you which: the database passwords for each service role (Claude generates them into a local, git-ignored file,
   and you paste them), and `HF_TOKEN` (section 4).

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
  ADMIN_DATABASE_URL=… ENVIRONMENT_NAME=pilot RECORDS_BASE_URL=https://… RECORDS_CRON_SECRET=… (one pair per service) \
  ALARM_WEBHOOK_URL=… SCHEDULES=on node infra/scripts/configure-environment.mjs
  ```
  Each `<SERVICE>_CRON_SECRET` is the same value as that Vercel project's `CRON_SECRET`. Generate each one with
  `openssl rand -hex 32`.
- Import the anonymised extractor master (2,155 rows) and run the smoke tests and benchmarks (QA-02, QA-03).
- Report to you: the pilot URL, results, and anything left open.

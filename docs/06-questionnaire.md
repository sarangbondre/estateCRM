# Stage 6 questionnaire: everything to settle before Stage 7

| | |
|---|---|
| Date | 2026-09-27 |
| Purpose | The product owner asked for **all** open questions now, so that Stage 7 runs in parallel to delivery without stopping. Each item has a recommended default. |
| How to answer | Reply with the item numbers you want to change, and say "rest default". Items in **A** need something only you can provide or do. |

## A. Things only you can provide or do (these block the build)
| # | Needed | Why | Recommended way |
|---|---|---|---|
| A1 | **Make the GitHub repo `sarangbondre/estateCRM` private** | It's public. Pushing would publish the client's BRD, design, prototype and code. | Reply "make it private" and I'll run `gh repo edit --visibility private`, or change it in GitHub settings yourself. |
| A2 | **Vercel account** (Hobby) and CLI login | 7 projects must be created in `bom1` | Sign up, then run `npx vercel@60 login` in your terminal. I never type your password. Say whether projects go under your personal account or a team. |
| A3 | **Supabase project in Mumbai** | The database, queues, storage and auth | In the Supabase dashboard, create organisation "11 Estates" and project `11e-crm-pilot`, region **Mumbai (ap-south-1)**, Free plan. Keep the DB password in your password manager. Then run `npx supabase@2 login` in your terminal and tell me the **project ref**. I'll link it and handle everything after that. |
| A4 | **Google sign-in client** | Staff "Sign in with Google" | In Google Cloud console, create an OAuth client (Web). I'll give exact redirect URLs once A3 exists. Paste the client ID and secret into the Supabase dashboard (Auth → Google) yourself. |
| A5 | **Hugging Face token** | AI for classification and chat | Create a fine-grained token with "Make calls to Inference Providers". **Don't paste it in chat.** Add it yourself as `HF_TOKEN` in the Vercel projects `intake` and `insight` (I'll create them first), or put it in `.env.local` (git-ignored). |
| A6 | **Staff list + email domain** | Invites and roles (Q4-1: Workspace) | Names, Google emails and roles (Admin, Manager, Demand agent, Supply agent, Data operator). At least your own Admin account is needed for the pilot. Is there a Google Workspace domain (e.g. `@11estates.in`)? |
| A7 | **11 Estates MahaRERA agent registration number** | Shown on every listing (BRD §4.6) | The number itself. Until then, a placeholder that blocks publishing to Public. |
| A8 | **Company domain(s)** | Error URIs, future API host, website CORS | e.g. `11estates.in`, and the website domain(s) that will call the Listings API |
| A9 | **Sample files** (anonymised is fine) | (a) a **WhatsApp extractor** output (confirms the sender fields); (b) a **Meta / website lead-form export** (Digi mapping mode) | If none, I build against the 89-column schema and a generic lead-form mapping. Both are adjustable later. |
| A10 | **Brand** | UI look and proposal PDF | A logo file and colours, or "use the prototype look" |
| A11 | **Local tools on this Mac** | Node 24, pnpm 12, Terraform | Reply "install local tools" and I'll use Homebrew (`fnm` + Node 24, corepack pnpm, `terraform`). This changes only your user environment. |

## B. How Stage 7 runs without stopping (autonomy rules)
| # | Question | Recommended default |
|---|---|---|
| B1 | **Service approval gates** (`APPROVED: <service>` in CLAUDE.md) | I **don't wait**. After each service I post a short summary (what was built, test results, contract compliance) and continue. You can object at any time. The only hard stop is B2. |
| B2 | **Where "delivered" ends** | At the **working pilot**: QA-02 deploy + QA-03 benchmarks, with the anonymised real master loaded. The paid-plan gate (REL-01…03) means **buying plans**, which only you can do, so I stop there with a report. |
| B3 | **Design flaws found while building** | Technical fixes that don't change approved behaviour or contracts' meaning: I decide, write a short CR marked "auto-approved (technical)", and continue. Anything that would change a **business rule, scope or an approved contract's meaning**: I pick the option closest to the approved documents, continue, and list it for your review at delivery. |
| B4 | **Git workflow** | Branch per task (`task/<ID>-<slug>`), PR to `main`, and I **merge my own PR when CI is green** (no auto-merge setting). The current docs branch is merged first. |
| B5 | **AI credits run out** | Use the recorded intercepting mocks for tests. No spending. Real AI calls resume when credits reset. |
| B6 | **Parallelism** | Up to 3 service tracks at once after the Foundation track. Records starts first because the others consume its events. |
| B7 | **Progress updates** | A short message when each service completes, and one when blocked on section A. Nothing else. |

## C. Earlier questions you haven't answered (defaults already assumed)
| # | Question | Default in the documents |
|---|---|---|
| C1 | Q4-1: staff sign-in | Google Workspace accounts with 2-step enforced (depends on A6) |
| C2 | Q4-2: may Data operators export contact columns? | No |
| C3 | Q4-3: add "maybe" to proposal feedback? | Yes |
| C4 | Q4-4: pilot fake phone format | `+91 00000 xxxxx` |
| C5 | OQ-P10: may the supply team see the **client's name** on a matched demand? | Yes (all staff see all; contact views are audit-logged) |
| C6 | OQ-P9: calls per person per day / Dormant revisit / proposal link expiry | 40 / 60 days / 14 days |
| C7 | OQ-21: attribution and commission | First touch gets the credit. Commission is recorded as a note and % only (no calculation). |
| C8 | OQ-23: attempts before "unreachable" | 3 |
| C9 | OQ-13: chat test questions | The 13 in PRD Appendix A. Add any real questions your team asks. |
| C10 | Duplicate-match thresholds | Start with the LLD values and tune them on pilot data (QA-03) |
| C11 | Digi (lead-form) exports in mapping mode | Accept optional campaign/listing IDs, photo URLs and free text |
| C12 | Demand must-haves | Keys `parking` and `amenity:<name>` |
| C13 | Public description on the website | Generated from fields only in Phase 1 (no free text, so nothing private slips through) |
| C14 | Production throughput target | Keep 1,000 requests/second for the Listings API (checked at the paid gate) |
| C15 | Target launch date | None set. The plan runs as fast as the parallel tracks allow. |
| C16 | Mumbai micromarket hierarchy (zones → micromarkets → localities, adjacency) | I draft it from public knowledge. Vinit and Priyanka review in the pilot. |
| C17 | An owner who refuses to work with 11 Estates ("unwilling") | The offer is retired and the person is flagged "unwilling" |
| C18 | When the extractor re-splits an ad | CRM work stays on the first child record |
| C19 | Vinit's journeys artifact shows WhatsApp (n8n) and Meta webhooks | Still next phase (Phase 1 = file upload + manual entry) |

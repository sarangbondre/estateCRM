# Runbook: hosting on AWS (CR-018, option A)

The seven apps run on **ECS Fargate in Mumbai (`ap-south-1`)**. Supabase keeps the database, sign-in, file storage, queues
and the scheduler. Everything AWS is in `infra/aws/` (Terraform). It is built and deployed only by GitHub Actions through
a short-lived role, so nobody needs AWS access keys.

| Piece | Where |
|---|---|
| One-time bootstrap (state bucket, GitHub deploy role) | `infra/aws/bootstrap/bootstrap.yaml` (CloudFormation, uploaded once) |
| Network, registry, ECS, load balancer, certificate, secrets, alarms | `infra/aws/*.tf` → workflow **aws-infra** |
| Per-app settings: secret keys, environment, size | `infra/aws/apps.json` |
| Secrets from the pilot settings file | workflow **aws-secrets** (`infra/aws/sync-secrets.mjs`) |
| Build + deploy one app or all | workflow **aws-deploy** (image per commit SHA, rolling, automatic rollback) |

## First-time setup (in this order)

**Product owner (console and GitHub settings; nothing secret goes in chat)**
1. Create an AWS account and turn on MFA for the root user. Create an admin user in IAM Identity Center and use it from
   then on. Billing → Budgets: a monthly budget with an e-mail alert. Region: Asia Pacific (Mumbai) `ap-south-1`.
2. CloudFormation → Create stack → Upload `infra/aws/bootstrap/bootstrap.yaml`.
   - Stack name: `estatecrm-bootstrap`.
   - If the account already has the GitHub identity provider, set `CreateOidcProvider = false`.
   - Acknowledge IAM and create the stack. When it's done, open **Outputs**.
3. GitHub → repository → Settings:
   - **Environments → New environment `aws`**. Add yourself as a required reviewer, so every AWS run waits for your click.
   - **Secrets and variables → Actions → Variables:**
     - `AWS_DEPLOY_ROLE_ARN` = the `DeployRoleArn` output
     - `AWS_STATE_BUCKET` = the `StateBucket` output
     - `AWS_DOMAIN` = e.g. `crm.11estates.in`
     - `SUPABASE_URL` = `https://uflcrwgxiwqunhjsixdw.supabase.co`
     - `ALARM_EMAIL` (optional)
   - **Secrets:** `PILOT_ENV` holds the whole private pilot settings file. Claude can set it with
     `gh secret set PILOT_ENV < ~/estatecrm-pilot-secrets.txt`, and the values are never shown. `HF_TOKEN` already exists.
4. Supabase: upgrade the project to **Pro** before commercial use.

**Then the rollout (Claude runs the workflows; you approve each run in the `aws` environment)**
5. **aws-infra**, action `apply`, launch off. This creates the network, registry, secrets and load balancer, and requests
   the certificate. The run summary shows `certificate_validation` (a CNAME record) and `load_balancer_dns`.
6. At the domain's DNS provider, add the **certificate CNAME**. The domain itself isn't switched yet.
7. **aws-secrets** with `pilot` writes the seven app secrets (only key names appear in the log).
8. **aws-deploy** with `all` builds and pushes the seven images. Nothing runs yet.
9. **aws-infra**, action `apply`, launch on. This issues the certificate (it waits for the DNS record), then creates
   HTTPS, the path rules and the services (2 tasks each, autoscaling to 4).
10. Test before switching. Point a hosts-file entry, or a temporary record such as `aws.<domain>`, at the load balancer.
    Then check `/health/ready` on web and `/svc/<svc>/health/ready` on each service, sign in, and run a sample upload.
11. **Cutover:**
    1. At the DNS provider, point `AWS_DOMAIN` at `load_balancer_dns` (CNAME).
    2. In Google Cloud OAuth (authorised origins and redirect) and Supabase → Auth → URL configuration, add
       `https://<domain>` and `https://<domain>/auth/callback`.
    3. Run **configure-scheduler** with `domain = <domain>`.
    4. Set the repository variable `AWS_AUTO_DEPLOY = on`.
    5. Keep Vercel for a week as the fallback, then remove the project.

## Day to day
- **Deploy:** every push to main deploys the apps (with `AWS_AUTO_DEPLOY = on`). To deploy by hand, run **aws-deploy**
  with one app.
- **Change a setting:**
  - a secret: update the settings file → `gh secret set PILOT_ENV` → **aws-secrets** → **aws-deploy** for the apps
    affected;
  - plain config: edit `apps.json` → **aws-infra** apply → **aws-deploy** for the apps affected.
- **Roll back:** run **aws-deploy** for the app from an older commit (Actions → the earlier run → Re-run). ECS also rolls
  back by itself when the new tasks fail their health checks.
- **Logs:** CloudWatch → Log groups → `/estatecrm/pilot/<app>`. Alarms go to `ALARM_EMAIL`.

## Notes
- The deploy role has administrator rights, because Terraform creates IAM roles and networks. Only this repository's
  `aws` environment can use it, and a required reviewer approves every run.
- The tasks reach Supabase over TLS through one fixed NAT IP (output `nat_egress_ip`). Supabase network restrictions can
  allow-list it.
- On AWS the gateway's cold-start allowance (CR-014) is 0, because `VERCEL` isn't set.

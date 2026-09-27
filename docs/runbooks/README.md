# Runbooks

| Runbook | When |
|---|---|
| [provisioning.md](provisioning.md) | Creating an environment (pilot now; staging/production after the paid gate) |
| [deploy.md](deploy.md) | Shipping a service |
| [rollback.md](rollback.md) | A deploy made things worse |
| [rotate-secrets.md](rotate-secrets.md) | Every 90 days, and on any suspected leak |
| [dlq-replay.md](dlq-replay.md) | A `dlq-depth` alarm fired |
| [restore.md](restore.md) | Data loss or corruption; the monthly restore check failed |

Rules that apply to all of them: never paste secrets into chat, tickets or commits; type them in your own shell. Logs and
alarm payloads never contain personal data. Every manual step that changes an environment is written down in the
incident or change note (what, when, who, why).

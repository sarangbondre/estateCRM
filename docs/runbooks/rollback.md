# Roll back a deploy

1. **Code:** in Vercel, open the service's project → Deployments → the last good deployment → **Promote to Production**
   (or `vercel rollback <deployment-url>`). The other services are untouched.
2. **Database:** migrations are forward-only and backward compatible (expand → migrate → contract), so the previous
   code runs against the new schema. **Don't** reverse a migration by hand. If a migration itself is wrong, write a new
   forward migration that fixes it.
3. **Stop the scheduler for that service if its relay/drains are failing hard** (it stops alarm noise and retries):
   `update platform.service_endpoints set enabled = false where service = '<service>';`
   Messages wait in the queues and outboxes; nothing is lost. Re-enable when healthy.
4. **Events already published by the bad version** stay valid only if they match the contract. If a consumer
   dead-lettered them, fix the consumer and replay (dlq-replay.md).
5. Write down what happened and open an issue for the fix.

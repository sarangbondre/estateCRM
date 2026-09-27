# DLQ replay

A `dlq-depth` alarm means a message was read more than 5 times without success, or couldn't be handled at all
(`invalid-envelope`, `no-handler`), and was moved to `<queue>_dlq`. The service keeps working; only that message waits.

1. **See what's there** (message bodies are never printed; they may contain PII):
   ```bash
   ADMIN_DATABASE_URL=… node infra/scripts/dlq.mjs list
   ADMIN_DATABASE_URL=… node infra/scripts/dlq.mjs show q_<service>
   ```
2. **Find the cause.** Search the consumer's logs by `eventId` / `correlationId`:
   - `no-handler` / `invalid-envelope`: a contract mismatch. Deploy a consumer that handles it. Don't replay before that.
   - `max-attempts`: the handler kept failing (a bug, a dependency that was down, or data it can't process). Fix or
     wait for the dependency.
3. **Replay** after the fix. Consumers are idempotent (processed_events), so replaying is safe:
   ```bash
   ADMIN_DATABASE_URL=… node infra/scripts/dlq.mjs replay q_<service>          # dry run
   ADMIN_DATABASE_URL=… node infra/scripts/dlq.mjs replay q_<service> --yes    # move them back
   ```
   The next drain (≤ 1 min) processes them. The alarm resolves on its own when the DLQ is empty.
4. If a message must be **dropped** (it will never be valid), write down why, then delete it:
   `select pgmq.delete('q_<service>_dlq', <msg_id>);`

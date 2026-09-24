Explore any idea through structured dialogue before committing to anything.

Use this to think through a concept, technical direction, product decision, or architecture question. **Nothing gets written to disk.** The output is a clear, structured summary you can act on.

When you're ready to turn the result into a project, run `/start-project` — it **founds** the project: authors the charter, principles, success criteria, and roadmap from this brainstorm and plans Phase 0. It works whether or not `momentum init` has already scaffolded the machinery (structure ≠ content — see `core/project-lifecycle.md`). To turn a decision into an ADR, run `/log` with `--decision`.

## When to use

- You have a vague idea and want to think it through
- You're weighing technical options and need to reason carefully
- You want to explore a product direction before committing to building it
- You're considering a significant architecture or process change

---

## Steps

0. **Enter the brainstorm gate**:
   ```bash
   mkdir -p .momentum && touch .momentum/brainstorm-active
   ```
   While this sentinel exists, the PreToolUse hook (`core/scripts/brainstorm-gate.sh`, wired by Claude Code + Codex + Antigravity) blocks any write-class tool call to `specs/`. This command should not write to disk at all — the sentinel guards against accidental scratch-file leakage (e.g., a stray `specs/decisions/draft.md`).

1. Ask one question at a time to understand the idea:
   - What is the core problem or opportunity?
   - Who is this for? (user, system, team)
   - What are the 2–3 options or directions worth exploring?
   - What constraints matter most? (time, cost, complexity, reversibility)
   - What does success look like?

2. After understanding the idea, reflect back a structured summary **in the chat** (no file):

   ```
   ## Idea Summary

   **Problem**: ...
   **Options explored**: ...
   **Key constraints**: ...
   **Recommendation**: ...
   **Open questions**: ...
   ```

3. Ask: "Does this capture it? Anything to refine?"

4. Iterate until the idea is clear.

4b. **Config discovery** — once the idea is settled, gather the
    project-shape config that `/start-project` will author into
    `specs/config.md` (ADR-0009). Ask one question at a time; if the
    user is unsure, suggest a default from the idea's context:
    - **Git forge**: "Which forge? GitHub / GitLab / Bitbucket / Gitea /
      Forgejo / bare-ssh?" (default from `git remote get-url origin` if a
      repo exists, else GitHub)
    - **Language + framework**: "What language/framework? Node+Next.js /
      Python+FastAPI / Rust+Actix / Go / …?" (default from manifests if a
      repo exists, else ask)
    - **Publish/deploy target**: "How does this ship? npm publish / pypi /
      crates.io / deploy-only (Vercel/Fly/…) / none?" (sets `publish_target`
      + `release_flow`)
    - **Branch flow**: "How do changes land? feature → staging → main /
      feature → main / feature-branch-only?" (sets `branch_flow` +
      `end_state`; default `feature → staging → main`)
    Carry the settled config as context into `/start-project` so it
    authors `specs/config.md` alongside the charter/roadmap in one batch.

5. **Exit the brainstorm gate** before any follow-up command:
   ```bash
   rm .momentum/brainstorm-active
   ```

6. Close with one of:
   - "Ready to build this? Run `/start-project` to found the project — it authors the foundation docs (charter, principles, success criteria, roadmap) from this brainstorm and plans Phase 0. An existing `momentum init` scaffold doesn't change this: init owns structure, founding owns content."
   - "Want to explore further before committing? Ask away."
   - "This is a decision, not a project — want to log it as an ADR with `/log --decision`?"

---

## Brainstorm Gate Contract

This command runs in two phases: **brainstorm** (conversational, no disk writes) and **commit** (writes files to disk on explicit approval).

### Sentinel-driven enforcement

A file `.momentum/brainstorm-active` exists for the lifetime of the brainstorm phase. While it exists, the `brainstorm-gate.sh` PreToolUse hook (shared across Claude Code, Codex, and Antigravity) blocks any write-class tool call whose target lives under `specs/`. The hook is the safety net; the discipline below is the primary contract.

For `/brainstorm-idea` specifically, there is no "commit phase" — this command never writes phase or spec files. The gate exists to prevent accidental scratch files from appearing under `specs/` during open-ended exploration. The sentinel is removed when the user picks a direction (or exits the conversation) so the follow-up command (`/start-project`, `/log`, etc.) starts clean.

### Sequence

1. **Enter brainstorm** — `mkdir -p .momentum && touch .momentum/brainstorm-active`
2. **Draft in conversation only** — the idea summary lives in chat, not a file. NEVER call `Write`/`Edit`/`MultiEdit` on `specs/` paths during this phase.
3. **User picks a direction** — the next step is a different command, not a file write.
4. **Exit brainstorm before that command** — `rm .momentum/brainstorm-active`.

### Red flags — STOP and stay in conversation

| If you find yourself thinking… | …STOP and stay in conversation |
|---|---|
| "I'll save the idea summary to a file so we don't lose it" | The user is the one who decides if it's worth saving. Keep it in chat; let them pick the destination (`/log --decision`, `/start-project`, etc.). |
| "I'll create `specs/ideas/foo.md` as a scratch file" | This command has no scratch files. The hook will block. |
| "The brainstorm session is going long; I'll dump notes to disk for safekeeping" | Long conversations are normal; chat is durable. |

### Anti-rationalization counters

- "It's just a note, not a real spec" — the hook can't tell a note from a spec; the discipline is consistent across all three brainstorm commands.
- "The user might forget the conclusion" — summarize in chat; they can copy if they want.
- "Other commands need this content" — they'll get it from the conversation context.

---

## Key Principles

- One question at a time — don't overwhelm
- No files written during brainstorming — this is thinking, not building
- The summary is the deliverable — concise, clear, actionable
- Stay generic — works for software, process, product, or architecture ideas
- **Brainstorm Gate**: see the contract above. No writes during the session.

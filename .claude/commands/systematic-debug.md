Systematically isolate, reproduce, and resolve task execution failures.

This recipe enforces the **3-strikes systematic debugging/retry budget** defined under the Autonomous Execution Contract. If validation fails for a task, execute the strikes sequentially:

---

## Strike 1 — Analyze and Adjust

1.  **Analyze validation output**: Look closely at the stdout/stderr, stack trace, and exit code.
2.  **Hypothesize the cause**: Identify if the failure is due to a simple syntax error, a missing import, incorrect pathing, or a basic logical gap.
3.  **Adjust**: Implement the simple correction directly.
4.  **Re-run validation**: Execute the group's verification command.
    *   *Passes* → Check task `[x]` and proceed.
    *   *Fails* → Proceed to **Strike 2**.

---

## Strike 2 — Reproduce and Isolate

1.  **Write reproduction test**: Create a minimal unit test or a temporary scratch script that isolates the failing code path and reproduces the exact failure.
2.  **Run isolation**: Run the reproduction case to confirm it fails in isolation.
3.  **Implement isolation fix**: Fix the code under the reproduced test case.
4.  **Verify isolation**: Confirm the reproduction case now passes.
5.  **Re-run validation**: Execute the main group verification command.
    *   *Passes* → Check task `[x]` and proceed. Clean up any temporary scratch scripts.
    *   *Fails* → Proceed to **Strike 3**.

---

## Strike 3 — Re-Read and Reframe

1.  **Re-read specs**: Completely stop coding. Re-read:
    *   `specs/status.md` (to check active context)
    *   `specs/phases/phase-N-*/overview.md` (to re-read goals and deliverables)
    *   `specs/phases/phase-N-*/plan.md` (to review architectural choices)
2.  **Identify gaps**: Figure out if the implementation approach is fundamentally incompatible with a spec constraint.
3.  **Reframe**: Redesign the approach to align with specs.
4.  **Draft proposed change**: Discuss the re-framed approach with the user in conversation. Do not write changes to specs.
5.  **Obtain Approval**: Wait for user review before implementing the reframed code.

---

## See Also

*   **Rule 12 (Verify Before Claim)**: Always run the actual verification command and capture output.
*   **start-phase**: Automates end-to-end execution utilizing this debugging recipe on task failures.

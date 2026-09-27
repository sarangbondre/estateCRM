Review and groom the backlog between phases.

## Steps

1. Read `specs/status.md` and `specs/backlog/backlog.md`

2. For each category, assess:
   - Are priorities still accurate?
   - Should items move to active/next phase?
   - Are any items resolved or deprecated?
   - Orphaned items without a phase?

3. Check for dependencies:
   - P0 bugs blocking progress
   - Features depending on unresolved tech debt
   - Items open 3+ months without progress

4. Update `specs/backlog/backlog.md` with changes

5. Update `specs/status.md` if blockers changed

6. Commit:
   ```bash
   git add specs/
   git commit -m "docs(backlog): grooming for Phase N"
   ```

7. Report:
   - Total open items by type and priority
   - P0/P1 items requiring attention
   - Recommended actions

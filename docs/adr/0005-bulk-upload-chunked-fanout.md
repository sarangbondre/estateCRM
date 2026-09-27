# ADR-0005: Large uploads: direct-to-storage + chunked fan-out

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24

## Context
Files have up to 150k rows / 50 MB. The target is 100k rows in ≤ 30 min, 10 files/day. Vercel functions are time-limited
(≤ 800 s).

## Options
1. **Browser uploads straight to Storage (signed URL). A split function streams the file into chunks (pgmq messages): **500 rows on
   the free pilot** (Hobby function limits), 2,000 rows on paid plans. Up to 20 chunk functions run in parallel (5 on the pilot). A completion tracker emits `upload.completed.v1`.**
2. Parse in one long function. Fails on large files and time limits.
3. Browser-side parsing. Unreliable for 50 MB Excel files on slower machines, and harder to audit.

## Decision
Option 1.
- The split function streams the file: CSV line by line, and xlsx with a streaming reader.
- Each chunk is idempotent: its key is upload_id + chunk_no.
- Progress per stage is stored on the upload row.

## Consequences
- Expected time for 100k rows on paid plans is about 3–8 minutes, well inside M2. The pilot caps files at 20k rows (CR-005).
- The concurrency cap protects the database connection pool (Supavisor) and the LLM rate limits.
- The chunk and progress model becomes part of the intake LLD.

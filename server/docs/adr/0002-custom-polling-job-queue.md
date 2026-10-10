# Background work runs on a custom Postgres-polling worker

Background jobs (SBOM processing, vulnerability scans, scheduled scans) are stored in a `jobs` table and processed by a custom worker (`worker.ts`) that polls Postgres, rather than a dedicated queue like Redis/BullMQ or SQS. This avoids adding a second piece of infrastructure: the job state, retries, priority, and scheduling all live in the same database as the application data, and the worker runs as a separate process alongside the API.

## Consequences

- No extra broker to operate, and jobs are transactional with application data.
- Throughput is bounded by polling, not push delivery; if job volume outgrows this, revisit before reaching for a hosted queue.
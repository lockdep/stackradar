-- The community edition stores its scanner key at start-up from
-- `BOOTSTRAP_CLUSTER_API_KEY` (`services/default-org.service.ts`), before any
-- user exists, so the row has nobody to name as its creator. `created_by`
-- stays audit metadata and never an acting identity; null means "the server
-- itself, at boot". Every request path still writes a user id. Forward-only
-- and safe on a populated database: existing rows keep their values.
ALTER TABLE "api_keys" ALTER COLUMN "created_by" DROP NOT NULL;
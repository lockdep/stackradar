-- Which OSV directories the live generation was built from (open-source plan
-- step 06, `OSV_ECOSYSTEMS`). Null means the whole corpus, which is what every
-- existing row means: the cloud bootstraps from the global all.zip. Written by
-- the bootstrap that publishes a generation; read by `--bootstrap-if-needed`
-- to notice a widened scope. Additive and safe on a populated database.
ALTER TABLE "osv_sync_state" ADD COLUMN "ecosystems" jsonb;
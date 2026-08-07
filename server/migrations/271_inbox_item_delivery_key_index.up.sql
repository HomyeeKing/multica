-- Single statement: CREATE UNIQUE INDEX CONCURRENTLY cannot run inside a
-- transaction or share a multi-command migration file.
--
-- Idempotency for new deliveries. PARTIAL on delivery_key IS NOT NULL because
-- every pre-existing row has NULL there: a plain unique index would be
-- satisfied by them (Postgres treats NULLs as distinct) but would also index
-- the entire history for nothing. The partial index covers only rows written
-- after the write gate opens, which are the only ones that can collide.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS inbox_item_delivery_key_uidx
    ON inbox_item (delivery_key) WHERE delivery_key IS NOT NULL;

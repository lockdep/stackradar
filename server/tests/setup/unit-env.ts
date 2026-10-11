/**
 * The environment every test file runs under, DB aside. Shared by the
 * Testcontainers setup (`test-db.ts`, which then points DATABASE_URL at the
 * container) and the unit setup (`unit-setup.ts`, which never starts one):
 * `config/index.ts` snapshots the environment at import, so both have to land
 * these before any `src/` module is evaluated, and they must agree or a unit
 * test and an integration test of the same module see different editions.
 */
export function exportUnitTestEnv(): void {
    process.env.INTERNAL_SERVICE_KEY = "test-internal-key-12345";
    process.env.NODE_ENV = "test";
    // The cloud is the superset of the surface, so it is what the suite runs
    // as unless told otherwise; `STACKRADAR_EDITION=community pnpm test` runs
    // the community edition and the cloud-only suites skip themselves.
    process.env.STACKRADAR_EDITION = process.env.STACKRADAR_EDITION || "cloud";
    // Stripe keys must be non-empty so config doesn't throw; Stripe is mocked in billing tests
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_fake";
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "whsec_test_fake";
    // A fixed vault key so minted keys are revealable in tests; the vault
    // unit test constructs its own vaults and does not depend on this one.
    process.env.API_KEY_ENCRYPTION_KEY =
        process.env.API_KEY_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    // A unit test must never reach a database. postgres.js opens its pool
    // lazily, so a URL nothing listens on is a hard, immediate failure the
    // moment a "unit" test issues a query — which is the signal that the file
    // belongs under tests/integration.
    process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:1/unit?sslmode=prefer";
}

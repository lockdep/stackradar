import {
    pgSchema,
    uuid,
    varchar,
    text,
    timestamp,
    integer,
    boolean,
    primaryKey,
    uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Auth.js schema — the client owns only authentication. Business data
 * (organizations, clusters, images, …) is the server's.
 *
 * These four tables live in the Postgres schema **`auth`** inside the
 * server's database rather than in a database of their own: a self-hoster supplies one connection string, and
 * both apps read the same `DATABASE_URL`. The server has a `public.users`
 * of its own (mirrored by id), so `public` was never an option here; the
 * schema is also where this app's Drizzle journal lives
 * (`auth.__drizzle_migrations`, see `drizzle.config.ts`), so the two chains
 * never collide. Nothing in the server's Drizzle project knows about
 * `auth`, and nothing here may reference `public`.
 */
export const authSchema = pgSchema('auth');

/**
 * Users table - managed by Auth.js
 *
 * Email uniqueness is enforced case-insensitively via a functional unique
 * index on `LOWER(email)`, mirroring the server's `users` table. Emails are
 * case-insensitive per RFC 5321, so a plain unique constraint would let
 * "Foo@example.com" and "foo@example.com" coexist here while the server
 * collapses them into one identity.
 */
export const users = authSchema.table(
    'users',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        name: varchar('name', { length: 255 }),
        email: varchar('email', { length: 255 }).notNull(),
        emailVerified: timestamp('email_verified', { withTimezone: true }),
        image: text('image'),
        isAdmin: boolean('is_admin').notNull().default(false),
        /**
         * The live demo's shared visitor account.
         * `/demo/enter` mints sessions only for a row flagged here, so a
         * mis-set `DEMO_USER_EMAIL` cannot hand out sessions for a real account.
         * Mirrors `users.demo` on the server, which enforces read-only; this
         * flag only decides who may be signed in without an OAuth round trip.
         */
        demo: boolean('demo').notNull().default(false),
        /**
         * Local username/password sign-in. Null for every account that signs in through a provider
         * (GitHub, Google, OIDC): those never get a hash. Argon2id PHC string,
         * written only by `lib/password.ts`.
         */
        passwordHash: text('password_hash'),
        /**
         * Set on the bootstrap admin and on every admin-set password: the only
         * page the session may reach is `/account/password` until it is cleared
         * (`proxy.ts`). Meaningless without a hash.
         */
        mustChangePassword: boolean('must_change_password').notNull().default(false),
        /** Consecutive failed local logins; reset on success and when a lock is placed. */
        failedLogins: integer('failed_logins').notNull().default(0),
        /** While in the future, local sign-in is refused without checking the password. */
        lockedUntil: timestamp('locked_until', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [uniqueIndex('users_email_lower_unique').on(sql`LOWER(${table.email})`)],
);

/**
 * Accounts table - OAuth provider links
 */
export const accounts = authSchema.table(
    'accounts',
    {
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        type: varchar('type', { length: 255 }).notNull(),
        provider: varchar('provider', { length: 255 }).notNull(),
        providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
        refresh_token: text('refresh_token'),
        access_token: text('access_token'),
        expires_at: integer('expires_at'),
        token_type: varchar('token_type', { length: 255 }),
        scope: varchar('scope', { length: 255 }),
        id_token: text('id_token'),
        session_state: varchar('session_state', { length: 255 }),
    },
    (table) => [primaryKey({ columns: [table.provider, table.providerAccountId] })],
);

/**
 * Sessions table - database-backed sessions
 */
export const sessions = authSchema.table('sessions', {
    sessionToken: varchar('session_token', { length: 255 }).primaryKey(),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
});

/**
 * Verification tokens - for email verification
 */
export const verificationTokens = authSchema.table(
    'verification_tokens',
    {
        identifier: varchar('identifier', { length: 255 }).notNull(),
        token: varchar('token', { length: 255 }).notNull(),
        expires: timestamp('expires', { withTimezone: true }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.identifier, table.token] })],
);

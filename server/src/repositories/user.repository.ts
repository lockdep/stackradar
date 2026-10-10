import { sql, eq, getTableColumns } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, type User } from "../db/schema/index.js";

export const userRepository = {
    /**
     * Whether the user is the shared demo visitor (`users.demo`). Called by
     * `requireAuth` on every non-read internal request; a primary-key probe
     * of one boolean. A missing row is not a demo user.
     */
    async isDemoUser(userId: string): Promise<boolean> {
        const [row] = await db
            .select({ demo: users.demo })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        return row?.demo === true;
    },

    async getUserById(userId: string): Promise<User | null> {
        const [user] = await db
            .select()
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        return user || null;
    },

    /**
     * Get user by email (case-insensitive).
     *
     * Matches the `users_email_lower_unique` functional index so the lookup is
     * indexed regardless of how the caller cased the input. See
     * docs/db-audit/P3-polish.md § P3-1.
     */
    async getUserByEmail(email: string): Promise<User | null> {
        const [user] = await db
            .select()
            .from(users)
            .where(sql`LOWER(${users.email}) = LOWER(${email})`)
            .limit(1);

        return user || null;
    },

    /**
     * Ensure a user exists in the server database
     * This syncs user data from the Auth.js client database
     * Uses upsert to handle both new and existing users
     *
     * Email is normalized to lowercase before persisting so the case-insensitive
     * unique index can never be tripped by a provider that returns mixed-case
     * addresses. See docs/db-audit/P3-polish.md § P3-1.
     */
    async ensureUserExists(userData: {
        id: string;
        email: string;
        name: string | null;
    }): Promise<User & { isNew: boolean }> {
        const normalizedEmail = userData.email.toLowerCase();

        const [row] = await db
            .insert(users)
            .values({
                id: userData.id,
                email: normalizedEmail,
                name: userData.name,
            })
            .onConflictDoUpdate({
                target: users.id,
                set: {
                    email: normalizedEmail,
                    name: userData.name,
                },
            })
            .returning({
                ...getTableColumns(users),
                // Postgres sets xmax on a row touched by ON CONFLICT DO UPDATE
                // and leaves it 0 on a fresh insert — the standard way to tell
                // "inserted" from "updated" in a single upsert. Callers use it
                // to send the welcome email exactly once.
                isNew: sql<boolean>`(xmax = 0)`,
            });

        if (!row) {
            throw new Error("Failed to ensure user exists");
        }

        return row;
    },
};

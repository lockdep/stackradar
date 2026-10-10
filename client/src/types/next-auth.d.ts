import type { DefaultSession } from "next-auth"

/**
 * Auth.js module augmentation.
 *
 * `isAdmin` and `mustChangePassword` are read off the users table by the
 * `session` callback in `src/auth.ts`; they are optional on `User` (the
 * adapter's row type) and always present on `Session` (the callback
 * defaults both to `false`). `mustChangePassword` is the local-login gate
 * `proxy.ts` enforces (step 04 of the open-source plan): while it is set,
 * the only page the session may reach is `/account/password`.
 *
 * The `import` above is load-bearing: it makes this file a module, so the
 * block below augments Auth.js' types instead of replacing them.
 */
declare module "next-auth" {
  interface User {
    isAdmin?: boolean
    mustChangePassword?: boolean
  }

  interface Session {
    user: {
      id: string
      isAdmin: boolean
      mustChangePassword: boolean
    } & DefaultSession["user"]
  }
}

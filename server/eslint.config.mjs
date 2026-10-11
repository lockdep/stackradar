import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Type-unaware linting, the same level the client runs at: the recommended
 * rule sets and nothing that needs a type-checker (that is `tsc`'s job and
 * `pnpm typecheck` runs it). Rules switched off below each name the house
 * style they would fight.
 */
export default tseslint.config(
    { ignores: ["dist/**", "drizzle/**", "coverage/**", "node_modules/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: { globals: { ...globals.node } },
        rules: {
            // `_req`, `_res`, `_unused` are how an Express signature says a parameter is deliberately ignored.
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                    // `const { rawJson, ...cols } = getTableColumns(t)` is how a column is left out of a select.
                    ignoreRestSiblings: true,
                },
            ],
            // `declare global { namespace Express { … } }` is the only way to extend `Request`.
            "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
        },
    },
);

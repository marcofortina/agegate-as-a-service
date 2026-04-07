// eslint.config.mjs
import { defineConfig } from "eslint/config";
import jest from "eslint-plugin-jest";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

export default defineConfig([
    {
        extends: compat.extends("eslint:recommended", "prettier"),

        plugins: {
            jest,
        },

        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest,
            },
            ecmaVersion: "latest",
            sourceType: "module",
        },

        rules: {
            "no-console": "off",
            "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
            "jest/no-disabled-tests": "warn",
            "jest/no-focused-tests": "error",
            "jest/no-identical-title": "error",
            "jest/prefer-expect-assertions": "off",
        },
    },
    {
        files: ["agegate-sdk.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                AgeGate: "readonly",
            }
        }
    }
]);

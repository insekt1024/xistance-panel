import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    rules: {
      "@next/next/no-html-link-for-pages": ["off"],
    },
  },
  ...nextVitals,
  ...nextTs,
  {
    files: ["apps/web/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "@next/next/no-html-link-for-pages": ["error", "apps/web/app"],
    },
  },
  {
    files: ["packages/**/*.ts"],
    ...tseslint.configs.recommended[0],
  },
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    "**/node_modules/**",
    "**/generated/**",
    "**/dist/**",
    "**/.data/**",
    "**/tunnels/**",
    "**/*.db",
  ]),
]);

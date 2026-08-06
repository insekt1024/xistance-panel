<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# xistance-panel

Next.js **16.3.0** + React 19 App Router starter. Follow the rules above before writing code.

## Commands

- `npm run dev` — dev server (this command also rewrites the `nextjs-agent-rules` block above; check for diffs before committing)
- `npm run lint` — ESLint (`eslint`). Only verification script configured.
- `npm run build` — production build; runs TypeScript typechecking as part of it.
- No test framework/test script is installed. To typecheck alone: `npx tsc --noEmit`.
- No `src/` directory.

## Conventions

- App Router lives in `app/`. Components are Server Components by default; the starter layout uses the Next 16 `LayoutProps<"/">` type from `next`.
- Path alias `@/*` maps to repo root (`tsconfig.json`), so imports are `@/app/...`, NOT `@/components/...`.
- Tailwind CSS v4 via `@tailwindcss/postcss`. There is **no `tailwind.config.js`** — theme/colors are declared in `app/globals.css` using `@theme inline` and CSS variables. Add fonts/mark colors there, not in a config file.
- Fonts load through `next/font/google` (`Geist`, `Geist_Mono`) and are exposed as CSS vars in `app/globals.css`.
- `.env*` files are gitignored; env loading is default Next.js behavior.
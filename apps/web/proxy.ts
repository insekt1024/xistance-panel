import createMiddleware from "next-intl/middleware";
import { routing } from "./src/i18n/routing";

// Runs locale negotiation/redirects via next-intl.
export default createMiddleware(routing);

export const config = {
  // Match all pathnames except API routes, static assets and internal Next files.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};

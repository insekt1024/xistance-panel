import createMiddleware from "next-intl/middleware";
import { routing } from "./src/i18n/routing";

// Next.js 16: Middleware is now "Proxy". Runs locale negotiation/redirects.
export default createMiddleware(routing);

export const config = {
  // Match all pathnames except API routes, static assets and internal Next files.
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};

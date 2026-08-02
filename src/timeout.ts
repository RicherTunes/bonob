import logger from "./logger";
import { sanitizeLogValue } from "./utils";

// Subsonic authenticates in the QUERY STRING (u / t / s), and the art routes carry `bat`. Any error
// text that might embed a URL must therefore be scrubbed before it reaches a log line. Defence in
// depth: the renderers below only take an error's name/message, but a future axios or driver change
// that starts folding the request URL into the message must not silently become a credential leak.
const CREDENTIAL_QUERY_PARAMS = /([?&](?:u|t|s|p|bat)=)[^&\s"']*/gi;

const redactCredentials = (value: string): string =>
  value.replace(CREDENTIAL_QUERY_PARAMS, "$1*****");

// Render an arbitrary rejection reason as a short, credential-safe, single-line string. Never
// serialize the reason wholesale: that is what produced the old
// "Failed getting coverArt for urn:'[object Object]'" lines, which named the failure without
// identifying it.
export const describeReason = (e: unknown): string => {
  const raw =
    e instanceof Error
      ? `${e.name}: ${e.message}`
      : typeof e === "string"
        ? e
        : e === null || e === undefined
          ? String(e)
          : typeof e === "object"
            ? // Describe an object rejection by SHAPE, never by content. An earlier version
              // JSON.stringify'd it, which was a real credential leak rather than a theoretical
              // one: the token-refresh fault this codebase throws (see smapi.ts) is a non-Error
              // object whose detail carries a freshly minted JWT, and the length cap still let the
              // JWT header and the leading payload through. Key names are structure and are worth
              // keeping for diagnosis; values never are.
              `[${(e as { constructor?: { name?: string } })?.constructor?.name ?? "object"}: ${Object.keys(
                e as object
              )
                .slice(0, 5)
                .join(", ")}]`
            : String(e);
  return sanitizeLogValue(redactCredentials(raw)).slice(0, 300);
};

// The SMAPI handlers build their context from the browsed/searched id, which arrives straight off
// the wire, so it is neutralized on the same terms as the reason.
const describeContext = (context: string): string => sanitizeLogValue(context).slice(0, 120);

// A SMAPI/auth fault (login failure, expired token, ...) is an object carrying a `Fault`; it MUST
// propagate so the SOAP layer returns the proper Sonos fault, not be swallowed by the backstop.
// Declared before withTimeout because the post-deadline follow-up has to recognise one too.
const isSmapiFault = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "Fault" in (e as object);

// Resolve to `fallback` if `p` has not settled within `ms` (and never leak the timer). Used both
// for per-call backend enrichment caps (e.g. Last.fm) and the SMAPI-level browse deadline.
//
// `context` (e.g. "search:tracks") makes the degradation visible. Without it these paths were
// completely silent, and a degraded response is indistinguishable in the Sonos app from a genuine
// empty result or a still-loading tile - which is exactly why "search only returns albums" and the
// stuck "Loading, please try again" tile could not be diagnosed from the logs. Omitting `context`
// keeps a call site silent, so the enrichment caps that degrade routinely stay quiet.
export const withTimeout = <T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
  context?: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();

  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        if (context) {
          logger.warn(
            `${describeContext(context)} exceeded its ${ms}ms deadline and degraded to the fallback`
          );
          // Keep following the abandoned work. The deadline alone only says "too slow"; the
          // eventual settle says BY HOW MUCH, which is what separates "just over budget, raise the
          // deadline" from "the backend is wedged, fix the backend". This also attaches a rejection
          // handler, so an abandoned promise that later fails cannot become an unhandled rejection.
          p.then(
            () =>
              logger.warn(
                `${describeContext(context)} finally succeeded after ${Date.now() - startedAt}ms, too late to be used (deadline ${ms}ms)`
              ),
            (e) => {
              // A SMAPI fault reaching here is not a degradation, it is the protocol working - and
              // the token-refresh fault carries a fresh auth token, so logging it would leak a
              // credential. faultOrFallback already stays quiet for faults; this path must match it.
              // Past the deadline the rejection is delivered HERE rather than to faultOrFallback,
              // so without this check the quiet guarantee silently did not apply.
              if (isSmapiFault(e)) return;
              logger.warn(
                `${describeContext(context)} finally failed after ${Date.now() - startedAt}ms, too late to be used (deadline ${ms}ms): ${describeReason(e)}`
              );
            }
          );
        }
        resolve(fallback);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Every SMAPI browse handler must return a VALID response within Sonos's ~5s SMAPI timeout. This
// deadline (safely below 5s) is the catch-all safety net: any handler that hangs OR rejects past it
// degrades to a graceful fallback instead of surfacing "something went wrong" in the Sonos app.
export const SMAPI_BROWSE_TIMEOUT_MS = 4500;

// Backstop catch: re-throw SMAPI/auth faults (they must reach Sonos), swallow every other
// (backend/timeout) rejection to the graceful fallback.
//
// A swallowed rejection is a user-visible degradation, so with a `context` it is reported. A
// re-thrown SMAPI fault is NOT a degradation - it is the protocol working correctly - and stays
// quiet so the log records real problems only.
export const faultOrFallback =
  <T>(fallback: T, context?: string) =>
  (e: unknown): T => {
    if (isSmapiFault(e)) throw e;
    if (context) {
      logger.warn(
        `${describeContext(context)} degraded to its fallback after a backend failure: ${describeReason(e)}`
      );
    }
    return fallback;
  };

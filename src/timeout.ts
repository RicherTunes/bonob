// Resolve to `fallback` if `p` has not settled within `ms` (and never leak the timer). Used both
// for per-call backend enrichment caps (e.g. Last.fm) and the SMAPI-level browse deadline.
export const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Every SMAPI browse handler must return a VALID response within Sonos's ~5s SMAPI timeout. This
// deadline (safely below 5s) is the catch-all safety net: any handler that hangs OR rejects past it
// degrades to a graceful fallback instead of surfacing "something went wrong" in the Sonos app.
export const SMAPI_BROWSE_TIMEOUT_MS = 4500;

// A SMAPI/auth fault (login failure, expired token, ...) is an object carrying a `Fault`; it MUST
// propagate so the SOAP layer returns the proper Sonos fault, not be swallowed by the backstop.
const isSmapiFault = (e: unknown): boolean =>
  typeof e === "object" && e !== null && "Fault" in (e as object);

// Backstop catch: re-throw SMAPI/auth faults (they must reach Sonos), swallow every other
// (backend/timeout) rejection to the graceful fallback.
export const faultOrFallback =
  <T>(fallback: T) =>
  (e: unknown): T => {
    if (isSmapiFault(e)) throw e;
    return fallback;
  };

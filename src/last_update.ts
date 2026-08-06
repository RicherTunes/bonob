import { Clock, SystemClock } from "./clock";

// Sonos polls getLastUpdate every `pollInterval` seconds and compares the returned stamps against
// what it last saw. A CHANGED stamp means "your cached view is stale, re-fetch it".
//
// Returning clock.now() for both stamps therefore told Sonos the catalog and the favourites had
// changed on EVERY poll, forever - which on a 113k-album library is a standing invitation to
// re-browse and re-fetch art, and precisely the load the caching layers exist to absorb. The
// bridge was generating the load it was then optimised to survive.
//
// These stamps change only when something actually changed:
//   - favourites: the user starred/unstarred or rated something through bonob
//   - catalog:    a playlist was created, edited or deleted, or an index finished rebuilding
//
// A library scan performed directly in Navidrome is invisible to bonob, so a catalog change made
// outside Sonos is picked up on the next index rebuild rather than immediately. That is the honest
// trade: bonob cannot observe what it is not told about, and claiming a change every 60 seconds to
// cover that case costs far more than it buys.
// Floor between two placeholder-driven catalog bumps. Long enough that a flapping index cannot
// storm a large catalog with re-browse orders, short enough that a real cold start recovers fast.
const MIN_PLACEHOLDER_BUMP_INTERVAL_MS = 60_000;

export class LastUpdate {
  private readonly clock: Clock;
  private catalogAt: number;
  private favouritesAt: number;

  // Plain assignment rather than a `private readonly clock: Clock = SystemClock` parameter
  // property: with a field initializer that dereferences this.clock, the emit order bit and
  // this.clock was still undefined when the constructor body first called now(). A caller that
  // passes an explicit `undefined` clock (some test harnesses spread one in) also has to land on
  // the default, so the guard is belt and braces.
  constructor(clock: Clock = SystemClock) {
    this.clock = clock ?? SystemClock;
    // Seeded at construction rather than 0 so a restart looks like a change exactly once, which is
    // correct: in-memory state was lost, so Sonos re-reading is the right outcome.
    this.catalogAt = this.tick(undefined);
    this.favouritesAt = this.tick(undefined);
  }

  // Milliseconds, and never less than one tick past the stamp already issued. Seconds alone lost
  // any bump landing in the same second as the value Sonos last saw, and a raw clock read would let
  // an NTP correction move a stamp BACKWARDS onto a value Sonos had already seen - which reads as
  // "nothing changed" and strands it on a stale view. The WSDL types both stamps as xs:string, so
  // any monotonically changing token is valid here.
  private tick(previous: number | undefined): number {
    const now = this.clock.now().valueOf();
    return previous === undefined ? now : Math.max(now, previous + 1);
  }

  catalog = () => this.catalogAt;
  favourites = () => this.favouritesAt;

  bumpCatalog = () => {
    this.catalogAt = this.tick(this.catalogAt);
  };

  bumpFavourites = () => {
    this.favouritesAt = this.tick(this.favouritesAt);
  };

  // Whether a "still loading" placeholder has been served since the last time real content was
  // reported. A cold start serves placeholders while the index builds, and the stamp seeded at
  // construction is consumed by the poll that FETCHES those placeholders - after which nothing
  // moves the catalog stamp again (the first index build after a restart only establishes the
  // fingerprint baseline). Sonos would then hold the placeholder view with no eviction trigger.
  private placeholderServed = false;
  private lastPlaceholderBumpAt: number | undefined;

  notePlaceholderServed = () => {
    this.placeholderServed = true;
  };

  // Real content is being served where a placeholder was before, so tell Sonos to re-read - once
  // per episode, not on every subsequent browse.
  noteContentReady = () => {
    if (!this.placeholderServed) return;
    // A placeholder-driven bump orders Sonos to re-read the WHOLE catalog (SMAPI has no finer
    // granularity than "catalog"), so a section that flaps cold/warm - an album index that keeps
    // failing and retrying while the backend is saturated - could issue a full re-browse of a
    // 113k-album library per cycle, precisely when the backend can least afford it. One bump per
    // interval at most; the flag stays set so a genuine recovery still lands on the next one.
    const now = this.clock.now().valueOf();
    if (
      this.lastPlaceholderBumpAt !== undefined &&
      now - this.lastPlaceholderBumpAt < MIN_PLACEHOLDER_BUMP_INTERVAL_MS
    )
      return;
    this.lastPlaceholderBumpAt = now;
    this.placeholderServed = false;
    this.bumpCatalog();
  };
}

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
    this.catalogAt = this.now();
    this.favouritesAt = this.now();
  }

  private now(): number {
    return this.clock.now().unix();
  }

  catalog = () => this.catalogAt;
  favourites = () => this.favouritesAt;

  bumpCatalog = () => {
    this.catalogAt = this.now();
  };

  bumpFavourites = () => {
    this.favouritesAt = this.now();
  };
}

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
}

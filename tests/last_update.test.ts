import dayjs from "dayjs";
import { LastUpdate } from "../src/last_update";
import { FixedClock } from "../src/clock";

describe("LastUpdate", () => {
  // Sonos compares these stamps against what it last saw; a CHANGED stamp means "re-fetch". The
  // old implementation returned clock.now() for both, so every 60s poll claimed the catalog and
  // the favourites had changed - a standing re-browse and re-art-fetch order against a 113k-album
  // library, from the bridge whose caching exists to absorb exactly that load.
  it("is stable across polls when nothing has changed", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);

    const firstCatalog = lastUpdate.catalog();
    const firstFavourites = lastUpdate.favourites();

    clock.time = dayjs("2026-08-05T10:05:00Z");

    expect(lastUpdate.catalog()).toEqual(firstCatalog);
    expect(lastUpdate.favourites()).toEqual(firstFavourites);
  });

  it("changes the favourites stamp only when favourites change", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);
    const catalogBefore = lastUpdate.catalog();
    const favouritesBefore = lastUpdate.favourites();

    clock.time = dayjs("2026-08-05T10:05:00Z");
    lastUpdate.bumpFavourites();

    expect(lastUpdate.favourites()).not.toEqual(favouritesBefore);
    // a star must not invalidate the whole catalog view
    expect(lastUpdate.catalog()).toEqual(catalogBefore);
  });

  it("changes the catalog stamp only when the catalog changes", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);
    const catalogBefore = lastUpdate.catalog();
    const favouritesBefore = lastUpdate.favourites();

    clock.time = dayjs("2026-08-05T10:05:00Z");
    lastUpdate.bumpCatalog();

    expect(lastUpdate.catalog()).not.toEqual(catalogBefore);
    expect(lastUpdate.favourites()).toEqual(favouritesBefore);
  });

  it("seeds both stamps at construction, so a restart reads as one change", () => {
    // In-memory state is lost on restart, so Sonos re-reading once is the CORRECT outcome; what
    // was wrong was claiming it every minute.
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const first = new LastUpdate(clock);
    clock.time = dayjs("2026-08-05T11:00:00Z");
    const second = new LastUpdate(clock);

    expect(second.catalog()).not.toEqual(first.catalog());
  });
});

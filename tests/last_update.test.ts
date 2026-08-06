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

  // The stamps were unix SECONDS, so a bump landing in the same second as the value Sonos last saw
  // was invisible and the change was simply lost. A playlist renamed moments after a scan finished
  // is exactly that case, and unlike favourites it has no later refresh to self-heal.
  it("always changes the stamp on a bump, even within the same clock tick", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);

    const seeded = lastUpdate.catalog();
    lastUpdate.bumpCatalog();
    const afterFirst = lastUpdate.catalog();
    lastUpdate.bumpCatalog();
    const afterSecond = lastUpdate.catalog();

    expect(afterFirst).not.toEqual(seeded);
    expect(afterSecond).not.toEqual(afterFirst);
  });

  // A backwards clock step (NTP correction) must not make a bump look like a REVERT to a stamp
  // Sonos has already seen, which would leave it holding a stale view believing it was current.
  it("never moves a stamp backwards when the clock does", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);
    const seeded = Number(lastUpdate.catalog());

    clock.time = dayjs("2026-08-05T09:00:00Z");
    lastUpdate.bumpCatalog();

    expect(Number(lastUpdate.catalog())).toBeGreaterThan(seeded);
  });

  // A cold restart serves "Loading, please try again..." placeholders while the index builds.
  // LastUpdate seeds a fresh stamp at construction, so Sonos re-browses within one poll and gets
  // the PLACEHOLDER - and the catalog stamp then never moves again, because the first index build
  // after a restart deliberately only establishes the fingerprint baseline. So nothing ever tells
  // Sonos the real content arrived. A confidently stale view with no eviction trigger is worse
  // than a slow one.
  it("bumps the catalog once when real content replaces a placeholder", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);
    const before = lastUpdate.catalog();

    lastUpdate.notePlaceholderServed();
    lastUpdate.noteContentReady();

    expect(lastUpdate.catalog()).not.toEqual(before);
  });

  it("does not bump when content was ready all along", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);
    const before = lastUpdate.catalog();

    lastUpdate.noteContentReady();
    lastUpdate.noteContentReady();

    expect(lastUpdate.catalog()).toEqual(before);
  });

  it("bumps only once per placeholder episode, not on every later browse", () => {
    const clock = new FixedClock(dayjs("2026-08-05T10:00:00Z"));
    const lastUpdate = new LastUpdate(clock);

    lastUpdate.notePlaceholderServed();
    lastUpdate.noteContentReady();
    const afterRecovery = lastUpdate.catalog();
    lastUpdate.noteContentReady();
    lastUpdate.noteContentReady();

    expect(lastUpdate.catalog()).toEqual(afterRecovery);
  });
});

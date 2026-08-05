import path from "path";
import fs from "fs";
import server from "./server";
import logger from "./logger";

import {
  axiosImageFetcher,
  deezerImageFetcher,
  cachingImageFetcher,
  TranscodingCustomPlayers,
  NO_CUSTOM_PLAYERS,
  Subsonic,
  ALBUM_INDEX_CACHE_MAX_ENTRIES
} from "./subsonic";
import { SubsonicMusicService} from "./subsonic_music_library";
import { InMemoryAPITokens, sha256 } from "./api_tokens";
import { InMemoryLinkCodes } from "./link_codes";
import readConfig, {
  albumSnapshotMaxBytes,
  albumSnapshotKeepPerKey,
  albumSnapshotProtectPerKey,
} from "./config";
import sonos, { bonobService } from "./sonos";
import { MusicService } from "./music_library";
import { SystemClock } from "./clock";
import { JWTSmapiLoginTokens } from "./smapi_auth";
import { SwrCache } from "./swr_cache";
import { fileStore } from "./swr_cache_file_store";
import { albumIndexStore } from "./album_snapshot";
import { deezerArtistImageUrl } from "./deezer";
import ms from "ms";

const config = readConfig();
const clock = SystemClock;

logger.info(`Starting bonob with config ${JSON.stringify({ ...config, secret: "*******" })}`);

const bonob = bonobService(
  config.sonos.serviceName,
  config.sonos.sid,
  config.bonobUrl,
  "AppLink"
);

const sonosSystem = sonos(config.sonos.discovery);

const customPlayers = config.subsonic.customClientsFor
  ? TranscodingCustomPlayers.from(config.subsonic.customClientsFor)
  : NO_CUSTOM_PLAYERS;

const artistImageFetcher = config.subsonic.artistImageCache
  ? cachingImageFetcher(config.subsonic.artistImageCache, axiosImageFetcher)
  : axiosImageFetcher;

// Deezer art: same byte cache as external art, but over the redirect-refusing fetcher (SSRF).
const deezerArtResolver = config.subsonic.artistImageCache
  ? cachingImageFetcher(config.subsonic.artistImageCache, deezerImageFetcher)
  : deezerImageFetcher;

// Freeze a loaded value and everything nested in it, matching how fetched summaries are
// frozen — a persisted entry restored from disk must be just as immutable as a live one.
const deepFreeze = (v: unknown): unknown => {
  if (v && typeof v === "object") {
    Object.values(v as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
};

// Bounded stale-while-revalidate cache for the large browse lists (getArtists, album pages).
// Parse the TTL at the config boundary; an invalid duration coerces to 0 = disabled. When a
// cache dir is configured, back it with a disk store so it survives restarts (no cold first
// browse after a redeploy).
const browseCacheTTLms = Number(ms(config.subsonic.cacheTTL)) || 0;
const browseCacheStore = config.subsonic.cacheDir
  ? fileStore(config.subsonic.cacheDir, {
      // The ARTIST INDEX used to live in this cache as one large JSON blob (~150-300 bytes/artist),
      // which is why this cap was raised from the 16MiB default to 256MiB — past the cap the file was
      // skipped on every restart, leaving the Artists browse permanently cold. Goal (c) moved the
      // artist index into the index cache's disk-backed snapshot store (records streamed, not one
      // blob), so it no longer lives here; the largest remaining entries are album-list pages (~240
      // KiB). The cap is retained as generous headroom rather than reverted, to avoid touching
      // working config; the skip stays logged so any future large entry is diagnosable, not silent.
      maxFileBytes: 256 * 1024 * 1024,
    })
  : undefined;
// The browse cache holds EVERY per-browse key, and this session multiplied that key space by an
// order of magnitude: artist:v1:<user>:<id> and artistInfo:v1:<user>:<id> are minted PER ARTIST
// OPENED, alongside albumPage:* per user/type/page/genre/year, playlist:* per playlist,
// artistTracks:*, genres:* and starredSongs:*.
//
// At the old default of 50 slots that is a lottery: scrolling ~25 artists mints 50 entries and
// evicts everything else, including starredSongs:<user> - which Favourite Songs is served from
// EXCLUSIVELY via peek(), so eviction drops the user back to the placeholder and re-triggers the
// 8.6s getStarred2. peek()-touches-LRU helps, but cannot survive 2 new keys per artist.
//
// Entries are small (a page of summaries, a bio, a track list), so headroom is cheap and eviction
// is expensive. Env-tunable for a household with unusual browsing habits.
const browseCache = new SwrCache(clock, browseCacheTTLms, {
  store: browseCacheStore,
  revive: deepFreeze,
  maxEntries: Number(process.env["BNB_BROWSE_CACHE_MAX_ENTRIES"] || 2000),
});

// The index cache holds the heavy full-catalog INDEXES — the album index (~N/500-request scan) AND
// the artist index (one getArtists) — both of which change only on a library scan, so they are cached
// far longer than browse pages (6h TTL, ~24h stale cap) to avoid re-scanning on every stale browse.
// Persisted in their own subdir so they survive restarts.
//
// Slice 1: each index snapshot is disk-backed (records streamed to an immutable per-build file, only
// buckets + a Uint32Array of byte offsets resident), so each is persisted by albumIndexStore (one
// self-describing snapshot file per build, recognised by its filename prefix — albumSnapshot.v3 /
// artistSnapshot.v2), NOT by the generic fileStore. albumIndexStore loads EVERY index kind from the
// shared dir; the same directory is passed to Subsonic so each scan writes its snapshot where the
// store will look for it, and the bound enforcer caps both kinds together.
const indexCacheDir = config.subsonic.cacheDir
  ? path.join(config.subsonic.cacheDir, "index")
  : undefined;
const indexCache = new SwrCache(clock, 6 * 60 * 60 * 1000, {
  store: indexCacheDir ? albumIndexStore(indexCacheDir) : undefined,
  // A restored index has a Uint32Array of byte offsets; deepFreeze must NOT recurse into it
  // (Object.values on a typed array allocates a million-entry array). Freeze just the index and
  // its bucket rows — enough to match the "persisted = immutable" contract without that cost.
  revive: (v) => {
    if (v && typeof v === "object") {
      Object.freeze(v);
      const buckets = (v as { buckets?: unknown }).buckets;
      if (Array.isArray(buckets)) {
        for (const b of buckets) if (b && typeof b === "object") Object.freeze(b);
      }
    }
    return v;
  },
  maxEntries: ALBUM_INDEX_CACHE_MAX_ENTRIES,
  // The full-catalog scan legitimately takes several minutes on a large library; the default
  // 60s backstop would abort it before it ever completes. Give it a generous ceiling.
  backstopMs: 20 * 60 * 1000,
});

const subsonic = new SubsonicMusicService(
  new Subsonic(
    config.subsonic.url,
    customPlayers,
    artistImageFetcher,
    browseCache,
    indexCache,
    config.subsonic.deezerArtistArt,
    {}, // coverArtCoordinatorOptions (default)
    undefined, // maxIndexScanAlbums (default)
    indexCacheDir, // Slice 1: disk-backed album snapshot directory
    // Global disk bound for the snapshot store (env-tunable). Stops a multi-user `/cache` bind mount
    // walking into ENOSPC: see enforceSnapshotBounds in album_snapshot.ts.
    {
      maxBytes: albumSnapshotMaxBytes(),
      keepPerKey: albumSnapshotKeepPerKey(),
      protectPerKey: albumSnapshotProtectPerKey(),
    }
  ),
  customPlayers,
  config.subsonic.transcode
);

// Resolve artist names to real Deezer photos, cached per-artist for a day. High cap (one entry
// per artist) so a large library isn't evicted; in-memory only (cheap to rebuild lazily).
const deezerCache = new SwrCache(clock, 24 * 60 * 60 * 1000, { maxEntries: 100_000 });
const cachedDeezerArtistImage = (name: string) =>
  deezerCache.get(`deezer:${name}`, () => deezerArtistImageUrl(name));

const featureFlagAwareMusicService: MusicService = {
  generateToken: subsonic.generateToken,
  refreshToken: subsonic.refreshToken,
  login: (serviceToken: string) =>
    subsonic.login(serviceToken).then((library) => {
      return {
        ...library,
        scrobble: (id: string) => {
          if (config.scrobbleTracks) return library.scrobble(id);
          else {
            logger.info("Track Scrobbling not enabled");
            return Promise.resolve(true);
          }
        },
        nowPlaying: (id: string) => {
          if (config.reportNowPlaying) return library.nowPlaying(id);
          else {
            logger.info("Reporting track now playing not enabled");
            return Promise.resolve(true);
          }
        },
      };
    }),
};

export const GIT_INFO = path.join(__dirname, "..", ".gitinfo");

const version = fs.existsSync(GIT_INFO)
  ? fs.readFileSync(GIT_INFO).toString().trim()
  : "v??";

const app = server(
  sonosSystem,
  bonob,
  config.bonobUrl,
  featureFlagAwareMusicService,
  {
    linkCodes: () => new InMemoryLinkCodes(clock, config.linkCodeTimeout),
    apiTokens: () => new InMemoryAPITokens(clock, config.authTimeout, sha256(config.secret)),
    clock,
    iconColors: config.icons,
    applyContextPath: true,
    logRequests: config.logRequests,
    version,
    smapiAuthTokens: new JWTSmapiLoginTokens(clock, config.secret, config.authTimeout),
    externalImageResolver: artistImageFetcher,
    deezerImageResolver: deezerArtResolver,
    deezerArtistImage: cachedDeezerArtistImage,
    loginTheme: config.loginTheme,
    enableS1: config.sonos.enableS1,
  }
);

const expressServer = app.listen(config.port, () => {
  logger.info(`Listening on ${config.port} available @ ${config.bonobUrl}`);
});

if (config.sonos.autoRegister) {
  sonosSystem.register(bonob).then((success) => {
    if (success) {
      logger.info(
        `Successfully registered ${bonob.name}(SID:${bonob.sid}) with sonos`
      );
    }
  });
} else if (config.sonos.discovery.enabled) {
  sonosSystem.devices().then((devices) => {
    devices.forEach((d) => {
      logger.info(`Found device ${d.name}(${d.group}) @ ${d.ip}:${d.port}`);
    });
  });
};

// LAST RESORT. This is a single-instance bridge: a crash silences the whole household until Docker
// restarts it, and takes every in-memory link code and API token with it, so Sonos then 401s on art
// and streams until the next SOAP call re-mints them. The one thing worse than that is it happening
// with no diagnosable line in the log - which is the default, because Node prints an uncaught
// exception to stderr and exits.
//
// These handlers do NOT keep the process alive: continuing after an unknown failure risks serving
// corrupt state. They exist so the restart has a cause attached to it.
process.on("uncaughtException", (e) => {
  logger.error(
    `FATAL uncaughtException, exiting for a clean restart: ${e && e.stack ? e.stack : String(e)}`
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  // Node 20+ terminates on an unhandled rejection by default, so this is a crash path too, and the
  // fire-and-forget SMAPI mutations are exactly the code that produces them.
  logger.error(
    `FATAL unhandledRejection, exiting for a clean restart: ${
      reason instanceof Error && reason.stack ? reason.stack : String(reason)
    }`
  );
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  // Exit INSIDE the close callback. Calling process.exit(0) synchronously after close() killed
  // in-flight streams instantly and made the "HTTP server closed" line unreachable - a graceful
  // shutdown that was neither graceful nor observable. The timeout bounds a hung connection so a
  // stuck stream cannot block the restart forever.
  const forced = setTimeout(() => {
    logger.warn('Shutdown timed out with connections still open; exiting anyway');
    process.exit(0);
  }, 10_000);
  forced.unref();
  expressServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});


export default app;

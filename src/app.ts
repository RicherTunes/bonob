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
import readConfig from "./config";
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
  ? fileStore(config.subsonic.cacheDir)
  : undefined;
const browseCache = new SwrCache(clock, browseCacheTTLms, {
  store: browseCacheStore,
  revive: deepFreeze,
});

// The album index is a heavy full-catalog scan (~N/500 requests) that changes only on a library
// scan, so cache it far longer than browse pages (6h TTL, ~24h stale cap) to avoid re-scanning on
// every stale browse. Persisted in its own subdir so it survives restarts.
//
// Slice 1: the index snapshot is disk-backed (records streamed to an immutable per-build file,
// only buckets + a Uint32Array of byte offsets resident), so it is persisted by albumIndexStore
// (one self-describing snapshot file per build), NOT by the generic fileStore. The same directory
// is passed to Subsonic so the scan writes its snapshot where the store will look for it.
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
    indexCacheDir // Slice 1: disk-backed album snapshot directory
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

process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  expressServer.close(() => {
    logger.info('HTTP server closed');
  });
  process.exit(0);
});


export default app;

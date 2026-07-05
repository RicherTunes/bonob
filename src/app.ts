import path from "path";
import fs from "fs";
import server from "./server";
import logger from "./logger";

import {
  axiosImageFetcher,
  cachingImageFetcher,
  TranscodingCustomPlayers,
  NO_CUSTOM_PLAYERS,
  Subsonic
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
const indexCache = new SwrCache(clock, 6 * 60 * 60 * 1000, {
  store: config.subsonic.cacheDir
    ? fileStore(path.join(config.subsonic.cacheDir, "index"))
    : undefined,
  revive: deepFreeze,
});

const subsonic = new SubsonicMusicService(
  new Subsonic(
    config.subsonic.url,
    customPlayers,
    artistImageFetcher,
    browseCache,
    indexCache
  ),
  customPlayers,
  config.subsonic.transcode
);

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

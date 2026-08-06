import { either as E, taskEither as TE } from "fp-ts";
import express, { Express, Request } from "express";
import * as Eta from "eta";
import path from "path";
import sharp from "sharp";
import { randomUUID as uuid } from "crypto";
import dayjs from "dayjs";

import { PassThrough, Transform } from "stream";

import { Sonos, Service, SONOS_LANG } from "./sonos";
import {
  SOAP_PATH,
  STRINGS_ROUTE,
  PRESENTATION_MAP_ROUTE,
  SONOS_RECOMMENDED_IMAGE_SIZES,
  LOGIN_ROUTE,
  sonosifyMimeType,
  ratingFromInt,
  ratingAsInt,
  splitId,
  shouldScrobble
} from "./smapi";
import { makeS1Router } from "./routes/s1";
import { LinkCodes, InMemoryLinkCodes } from "./link_codes";
import { MusicService, AuthFailure, AuthSuccess } from "./music_library";
import bindSmapiSoapServiceToExpress from "./smapi";
import {
  APITokens,
  InMemoryAPITokens,
  serviceTokenForScopedApiToken,
} from "./api_tokens";
import logger from "./logger";
import { Clock, SystemClock } from "./clock";
import { pipe } from "fp-ts/lib/function";
import { URLBuilder } from "./url_builder";
import makeI8N, { asLANGs, KEY, keys as i8nKeys, LANG } from "./i8n";
import { Icon, ICONS, festivals, features, no_festivals } from "./icon";
import { DEFAULT_LOGIN_THEME } from './config'
import _ from "underscore";
import morgan from "morgan";
import { parse, BUrn } from "./burn";
import { deezerArtistImageUrl } from "./deezer";
import {
  axiosImageFetcher,
  deezerImageFetcher,
  ImageFetcher,
  isSafeExternalImageUrl,
  CoverArtUnavailableError,
} from "./subsonic";
import {
  JWTSmapiLoginTokens,
  SmapiAuthTokens,
} from "./smapi_auth";
import { isValidMimeType, sanitizeLogValue } from "./utils";
import { describeReason } from "./timeout";

export const BONOB_ACCESS_TOKEN_HEADER = "bat";

type TimePlayed = {
  items: {
      mediaUrl: string,
      type: "update" | "final"
      durationPlayedMillis: number
  }[]
}

// REMOVED: rangeFilterFor / RangeBytesFromFilter. No route used them - the Range header is passed
// upstream and the response is proxied through a PassThrough - so they were dead production code
// kept alive only by their own tests. rangeFilterFor also threw a bare string rather than an Error,
// which would have produced an unhelpful failure had anything ever called it.

export type ServerOpts = {
  linkCodes: () => LinkCodes;
  apiTokens: () => APITokens;
  clock: Clock;
  iconColors: {
    foregroundColor: string | undefined;
    backgroundColor: string | undefined;
  };
  applyContextPath: boolean;
  logRequests: boolean;
  version: string;
  smapiAuthTokens: SmapiAuthTokens;
  externalImageResolver: ImageFetcher;
  // Resolve an artist name to a real photo URL (Deezer). Cached at the app boundary.
  deezerArtistImage: (name: string) => Promise<string | undefined>;
  // Fetch a resolved Deezer image URL. Separate from externalImageResolver so it can refuse
  // redirects (the SSRF allowlist only checks the initial *.dzcdn.net URL).
  deezerImageResolver: ImageFetcher;
  loginTheme: string;
  enableS1: boolean;
};

const DEFAULT_TIMEOUT = "1h"

export const redactAccessTokenFromUrl = (value: string | undefined): string => {
  if (!value) return "";
  try {
    const parsed = new URL(value, "http://bonob.local");
    if (parsed.searchParams.has(BONOB_ACCESS_TOKEN_HEADER)) {
      parsed.searchParams.set(BONOB_ACCESS_TOKEN_HEADER, "*****");
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return value.replace(
      new RegExp(`([?&]${BONOB_ACCESS_TOKEN_HEADER}=)[^&\\s"]*`, "g"),
      "$1*****"
    );
  }
};

// The Referer is a full absolute URL, so it keeps its origin (that is the diagnostic value) while
// the access token inside it is redacted exactly as it is in the request line. Without this,
// :redacted-url was pointless: a client that follows a link from a bonob page carrying ?bat=<token>
// sends that same token back in the Referer header, and morgan logged it verbatim.
export const redactAccessTokenFromReferrer = (value: string | undefined): string => {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has(BONOB_ACCESS_TOKEN_HEADER)) {
      parsed.searchParams.set(BONOB_ACCESS_TOKEN_HEADER, "*****");
    }
    return parsed.href;
  } catch {
    // Not an absolute URL. Fall through to the path-relative redactor, which has its own regex
    // backstop for values that do not parse as a URL at all.
    return redactAccessTokenFromUrl(value);
  }
};

// Re-exported so the access-log call sites (and their tests) keep a single obvious import, while
// the implementation lives in utils.ts - shared with the SMAPI degradation log, which must not
// import this module.
export { sanitizeLogValue };

const MORGAN_REDACTED_COMBINED =
  ':remote-addr - :remote-user [:date[clf]] ":method :redacted-url HTTP/:http-version" :status :res[content-length] ":redacted-referrer" ":safe-user-agent"';

const DEFAULT_SERVER_OPTS: ServerOpts = {
  linkCodes: () => new InMemoryLinkCodes(),
  apiTokens: () => new InMemoryAPITokens(SystemClock, DEFAULT_TIMEOUT),
  clock: SystemClock,
  iconColors: { foregroundColor: undefined, backgroundColor: undefined },
  applyContextPath: true,
  logRequests: false,
  version: "v?",
  smapiAuthTokens: new JWTSmapiLoginTokens(
    SystemClock,
    `bonob-${uuid()}`,
    DEFAULT_TIMEOUT
  ),
  externalImageResolver: axiosImageFetcher,
  deezerArtistImage: deezerArtistImageUrl,
  deezerImageResolver: deezerImageFetcher,
  loginTheme: DEFAULT_LOGIN_THEME,
  enableS1: false,
};

function server(
  sonos: Sonos,
  service: Service,
  bonobUrl: URLBuilder,
  musicService: MusicService,
  opts: Partial<ServerOpts> = {}
): Express {
  const serverOpts = { ...DEFAULT_SERVER_OPTS, ...opts };

  const linkCodes = serverOpts.linkCodes();
  const smapiAuthTokens = serverOpts.smapiAuthTokens;
  const apiTokens = serverOpts.apiTokens();
  const clock = serverOpts.clock;
  const loginTheme = serverOpts.loginTheme || "classic"

  const startUpTime = dayjs();

  const app = express();
  const i8n = makeI8N(service.name);

  if (serverOpts.logRequests) {
    morgan.token("redacted-url", (req) =>
      sanitizeLogValue(redactAccessTokenFromUrl(req.url))
    );
    // A client that followed a link from a bonob page sends that page's URL back in Referer -
    // including its ?bat=<token>. Logging it raw defeated :redacted-url entirely.
    morgan.token("redacted-referrer", (req) =>
      sanitizeLogValue(
        redactAccessTokenFromReferrer(
          (req.headers["referer"] ?? req.headers["referrer"]) as string | undefined
        )
      )
    );
    // Fully client-controlled and never redacted by morgan; neutralize it for the same reason.
    morgan.token("safe-user-agent", (req) =>
      sanitizeLogValue(req.headers["user-agent"])
    );
    app.use(morgan(MORGAN_REDACTED_COMBINED));
  }
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.use(express.static(path.resolve(__dirname, "..", "web", "public")));
  app.engine("eta", Eta.renderFile);

  app.set("view engine", "eta");
  app.set("views", path.resolve(__dirname, "..", "web", "views"));

  app.set("query parser", "simple");

  const langFor = (req: Request) => {
    logger.debug(
      `${req.path} (req[accept-language]=${req.headers["accept-language"]})`
    );
    return i8n(...asLANGs(req.headers["accept-language"]));
  };

  app.get("/", (_, res) => {
    res.render("index", {
      serviceName: service.name,
      version: serverOpts.version || DEFAULT_SERVER_OPTS.version,
    });
  });

  app.get("/about", (_, res) => {
    return res.send({
      service: {
        name: service.name,
        sid: service.sid,
      },
    });
  });

  app.use("/s1", makeS1Router(sonos, service, langFor, bonobUrl, serverOpts.version || DEFAULT_SERVER_OPTS.version, serverOpts.enableS1));

  app.get(LOGIN_ROUTE, (req, res) => {
    const lang = langFor(req);
    res.render(`login/${loginTheme}/login`, {
      lang,
      linkCode: req.query.linkCode,
      loginRoute: bonobUrl.append({ pathname: LOGIN_ROUTE }).pathname(),
    });
  });


  app.post(LOGIN_ROUTE, async (req, res) => {
    const lang = langFor(req);
    const { username, password, linkCode } = req.body;
    if (!linkCodes.has(linkCode)) {
      return res.status(400).render(`login/${loginTheme}/login`, {
        lang,
        status: "fail",
        message: lang("invalidLinkCode"),
        loginRoute: bonobUrl.append({ pathname: LOGIN_ROUTE }).pathname(),
      });
    } else {
      return pipe(
        musicService.generateToken({
          username,
          password,
        }),
        TE.match(
          (e: AuthFailure) => {
            // Count the failure against this link code. bonob relays credentials to Navidrome
            // SERVER-SIDE, so every guess reaches Navidrome from the VPS's own IP: Navidrome-side
            // brute-force detection sees one client (bonob), which destroys source attribution and
            // risks bonob itself being banned - a denial of service by proxy on the household's
            // music. At the limit the code is burned, so an attacker must go back through
            // getAppLink for each new one.
            linkCodes.recordFailure(linkCode);
            return {
            status: 403,
            template: `login/${loginTheme}/login`,
            params: {
              lang,
              status: "fail",
              message: lang("loginFailed"),
              cause: e.message,
              linkCode: linkCode,
              loginRoute: bonobUrl.append({ pathname: LOGIN_ROUTE }).pathname(),
            },
          };
          },
          (success: AuthSuccess) => {
            try {
              linkCodes.associate(linkCode, success);
            } catch {
              // The link code can expire between the has() check above and here
              // (its TTL crossing during token generation); degrade to the same
              // friendly fail page as an unknown link code rather than a 500.
              return {
                status: 400,
                template: `login/${loginTheme}/login`,
                params: {
                  lang,
                  status: "fail",
                  message: lang("invalidLinkCode"),
                  loginRoute: bonobUrl.append({ pathname: LOGIN_ROUTE }).pathname(),
                },
              };
            }
            return {
              status: 200,
              template: `login/${loginTheme}/success`,
              params: {
                lang,
                message: lang("loginSuccessful"),
              },
            };
          }
        )
      )().then(({ status, template, params }) =>
        res.status(status).render(template, params)
      );
    }
  });

  app.get(STRINGS_ROUTE, (_, res) => {
    const stringNode = (id: string, value: string) =>
      `<string stringId="${id}"><![CDATA[${value}]]></string>`;
    const stringtableNode = (langName: string) =>
      `<stringtable rev="1" xml:lang="${langName}">${i8nKeys()
        .map((key) => stringNode(key, i8n(langName as LANG)(key as KEY)))
        .join("")}</stringtable>`;

    res.type("application/xml").send(`<?xml version="1.0" encoding="utf-8" ?>
<stringtables xmlns="http://sonos.com/sonosapi">
    ${SONOS_LANG.map(stringtableNode).join("")}
</stringtables>
`);
  });

  app.get(PRESENTATION_MAP_ROUTE, (_, res) => {
    const LastModified = startUpTime.format("HH:mm:ss D MMM YYYY");

    const nowPlayingRatingsMatch = (value: number) => {
      const rating = ratingFromInt(value);
      const nextLove = { ...rating, love: !rating.love };
      const nextStar = {
        ...rating,
        stars: rating.stars === 5 ? 0 : rating.stars + 1,
      };

      const loveRatingIcon = bonobUrl
        .append({
          pathname: rating.love ? "/love-selected.svg" : "/love-unselected.svg",
        })
        .href();
      const starsRatingIcon = bonobUrl
        .append({ pathname: `/star${rating.stars}.svg` })
        .href();

      return `<Match propname="rating" value="${value}">
        <Ratings>
          <Rating Id="${ratingAsInt(
        nextLove
      )}" AutoSkip="NEVER" OnSuccessStringId="LOVE_SUCCESS" StringId="LOVE">
            <Icon Controller="universal" LastModified="${LastModified}" Uri="${loveRatingIcon}" />
          </Rating>
          <Rating Id="${-ratingAsInt(
        nextStar
      )}" AutoSkip="NEVER" OnSuccessStringId="STAR_SUCCESS" StringId="STAR">
            <Icon Controller="universal" LastModified="${LastModified}" Uri="${starsRatingIcon}" />
          </Rating>
        </Ratings>
      </Match>`;
    };

    res.type("application/xml").send(`<?xml version="1.0" encoding="utf-8" ?>
    <Presentation>
      <BrowseOptions PageSize="30" />
      <PresentationMap type="ArtWorkSizeMap">
        <Match>
          <imageSizeMap>
            ${SONOS_RECOMMENDED_IMAGE_SIZES.map(
      (size) =>
        `<sizeEntry size="${size}" substitution="/size/${size}"/>`
    ).join("")}
          </imageSizeMap>
        </Match>
      </PresentationMap>
      <PresentationMap type="BrowseIconSizeMap">
        <Match>
          <browseIconSizeMap>
              <sizeEntry size="0" substitution="/size/legacy"/>
              ${SONOS_RECOMMENDED_IMAGE_SIZES.map(
      (size) =>
        `<sizeEntry size="${size}" substitution="/size/${size}"/>`
    ).join("")}
            </browseIconSizeMap>
        </Match>
      </PresentationMap>
      <PresentationMap type="Search">
        <Match>
          <SearchCategories>
              <Category id="artists"/>
              <Category id="albums"/>
              <Category id="tracks"/>
          </SearchCategories>
        </Match>
      </PresentationMap>
      <PresentationMap type="NowPlayingRatings" trackEnabled="true" programEnabled="false">
        ${nowPlayingRatingsMatch(100)}
        ${nowPlayingRatingsMatch(101)}
        ${nowPlayingRatingsMatch(110)}
        ${nowPlayingRatingsMatch(111)}
        ${nowPlayingRatingsMatch(120)}
        ${nowPlayingRatingsMatch(121)}
        ${nowPlayingRatingsMatch(130)}
        ${nowPlayingRatingsMatch(131)}
        ${nowPlayingRatingsMatch(140)}
        ${nowPlayingRatingsMatch(141)}
        ${nowPlayingRatingsMatch(150)}
        ${nowPlayingRatingsMatch(151)}
      </PresentationMap>
    </Presentation>`);
  });

  app.post("/report/timePlayed", async (req, res) => {
    const serviceToken = pipe(
      E.fromNullable("Missing authorization header")(req.headers["authorization"] as string),
      E.flatMap((token) => {
        return pipe(
         smapiAuthTokens.verify({ token }),
          E.mapLeft((_) => "Auth token failed to verify")
      )
      }),
      E.getOrElseW(() => undefined)
    );

    if (!serviceToken) {
      return res.status(401).send();
    } else {
      return musicService
        .login(serviceToken)
        .then(musicLibrary => {
          const scrobbles = (req.body as TimePlayed).items
            .filter(it => it.type == 'final')
            .map(({ mediaUrl, durationPlayedMillis }) => ({
              ...splitId(decodeURIComponent(new URL(mediaUrl).pathname).split(".")[0]!),
              durationPlayedMillis
            }))
            .map(({ type, typeId, durationPlayedMillis }) => {
              return type == "track" ? ({ trackId: typeId, durationPlayedMillis }) : null
            })
            .filter((it) => it != null)
            .map(({ trackId, durationPlayedMillis }) => 
              musicLibrary
                .track(trackId)
                .then(track => {
                  if(shouldScrobble(track, durationPlayedMillis / 1000))
                    return musicLibrary.scrobble(trackId).then(scrobbled => ({ trackId, scrobbled }))
                  else
                    return Promise.resolve({ trackId, scrobbled: false })
                })
            );
          return Promise.all(scrobbles)
        })
        .then(it => res.status(200).json({ 
          scrobbled: it.filter(scrobble => scrobble.scrobbled).length 
        }));
    }
  }),

  app.get("/stream/track/:id", async (req, res) => {
    const id = req.params["id"]!;
    const trace = uuid();
    
    logger.debug(
      `${trace} bnb<- ${req.method} ${req.path}?${JSON.stringify(
        req.query
      )}, headers=${JSON.stringify({ ...req.headers, "authorization": "*****" })}`
    );

    const serviceToken = pipe(
      E.fromNullable("Missing authorization header")(req.headers["authorization"] as string),
      E.chain((authorization) =>
        pipe(
          apiTokens.authTokenFor(authorization),
          E.fromNullable("Failed to find matching API token, or API token has expired"),
          E.map((authToken) =>
            serviceTokenForScopedApiToken(authToken, "stream", {
              allowLegacy: true,
            })
          ),
          E.chain(E.fromNullable("API token scope is not authorized for streams"))
        )
      ),
      E.getOrElseW(() => undefined)
    )

    if (!serviceToken) {
      return res.status(401).send();
    } else {
      return musicService
        .login(serviceToken)
        .then((it) =>
          it
            .stream({
              trackId: id,
              range: req.headers["range"] || undefined,
            })
            .then((stream) => {
              res.on('close', () => {
                stream.stream.destroy()
              });
              return stream;
            })
            .then((stream) => ({ musicLibrary: it, stream }))
        )
        .then(({ musicLibrary, stream }) => {
          logger.debug(
            `${trace} bnb<- stream response from music service for ${id}, status=${stream.status}, headers=(${JSON.stringify(stream.headers)})`
          );

          // An upstream 200 with no content-type used to throw here (undefined.split), and
          // collapsing it to "" then shipped a bare `Content-Type:` header. Omitting it is not the
          // answer either: Express then supplies its own default of "text/html; charset=utf-8",
          // which is actively wrong for an audio stream and could have a client try to render it.
          // Answer "bytes of unknown type" explicitly instead, which is true and misleads nobody -
          // Sonos still has the mimeType SMAPI declared for the track.
          const sonosisfyContentType = (contentType: string | undefined) =>
            contentType === undefined || contentType === ""
              ? "application/octet-stream"
              : contentType
              .split(";")
              .map((it) => it.trim())
              .map(sonosifyMimeType)
              .join("; ");

          const respondWith = ({
            status,
            filter,
            headers,
            sendStream,
            nowPlaying,
          }: {
            status: number;
            filter: Transform;
            // Absent upstream headers are passed through as undefined and dropped below, rather
            // than being asserted as strings and set as the literal "undefined".
            headers: Record<string, string | undefined>;
            sendStream: boolean;
            nowPlaying: boolean;
          }) => {
            logger.debug(
              `${trace} bnb-> ${req.path}, status=${status}, headers=${JSON.stringify(headers)}`
            );
            (nowPlaying
              ? musicLibrary.nowPlaying(id)
              : Promise.resolve(true)
            ).then((_) => {
              res.status(status);
              Object.entries(headers)
                .filter(([_, v]) => v !== undefined)
                .forEach(([header, value]) => {
                  res.setHeader(header, value!);
                });
              if (sendStream) {
                // pipe() does NOT forward errors. Without this listener, a mid-song ECONNRESET
                // from Navidrome (a restart, a library scan, a network blip) emits 'error' on a
                // stream nobody is listening to, which in Node is an UNCAUGHT EXCEPTION and kills
                // the process - taking the whole household's music down until Docker restarts it,
                // and losing every in-memory link code and API token with it. The existing
                // res.on("close") handler covers the CLIENT going away, not the upstream failing.
                stream.stream.on("error", (e: Error) => {
                  logger.warn(
                    `Upstream audio stream failed mid-response: ${describeReason(e)}`
                  );
                  res.destroy();
                });
                filter.on("error", () => res.destroy());
                stream.stream.pipe(filter).pipe(res);
              } else res.send()
            });
          };

          if (stream.status == 200) {
            respondWith({
              status: 200,
              filter: new PassThrough(),
              headers: {
                "content-type": sonosisfyContentType(
                  stream.headers["content-type"]
                ),
                "content-length": stream.headers["content-length"],
                "accept-ranges": stream.headers["accept-ranges"],
              },
              sendStream: req.method == "GET",
              nowPlaying: req.method == "GET",
            });
          } else if (stream.status == 206) {
            respondWith({
              status: 206,
              filter: new PassThrough(),
              headers: {
                "content-type": sonosisfyContentType(
                  stream.headers["content-type"]
                ),
                "content-length": stream.headers["content-length"],
                "content-range": stream.headers["content-range"],
                "accept-ranges": stream.headers["accept-ranges"],
              },
              sendStream: req.method == "GET",
              nowPlaying: req.method == "GET",
            });
          } else {
            respondWith({
              status: stream.status,
              filter: new PassThrough(),
              headers: {},
              sendStream: req.method == "GET",
              nowPlaying: false,
            });
          }
        });
    }
  });

  app.get("/icon/:type_text/size/:size", (req, res) => {
    const apply_festivals = req.query["nofest"] == null
    const match = (req.params["type_text"] || "")!.match("^([A-Za-z0-9]+)(?:\:([A-Za-z0-9]+))?$")
    if (!match)
      return res.status(400).send();
    
    const type = match[1]!
    const text = match[2]
    const size = req.params["size"]!;

    if (!Object.keys(ICONS).includes(type)) {
      return res.status(404).send();
    } else if (size != "legacy" && !SONOS_RECOMMENDED_IMAGE_SIZES.includes(size)) {
      return res.status(400).send();
    } else {
      let icon = (ICONS as any)[type]! as Icon;
      const spec =
        size == "legacy"
          ? {
            mimeType: "image/png",
            responseFormatter: (svg: string): Promise<Buffer | string> =>
              sharp(Buffer.from(svg)).resize(80).png().toBuffer(),
          }
          : {
            mimeType: "image/svg+xml",
            responseFormatter: (svg: string): Promise<Buffer | string> =>
              Promise.resolve(svg),
          };

      return Promise.resolve(
        icon
          .apply(
            features({
              ...serverOpts.iconColors,
              text: text
            })
          )
          .apply(apply_festivals ? festivals(clock) : no_festivals)
          .toString()
      )
        .then(spec.responseFormatter)
        .then((data) =>
          res
            .status(200)
            // festival overlays are date-dependent, so only long-cache when they
            // are disabled (?nofest); otherwise keep it short so a decoration
            // doesn't stay frozen across a festival boundary for a whole day.
            .set(
              "Cache-Control",
              `public, max-age=${apply_festivals ? 3600 : 86400}`
            )
            .type(spec.mimeType)
            .send(data)
        );
    }
  });

  app.get("/icons", (_, res) => {
    res.render("icons", {
      icons: Object.keys(ICONS).map((k) => [
        k,
        ((ICONS as any)[k] as Icon)
          .apply(
            features({
              viewPortIncreasePercent: 80,
              ...serverOpts.iconColors,
            })
          )
          .toString()
          .replace('<?xml version="1.0" encoding="UTF-8"?>', ""),
      ]),
    });
  });

  app.get("/art/:burn/size/:size", (req, res) => {
    const serviceToken = serviceTokenForScopedApiToken(
      apiTokens.authTokenFor(req.query[BONOB_ACCESS_TOKEN_HEADER] as string),
      "art",
      { allowLegacy: true }
    );
    const size = Number.parseInt(req.params["size"]!);

    if (!serviceToken) {
      return res.status(401).send();
    } else if (!(size > 0)) {
      return res.status(400).send();
    }

    let urn: BUrn;
    try {
      urn = parse(req.params["burn"]!);
    } catch {
      logger.warn("rejected art request: malformed or unparseable burn");
      res.setHeader("Cache-Control", "no-store");
      return res.status(400).send();
    }

    if (urn.system == "external" && !isSafeExternalImageUrl(urn.resource)) {
      logger.warn("rejected art request: unsafe external resource");
      res.setHeader("Cache-Control", "no-store");
      return res.status(400).send();
    }

    logger.debug(`Getting art for system ${urn.system} in size ${size}`)

    return musicService
      .login(serviceToken)
      .then((musicLibrary) => {
        if (urn.system == "deezer") {
          // Resolve the artist name to a real Deezer photo URL (cached), then proxy the image with
          // a redirect-refusing fetcher (the allowlist only validated the initial dzcdn.net URL).
          return serverOpts
            .deezerArtistImage(urn.resource)
            .then((url) =>
              url ? serverOpts.deezerImageResolver(url) : undefined
            );
        } else if (urn.system == "external") {
          return serverOpts.externalImageResolver(urn.resource);
        } else {
          return musicLibrary.coverArt(urn, size);
        }
      })
      .then((coverArt) => {
        // Artist art resolves through the EXTERNAL pipeline (deezer / external), which for most
        // non-mainstream artists either has no photo at all or hands back an error document rather
        // than an image. Measured on the production library, 2 of 3 artist search hits failed here
        // while 20 of 20 album hits served fine, because album art always resolves through
        // Navidrome. A search result whose art fails to load is a tile the client may refuse to
        // render, so BOTH artist failure modes end in the generic artist icon rather than an error.
        //
        // Album/track art (the subsonic system) deliberately keeps its 404/502: Navidrome supplies
        // its own placeholder, so a failure there means something genuinely went wrong and should
        // stay visible rather than being papered over.
        const isArtistArt = urn.system == "deezer" || urn.system == "external";
        const serveArtistPlaceholder = () =>
          Promise.resolve(
            ICONS["artists"]!
              .apply(features({ ...serverOpts.iconColors }))
              .apply(no_festivals)
              .toString()
          )
            .then((svg) => sharp(Buffer.from(svg)).resize(size).png().toBuffer())
            .then((data) => {
              res.status(200);
              res.setHeader("content-type", "image/png");
              res.setHeader("X-Content-Type-Options", "nosniff");
              // Short cache: the artist may gain a real photo upstream later.
              res.setHeader("Cache-Control", "private, max-age=3600");
              return res.send(data);
            });

        if (coverArt == undefined) {
          if (isArtistArt) return serveArtistPlaceholder();
          res.setHeader("Cache-Control", "private, max-age=60");
          return res.status(404).send();
        } else if (
          (coverArt.contentType || "").toLowerCase().startsWith("image/") &&
          isValidMimeType(coverArt.contentType)
        ) {
          // Only serve genuine images. An upstream error page / hotlink HTML must never be cached
          // and served as art; nosniff stops a client re-interpreting the bytes.
          res.status(200);
          res.setHeader("content-type", coverArt.contentType);
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Cache-Control", "private, max-age=86400");
          return res.send(coverArt.data);
        } else {
          logger.warn(`Refusing to serve a 200 response with a non-image content type (${coverArt.contentType}) as art`);
          // Observed live during a Sonos search: the external artist-art pipeline handed back
          // application/xml (an upstream error document) with a 200, which became a 502 and a
          // broken artist tile. Same user-visible outcome as the missing-photo case, so it takes
          // the same placeholder rather than an error the client has to render around.
          if (isArtistArt) return serveArtistPlaceholder();
          res.setHeader("Cache-Control", "no-store");
          return res.status(502).send();
        }
    })
      .catch((e: Error) => {
        // Do NOT log the raw urn / id / username / upstream body: a transient throttle is
        // expected and identifiers must not leak. A CoverArtUnavailableError (429/5xx/timeout/
        // network/coordinator busy) is a capacity failure -> 503 + no-store + a small Retry-After
        // so clients/caches back off without retry-storming. Anything else is an unexpected
        // programming error -> 500 + no-store.
        res.setHeader("Cache-Control", "no-store");
        if (e instanceof CoverArtUnavailableError) {
          res.setHeader("Retry-After", "5");
          return res.status(503).send();
        }
        return res.status(500).send();
      });
  });

  bindSmapiSoapServiceToExpress(
    app,
    SOAP_PATH,
    bonobUrl,
    linkCodes,
    musicService,
    apiTokens,
    clock,
    i8n,
    serverOpts.smapiAuthTokens
  );

  if (serverOpts.applyContextPath) {
    const container = express();
    container.use(bonobUrl.path(), app);
    return container;
  } else {
    return app;
  }
}

export default server;

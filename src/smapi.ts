import crypto from "crypto";
import { Express, Request } from "express";
import { listen } from "soap";
import { readFileSync } from "fs";
import path from "path";
import { option as O, either as E, taskEither as TE, task as T } from "fp-ts";
import { pipe } from "fp-ts/lib/function";

import logger from "./logger";

import { LinkCodes } from "./link_codes";
import {
  AlbumQuery,
  AlbumSummary,
  ArtistSummary,
  Genre,
  Year,
  MusicService,
  RadioStation,
  Rating,
  range,
  slice2,
  Track,
  TrackSummary,
  PlaylistSummary
} from "./music_library";
import { APITokens, scopedApiTokenPayload } from "./api_tokens";
import { Clock } from "./clock";
import { URLBuilder } from "./url_builder";
import { asLANGs, I8N } from "./i8n";
import { ICON, iconForGenre } from "./icon";
import _ from "underscore";
import { BUrn, formatForURL } from "./burn";
import {
  albumIndexLetters,
  albumIndexLetterTotal,
  MAX_ALBUMS_FLAT,
} from "./album_index";
import { readAlbumIndexPage, readAlbumIndexAll } from "./album_snapshot";
import { MAX_ARTISTS_FLAT } from "./artist_index";
import { withTimeout, SMAPI_BROWSE_TIMEOUT_MS, faultOrFallback } from "./timeout";
import {
  isExpiredTokenError,
  MissingLoginTokenError,
  SmapiAuthTokens,
  SMAPI_FAULT_LOGIN_UNAUTHORIZED,
  ToSmapiFault,
} from "./smapi_auth";
import { IncomingHttpHeaders } from "http";
import { sanitizeLogValue } from "./utils";

export const LOGIN_ROUTE = "/login";
export const SOAP_PATH = "/ws/sonos";
export const STRINGS_ROUTE = "/sonos/strings.xml";
export const PRESENTATION_MAP_ROUTE = "/sonos/presentationMap.xml";
export const SONOS_RECOMMENDED_IMAGE_SIZES = [
  "60",
  "80",
  "120",
  "180",
  "192",
  "200",
  "230",
  "300",
  "600",
  "640",
  "750",
  "1000",
  "1242",
  "1500",
];

const WSDL_FILE = path.resolve(
  __dirname,
  "Sonoswsdl-1.19.6-20231024.wsdl"
);


export type LoginToken = {
    token: string;
    householdId: string;
}

export type Credentials = {
  loginToken: LoginToken;
  deviceId: string;
  deviceProvider: string;
};

export type GetAppLinkResult = {
  getAppLinkResult: {
    authorizeAccount: {
      appUrlStringId: string;
      deviceLink: { regUrl: string; linkCode: string; showLinkCode: boolean };
    };
  };
};

export type GetDeviceAuthTokenResult = {
  getDeviceAuthTokenResult: {
    authToken: string;
    // Required by Sonos S2: the WSDL declares privateKey in deviceAuthTokenResult.
    // Omitting it makes the S2 app reject the token and abort "Add Service".
    privateKey: string;
    // todo: appears this thing can be optional
    userInfo: {
      userIdHashCode: string;
      nickname: string;
    };
  };
};

export const ratingAsInt = (rating: Rating): number =>
  rating.stars * 10 + (rating.love ? 1 : 0) + 100;

export const ratingFromInt = (value: number): Rating => {
  const x = value - 100;
  return { love: x % 10 == 1, stars: Math.floor(x / 10) };
};

export type MediaCollection = {
  id: string;
  itemType: "collection";
  title: string;
};

export type getMetadataResult = {
  count: number;
  index: number;
  total: number;
  mediaCollection?: any[];
  mediaMetadata?: any[];
};

export type GetMetadataResponse = {
  getMetadataResult: getMetadataResult;
};

// Characters that are illegal in XML 1.0 (control chars, U+FFFE/FFFF). Music tags routinely carry
// junk like a stray \x04; leaving it in a title produces a malformed SOAP response that Sonos
// rejects wholesale (one bad album breaks the whole page). Strip it from all emitted text.
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

// Unpaired UTF-16 surrogates are also illegal in XML 1.0: a high surrogate not followed by a low,
// or a low not preceded by a high. Strip those while leaving valid pairs (emoji) intact.
const LONE_SURROGATES =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const sanitizeXml = (value: any): any => {
  if (typeof value === "string")
    return value.replace(XML_INVALID_CHARS, "").replace(LONE_SURROGATES, "");
  if (Array.isArray(value)) return value.map(sanitizeXml);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = sanitizeXml(value[k]);
    return out;
  }
  return value;
};

export function getMetadataResult(
  result: Partial<getMetadataResult>
): GetMetadataResponse {
  const count =
    (result?.mediaCollection?.length || 0) +
    (result?.mediaMetadata?.length || 0);
  return {
    getMetadataResult: {
      count,
      index: 0,
      total: count,
      ...result,
      ...(result.mediaCollection && {
        mediaCollection: sanitizeXml(result.mediaCollection),
      }),
      ...(result.mediaMetadata && {
        mediaMetadata: sanitizeXml(result.mediaMetadata),
      }),
    },
  };
}

export type SearchResponse = {
  searchResult: getMetadataResult;
};

export function searchResult(
  result: Partial<getMetadataResult>
): SearchResponse {
  const count =
    (result?.mediaCollection?.length || 0) +
    (result?.mediaMetadata?.length || 0);
  return {
    searchResult: {
      count,
      index: 0,
      total: count,
      ...result,
      ...(result.mediaCollection && {
        mediaCollection: sanitizeXml(result.mediaCollection),
      }),
      ...(result.mediaMetadata && {
        mediaMetadata: sanitizeXml(result.mediaMetadata),
      }),
    },
  };
}

class SonosSoap {
  linkCodes: LinkCodes;
  bonobUrl: URLBuilder;
  smapiAuthTokens: SmapiAuthTokens;
  clock: Clock;

  constructor(
    bonobUrl: URLBuilder,
    linkCodes: LinkCodes,
    smapiAuthTokens: SmapiAuthTokens,
    clock: Clock
  ) {
    this.bonobUrl = bonobUrl;
    this.linkCodes = linkCodes;
    this.smapiAuthTokens = smapiAuthTokens;
    this.clock = clock;
  }

  getAppLink(): GetAppLinkResult {
    const linkCode = this.linkCodes.mint();
    return {
      getAppLinkResult: {
        authorizeAccount: {
          appUrlStringId: "AppLinkMessage",
          deviceLink: {
            regUrl: this.bonobUrl
              .append({ pathname: LOGIN_ROUTE })
              .with({ searchParams: { linkCode } })
              .href(),
            linkCode: linkCode,
            showLinkCode: false,
          },
        },
      },
    };
  }

  reportAccountAction = (_: { type: string }) => ({})

  getDeviceAuthToken({
    linkCode,
  }: {
    linkCode: string;
  }): GetDeviceAuthTokenResult {
    const association = this.linkCodes.associationFor(linkCode);
    if (association) {
      const smapiAuthToken = this.smapiAuthTokens.issue(
        association.serviceToken
      );
      return {
        getDeviceAuthTokenResult: {
          authToken: smapiAuthToken.token,
          // Sonos sentinel meaning "I don't issue refreshable private keys".
          // bonob doesn't implement private-key refresh, so this is the correct
          // value (a random/opaque key here makes S2 abort the add).
          privateKey: "alwaysReauthenticate",
          // userIdHashCode must precede nickname to match the WSDL xs:sequence.
          userInfo: {
            userIdHashCode: crypto
              .createHash("sha256")
              .update(association.userId)
              .digest("hex"),
            nickname: association.nickname,
          },
        },
      };
    } else {
      logger.info(
        "Client not linked, awaiting user to associate account with link code by logging in."
      );
      throw {
        Fault: {
          faultcode: "Client.NOT_LINKED_RETRY",
          faultstring:
            "Link Code not found yet, sonos app will keep polling until you log in to bonob",
          detail: {
            ExceptionInfo: "NOT_LINKED_RETRY",
            SonosError: "5",
          },
        },
      };
    }
  }
}

export type ContainerType = "container" | "search" | "albumList";

export type Container = {
  itemType: ContainerType;
  id: string;
  title: string;
  displayType: string | undefined;
};

// const collection = () => ({
//   itemType: "collection",
//   canScroll: false,
//   canPlay: false,
//   canEnumerate: true,
//   canAddToFavorites: true,
//   containsFavorite: false,
//   canSkip: true, 
// })

const genre = (bonobUrl: URLBuilder, genre: Genre) => ({
  itemType: "albumList",
  id: `genre:${genre.id}`,
  title: genre.name,
  albumArtURI: albumArtURI(iconArtURI(bonobUrl, iconForGenre(genre.name)).href()),
});

const yyyy = (bonobUrl: URLBuilder, year: Year) => ({
  itemType: "albumList",
  id: `year:${year.year}`,
  title: year.year,
  // todo: maybe year.year should be nullable?
  albumArtURI: albumArtURI(year.year !== "?" ? iconArtURI(bonobUrl, "yyyy", year.year).href() : iconArtURI(bonobUrl, "music").href()),
});

export const shouldScrobble = (track: Track, playbackTime: number) => (
  (track.duration < 30 && playbackTime >= 10) ||
  (track.duration >= 30 && playbackTime >= 30))

// canPlay: true,
// canEnumerate: true,
// canResume: false,
// attributes: {
//   readOnly: false,
//   userContent: true,
//   renameable: true,
// },


const playlist = (bonobUrl: URLBuilder, playlist: PlaylistSummary) => ({
  itemType: "playlist",
  id: `playlist:${playlist.id}`,
  title: playlist.name,
  albumArtURI: albumArtURI(coverArtURI(bonobUrl, playlist).href()),
  canPlay: true,
  attributes: {
    userContent: true,
  },  
});

export const coverArtURI = (
  bonobUrl: URLBuilder,
  { coverArt }: { coverArt?: BUrn | undefined }
) =>
  pipe(
    coverArt,
    O.fromNullable,
    O.map((it) =>
      bonobUrl.append({
        pathname: `/art/${encodeURIComponent(formatForURL(it))}/size/180`,
      })
    ),
    O.getOrElseW(() => iconArtURI(bonobUrl, "vinyl"))
  );

export const iconArtURI = (bonobUrl: URLBuilder, icon: ICON, text: string | undefined = undefined) =>
  bonobUrl.append({
    pathname: `/icon/${text == undefined ? icon : `${icon}:${text}`}/size/legacy`,
  });

export const sonosifyMimeType = (mimeType: string) =>
  mimeType == "audio/x-flac" ? "audio/flac" : mimeType;


/* This doesnt seem to work on S2, only S1, ChatGPT seems to imply it has been deprecated
even though there is no mention of that in the docs that i can find.
{
  attributes: {
      requiresAuthentication: true
  },
  $value: value
}
*/
const albumArtURI = (value: string) => value

export const album = (bonobUrl: URLBuilder, album: AlbumSummary) => ({
  itemType: "album",
  id: `album:${album.id}`,
  artist: album.artistName,
  artistId: `artist:${album.artistId}`,
  title: album.name,
  albumArtURI: albumArtURI(coverArtURI(bonobUrl, album).href()),
  canPlay: true,
  // defaults
  // canScroll: false,
  // canEnumerate: true,
  // canAddToFavorites: true
});

export const internetRadioStation = (station: RadioStation) => ({
  itemType: "stream",
  id: `internetRadioStation:${station.id}`,
  title: station.name,
  mimeType: "audio/mpeg",
});

export const track = (bonobUrl: URLBuilder, track: Track) => ({
  itemType: "track",
  id: `track:${track.id}`,
  mimeType: sonosifyMimeType(track.encoding.mimeType),
  title: track.name,

  trackMetadata: {
    album: track.album.name,
    albumId: `album:${track.album.id}`,
    albumArtist: track.artist.name,
    albumArtistId: track.artist.id ? `artist:${track.artist.id}` : undefined,
    albumArtURI: albumArtURI(coverArtURI(bonobUrl, track).href()),
    artist: track.artist.name,
    artistId: track.artist.id ? `artist:${track.artist.id}` : undefined,
    duration: track.duration,
    genre: track.album.genre?.name,
    genreId: track.album.genre?.id,
    trackNumber: track.number,
  },
  dynamic: {
    property: [{ name: "rating", value: `${ratingAsInt(track.rating)}` }],
  },
});

// Top songs come back from getTopSongs as TrackSummary (no album context), so they need album-free
// track metadata. Everything Sonos needs to play + display a track is present on the summary.
export const topSongMetadata = (bonobUrl: URLBuilder, t: TrackSummary) => ({
  itemType: "track",
  id: `track:${t.id}`,
  mimeType: sonosifyMimeType(t.encoding.mimeType),
  title: t.name,
  trackMetadata: {
    albumArtURI: albumArtURI(coverArtURI(bonobUrl, t).href()),
    artist: t.artist.name,
    artistId: t.artist.id ? `artist:${t.artist.id}` : undefined,
    duration: t.duration,
    genre: t.genre?.name,
    genreId: t.genre?.id,
    trackNumber: t.number,
  },
  dynamic: {
    property: [{ name: "rating", value: `${ratingAsInt(t.rating)}` }],
  },
});

// MAX_ALBUMS_FLAT now lives in album_index.ts (one source of truth); re-export it here
// so existing callers/tests importing it from smapi keep working.
export { MAX_ALBUMS_FLAT };

export const artist = (bonobUrl: URLBuilder, artist: ArtistSummary) => ({
  itemType: "artist",
  id: `artist:${artist.id}`,
  // The WSDL types artistId as tns:id - a browsable container id, not a backend key. album()
  // already emits the prefixed form (`artist:<id>`) and that is the shape Sonos demonstrably
  // accepts; this emitted the RAW Navidrome id, so an artist tile advertised an artistId that
  // resolves to nothing. Whether that is what makes the Sonos app drop artist search results is
  // unproven - the tiles are returned correctly at the SOAP layer either way - but an id-typed
  // field carrying a non-id is wrong regardless, and the two tile builders disagreeing is the kind
  // of asymmetry that hides a client-side bug.
  artistId: `artist:${artist.id}`,
  title: artist.name,
  albumArtURI: albumArtURI(coverArtURI(bonobUrl, { coverArt: artist.image }).href()),
});

export const splitId = (id: string) => {
  // Split on the FIRST colon only: subsonic ids can themselves contain colons (and our
  // synthetic ids like topSongs:<id> wrap them), so id.split(":")[1] would truncate the typeId.
  const sep = id.indexOf(":");
  return {
    type: sep < 0 ? id : id.slice(0, sep),
    typeId: sep < 0 ? "" : id.slice(sep + 1),
  };
}

export function withSplitId<T>(id: string) {
  return (t: T) => ({
    ...t,
    ...splitId(id)
  });
}

export type SoapyHeaders = {
  credentials?: {
    loginToken?: {
      // wsdl seems to imply that token is required, however in practice that doesnt seem to be true
      token?: string;
      key?: string;
      householdId: string;
    },
    deviceId?: string;
    deviceProvider?: string;
  };
};

type Auth = {
  serviceToken: string;
  apiKey: string;
};

function isAuth(thing: any): thing is Auth {
  return thing.serviceToken;
}

export function findLoginToken(
  soapHeaders: SoapyHeaders | undefined,
  httpRequestHeaders: IncomingHttpHeaders
): string | undefined {
  const soapToken = soapHeaders?.credentials?.loginToken?.token
  const httpRequestToken = httpRequestHeaders["authorization"]
  if(soapToken != undefined) return soapToken
  else if(httpRequestToken != undefined) return httpRequestToken.replace(/^Bearer /, "")
  else return undefined
}

function bindSmapiSoapServiceToExpress(
  app: Express,
  soapPath: string,
  bonobUrl: URLBuilder,
  linkCodes: LinkCodes,
  musicService: MusicService,
  apiKeys: APITokens,
  clock: Clock,
  i8n: I8N,
  smapiAuthTokens: SmapiAuthTokens
) {
  const sonosSoap = new SonosSoap(bonobUrl, linkCodes, smapiAuthTokens, clock);

  const artApiKeysByApiKey = new Map<string, string>();

  const urlWithToken = (accessToken: string) =>
    bonobUrl.append({
      searchParams: {
        bat: artApiKeysByApiKey.get(accessToken) ?? accessToken,
      },
    });

  const auth = (loginToken?: string): E.Either<ToSmapiFault, Auth> => {
    const tokenFrom = E.fromNullable(new MissingLoginTokenError());
    return pipe(
      tokenFrom(loginToken),
      E.chain((token) =>
        pipe(
          smapiAuthTokens.verify({
            token
          }),
          E.map((serviceToken) => ({
            serviceToken
          }))
        )
      ),
      E.map(({ serviceToken }) => {
        const apiKey = apiKeys.mint(serviceToken);
        artApiKeysByApiKey.set(
          apiKey,
          apiKeys.mint(scopedApiTokenPayload("art", serviceToken))
        );
        return { serviceToken, apiKey };
      })
    );
  };

  const login = async (loginToken?: string) => {
    const authOrFail = pipe(
      auth(loginToken),
      E.getOrElseW((fault) => fault)
    );
    if (isAuth(authOrFail)) {
      return musicService
        .login(authOrFail.serviceToken)
        .then((musicLibrary) => ({ ...authOrFail, musicLibrary }))
        .catch((_) => {
          throw SMAPI_FAULT_LOGIN_UNAUTHORIZED;
        });
    } else if (isExpiredTokenError(authOrFail)) {
      throw await pipe(
        musicService.refreshToken(authOrFail.expiredToken),
        TE.map((it) => smapiAuthTokens.issue(it.serviceToken)),
        TE.map((newToken) => ({
            Fault: {
              faultcode: "Client.TokenRefreshRequired",
              faultstring: "Token has expired",
              detail: {
                refreshAuthTokenResult: {
                  authToken: newToken.token,
                  privateKey: "nonsense",
                },
              },
            },
          })),
        TE.getOrElse(() => T.of(SMAPI_FAULT_LOGIN_UNAUTHORIZED))
      )();
    } else {
      throw authOrFail.toSmapiFault();
    }
  };

  const soapyService = listen(
    app,
    soapPath,
    {
      Sonos: {
        SonosSoap: {
          getAppLink: () => sonosSoap.getAppLink(),
          reportAccountAction: ({ type } : { type: string }) =>
            sonosSoap.reportAccountAction({ type }),
          getDeviceAuthToken: ({ linkCode }: { linkCode: string }) =>
            sonosSoap.getDeviceAuthToken({ linkCode }),
          getLastUpdate: () => ({
            getLastUpdateResult: {
              autoRefreshEnabled: true,
              favorites: clock.now().unix(),
              catalog: clock.now().unix(),
              pollInterval: 60,
            },
          }),
          refreshAuthToken: async (
            _, 
            _2, 
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) => {       
            const serviceToken = pipe(
              auth(findLoginToken(soapyHeaders, headers)),
              E.fold(
                (fault) =>
                  isExpiredTokenError(fault)
                    ? E.right(fault.expiredToken)
                    : E.left(fault),
                (creds) => E.right(creds.serviceToken)
              ),
              E.getOrElseW((fault) => {
                throw fault.toSmapiFault();
              })
            );
            return pipe(
              musicService.refreshToken(serviceToken),
              TE.map((it) => smapiAuthTokens.issue(it.serviceToken)),
              TE.map((it) => ({
                refreshAuthTokenResult: {
                  authToken: it.token,
                  privateKey: "nonsense",
                },
              })),
              TE.getOrElse((_) => {
                throw SMAPI_FAULT_LOGIN_UNAUTHORIZED;
              })
            )();
          },
          getMediaURI: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) => 
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(({ musicLibrary, apiKey, type, typeId }) => {
                switch (type) {
                  case "internetRadioStation":
                    return musicLibrary.radioStation(typeId).then((it) => ({
                      getMediaURIResult: it.url,
                    }));
                  case "track":
                    return {
                      getMediaURIResult: bonobUrl
                        .append({
                          pathname: `/stream/${type}/${typeId}`,
                        })
                        .href(),
                      httpHeaders: [
                        {
                          httpHeader: {
                            header: "authorization",
                            value: apiKey,
                          },
                        },
                      ],
                    };
                  default:
                    logger.info(`Sonos asked for an unsupported getMediaURI: ${type}:${typeId}`);
                    return {
                      getMediaURIResult: iconArtURI(bonobUrl, "error", "?").href(),
                    }
                  }
              }),
          getMediaMetadata: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(async ({ musicLibrary, apiKey, type, typeId }) => {
                switch (type) {
                  case "internetRadioStation":
                    return musicLibrary.radioStation(typeId).then((it) => ({
                      getMediaMetadataResult: internetRadioStation(it),
                    }));
                  case "track":
                    return musicLibrary.track(typeId!).then((it) => ({
                      getMediaMetadataResult: track(urlWithToken(apiKey), it),
                    }));
                  default:
                    logger.info(`Sonos asked for an unsupported getMediaMetadata: ${type}:${typeId}`);
                    return {
                      getMediaMetadataResult: {}
                    }
                }
              })
              // strip XML-invalid control chars from tag text so one bad tag can't break the page
              .then(sanitizeXml),
          search: async (
            { id, term }: { id: string; term: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) => {
            // A SUCCESSFUL search logged nothing, which made the one user-visible bug left in this
            // service undiagnosable: when artist results do not appear in the Sonos app, "the app
            // never issued an artists search" and "the app issued it, got results, and dropped
            // them" are indistinguishable from the outside - and they have OPPOSITE fixes
            // (re-register the service vs. fix the tile shape). One line settles it. Searches are
            // user-initiated and rare, so this is not chatty. The term is length-only: it is the
            // category and the count that discriminate, and a search term is the user's own data.
            logger.info(
              `SMAPI search: category=${sanitizeLogValue(id)} termLength=${(term ?? "").length}`
            );
            return withTimeout(login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(async ({ musicLibrary, apiKey }) => {
                switch (id) {
                  case "albums":
                    return musicLibrary.searchAlbums(term).then((it) =>
                      searchResult({
                        count: it.length,
                        mediaCollection: it.map((albumSummary) =>
                          album(urlWithToken(apiKey), albumSummary)
                        ),
                      })
                    );
                  case "artists":
                    return musicLibrary.searchArtists(term).then((it) =>
                      searchResult({
                        count: it.length,
                        mediaCollection: it.map((artistSummary) =>
                          artist(urlWithToken(apiKey), artistSummary)
                        ),
                      })
                    );
                  case "tracks":
                    return musicLibrary.searchTracks(term).then((it) => {
                      // Track hits are rendered as ALBUM tiles, so several hits from one album used
                      // to produce several identical tiles - visually redundant, and each carried
                      // the matching song's own art id, giving one distinct /art url per hit and
                      // defeating the cover-art coordinator's coalescing (up to 20x the fetches).
                      // Deduplicating by album fixes both, and keeps the art id the SERVER returned
                      // rather than one synthesized from the album id: OpenSubsonic specifies that
                      // getCoverArt takes the opaque coverArt value, so deriving it from albumId
                      // works on Navidrome but is not portable.
                      const byAlbum = new Map<string, AlbumSummary>();
                      for (const aTrack of it) {
                        if (!byAlbum.has(aTrack.album.id))
                          byAlbum.set(aTrack.album.id, aTrack.album);
                      }
                      const albums = [...byAlbum.values()];
                      return searchResult({
                        count: albums.length,
                        mediaCollection: albums.map((it) =>
                          album(urlWithToken(apiKey), it)
                        ),
                      });
                    });
                  default:
                    logger.info(`Sonos asked for an unsupported search of: ${id}, term=${term}`);
                    return searchResult({
                      count: 0,
                      mediaCollection: [],
                    })
                }
              }),
              SMAPI_BROWSE_TIMEOUT_MS,
              searchResult({ count: 0, mediaCollection: [] }),
              // Named per category, because the whole point is to tell WHICH search degrades. A
              // category whose backend work outruns the deadline returns an empty result, which in
              // the Sonos app looks exactly like "nothing matched".
              `search:${id}`
            ).catch(
              faultOrFallback(
                searchResult({ count: 0, mediaCollection: [] }),
                `search:${id}`
              )
            );
          },
          getExtendedMetadata: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            withTimeout(login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(async ({ musicLibrary, apiKey, type, typeId }) => {
                switch (type) {
                  case "artist":
                    return musicLibrary
                      .artist(typeId)
                      .then((it) => ({
                        getExtendedMetadataResult: {
                          mediaCollection: artist(urlWithToken(apiKey), it),
                          relatedBrowse: it
                            .similarArtists
                            .filter((it) => it.inLibrary)
                            .length > 0
                            ? ([{ id: `relatedArtists:${it.id}`, type: "RELATED_ARTISTS" }])
                            : [],
                          // A relatedText marker tells Sonos a bio exists; it then fetches the
                          // body via getExtendedMetadataText(id, ARTIST_BIO).
                          ...(it.biography
                            ? { relatedText: [{ id: `artist:${it.id}`, type: "ARTIST_BIO" }] }
                            : {}),
                        },
                      }));
                  case "track":
                    return musicLibrary
                      .track(typeId)
                      .then((it) => ({
                        getExtendedMetadataResult: {
                          mediaMetadata: track(urlWithToken(apiKey), it),
                        },
                      }));
                  case "album":
                    return musicLibrary.album(typeId).then((it) => ({
                      getExtendedMetadataResult: {
                        // todo: can these go in the album function?  Also used in search....
                        mediaCollection: {
                          attributes: {
                            readOnly: true,
                            userContent: false,
                            renameable: false,
                          },
                          ...album(urlWithToken(apiKey), it),
                        },
                      },
                    }));
                  case "playlist":
                    return musicLibrary
                      .playlist(typeId!)
                      .then(it => ({
                        getExtendedMetadataResult: {
                          mediaCollection: playlist(urlWithToken(apiKey), it),
                        },
                      }));                    
                  default:
                    logger.info(`Sonos requested extended meta data for currently unsupported type=${type}, typeId=${typeId}`)
                    return {
                      getExtendedMetadataResult: {}
                    };
                }
              })
              .then(sanitizeXml),
              SMAPI_BROWSE_TIMEOUT_MS,
              { getExtendedMetadataResult: {} },
              `getExtendedMetadata:${id}`
            ).catch(
              faultOrFallback({ getExtendedMetadataResult: {} }, `getExtendedMetadata:${id}`)
            ),
          getExtendedMetadataText: async (
            { id, type: textType }: { id: string; type: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            withTimeout(
              login(findLoginToken(soapyHeaders, headers))
                .then(withSplitId(id))
                .then(async ({ musicLibrary, type, typeId }) => {
                  if (textType === "ARTIST_BIO" && type === "artist") {
                    return musicLibrary
                      .artist(typeId)
                      .then((it) => ({
                        getExtendedMetadataTextResult: it.biography || "",
                      }));
                  }
                  logger.info(
                    `Sonos requested extended metadata text for currently unsupported type=${textType}, id=${id}`
                  );
                  return { getExtendedMetadataTextResult: "" };
                })
                .then(sanitizeXml),
              SMAPI_BROWSE_TIMEOUT_MS,
              { getExtendedMetadataTextResult: "" },
              `getExtendedMetadataText:${textType}`
            ).catch(
              faultOrFallback(
                { getExtendedMetadataTextResult: "" },
                `getExtendedMetadataText:${textType}`
              )
            ),
          getMetadata: async (
            {
              id,
              index,
              count,
            }: // recursive,
            { id: string; index: number; count: number; recursive: boolean },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) => {
            // Browse deadline (below Sonos's ~5s SMAPI timeout): if a handler hangs or rejects on a
            // slow/flaky backend, return a "please try again" placeholder rather than a Sonos error.
            const browseTimeoutFallback = getMetadataResult({
              mediaCollection: [
                { itemType: "container", id, title: "Loading, please try again..." },
              ],
              index: 0,
              total: 1,
            });
            return withTimeout(login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(({ musicLibrary, apiKey, type, typeId }) => {
                const paging = { _index: index, _count: count };
                const acceptLanguage = headers["accept-language"];
                logger.debug(
                  `Fetching metadata type=${type}, typeId=${typeId}, acceptLanguage=${acceptLanguage}`
                );
                const lang = i8n(...asLANGs(acceptLanguage));

                const albums = (q: AlbumQuery): Promise<GetMetadataResponse> =>
                  musicLibrary.albums(q).then((result) => {
                    return getMetadataResult({
                      mediaCollection: result.results.map((it) =>
                        album(urlWithToken(apiKey), it)
                      ),
                      index: paging._index,
                      total: result.total,
                    });
                  });

                switch (type) {
                  case "root":
                    return getMetadataResult({
                      mediaCollection: [
                        {
                          id: "artists",
                          title: lang("artists"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "artists").href()),
                          itemType: "container",
                        },
                        {
                          id: "albums",
                          title: lang("albums"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "albums").href()),
                          itemType: "albumList",
                        },
                        {
                          id: "randomAlbums",
                          title: lang("random"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "random").href()),
                          itemType: "albumList",
                        },
                        {
                          id: "favouriteAlbums",
                          title: lang("favourites"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "heart").href()),
                          itemType: "albumList",
                        },
                        {
                          id: "favouriteSongs",
                          title: "Favourite Songs",
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "heart").href()),
                          itemType: "trackList",
                        },
                        {
                          id: "starredAlbums",
                          title: lang("topRated"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "star").href()),
                          itemType: "albumList",
                        },
                        {
                          id: "playlists",
                          title: lang("playlists"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "playlists").href()),
                          itemType: "collection",
                          attributes: {
                            userContent: true,
                          },
                        },
                        {
                          id: "genres",
                          title: lang("genres"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "genres").href()),
                          itemType: "container",
                        },
                        {
                          id: "years",
                          title: lang("years"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "music").href()),
                          itemType: "container",
                        },
                        {
                          id: "recentlyAdded",
                          title: lang("recentlyAdded"),
                          albumArtURI: albumArtURI(iconArtURI(
                            bonobUrl,
                            "recentlyAdded"
                          ).href()),
                          itemType: "albumList",
                        },
                        {
                          id: "recentlyPlayed",
                          title: lang("recentlyPlayed"),
                          albumArtURI: albumArtURI(iconArtURI(
                            bonobUrl,
                            "recentlyPlayed"
                          ).href()),
                          itemType: "albumList",
                        },
                        {
                          id: "mostPlayed",
                          title: lang("mostPlayed"),
                          albumArtURI: albumArtURI(iconArtURI(
                            bonobUrl,
                            "mostPlayed"
                          ).href()),
                          itemType: "albumList",
                        },
                        {
                          id: "internetRadio",
                          title: lang("internetRadio"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "radio").href()),
                          itemType: "stream",
                        },
                      ],
                    });
                  case "search":
                    return getMetadataResult({
                      mediaCollection: [
                        {
                          itemType: "search",
                          id: "artists",
                          title: lang("artists"),
                        },
                        {
                          itemType: "search",
                          id: "albums",
                          title: lang("albums"),
                        },
                        {
                          itemType: "search",
                          id: "tracks",
                          title: lang("tracks"),
                        },
                      ],
                    });
                  case "artists": {
                    // The artist index is the cached getArtists response with Navidrome's index-letter
                    // grouping preserved (NOT re-derived from names). Warm -> serve the flat list for a
                    // small catalog, or the A-Z letter menu for a large one (no single container may
                    // advertise the whole-catalog artist total — the same S2 ceiling that forced albums
                    // into buckets). Cold -> kick the warm and return a bounded placeholder, exactly as
                    // the Albums branch does.
                    const artistsPlaceholder = () =>
                      getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "container",
                            id: "artists",
                            title: "Loading your artists… (open again shortly)",
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "artists").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    const peekedArtists = musicLibrary.peekArtistIndex();
                    if (peekedArtists) {
                      return peekedArtists.then(async (idx) => {
                        // A catalog that shrank back under the cap can still serve flat from the index.
                        if (idx.total <= MAX_ARTISTS_FLAT) {
                          return getMetadataResult({
                            mediaCollection: (
                              await readAlbumIndexAll(
                                idx,
                                paging._index,
                                paging._count
                              )
                            ).map((it) => artist(urlWithToken(apiKey), it)),
                            index: paging._index,
                            total: idx.total,
                          });
                        }
                        const letters = albumIndexLetters(idx);
                        return getMetadataResult({
                          mediaCollection: letters.map((b) => ({
                            itemType: "container",
                            id: `artistsByLetter:${b.key}`,
                            title: b.label,
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "artists").href()
                            ),
                          })),
                          index: 0,
                          total: letters.length,
                        });
                      });
                    }
                    // Cold: never block the browse on the multi-second getArtists. Kick the warm and
                    // show the retry placeholder.
                    void musicLibrary.artistIndex().catch(() => undefined);
                    return artistsPlaceholder();
                  }
                  case "artistsByLetter": {
                    const peekedLetter = musicLibrary.peekArtistIndex();
                    if (!peekedLetter) {
                      // Never block a leaf browse on the multi-second getArtists; kick the warm and
                      // show the retry placeholder instead.
                      void musicLibrary.artistIndex().catch(() => undefined);
                      return getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "container",
                            id: `artistsByLetter:${typeId}`,
                            title: "Loading your artists… (open again shortly)",
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "artists").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    }
                    return peekedLetter.then(async (idx) => {
                      const letterTotal = albumIndexLetterTotal(idx, typeId);
                      if (letterTotal > MAX_ARTISTS_FLAT) {
                        // A single letter is itself too big for one S2 container; split it into
                        // fixed-size sub-buckets so no leaf ever advertises an oversized total.
                        const chunks = Math.ceil(letterTotal / MAX_ARTISTS_FLAT);
                        const chunkIndexes = range(chunks).slice(
                          paging._index,
                          paging._index + paging._count
                        );
                        return getMetadataResult({
                          mediaCollection: chunkIndexes.map((i) => ({
                            itemType: "container",
                            id: `artistsChunk:${typeId}_${i}`,
                            title: `${typeId} · part ${i + 1}`,
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "artists").href()
                            ),
                          })),
                          index: paging._index,
                          total: chunks,
                        });
                      }
                      // Serve the letter's page straight from the index (drift-proof: no live
                      // re-fetch by offset). Advertise only this letter's total.
                      const page = await readAlbumIndexPage(
                        idx,
                        typeId,
                        paging._index,
                        paging._count
                      );
                      return getMetadataResult({
                        mediaCollection: page.items.map((it) =>
                          artist(urlWithToken(apiKey), it)
                        ),
                        index: paging._index,
                        total: page.total,
                      });
                    });
                  }
                  case "artistsChunk": {
                    // A sub-bucket of an oversized letter: "artistsChunk:<key>_<n>". Parse from the
                    // right so a "#" key works (mirrors albumsChunk).
                    const sep = typeId.lastIndexOf("_");
                    const chunkKey = sep >= 0 ? typeId.slice(0, sep) : typeId;
                    const chunkText = sep >= 0 ? typeId.slice(sep + 1) : "0";
                    const chunk = Number(chunkText);
                    if (!/^\d+$/.test(chunkText) || !Number.isSafeInteger(chunk)) {
                      return getMetadataResult({
                        mediaCollection: [],
                        index: paging._index,
                        total: 0,
                      });
                    }
                    const peekedChunk = musicLibrary.peekArtistIndex();
                    if (!peekedChunk) {
                      void musicLibrary.artistIndex().catch(() => undefined);
                      return getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "container",
                            id: `artistsChunk:${typeId}`,
                            title: "Loading your artists… (open again shortly)",
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "artists").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    }
                    return peekedChunk.then(async (idx) => {
                      const base = chunk * MAX_ARTISTS_FLAT;
                      const letterTotal = albumIndexLetterTotal(idx, chunkKey);
                      const chunkTotal = Math.max(
                        0,
                        Math.min(MAX_ARTISTS_FLAT, letterTotal - base)
                      );
                      const take = Math.min(
                        paging._count,
                        Math.max(0, chunkTotal - paging._index)
                      );
                      const page = await readAlbumIndexPage(
                        idx,
                        chunkKey,
                        base + paging._index,
                        take
                      );
                      return getMetadataResult({
                        mediaCollection: page.items.map((it) =>
                          artist(urlWithToken(apiKey), it)
                        ),
                        index: paging._index,
                        total: chunkTotal,
                      });
                    });
                  }
                  case "albums": {
                    const albumsPlaceholder = () =>
                      getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "albumList",
                            id: "albums",
                            title: "Loading your albums… (open again shortly)",
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "albums").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    // 1. Index warm -> the catalog is large (the index is only built for large
                    // catalogs) -> serve the bucketed A-Z menu. No count fetch, never blocks.
                    const peekedAlbums = musicLibrary.peekAlbumIndex();
                    if (peekedAlbums) {
                      return peekedAlbums.then(async (idx) => {
                        // A catalog that shrank back under the cap can still serve flat from the
                        // snapshot; otherwise the A-Z letter menu.
                        if (idx.total <= MAX_ALBUMS_FLAT) {
                          return getMetadataResult({
                            mediaCollection: (
                              await readAlbumIndexAll(
                                idx,
                                paging._index,
                                paging._count
                              )
                            ).map((it) => album(urlWithToken(apiKey), it)),
                            index: paging._index,
                            total: idx.total,
                          });
                        }
                        const letters = albumIndexLetters(idx);
                        return getMetadataResult({
                          mediaCollection: letters.map((b) => ({
                            itemType: "albumList",
                            id: `albumsByLetter:${b.key}`,
                            title: b.label,
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "albums").href()
                            ),
                          })),
                          index: 0,
                          total: letters.length,
                        });
                      });
                    }
                    // 2. Not indexed. Decide small vs large from the NON-BLOCKING cached count -
                    // never a cold multi-second getArtists on this live browse.
                    const peekedCount = musicLibrary.peekAlbumCount();
                    if (!peekedCount) {
                      // Not even the count is warm: kick the artist-list warm, show a placeholder.
                      void musicLibrary.albumCount().catch(() => undefined);
                      return albumsPlaceholder();
                    }
                    return peekedCount.then((count) => {
                      if (count <= MAX_ALBUMS_FLAT) {
                        // Small catalog: serve the flat Albums list LIVE, never build the index.
                        // Stock bonob behavior; small setups pay nothing for the bucketing machinery.
                        return musicLibrary
                          .albums({ type: "alphabeticalByName", ...paging })
                          .then((result) =>
                            getMetadataResult({
                              mediaCollection: result.results.map((it) =>
                                album(urlWithToken(apiKey), it)
                              ),
                              index: paging._index,
                              total: count,
                            })
                          );
                      }
                      // Large catalog, index not warm yet: kick the build, show the placeholder
                      // (never block the browse on the multi-minute scan).
                      void musicLibrary.albumIndex().catch(() => undefined);
                      return albumsPlaceholder();
                    });
                  }
                  case "albumsByLetter": {
                    const peekedLetter = musicLibrary.peekAlbumIndex();
                    if (!peekedLetter) {
                      // Never block a leaf browse on the multi-minute scan (S2 would time out);
                      // kick the build and show the retry placeholder instead.
                      void musicLibrary.albumIndex().catch(() => undefined);
                      return getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "albumList",
                            id: `albumsByLetter:${typeId}`,
                            title: "Indexing your albums… (open again shortly)",
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "albums").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    }
                    return peekedLetter.then(async (idx) => {
                      const letterTotal = albumIndexLetterTotal(idx, typeId);
                      if (letterTotal > MAX_ALBUMS_FLAT) {
                        // A single letter is itself too big for one S2 container; split it into
                        // fixed-size sub-buckets so no leaf ever advertises an oversized total.
                        const chunks = Math.ceil(letterTotal / MAX_ALBUMS_FLAT);
                        const chunkIndexes = range(chunks).slice(
                          paging._index,
                          paging._index + paging._count
                        );
                        return getMetadataResult({
                          mediaCollection: chunkIndexes.map((i) => ({
                            itemType: "albumList",
                            id: `albumsChunk:${typeId}_${i}`,
                            title: `${typeId} · part ${i + 1}`,
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "albums").href()
                            ),
                          })),
                          index: paging._index,
                          total: chunks,
                        });
                      }
                      // Serve the letter's page straight from the index snapshot (drift-proof: no
                      // live re-fetch by offset). Advertise only this letter's total.
                      const page = await readAlbumIndexPage(
                        idx,
                        typeId,
                        paging._index,
                        paging._count
                      );
                      return getMetadataResult({
                        mediaCollection: page.items.map((it) =>
                          album(urlWithToken(apiKey), it)
                        ),
                        index: paging._index,
                        total: page.total,
                      });
                    });
                  }
                  case "albumsChunk": {
                    // A sub-bucket of an oversized letter: "albumsChunk:<key>_<n>". Parse from the
                    // right so a "#" key works.
                    const sep = typeId.lastIndexOf("_");
                    const chunkKey = sep >= 0 ? typeId.slice(0, sep) : typeId;
                    const chunkText = sep >= 0 ? typeId.slice(sep + 1) : "0";
                    const chunk = Number(chunkText);
                    if (!/^\d+$/.test(chunkText) || !Number.isSafeInteger(chunk)) {
                      return getMetadataResult({
                        mediaCollection: [],
                        index: paging._index,
                        total: 0,
                      });
                    }
                    const peekedChunk = musicLibrary.peekAlbumIndex();
                    if (!peekedChunk) {
                      void musicLibrary.albumIndex().catch(() => undefined);
                      return getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "albumList",
                            id: `albumsChunk:${typeId}`,
                            title: "Indexing your albums… (open again shortly)",
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "albums").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    }
                    return peekedChunk.then(async (idx) => {
                      const base = chunk * MAX_ALBUMS_FLAT;
                      const letterTotal = albumIndexLetterTotal(idx, chunkKey);
                      const chunkTotal = Math.max(
                        0,
                        Math.min(MAX_ALBUMS_FLAT, letterTotal - base)
                      );
                      const take = Math.min(
                        paging._count,
                        Math.max(0, chunkTotal - paging._index)
                      );
                      const page = await readAlbumIndexPage(
                        idx,
                        chunkKey,
                        base + paging._index,
                        take
                      );
                      return getMetadataResult({
                        mediaCollection: page.items.map((it) =>
                          album(urlWithToken(apiKey), it)
                        ),
                        index: paging._index,
                        total: chunkTotal,
                      });
                    });
                  }
                  case "genre":
                    return albums({
                      type: "byGenre",
                      genre: typeId,
                      ...paging,
                    });
                  case "year": {
                    // "?" is our label for unknown-year albums, which Navidrome stores as year 0.
                    // getAlbumList2(byYear) requires an integer, so "?" itself is rejected.
                    const yr = typeId === "?" ? "0" : typeId;
                    return albums({
                      type: "byYear",
                      fromYear: yr,
                      toYear: yr,
                      ...paging,
                    });
                  }
                  case "randomAlbums":
                    return albums({
                      type: "random",
                      ...paging,
                    });
                  case "favouriteAlbums":
                    return albums({
                      type: "favourited",
                      ...paging,
                    });
                  case "starredAlbums":
                    return albums({
                      type: "starred",
                      ...paging,
                    });
                  case "recentlyAdded":
                    return albums({
                      type: "recentlyAdded",
                      ...paging,
                    });
                  case "recentlyPlayed":
                    return albums({
                      type: "recentlyPlayed",
                      ...paging,
                    });
                  case "mostPlayed":
                    return albums({
                      type: "mostPlayed",
                      ...paging,
                    });
                  case "internetRadio":
                    return musicLibrary
                      .radioStations()
                      .then(slice2(paging))
                      .then(([page, total]) =>
                        getMetadataResult({
                          mediaMetadata: page.map((it) =>
                            internetRadioStation(it)
                          ),
                          index: paging._index,
                          total,
                        })
                      );
                  case "years":
                    return musicLibrary
                      .years()
                      .then(slice2(paging))
                      .then(([page, total]) =>
                        getMetadataResult({
                          mediaCollection: page.map((it) =>
                            yyyy(bonobUrl, it)
                          ),
                          index: paging._index,
                          total,
                        })
                      );
                  case "genres":
                    return musicLibrary
                      .genres()
                      .then(slice2(paging))
                      .then(([page, total]) =>
                        getMetadataResult({
                          mediaCollection: page.map((it) => genre(bonobUrl, it)),
                          index: paging._index,
                          total,
                        })
                      );
                  case "playlists":
                    return musicLibrary
                      .playlists()
                      .then(slice2(paging))
                      .then(([page, total]) => {
                        return getMetadataResult({
                          mediaCollection: page.map((it) => playlist(urlWithToken(apiKey), it)),
                          index: paging._index,
                          total,
                        });
                      });
                  case "playlist":
                    return musicLibrary
                      .playlist(typeId!)
                      .then((playlist) => playlist.entries)
                      .then(slice2(paging))
                      .then(([page, total]) => {
                        return getMetadataResult({
                          mediaMetadata: page.map((it) =>
                            track(urlWithToken(apiKey), it)
                          ),
                          index: paging._index,
                          total,
                        });
                      });
                  case "artist":
                    return musicLibrary.artist(typeId!).then((artist) => {
                      // Offer the artist's top songs as the first entry, then their albums. Page
                      // over the combined list so paging and total stay correct.
                      const items = [
                        {
                          itemType: "trackList",
                          id: `topSongs:${typeId}`,
                          title: "Top Songs",
                          albumArtURI: albumArtURI(
                            coverArtURI(urlWithToken(apiKey), {
                              coverArt: artist.image,
                            }).href()
                          ),
                        },
                        ...artist.albums.map((it) =>
                          album(urlWithToken(apiKey), it)
                        ),
                      ];
                      const [page, total] = slice2(paging)(items);
                      return getMetadataResult({
                        mediaCollection: page,
                        index: paging._index,
                        total,
                      });
                    });
                  case "topSongs":
                    return musicLibrary
                      .topSongs(typeId!)
                      .then(slice2(paging))
                      .then(([page, total]) =>
                        getMetadataResult({
                          mediaMetadata: page.map((it) =>
                            // /art needs the access token (bat), same as album art
                            topSongMetadata(urlWithToken(apiKey), it)
                          ),
                          index: paging._index,
                          total,
                        })
                      );
                  case "favouriteSongs":
                    return musicLibrary
                      .starredSongs()
                      .then(slice2(paging))
                      .then(([page, total]) =>
                        getMetadataResult({
                          mediaMetadata: page.map((it) =>
                            topSongMetadata(urlWithToken(apiKey), it)
                          ),
                          index: paging._index,
                          total,
                        })
                      );
                  case "relatedArtists":
                    return musicLibrary
                      .artist(typeId!)
                      .then((artist) => artist.similarArtists.filter((it) => it.inLibrary))
                      .then(slice2(paging))
                      .then(([page, total]) => {
                        return getMetadataResult({
                          mediaCollection: page.map((it) =>
                            artist(urlWithToken(apiKey), it)
                          ),
                          index: paging._index,
                          total,
                        });
                      });
                  case "album":
                    return musicLibrary
                      .album(typeId!)
                      .then(it => it.tracks)
                      .then(slice2(paging))
                      .then(([page, total]) => {
                        return getMetadataResult({
                          mediaMetadata: page.map((it) =>
                            track(urlWithToken(apiKey), it)
                          ),
                          index: paging._index,
                          total,
                        });
                      });
                  default:
                    logger.info(`Sonos asked for an unsupported getMetadata: ${type}:${typeId}`);
                    return getMetadataResult({
                      mediaMetadata: [],
                      index: paging._index,
                      total: 0,
                    });
                }
              }),
              SMAPI_BROWSE_TIMEOUT_MS,
              browseTimeoutFallback,
              // This is the degradation the user sees as a tile stuck on "Loading, please try
              // again" - naming the browsed id is what makes it actionable.
              `getMetadata:${id}`
            ).catch(faultOrFallback(browseTimeoutFallback, `getMetadata:${id}`))
          }
          ,
          createContainer: async (
            { title, seedId }: { title: string; seedId: string | undefined },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(({ musicLibrary }) =>
                musicLibrary
                  .createPlaylist(title)
                  .then((playlist) => ({ playlist, musicLibrary }))
              )
              .then(({ musicLibrary, playlist }) => {
                if (seedId) {
                  musicLibrary.addToPlaylist(
                    playlist.id,
                    seedId.split(":")[1]!
                  );
                }
                return playlist;
              })
              .then((it) => ({
                createContainerResult: {
                  id: `playlist:${it.id}`,
                  updateId: "",
                },
              })),
          deleteContainer: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(({ musicLibrary }) => musicLibrary.deletePlaylist(id))
              .then((_) => ({ deleteContainerResult: {} })),
          addToContainer: async (
            { id, parentId }: { id: string; parentId: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(({ musicLibrary, typeId }) =>
                musicLibrary.addToPlaylist(parentId.split(":")[1]!, typeId)
              )
              .then((_) => ({ addToContainerResult: { updateId: "" } })),
          removeFromContainer: async (
            { id, indices }: { id: string; indices: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then((it) => ({
                ...it,
                indices: indices.split(",").map((it) => +it),
              }))
              .then(({ musicLibrary, typeId, indices }) => {
                if (id == "playlists") {
                  musicLibrary.playlists().then((it) => {
                    indices.forEach((i) => {
                      musicLibrary.deletePlaylist(it[i]?.id!);
                    });
                  });
                } else {
                  musicLibrary.removeFromPlaylist(typeId, indices);
                }
              })
              .then((_) => ({ removeFromContainerResult: { updateId: "" } })),

          rateItem: async (
            { id, rating }: { id: string; rating: number },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(({ musicLibrary, typeId }) =>
                musicLibrary.rate(typeId, ratingFromInt(Math.abs(rating)))
              )
              .then((_) => ({ rateItemResult: { shouldSkip: false } })),

          setPlayedSeconds: async (
            { id, seconds }: { id: string; seconds: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(({ musicLibrary, type, typeId }) => {
                switch (type) {
                  case "track":
                    return musicLibrary.track(typeId).then(track => {
                      if (shouldScrobble(track, +seconds)) {
                        return musicLibrary.scrobble(typeId);
                      } else {
                        return Promise.resolve(true);
                      }
                    });
                  default:
                    logger.info("Unsupported scrobble", { id, seconds });
                    return Promise.resolve(true);
                }
              })
              .then((_) => ({
                setPlayedSecondsResult: {},
              })),
        },
      },
    },
    readFileSync(WSDL_FILE, "utf8"),
    (err: any, res: any) => {
      if (err) {
        logger.error("BOOOOM", { err, res });
      }
    }
  );

  soapyService.log = (type, data) => {
    switch (type) {
      // routing all soap info messages to debug so less noisy
      case "info":
        logger.debug({ level: "info", data });
        break;
      case "warn":
        logger.warn({ level: "warn", data });
        break;
      case "error":
        logger.error({ level: "error", data });
        break;
      default:
        logger.debug({ level: "debug", data });
    }
  };
}

export default bindSmapiSoapServiceToExpress;

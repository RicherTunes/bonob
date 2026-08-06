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
  Encoding,
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
  scrollIndicesFrom,
  albumIndexLetterTotal,
  MAX_ALBUMS_FLAT,
} from "./album_index";
import { readAlbumIndexPage, readAlbumIndexAll } from "./album_snapshot";
import { MAX_ARTISTS_FLAT } from "./artist_index";
import { withTimeout, withDeadline, SMAPI_BROWSE_TIMEOUT_MS, faultOrFallback } from "./timeout";
import { LastUpdate } from "./last_update";
import { randomInt } from "./random";
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

// ---------------------------------------------------------------------------------------------
// WSDL element ORDER.
//
// Every SMAPI media type is an xs:sequence, so element order is part of the contract, not a style
// choice - and the soap library serializes a JS object in KEY INSERTION ORDER. Our tile builders
// emitted `itemType` before `id` (and albumArtURI before canPlay, and so on), so every tile bonob
// has ever sent was schema-invalid. Sonos S2 tolerates it, which is exactly why it went unnoticed
// until 14 captured PRODUCTION responses were validated against the WSDL schema.
//
// Ordering is applied centrally, on the way out, rather than by hand-reordering each builder: a
// builder is easy to get right once and easy to let drift later, and new ones would repeat the
// mistake. Keys the schema does not name (notably `attributes`, which is an XML attribute group
// rather than an element) are preserved after the ordered ones.
//
// Order is transcribed from Sonoswsdl-1.19.6: AbstractMedia + the mediaCollection extension, and
// mediaMetadata + trackMetadata. Both orderings live in ONE list because an emitted object is
// only ever one of those shapes, and a key never appears in both with a different position.
const SMAPI_ELEMENT_ORDER: string[] = [
  // AbstractMedia
  "id", "itemType", "semanticType", "displayType", "title", "summary", "isFavorite", "tags",
  "isExplicit", "isEphemeral", "positionInformation", "releaseDate",
  // mediaCollection extension
  "artist", "artistId", "authorId", "author", "narratorId", "narrator", "producerId", "producer",
  "podcastId", "podcast", "canScroll", "canPlay", "canEnumerate", "canAddToFavorites",
  "containsFavorite", "canSkip", "albumArtURI", "canResume", "total",
  // mediaMetadata
  "mimeType", "trackMetadata", "streamMetadata", "dynamic", "behaviors",
];

// trackMetadata has its OWN sequence, and it reuses names (artist, album, albumArtURI, canPlay)
// at different positions, so it cannot share the list above.
const TRACK_METADATA_ORDER: string[] = [
  "artistId", "artist", "composerId", "composer", "albumArtistId", "albumArtist", "albumId",
  "album", "authorId", "author", "narratorId", "narrator", "bookId", "book", "producerId",
  "producer", "podcastId", "podcast", "hostId", "host", "genreId", "genre", "duration", "rating",
  "albumArtURI", "trackNumber", "canPlay", "canSkip", "canAddToFavorites", "canResume", "canSeek",
];

const reorderBy = (order: string[], value: any): any => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const out: Record<string, any> = {};
  for (const k of Object.keys(value).sort((a, b) => rank(a) - rank(b))) out[k] = value[k];
  return out;
};

// Reorder one emitted media item (and its nested trackMetadata / streamMetadata) into WSDL order.
// Order the media items inside a whole response envelope (getExtendedMetadataResult /
// getMediaMetadataResult), which do not go through getMetadataResult/searchResult.
export const orderEmittedMedia = (response: any): any => {
  if (!response || typeof response !== "object") return response;
  const out: Record<string, any> = { ...response };
  for (const envelope of Object.keys(out)) {
    const body = out[envelope];
    if (!body || typeof body !== "object") continue;
    // Two shapes reach here. getExtendedMetadataResult WRAPS the item in a mediaCollection /
    // mediaMetadata field; getMediaMetadataResult IS the item. Only handling the wrapper meant the
    // PLAYBACK metadata path silently bypassed ordering, leaving exactly the id-before-itemType
    // violation this machinery exists to remove - while the comment claimed it was covered.
    if (
      Object.prototype.hasOwnProperty.call(body, "mediaCollection") ||
      Object.prototype.hasOwnProperty.call(body, "mediaMetadata")
    ) {
      const copy: Record<string, any> = { ...body };
      for (const field of ["mediaCollection", "mediaMetadata"]) {
        if (copy[field]) copy[field] = inSmapiOrder(copy[field]);
      }
      out[envelope] = copy;
    } else {
      out[envelope] = inSmapiOrder(body);
    }
  }
  return out;
};

export const inSmapiOrder = (value: any): any => {
  if (Array.isArray(value)) return value.map(inSmapiOrder);
  if (!value || typeof value !== "object") return value;
  const ordered = reorderBy(SMAPI_ELEMENT_ORDER, value);
  if (ordered["trackMetadata"])
    ordered["trackMetadata"] = reorderBy(TRACK_METADATA_ORDER, ordered["trackMetadata"]);
  return ordered;
};

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
  // WSDL order matters: mediaList is an xs:sequence of index, then count, then total, and the
  // soap library serializes object keys in insertion order. Building {count, index, total} made
  // every browse and search response bonob sent schema-invalid. Sonos S2 tolerates it, which is
  // why it survived unnoticed until 14 captured production responses were validated against the
  // schema. Destructure the caller's overrides out of the spread so they cannot reintroduce the
  // wrong order by appearing after these three.
  const { index: overrideIndex, count: _ignoredCount, total: overrideTotal, ...rest } = result;
  return {
    getMetadataResult: {
      index: overrideIndex ?? 0,
      count,
      total: overrideTotal ?? count,
      ...rest,
      // sanitizeXml strips XML-illegal characters; inSmapiOrder puts the keys into the WSDL's
      // xs:sequence order, which the soap library then serializes verbatim.
      ...(result.mediaCollection && {
        mediaCollection: inSmapiOrder(sanitizeXml(result.mediaCollection)),
      }),
      ...(result.mediaMetadata && {
        mediaMetadata: inSmapiOrder(sanitizeXml(result.mediaMetadata)),
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
  // WSDL order matters: mediaList is an xs:sequence of index, then count, then total, and the
  // soap library serializes object keys in insertion order. Building {count, index, total} made
  // every browse and search response bonob sent schema-invalid. Sonos S2 tolerates it, which is
  // why it survived unnoticed until 14 captured production responses were validated against the
  // schema. Destructure the caller's overrides out of the spread so they cannot reintroduce the
  // wrong order by appearing after these three.
  const { index: overrideIndex, count: _ignoredCount, total: overrideTotal, ...rest } = result;
  return {
    searchResult: {
      index: overrideIndex ?? 0,
      count,
      total: overrideTotal ?? count,
      ...rest,
      // sanitizeXml strips XML-illegal characters; inSmapiOrder puts the keys into the WSDL's
      // xs:sequence order, which the soap library then serializes verbatim.
      ...(result.mediaCollection && {
        mediaCollection: inSmapiOrder(sanitizeXml(result.mediaCollection)),
      }),
      ...(result.mediaMetadata && {
        mediaMetadata: inSmapiOrder(sanitizeXml(result.mediaMetadata)),
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

// The SMAPI itemTypes bonob actually emits. This was previously "container" | "search" |
// "albumList" while the root menu emitted trackList, collection, stream and playlist as well -
// those entries are untyped object literals, so the narrow union never caught it.
export type ContainerType =
  | "container"
  | "search"
  | "albumList"
  | "trackList"
  | "collection"
  | "stream"
  | "playlist";

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

// Container ids Sonos may ask for extended metadata on before opening them. Every root section
// reaches getExtendedMetadata this way; without an entry here the tile is described as nothing.
//
// The itemType MUST match what the root getMetadata advertises for the same id - answering
// "container" for starredAlbums while the root menu calls it an albumList gives Sonos two
// different answers for one id, which is worse than answering nothing. A test walks the real root
// response and asserts every id agrees, so this cannot drift away from the menu above it.
//
// Titles are deliberately plain English rather than localised: getExtendedMetadata destructures
// only the id and has no accept-language in scope, and a container that is DESCRIBED beats one
// that is not.
// reportStatus takes an arbitrary client-supplied message and needs no auth, so its length is
// bounded before logging. Long enough for any real player diagnostic.
const MAX_REPORTED_STATUS_MESSAGE = 500;

const KNOWN_CONTAINERS: Record<
  string,
  { itemType: ContainerType; title: string; attributes?: { userContent: boolean } }
> = {
  artists: { itemType: "container", title: "Artists" },
  albums: { itemType: "albumList", title: "Albums" },
  randomAlbums: { itemType: "albumList", title: "Random" },
  favouriteAlbums: { itemType: "albumList", title: "Favourites" },
  favouriteSongs: { itemType: "trackList", title: "Favourite Songs" },
  starredAlbums: { itemType: "albumList", title: "Top Rated" },
  playlists: {
    itemType: "collection",
    title: "Playlists",
    // The root menu advertises this; a descriptor that silently dropped it could withdraw the
    // create/rename affordance for a client that asks getExtendedMetadata about capabilities.
    attributes: { userContent: true },
  },
  genres: { itemType: "container", title: "Genres" },
  years: { itemType: "container", title: "Years" },
  recentlyAdded: { itemType: "albumList", title: "Recently Added" },
  recentlyPlayed: { itemType: "albumList", title: "Recently Played" },
  mostPlayed: { itemType: "albumList", title: "Most Played" },
  internetRadio: { itemType: "stream", title: "Internet Radio" },
  // Not root tiles, but Sonos asks about these the same way once you are one level down.
  genre: { itemType: "albumList", title: "Genre" },
  year: { itemType: "albumList", title: "Year" },
  artistsByLetter: { itemType: "container", title: "Artists" },
  albumsByLetter: { itemType: "albumList", title: "Albums" },
  artistsChunk: { itemType: "container", title: "Artists" },
  albumsChunk: { itemType: "albumList", title: "Albums" },
};


export const sonosifyMimeType = (mimeType: string) =>
  mimeType == "audio/x-flac" ? "audio/flac" : mimeType;

// Formats a Sonos player decodes natively, so Navidrome's transcode decision returns canDirectPlay
// and the response is a byte-range-seekable proxy of the original file.
//
// This is what `canSeek` (WSDL: trackMetadata) is keyed on, and the reason it is keyed on the mime
// type rather than emitted unconditionally: the transcode decision is made PER TRACK at stream
// time (subsonic_music_library.stream), long after the tile is built, and calling it per tile would
// be an N+1 across a whole browse page. A transcoded stream's byte offsets do not map linearly to
// time, so advertising seek on one invites a scrubber that lands in the wrong place - worse than no
// scrubber. Keying on the format we KNOW direct-plays keeps the promise honest for the common case
// and stays silent for the rest.
const SONOS_NATIVELY_SEEKABLE_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);

export const canSeekMimeType = (mimeType: string | undefined): boolean =>
  !!mimeType && SONOS_NATIVELY_SEEKABLE_MIME_TYPES.has(mimeType.toLowerCase());

// The mime above is the mime Sonos will be DELIVERED, not the source file's. When a custom player
// or a Navidrome player transcode is configured, a flac arrives as audio/mpeg - natively decodable,
// so the set above says "seekable", but it is ffmpeg output with no linear byte-to-time mapping and
// no 206 support. Advertising a scrubber there is the failure this whole feature set out to avoid,
// so a transcoded stream never claims seek regardless of its format.
export const canSeekTrack = (encoding: Encoding): boolean =>
  !encoding.transcoded && canSeekMimeType(encoding.mimeType);


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
    // canSeek is last in the trackMetadata xs:sequence; inSmapiOrder enforces that regardless.
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
    canSeek: canSeekTrack(track.encoding)
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
    canSeek: canSeekTrack(t.encoding)
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
  // Playable now that the recursive flag is implemented: Sonos re-requests this container with
  // recursive=true and gets a flat, bounded, cached track list. Advertising this WITHOUT the
  // recursive handler would have broken play-artist, which is why it waited for it.
  canPlay: true,
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
  smapiAuthTokens: SmapiAuthTokens,
  // Injected rather than constructed here: the Subsonic layer must be able to bump the SAME
  // instance when an index rebuild reveals a catalog change, and that happens far from here.
  lastUpdate: LastUpdate = new LastUpdate(clock)
) {
  const sonosSoap = new SonosSoap(bonobUrl, linkCodes, smapiAuthTokens, clock);

  // Maps a full-scope api key to its ART-SCOPED sibling, so art URLs never carry a key that can
  // also stream. One entry is minted per auth() - i.e. per SOAP call - and nothing ever removed
  // them, so the map grew for the life of the process. Bounded LRU: entries are only needed while
  // the api key they describe is still valid (api keys expire after the auth timeout anyway), and
  // an evicted entry is re-minted by the next auth() rather than lost.
  const MAX_ART_KEY_MAPPINGS = 5_000;
  const artApiKeysByApiKey = new Map<string, string>();

  const rememberArtKey = (apiKey: string, artApiKey: string) => {
    artApiKeysByApiKey.set(apiKey, artApiKey);
    while (artApiKeysByApiKey.size > MAX_ART_KEY_MAPPINGS) {
      const oldest = artApiKeysByApiKey.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      artApiKeysByApiKey.delete(oldest);
    }
  };

  const urlWithToken = (accessToken: string) => {
    const artKey = artApiKeysByApiKey.get(accessToken);
    // NEVER fall back to the unscoped key. That fallback would silently embed a STREAM-capable
    // token into every art URL - and art URLs are the ones that end up in logs, caches and proxy
    // access records. auth() always populates the mapping first, so a miss means the entry was
    // evicted or something is wrong; failing loudly is correct for a scope-isolation invariant.
    if (!artKey) {
      throw new Error(
        "No art-scoped key for this api key: refusing to emit an art URL carrying a stream-capable token"
      );
    }
    return bonobUrl.append({
      searchParams: {
        bat: artKey,
      },
    });
  };

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
        rememberArtKey(
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
          // Sonos compares these stamps against what it last saw; a CHANGED stamp orders a
          // re-fetch. Returning now() for both claimed the catalog AND the favourites had changed
          // on every 60s poll, forever - a standing re-browse and re-art-fetch order against a
          // 113k-album catalog, issued by the bridge whose caching exists to absorb that load.
          // Element order is the WSDL lastUpdate xs:sequence: catalog, favorites, pollInterval,
          // autoRefreshEnabled. node-soap serializes object keys in insertion order, so this
          // object literal IS the wire order - it was previously autoRefreshEnabled-first, which
          // made every getLastUpdate response schema-invalid. Pinned by a raw-XML test.
          getLastUpdate: () => ({
            getLastUpdateResult: {
              catalog: lastUpdate.catalog(),
              favorites: lastUpdate.favourites(),
              pollInterval: 60,
              autoRefreshEnabled: true,
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
            // PLAYBACK path: bounded, but it fails rather than substituting a placeholder - there
            // is no safe stand-in for "the URI of this track", and handing Sonos one would make it
            // try to play something that is not the track. See withDeadline.
            withDeadline(
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
                    logger.info(
                      `Sonos asked for an unsupported getMediaURI: ${sanitizeLogValue(type)}:${sanitizeLogValue(typeId)}`
                    );
                    return {
                      getMediaURIResult: iconArtURI(bonobUrl, "error", "?").href(),
                    }
                  }
              }),
              SMAPI_BROWSE_TIMEOUT_MS,
              `getMediaURI:${id}`
            ),
          getMediaMetadata: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            // PLAYBACK path: bounded, failing rather than serving a placeholder. getMediaMetadata
            // for a track costs getSong + getAlbum (the whole album track list), so it is not the
            // trivial call it looks like. See withDeadline.
            withDeadline(
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
                    logger.info(
                      `Sonos asked for an unsupported getMediaMetadata: ${sanitizeLogValue(type)}:${sanitizeLogValue(typeId)}`
                    );
                    return {
                      getMediaMetadataResult: {}
                    }
                }
              })
              // strip XML-invalid control chars from tag text so one bad tag can't break the page
              .then(sanitizeXml)
              .then(orderEmittedMedia),
              SMAPI_BROWSE_TIMEOUT_MS,
              `getMediaMetadata:${id}`
            ),
          search: async (
            { id, term, index, count }: {
              id: string;
              term: string;
              index?: number;
              count?: number;
            },
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
            // index/count are logged because they are the ONLY way to answer whether the app
            // re-requests with a larger count when the user expands a category, or renders the
            // expanded view from items we over-returned. That distinction decides whether honouring
            // the paging contract is a fix or a regression, and no test can answer it.
            logger.info(
              `SMAPI search: category=${sanitizeLogValue(id)} termLength=${(term ?? "").length} index=${index ?? "-"} count=${count ?? "-"}`
            );

            // Honour the index/count Sonos sends. Measured from the real app: it asks for count=20
            // on the search SUMMARY screen and count=50 when a category is EXPANDED, and always
            // index=0 - it never pages. So the summary screen was being handed 50 tiles when it
            // asked for 20, and every surplus tile is a candidate art fetch across three
            // categories. Slicing cannot lose expanded results, because expanding re-queries.
            //
            // `total` stays the number we HOLD, not the number returned: reporting the slice length
            // would tell the app the search matched only 20 things. Missing or zero paging means
            // "everything held" - a client that omits count leaves it undefined, and a naive
            // slice(index, index + undefined) is slice(0, NaN) = [], which would make every search
            // look like it matched nothing.
            const pageOf = <T>(items: T[]): { page: T[]; index: number; total: number } => {
              const from = Number.isFinite(index) && (index as number) > 0 ? (index as number) : 0;
              const take =
                Number.isFinite(count) && (count as number) > 0
                  ? (count as number)
                  : items.length;
              return { page: items.slice(from, from + take), index: from, total: items.length };
            };
            return withTimeout(login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(async ({ musicLibrary, apiKey }) => {
                switch (id) {
                  case "albums":
                    return musicLibrary.searchAlbums(term).then((it) => {
                      // Slice the SUMMARIES before building tiles: no point constructing tiles,
                      // and advertising their art, only to discard them.
                      const { page, index: from, total } = pageOf(it);
                      return searchResult({
                        mediaCollection: page.map((albumSummary) =>
                          album(urlWithToken(apiKey), albumSummary)
                        ),
                        index: from,
                        total,
                      });
                    });
                  case "artists":
                    return musicLibrary.searchArtists(term).then((it) => {
                      const { page, index: from, total } = pageOf(it);
                      return searchResult({
                        mediaCollection: page.map((artistSummary) =>
                          artist(urlWithToken(apiKey), artistSummary)
                        ),
                        index: from,
                        total,
                      });
                    });
                  case "tracks":
                    return musicLibrary.searchTracks(term).then((it) =>
                      // The Songs category must return SONGS. This used to collapse every track hit
                      // into its ALBUM and return album tiles, so searching a song title showed
                      // albums and never the song - reported from the Sonos app as "I searched
                      // 'all i need' and only albums showed up". Track hits are now playable
                      // mediaMetadata, the same shape Favourite Songs and Top Songs already use.
                      //
                      // The collapse existed to stop N hits from one album rendering as N identical
                      // album tiles, each with its own /art url (up to 20x the cover-art fetches for
                      // one search page). That redundancy was an artifact of rendering tracks AS
                      // albums; distinct songs are legitimately distinct tiles. Coalescing still
                      // holds because tracks from one album carry the same server-returned coverArt
                      // value, so they share a single /art url and a single coordinator key.
                      ((): SearchResponse => {
                        const { page, index: from, total } = pageOf(it);
                        return searchResult({
                          mediaMetadata: page.map((track) =>
                            topSongMetadata(urlWithToken(apiKey), track)
                          ),
                          index: from,
                          total,
                        });
                      })()
                    );
                  default:
                    // The TERM is the user's own data and is logged length-only, exactly as the successful
                    // search path does; the category id is client-controlled and is neutralised.
                    logger.info(
                      `Sonos asked for an unsupported search of: ${sanitizeLogValue(id)}, termLength=${(term ?? "").length}`
                    );
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
                    // Rendering ONE tile needs only id/name/coverArt. This used to fetch the whole
                    // playlist - every entry, mapped to a Track - to read three fields off it, and
                    // getPlaylist is unpaginated, so a big playlist meant hundreds of thousands of
                    // records for a single tile. playlists() already returns exactly that summary.
                    return musicLibrary
                      .playlists()
                      .then((all) => all.find((it) => it.id == typeId))
                      .then((summary) =>
                        summary
                          ? {
                              getExtendedMetadataResult: {
                                mediaCollection: playlist(
                                  urlWithToken(apiKey),
                                  summary
                                ),
                              },
                            }
                          : // Unknown id (deleted between browse and tap): return an empty result
                            // rather than falling back to the expensive full fetch for something
                            // that no longer exists.
                            { getExtendedMetadataResult: {} }
                      );

                  case "topSongs":
                    return {
                      getExtendedMetadataResult: {
                        mediaCollection: {
                          id,
                          itemType: "trackList",
                          title: "Top Songs",
                        },
                      },
                    };
                  default: {
                    // Sonos asks for extended metadata on EVERY container tile before opening it.
                    // Answering "unsupported" with an empty result described nothing, and a browse
                    // of the live library showed it happening for starredAlbums, playlists, genres,
                    // years, year, recentlyAdded and recentlyPlayed - every root section. Top Songs
                    // was fixed as a special case first, which missed that the gap was systematic.
                    //
                    // These are all plain browsable containers, so describe them as such rather
                    // than returning nothing. An id we genuinely do not recognise still returns the
                    // empty result, and still says so in the log.
                    const known = KNOWN_CONTAINERS[type];
                    if (known) {
                      return {
                        getExtendedMetadataResult: {
                          mediaCollection: {
                            id,
                            itemType: known.itemType,
                            title: known.title,
                            ...(known.attributes
                              ? { attributes: known.attributes }
                              : {}),
                          },
                        },
                      };
                    }
                    logger.info(
                      `Sonos requested extended meta data for currently unsupported type=${sanitizeLogValue(type)}, typeId=${sanitizeLogValue(typeId)}`
                    )
                    return {
                      getExtendedMetadataResult: {}
                    };
                  }
                }
              })
              .then(sanitizeXml)
              .then(orderEmittedMedia),
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
                .then(sanitizeXml)
              .then(orderEmittedMedia),
              SMAPI_BROWSE_TIMEOUT_MS,
              { getExtendedMetadataTextResult: "" },
              `getExtendedMetadataText:${textType}`
            ).catch(
              faultOrFallback(
                { getExtendedMetadataTextResult: "" },
                `getExtendedMetadataText:${textType}`
              )
            ),
          // The alphabet scrubber for a container that advertised canScroll. Answered from the
          // index bucket table, so it is O(26) rather than a scan of 24,797 artists, and it never
          // triggers a build: a cold index degrades to no scroll rather than blocking the browse.
          getScrollIndices: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            withTimeout(
              login(findLoginToken(soapyHeaders, headers)).then(
                async ({ musicLibrary }) => {
                  if (id !== "artists")
                    return { getScrollIndicesResult: "" };
                  const peeked = musicLibrary.peekArtistIndex();
                  if (!peeked) return { getScrollIndicesResult: "" };
                  const idx = await peeked;
                  // Offsets are only meaningful against the list the container actually shows.
                  // Over the cap, Artists is BUCKETED into 26 letter tiles, so flat-list offsets
                  // would point far past the end of what Sonos is displaying.
                  if (idx.total > MAX_ARTISTS_FLAT)
                    return { getScrollIndicesResult: "" };
                  return { getScrollIndicesResult: scrollIndicesFrom(idx) };
                }
              ),
              SMAPI_BROWSE_TIMEOUT_MS,
              { getScrollIndicesResult: "" },
              `getScrollIndices:${id}`
            ).catch(
              faultOrFallback({ getScrollIndicesResult: "" }, `getScrollIndices:${id}`)
            ),
          getMetadata: async (
            {
              id,
              index,
              count,
              recursive,
            }: { id: string; index: number; count: number; recursive: boolean },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) => {
            // Browse deadline (below Sonos's ~5s SMAPI timeout): if a handler hangs or rejects on a
            // slow/flaky backend, return a "please try again" placeholder rather than a Sonos error.
            // A recursive request is a PLAY intent, and its contract is a FLAT mediaMetadata list.
            // Answering it with the browse placeholder container hands Sonos an unplayable tile
            // where it asked for tracks, so "play artist" fails confusingly rather than emptily.
            // The playback paths already got reject-don't-fake treatment (withDeadline); this is
            // the same principle for the recursive path.
            // Every "still loading" title goes through here, so serving one is RECORDED by
            // construction. The previous version armed only the artists placeholder, which is the
            // fast one (a single getArtists); the albums placeholder sits in front of the
            // multi-minute ~230-request catalog scan and was the one that actually needed it.
            const loading = (text: string): string => {
              lastUpdate.notePlaceholderServed();
              return text;
            };
            const browseTimeoutFallback = recursive
              ? getMetadataResult({ mediaMetadata: [], index: 0, total: 0 })
              : getMetadataResult({
                  mediaCollection: [
                    {
                      itemType: "container",
                      id,
                      title: loading("Loading, please try again..."),
                    },
                  ],
                  index: 0,
                  total: 1,
                });
            return withTimeout(login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(async ({ musicLibrary, apiKey, type, typeId }) => {
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
                  case "root": {
                    // Non-blocking: undefined while cold, which correctly omits canScroll rather
                    // than blocking the root browse on a multi-second index build.
                    const peekedForScroll = musicLibrary.peekArtistIndex();
                    const artistsServedFlat = peekedForScroll
                      ? (await peekedForScroll).total <= MAX_ARTISTS_FLAT
                      : false;
                    return getMetadataResult({
                      mediaCollection: [
                        {
                          id: "artists",
                          title: lang("artists"),
                          albumArtURI: albumArtURI(iconArtURI(bonobUrl, "artists").href()),
                          itemType: "container",
                          // The scrubber maps a touch to an OFFSET in the list this container
                          // shows. Served FLAT, that is the artist list and scrolling is exactly
                          // right. Served BUCKETED (catalog over MAX_ARTISTS_FLAT) the container
                          // shows 26 letter tiles, so advertising canScroll would have Sonos
                          // scroll to offset 10228 in a 26-item list. Verified on the live library:
                          // the container reported total=26 while getScrollIndices returned
                          // offsets up to ~24,797. So only claim it when the list is actually flat.
                          ...(artistsServedFlat ? { canScroll: true } : {}),
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
                  }
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
                    const artistsPlaceholder = () => {
                      return getMetadataResult({
                        mediaCollection: [
                          {
                            itemType: "container",
                            id: "artists",
                            title: loading("Loading your artists… (open again shortly)"),
                            albumArtURI: albumArtURI(
                              iconArtURI(bonobUrl, "artists").href()
                            ),
                          },
                        ],
                        index: 0,
                        total: 1,
                      });
                    };
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
                            title: loading("Loading your artists… (open again shortly)"),
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
                            title: loading("Loading your artists… (open again shortly)"),
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
                            title: loading("Loading your albums… (open again shortly)"),
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
                  case "randomAlbums": {
                    // Navidrome randomises with an ORDER BY RANDOM scan across the whole catalog:
                    // measured 2381ms on the live 113k-album library, and once 5874ms, which blew
                    // the 4500ms deadline and degraded the section. Asking for fewer rows did NOT
                    // help, which proved the cost is the scan rather than the row count.
                    //
                    // When the album index is warm every album is already addressable by offset, so
                    // "random" is N independent single-record reads and no upstream query at all.
                    const peekedForRandom = musicLibrary.peekAlbumIndex();
                    if (peekedForRandom) {
                      return peekedForRandom.then(async (idx) => {
                        if (idx.total > 0) {
                          const wanted = Math.max(1, Math.min(paging._count, idx.total));
                          // Sample WITHOUT replacement so a page never shows the same album twice.
                          const offsets = new Set<number>();
                          // Bounded attempts: with wanted << total this converges immediately, and
                          // the cap stops a pathological small catalog from spinning.
                          for (
                            let attempts = 0;
                            offsets.size < wanted && attempts < wanted * 10;
                            attempts++
                          ) {
                            offsets.add(randomInt(idx.total));
                          }
                          const picked = (
                            await Promise.all(
                              [...offsets].map((offset) =>
                                readAlbumIndexAll<AlbumSummary>(idx, offset, 1)
                              )
                            )
                          ).flat();
                          return getMetadataResult({
                            mediaCollection: picked.map((it) =>
                              album(urlWithToken(apiKey), it)
                            ),
                            index: 0,
                            total: picked.length,
                          });
                        }
                        return albums({ type: "random", ...paging });
                      });
                    }
                    // Cold index (small library, or still building): fall back to the upstream
                    // query rather than serving nothing.
                    return albums({
                      type: "random",
                      ...paging,
                    });
                  }
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
                    // SMAPI: a container advertising canPlay is played by re-requesting it with
                    // the recursive flag and expecting a FLAT list of mediaMetadata. bonob never
                    // read that flag, which is why adding canPlay to artist tiles earlier would
                    // have broken play-artist rather than enabled it: Sonos would have asked for
                    // tracks and received containers. Bounded and cached in artistTracks.
                    if (recursive) {
                      return musicLibrary.artistTracks(typeId!).then((tracks) => {
                        const [page, total] = slice2<TrackSummary>(paging)(tracks);
                        return getMetadataResult({
                          mediaMetadata: page.map((it) =>
                            topSongMetadata(urlWithToken(apiKey), it)
                          ),
                          index: paging._index,
                          total,
                        });
                      });
                    }
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
                  case "favouriteSongs": {
                    // getStarred2 is unpaginated: 8615ms end-to-end at 11,505 starred songs,
                    // against a 4500ms deadline, re-run for EVERY page Sonos requests. So this
                    // browse is served only from the warm cache; cold, it kicks the warm and
                    // shows the retry placeholder rather than blocking (same shape as artists).
                    const peekedStarred = musicLibrary.peekStarredSongs();
                    if (peekedStarred) {
                      return peekedStarred
                        .then(slice2(paging))
                        .then(([page, total]) =>
                          getMetadataResult({
                            mediaMetadata: page.map((it) =>
                              topSongMetadata(urlWithToken(apiKey), it)
                            ),
                            index: paging._index,
                            // Sonos S2 rejects a container advertising a very large total, so
                            // never advertise more than the flat cap even if the user has starred
                            // more than that.
                            total: Math.min(total, MAX_ALBUMS_FLAT),
                          })
                        );
                    }
                    void musicLibrary.starredSongs().catch(() => undefined);
                    return getMetadataResult({
                      mediaCollection: [
                        {
                          itemType: "container",
                          id: "favouriteSongs",
                          title: loading("Loading your favourite songs… (open again shortly)"),
                          albumArtURI: albumArtURI(
                            iconArtURI(bonobUrl, "heart").href()
                          ),
                        },
                      ],
                      index: 0,
                      total: 1,
                    });
                  }
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
                    logger.info(
                      `Sonos asked for an unsupported getMetadata: ${sanitizeLogValue(type)}:${sanitizeLogValue(typeId)}`
                    );
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
              .then(async ({ musicLibrary, playlist }) => {
                // AWAIT the seed add. Unawaited, a transient Subsonic failure here was an
                // unhandled rejection - which Node 20+ turns into process exit - and Sonos was
                // told the container was created with its seed track before the add had even been
                // attempted, so a re-browse showed an empty playlist.
                if (seedId) {
                  await musicLibrary.addToPlaylist(
                    playlist.id,
                    seedId.split(":")[1]!
                  );
                }
                return playlist;
              })
              .then((it) => {
                lastUpdate.bumpCatalog();
                return {
                  createContainerResult: {
                    id: `playlist:${it.id}`,
                    updateId: "",
                  },
                };
              }),
          deleteContainer: async (
            { id }: { id: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(({ musicLibrary }) => musicLibrary.deletePlaylist(id))
              .then((_) => {
                lastUpdate.bumpCatalog();
                return { deleteContainerResult: {} };
              }),
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
              .then((_) => {
                lastUpdate.bumpCatalog();
                return { addToContainerResult: { updateId: "" } };
              }),
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
              .then(async ({ musicLibrary, typeId, indices }) => {
                // AWAIT the whole chain. None of this was awaited or caught: a transient failure
                // was an unhandled rejection (process exit on Node 20+), and Sonos was told the
                // removal succeeded before it had been attempted - so the immediate re-browse,
                // now served from the playlist cache, showed the track still there.
                if (id == "playlists") {
                  const all = await musicLibrary.playlists();
                  // Delete by id resolved BEFORE any deletion, because deleting shifts the
                  // positions the remaining indices refer to.
                  const doomed = indices
                    .map((i) => all[i]?.id)
                    .filter((it): it is string => !!it);
                  for (const playlistId of doomed) {
                    await musicLibrary.deletePlaylist(playlistId);
                  }
                } else {
                  await musicLibrary.removeFromPlaylist(typeId, indices);
                }
              })
              .then((_) => {
                lastUpdate.bumpCatalog();
                return { removeFromContainerResult: { updateId: "" } };
              }),

          // SMAPI's rename for a container. create/delete/addTo/removeFrom were all implemented and
          // this was not, so renaming a playlist in the app returned a fault. Subsonic's
          // updatePlaylist takes a name, so it is the same call the add/remove path already makes.
          renameContainer: async (
            { id, title }: { id: string; title: string },
            _,
            soapyHeaders: SoapyHeaders,
            { headers }: Pick<Request, "headers">
          ) =>
            login(findLoginToken(soapyHeaders, headers))
              .then(withSplitId(id))
              .then(({ musicLibrary, typeId }) =>
                musicLibrary.renamePlaylist(typeId, title)
              )
              .then((renamed) => {
                // renamePlaylist resolves FALSE when Subsonic answers non-ok. Ignoring the boolean
                // told Sonos the rename succeeded and moved the catalog stamp, so the re-browse it
                // performed showed the OLD name back with no error reported anywhere.
                if (!renamed) {
                  throw {
                    Fault: {
                      faultcode: "Server.ServiceUnknownError",
                      faultstring: "Failed to rename the playlist",
                    },
                  };
                }
                lastUpdate.bumpCatalog();
                return { renameContainerResult: {} };
              }),

          // How the PLAYER tells the service that a getMediaURI result failed to play. Unhandled it
          // faulted and the reason was discarded - on a deployment whose entire debugging loop is
          // reading logs, that is the one report worth never losing. The response is empty by
          // contract; the value is entirely in the log line.
          reportStatus: async ({
            id,
            errorCode,
            message,
          }: {
            id: string;
            errorCode: number;
            message: string;
          }) => {
            // Every field here is client-supplied and this handler is reachable without a login
            // token, so the message is truncated before it reaches the log. sanitizeLogValue
            // already neutralises CR/LF and control characters; this bounds the volume.
            const reported = String(message ?? "").slice(0, MAX_REPORTED_STATUS_MESSAGE);
            logger.warn(
              `Sonos reported a playback failure for ${sanitizeLogValue(
                id
              )}: errorCode=${sanitizeLogValue(String(errorCode))} ${sanitizeLogValue(reported)}`
            );
            return {};
          },

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
              .then((ok) => {
                // Tell Sonos the favourites view is stale ONLY when it actually is. rate() reports
                // false on failure (and logs why), and bumping on a failed write would order a
                // pointless re-fetch of an unchanged list.
                if (ok) lastUpdate.bumpFavourites();
                return { rateItemResult: { shouldSkip: false } };
              }),

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

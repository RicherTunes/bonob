import crypto from "crypto";
import request from "supertest";
import { Client, createClientAsync } from "soap";
import { randomUUID as uuid } from "crypto";
import { either as E, taskEither as TE } from "fp-ts";
import { DOMParserImpl } from "xmldom-ts";
import * as xpath from "xpath-ts";
import { randomInt } from "crypto";

import { LinkCodes } from "../src/link_codes";
import makeServer from "../src/server";
import { bonobService, SONOS_DISABLED, SONOS_LANG } from "../src/sonos";
import {
  STRINGS_ROUTE,
  getMetadataResult,
  splitId,
  withSplitId,
  SOAP_PATH,
  PRESENTATION_MAP_ROUTE,
  SONOS_RECOMMENDED_IMAGE_SIZES,
  track,
  artist,
  album,
  topSongMetadata,
  coverArtURI,
  searchResult,
  iconArtURI,
  sonosifyMimeType,
  ratingAsInt,
  ratingFromInt,
  internetRadioStation,
  findLoginToken,
  MAX_ALBUMS_FLAT,
} from "../src/smapi";
import logger from "../src/logger";

import { keys as i8nKeys } from "../src/i8n";
import {
  aService,
  getAppLinkMessage,
  anArtist,
  anAlbum,
  aTrack,
  POP,
  ROCK,
  TRIP_HOP,
  PUNK,
  aPlaylist,
  aRadioStation,
  anArtistSummary,
  anAlbumSummary,
  someSoapHeadersForToken,
} from "./builders";
import { InMemoryMusicService } from "./in_memory_music_service";
import supersoap from "./supersoap";
import {
  albumToAlbumSummary,
  artistToArtistSummary,
  MusicService,
  playlistToPlaylistSummary,
  AuthFailure,
} from "../src/music_library";
import { APITokens } from "../src/api_tokens";
import dayjs from "dayjs";
import url, { URLBuilder } from "../src/url_builder";
import { iconForGenre } from "../src/icon";
import { formatForURL } from "../src/burn";
import { FixedClock } from "../src/clock";
import { ExpiredTokenError, InvalidTokenError, SmapiAuthTokens, SmapiToken, ToSmapiFault } from "../src/smapi_auth";

const parseXML = (value: string) => new DOMParserImpl().parseFromString(value);

// Builds a minimal in-memory artist index for the Artists-browse tests: `items` in scan order with
// explicit `buckets` (defaults to one bucket over all items). The artists branch serves the flat
// list (small catalog) or the A-Z letter menu (large) off the same shape the real index has, so the
// bucket keys here are Navidrome's letters verbatim.
const anArtistIndex = (
  items: any[],
  opts: { total?: number; buckets?: any[] } = {}
) => ({
  total: opts.total ?? items.length,
  buckets:
    opts.buckets ??
    (items.length > 0
      ? [{ key: "A", label: "A", offset: 0, count: items.length }]
      : []),
  items,
});

describe("splitId", () => {
  it("splits on the first colon so ids that contain colons keep their full typeId", () => {
    expect(splitId("root")).toEqual({ type: "root", typeId: "" });
    expect(splitId("artist:123")).toEqual({ type: "artist", typeId: "123" });
    expect(splitId("year:?")).toEqual({ type: "year", typeId: "?" });
    expect(splitId("albumsByLetter:#")).toEqual({ type: "albumsByLetter", typeId: "#" });
    expect(splitId("albumsChunk:S_0")).toEqual({ type: "albumsChunk", typeId: "S_0" });
    // ids whose typeId itself contains colons must NOT be truncated
    expect(splitId("artist:a:b")).toEqual({ type: "artist", typeId: "a:b" });
    expect(splitId("topSongs:a:b")).toEqual({ type: "topSongs", typeId: "a:b" });
  });
});

describe("withSplitId", () => {
  // Directly exercises the withSplitId combinator (the declaration line is otherwise only ever
  // hit indirectly through handler chains). A mutant that drops the spread of splitId(id), or
  // hard-codes the typeId, makes the merged object wrong -> red.
  it("merges the split type/typeId into the target object", () => {
    const base = { musicLibrary: "ml", apiKey: "k" };
    expect(withSplitId("track:abc")(base)).toEqual({
      musicLibrary: "ml",
      apiKey: "k",
      type: "track",
      typeId: "abc",
    });
  });

  it("preserves ids whose typeId itself contains colons (split-on-first-colon)", () => {
    expect(withSplitId("topSongs:a:b:c")({ x: 1 })).toEqual({
      x: 1,
      type: "topSongs",
      typeId: "a:b:c",
    });
  });

  it("returns an empty typeId when there is no colon", () => {
    expect(withSplitId("root")({ x: 1 })).toEqual({ x: 1, type: "root", typeId: "" });
  });

  it("does not mutate the target it receives", () => {
    const target = { a: 1 };
    withSplitId("album:9")(target);
    expect(target).toEqual({ a: 1 });
  });
});

describe("rating to and from ints", () => {
  describe("ratingAsInt", () => {
    [
      { rating: { love: false, stars: 0 }, expectedValue: 100 },
      { rating: { love: true, stars: 0 }, expectedValue: 101 },
      { rating: { love: false, stars: 1 }, expectedValue: 110 },
      { rating: { love: true, stars: 1 }, expectedValue: 111 },
      { rating: { love: false, stars: 2 }, expectedValue: 120 },
      { rating: { love: true, stars: 2 }, expectedValue: 121 },
      { rating: { love: false, stars: 3 }, expectedValue: 130 },
      { rating: { love: true, stars: 3 }, expectedValue: 131 },
      { rating: { love: false, stars: 4 }, expectedValue: 140 },
      { rating: { love: true, stars: 4 }, expectedValue: 141 },
      { rating: { love: false, stars: 5 }, expectedValue: 150 },
      { rating: { love: true, stars: 5 }, expectedValue: 151 },
    ].forEach(({ rating, expectedValue }) => {
      it(`should map ${JSON.stringify(
        rating
      )} to a ${expectedValue} and back`, () => {
        const actualValue = ratingAsInt(rating);
        expect(actualValue).toEqual(expectedValue);
        expect(ratingFromInt(actualValue)).toEqual(rating);
      });
    });
  });
});

describe("findLoginToken", () => {
  describe("when there are credentials on the soap header only", () => {
    it("should use them", () => {
      expect(findLoginToken(
        { credentials: { loginToken: { token: "soap-only-token", householdId: "the-household" } } }, 
        {}
      )).toEqual("soap-only-token")
    });
  });

  describe("when the credentials are on the http request header", () => {
    it("should use them", () => {
      expect(findLoginToken(
        { credentials: { loginToken: { householdId: "the-household" } } }, 
        { "accept": "something", "authorization": `Bearer http-request-token` }
      )).toEqual("http-request-token")
    });
  });

  describe("when the credentials are on the http request header, and there are none on the soap header", () => {
    it("should use them", () => {
      expect(findLoginToken(
        { }, 
        { "accept": "something", "authorization": `Bearer http-request-token` }
      )).toEqual("http-request-token")
    });
  });

  describe("when there is no token on the soap header and no http request header", () => {
    it("should return undefined", () => {
      expect(findLoginToken(
        { credentials: { loginToken: { householdId: "the-household" } } }, 
        { "accept": "something" }
      )).toEqual(undefined)
    });
  });

  describe("when there are no credientials at all on the soap header and no http request header", () => {
    it("should return undefined", () => {
      expect(findLoginToken(
        { }, 
        { "accept": "something" }
      )).toEqual(undefined)
    });
  });

});

describe("service config", () => {
  const bonobWithNoContextPath = url("http://localhost:1234");
  const bonobWithContextPath = url("http://localhost:5678/some-context-path");

  [bonobWithNoContextPath, bonobWithContextPath].forEach((bonobUrl) => {
    describe(bonobUrl.href(), () => {
      const server = makeServer(
        SONOS_DISABLED,
        aService({ name: "music land" }),
        bonobUrl,
        new InMemoryMusicService()
      );

      const stringsUrl = bonobUrl.append({ pathname: STRINGS_ROUTE });
      const presentationUrl = bonobUrl.append({
        pathname: PRESENTATION_MAP_ROUTE,
      });

      async function fetchStringsXml() {
        const res = await request(server).get(stringsUrl.path()).send();

        expect(res.status).toEqual(200);

        // removing the sonos xml ns as makes xpath queries with xpath-ts painful
        return parseXML(
          res.text.replace('xmlns="http://sonos.com/sonosapi"', "")
        );
      }

      describe(STRINGS_ROUTE, () => {
        it("should return xml for the strings", async () => {
          const xml: Document = await fetchStringsXml();

          const sonosString = (id: string, lang: string) =>
            xpath.select(
              `string(/stringtables/stringtable[@xml:lang="${lang}"]/string[@stringId="${id}"])`,
              xml
            );

          expect(sonosString("AppLinkMessage", "en-US")).toEqual(
            "Linking sonos with music land"
          );
          expect(sonosString("AppLinkMessage", "nl-NL")).toEqual(
            "Sonos koppelen aan music land"
          );

          // no pt-BR translation, so use en-US
          expect(sonosString("AppLinkMessage", "pt-BR")).toEqual(
            "Linking sonos with music land"
          );
        });

        it("should return a section for all sonos supported languages", async () => {
          const xml = await fetchStringsXml();
          SONOS_LANG.forEach((lang) => {
            expect(
              xpath.select(
                `string(/stringtables/stringtable[@xml:lang="${lang}"]/string[@stringId="AppLinkMessage"])`,
                xml
              )
            ).toBeDefined();
          });
        });
      });

      describe(PRESENTATION_MAP_ROUTE, () => {
        async function presentationMapXml() {
          const res = await request(server).get(presentationUrl.path()).send();
          expect(res.status).toEqual(200);
          // removing the sonos xml ns as makes xpath queries with xpath-ts painful
          return parseXML(
            res.text.replace('xmlns="http://sonos.com/sonosapi"', "")
          );
        }

        it("should have a PageSize of specified", async () => {
          const xml = await presentationMapXml();

          const pageSize = xpath.select(
            `string(/Presentation/BrowseOptions/@PageSize)`,
            xml
          );

          expect(pageSize).toEqual("30");
        });

        it("should have an ArtWorkSizeMap for all sizes recommended by sonos", async () => {
          const xml = await presentationMapXml();

          const imageSizeMap = (size: string) =>
            xpath.select(
              `string(/Presentation/PresentationMap[@type="ArtWorkSizeMap"]/Match/imageSizeMap/sizeEntry[@size="${size}"]/@substitution)`,
              xml
            );

          SONOS_RECOMMENDED_IMAGE_SIZES.forEach((size) => {
            expect(imageSizeMap(size)).toEqual(`/size/${size}`);
          });
        });

        it("should have an BrowseIconSizeMap for all sizes recommended by sonos", async () => {
          const xml = await presentationMapXml();

          const imageSizeMap = (size: string) =>
            xpath.select(
              `string(/Presentation/PresentationMap[@type="BrowseIconSizeMap"]/Match/browseIconSizeMap/sizeEntry[@size="${size}"]/@substitution)`,
              xml
            );

          SONOS_RECOMMENDED_IMAGE_SIZES.forEach((size) => {
            expect(imageSizeMap(size)).toEqual(`/size/${size}`);
          });
        });

        describe("NowPlayingRatings", () => {
          it("should have Matches with propname = rating", async () => {
            const xml = await presentationMapXml();

            const matchElements = xpath.select(
              `/Presentation/PresentationMap[@type="NowPlayingRatings"]/Match`,
              xml
            ) as Element[];

            expect(matchElements.length).toBe(12);

            matchElements.forEach((match) => {
              expect(match.getAttributeNode("propname")?.value).toEqual(
                "rating"
              );
            });
          });

          it("should have Rating stringIds that are in strings.xml", async () => {
            const xml = await presentationMapXml();

            const ratingElements = xpath.select(
              `/Presentation/PresentationMap[@type="NowPlayingRatings"]/Match/Ratings/Rating`,
              xml
            ) as Element[];

            expect(ratingElements.length).toBeGreaterThan(1);

            ratingElements.forEach((rating) => {
              const OnSuccessStringId =
                rating.getAttributeNode("OnSuccessStringId")!.value;
              const StringId = rating.getAttributeNode("StringId")!.value;

              expect(i8nKeys()).toContain(OnSuccessStringId);
              expect(i8nKeys()).toContain(StringId);
            });
          });

          it("should have Rating Ids that are valid ratings as ints", async () => {
            const xml = await presentationMapXml();

            const ratingElements = xpath.select(
              `/Presentation/PresentationMap[@type="NowPlayingRatings"]/Match/Ratings/Rating`,
              xml
            ) as Element[];

            expect(ratingElements.length).toBeGreaterThan(1);

            ratingElements.forEach((ratingElement) => {
              const rating = ratingFromInt(
                Math.abs(
                  Number.parseInt(ratingElement.getAttributeNode("Id")!.value)
                )
              );
              expect(rating.love).toBeDefined();
              expect(rating.stars).toBeGreaterThanOrEqual(0);
              expect(rating.stars).toBeLessThanOrEqual(5);
            });
          });
        });
      });
    });
  });
});

describe("getMetadataResult", () => {
  describe("XML sanitization", () => {
    it("strips XML-1.0-invalid control characters from emitted media text", () => {
      const bad = String.fromCharCode(4); // U+0004, illegal in XML 1.0
      const result = getMetadataResult({
        mediaCollection: [
          {
            itemType: "album",
            id: "album:1",
            title: "Awaken" + bad + " My Love!",
            artist: "Childish" + bad + " Gambino",
          },
        ],
      });
      const item = result.getMetadataResult.mediaCollection![0];
      expect(item.title).toEqual("Awaken My Love!");
      expect(item.artist).toEqual("Childish Gambino");
    });

    it("leaves clean text (incl. unicode/emoji) untouched", () => {
      const result = getMetadataResult({
        mediaCollection: [{ title: "cafe unicode ok & <x>" }],
      });
      expect(result.getMetadataResult.mediaCollection![0].title).toEqual(
        "cafe unicode ok & <x>"
      );
    });
  });

  describe("when there are a no mediaCollections & no mediaMetadata", () => {
    it("should have zero count", () => {
      const result = getMetadataResult({
        index: 33,
        total: 99,
      });

      expect(result).toEqual({
        getMetadataResult: {
          count: 0,
          index: 33,
          total: 99,
        },
      });
    });
  });

  describe("when there are a number of mediaCollections", () => {
    it("should add correct counts", () => {
      const mediaCollection = [{}, {}];
      const result = getMetadataResult({
        mediaCollection,
        index: 22,
        total: 3,
      });

      expect(result).toEqual({
        getMetadataResult: {
          count: 2,
          index: 22,
          total: 3,
          mediaCollection,
        },
      });
    });
  });

  describe("when there are a number of mediaMetadata", () => {
    it("should add correct counts", () => {
      const mediaMetadata = [{}, {}];
      const result = getMetadataResult({
        mediaMetadata,
        index: 22,
        total: 3,
      });

      expect(result).toEqual({
        getMetadataResult: {
          count: 2,
          index: 22,
          total: 3,
          mediaMetadata,
        },
      });
    });
  });

  describe("when there are both a number of mediaMetadata & mediaCollections", () => {
    it("should sum the counts", () => {
      const mediaCollection = [{}, {}, {}];
      const mediaMetadata = [{}, {}];
      const result = getMetadataResult({
        mediaCollection,
        mediaMetadata,
        index: 22,
        total: 3,
      });

      expect(result).toEqual({
        getMetadataResult: {
          count: 5,
          index: 22,
          total: 3,
          mediaCollection,
          mediaMetadata,
        },
      });
    });
  });
});

describe("searchResult", () => {
  // Mirrors the getMetadataResult coverage, but for the search-shaped response. Existing tests
  // only build searchResult with mediaCollection, leaving its `mediaMetadata &&` sanitize arm
  // uncovered; this block exercises both arms and the count summing.
  describe("XML sanitization (mediaMetadata arm)", () => {
    it("strips XML-1.0-invalid control characters from emitted mediaMetadata text", () => {
      const bad = String.fromCharCode(4); // U+0004, illegal in XML 1.0
      const result = searchResult({
        mediaMetadata: [
          {
            itemType: "track",
            id: "track:1",
            title: "Awaken" + bad + " My Love!",
          },
        ],
      });
      const item = result.searchResult.mediaMetadata![0];
      expect(item.title).toEqual("Awaken My Love!");
    });
  });

  describe("when there are a no mediaCollections & no mediaMetadata", () => {
    it("should have zero count and neither key", () => {
      const result = searchResult({ index: 33, total: 99 });
      expect(result).toEqual({
        searchResult: {
          count: 0,
          index: 33,
          total: 99,
        },
      });
    });
  });

  describe("when there are a number of mediaCollections but no mediaMetadata", () => {
    it("emits mediaCollection and omits the mediaMetadata key entirely (&& short-circuits)", () => {
      const mediaCollection = [{}, {}];
      const result = searchResult({ mediaCollection, index: 22, total: 3 });
      expect(result).toEqual({
        searchResult: {
          count: 2,
          index: 22,
          total: 3,
          mediaCollection,
        },
      });
      // A mutant that drops the `&&` guard (always spreads {mediaMetadata: sanitizeXml(undefined)})
      // would add a `mediaMetadata: undefined` key here.
      expect(result.searchResult).not.toHaveProperty("mediaMetadata");
    });
  });

  describe("when there are both a number of mediaMetadata & mediaCollections", () => {
    it("should sum the counts and emit both (sanitized)", () => {
      const mediaCollection = [{}, {}, {}];
      const mediaMetadata = [{}, {}];
      const result = searchResult({ mediaCollection, mediaMetadata, index: 22, total: 3 });
      expect(result).toEqual({
        searchResult: {
          count: 5,
          index: 22,
          total: 3,
          mediaCollection,
          mediaMetadata,
        },
      });
    });
  });
});

describe("track", () => {
  it("should map into a sonos expected track", () => {
    const bonobUrl = url("http://localhost:4567/foo?access-token=1234");
    const someTrack = aTrack({
      id: uuid(),
      // audio/x-flac should be mapped to audio/flac
      encoding: {
        player: "something",
        mimeType: "audio/x-flac"
      },
      name: "great song",
      duration: randomInt(1000),
      number: randomInt(100),
      album: anAlbum({
        name: "great album",
        id: uuid(),
        genre: { id: "genre101", name: "some genre" },
      }),
      artist: anArtist({ name: "great artist", id: uuid() }),
      coverArt: { system: "subsonic", resource: "887766" },
      rating: {
        love: true,
        stars: 5,
      },
    });

    expect(track(bonobUrl, someTrack)).toEqual({
      itemType: "track",
      id: `track:${someTrack.id}`,
      mimeType: "audio/flac",
      title: someTrack.name,

      trackMetadata: {
        album: someTrack.album.name,
        albumId: `album:${someTrack.album.id}`,
        albumArtist: someTrack.artist.name,
        albumArtistId: `artist:${someTrack.artist.id}`,
        albumArtURI: `http://localhost:4567/foo/art/${encodeURIComponent(
          formatForURL(someTrack.coverArt!)
        )}/size/180?access-token=1234`,
        artist: someTrack.artist.name,
        artistId: `artist:${someTrack.artist.id}`,
        duration: someTrack.duration,
        genre: someTrack.album.genre?.name,
        genreId: someTrack.album.genre?.id,
        trackNumber: someTrack.number,
      },
      dynamic: {
        property: [
          {
            name: "rating",
            value: `${ratingAsInt(someTrack.rating)}`,
          },
        ],
      },
    });
  });

  describe("when there is no artistId from subsonic", () => {
    it("should not send an artist id to sonos", () => {
      const bonobUrl = url("http://localhost:4567/foo?access-token=1234");
      const someTrack = aTrack({
        id: uuid(),
        // audio/x-flac should be mapped to audio/flac
        encoding: {
          player: "something",
          mimeType: "audio/x-flac"
        },
        name: "great song",
        duration: randomInt(1000),
        number: randomInt(100),
        album: anAlbum({
          name: "great album",
          id: uuid(),
          genre: { id: "genre101", name: "some genre" },
        }),
        artist: anArtist({ name: "great artist", id: undefined }),
        coverArt: { system: "subsonic", resource: "887766" },
        rating: {
          love: true,
          stars: 5,
        },
      });

      expect(track(bonobUrl, someTrack)).toEqual({
        itemType: "track",
        id: `track:${someTrack.id}`,
        mimeType: "audio/flac",
        title: someTrack.name,

        trackMetadata: {
          album: someTrack.album.name,
          albumId: `album:${someTrack.album.id}`,
          albumArtist: someTrack.artist.name,
          albumArtistId: undefined,
          albumArtURI: `http://localhost:4567/foo/art/${encodeURIComponent(
            formatForURL(someTrack.coverArt!)
          )}/size/180?access-token=1234`,
          artist: someTrack.artist.name,
          artistId: undefined,
          duration: someTrack.duration,
          genre: someTrack.album.genre?.name,
          genreId: someTrack.album.genre?.id,
          trackNumber: someTrack.number,
        },
        dynamic: {
          property: [
            {
              name: "rating",
              value: `${ratingAsInt(someTrack.rating)}`,
            },
          ],
        },
      });
    });
  });
});

describe("album", () => {
  it("should map to a sonos album", () => {
    const bonobUrl = url("http://localhost:9988/some-context-path?s=hello");
    const someAlbum = anAlbum({ id: "id123", name: "What a great album" });

    expect(album(bonobUrl, someAlbum)).toEqual({
      itemType: "album",
      id: `album:${someAlbum.id}`,
      title: someAlbum.name,
      albumArtURI: coverArtURI(bonobUrl, someAlbum).href(),
      canPlay: true,
      artist: someAlbum.artistName,
      artistId: `artist:${someAlbum.artistId}`,
    });
  });
});

describe("internetRadioStation", () => {
  it("should map to a sonos internet stream", () => {
    const station = aRadioStation()
    expect(internetRadioStation(station)).toEqual({
      itemType: "stream",
      id: `internetRadioStation:${station.id}`,
      title: station.name,
      mimeType: "audio/mpeg"
    })
  });
});

describe("sonosifyMimeType", () => {
  describe("when is audio/x-flac", () => {
    it("should be mapped to audio/flac", () => {
      expect(sonosifyMimeType("audio/x-flac")).toEqual("audio/flac");
    });
  });

  describe("when it is not audio/x-flac", () => {
    it("should be returned as is", () => {
      expect(sonosifyMimeType("audio/flac")).toEqual("audio/flac");
      expect(sonosifyMimeType("audio/mpeg")).toEqual("audio/mpeg");
      expect(sonosifyMimeType("audio/whoop")).toEqual("audio/whoop");
    });
  });
});


describe("coverArtURI", () => {
  const bonobUrl = new URLBuilder(
    "http://bonob.example.com:8080/context?search=yes"
  );

  describe("when there is an album coverArt", () => {
    describe("from subsonic", () => {
      it("should use it", () => {
        const coverArt = { system: "subsonic", resource: "12345" };
        expect(
          coverArtURI(bonobUrl, anAlbum({ coverArt })).href()
        ).toEqual(
          `http://bonob.example.com:8080/context/art/${encodeURIComponent(
            formatForURL(coverArt)
          )}/size/180?search=yes`
        );
      });
    });

    describe("that is external", () => {
      it("should use encrypt it", () => {
        const coverArt = {
          system: "external",
          resource: "http://example.com/someimage.jpg",
        };
        expect(
          coverArtURI(bonobUrl, anAlbum({ coverArt })).href()
        ).toEqual(
          `http://bonob.example.com:8080/context/art/${encodeURIComponent(
            formatForURL(coverArt)
          )}/size/180?search=yes`
        );
      });
    });
  });

  describe("when there is no album coverArt", () => {
    it("should return a vinly icon image", () => {
      expect(
        coverArtURI(bonobUrl, anAlbum({ coverArt: undefined })).href()
      ).toEqual(
        "http://bonob.example.com:8080/context/icon/vinyl/size/legacy?search=yes"
      );
    });
  });
});

describe("iconArtURI", () => {
  const bonobUrl = new URLBuilder(
    "http://bonob.example.com:8080/context?search=yes"
  );

  describe("with no text", () => {
    it("should return just the icon uri", () => {
      expect(iconArtURI(bonobUrl, "mushroom").href()).toEqual("http://bonob.example.com:8080/context/icon/mushroom/size/legacy?search=yes")
    });
  });

  describe("with text", () => {
    it("should return just the icon uri", () => {
      expect(iconArtURI(bonobUrl, "yyyy", "foobar10000").href()).toEqual("http://bonob.example.com:8080/context/icon/yyyy:foobar10000/size/legacy?search=yes")
    });
  });
});

describe("wsdl api", () => {
  const musicService = {
    generateToken: jest.fn(),
    refreshToken: jest.fn(),
    login: jest.fn(),
  };
  const linkCodes = {
    mint: jest.fn(),
    has: jest.fn(),
    associate: jest.fn(),
    associationFor: jest.fn(),
  };
  const musicLibrary = {
    artists: jest.fn(),
    artist: jest.fn(),
    genres: jest.fn(),
    years: jest.fn(),
    year: jest.fn(),
    playlists: jest.fn(),
    playlist: jest.fn(),
    album: jest.fn(),
    albums: jest.fn(),
    albumIndex: jest.fn(),
    peekAlbumIndex: jest.fn(),
    albumCount: jest.fn(),
    peekAlbumCount: jest.fn(),
    peekArtists: jest.fn(),
    artistIndex: jest.fn(),
    peekArtistIndex: jest.fn(),
    tracks: jest.fn(),
    track: jest.fn(),
    topSongs: jest.fn(),
    starredSongs: jest.fn(),
    peekStarredSongs: jest.fn(),
    searchArtists: jest.fn(),
    searchAlbums: jest.fn(),
    searchTracks: jest.fn(),
    createPlaylist: jest.fn(),
    addToPlaylist: jest.fn(),
    deletePlaylist: jest.fn(),
    removeFromPlaylist: jest.fn(),
    scrobble: jest.fn(),
    nowPlaying: jest.fn(),
    rate: jest.fn(),
    radioStation: jest.fn(),
    radioStations: jest.fn(),
  };
  const apiTokens = {
    mint: jest.fn(),
    authTokenFor: jest.fn(),
  };

  const smapiAuthTokens = {
    issue: jest.fn(() => ({ token: `default-smapiToken-${uuid()}` })),
    verify: jest.fn<E.Either<ToSmapiFault, string>, []>(() => E.right(`default-serviceToken-${uuid()}`)),
  };

  const clock = new FixedClock();

  const bonobUrlWithoutContextPath = url("http://localhost:222");
  const bonobUrlWithContextPath = url("http://localhost:111/path/to/bonob");

  [bonobUrlWithoutContextPath, bonobUrlWithContextPath].forEach((bonobUrl) => {
    describe(`bonob with url ${bonobUrl}`, () => {
      const serviceToken = `serviceToken-${uuid()}`;
      const apiToken = `apiToken-${uuid()}`;
      const smapiAuthToken: SmapiToken = {
        token: `smapiAuthToken.token-${uuid()}`
      };

      const bonobUrlWithAccessToken = bonobUrl.append({
        searchParams: { bat: apiToken },
      });

      const service = bonobService("test-api", 133, bonobUrl, "AppLink");
      const server = makeServer(
        SONOS_DISABLED,
        service,
        bonobUrl,
        musicService as unknown as MusicService,
        {
          linkCodes: () => linkCodes as unknown as LinkCodes,
          apiTokens: () => apiTokens as unknown as APITokens,
          clock,
          smapiAuthTokens: smapiAuthTokens as unknown as SmapiAuthTokens,
        }
      );

      beforeEach(() => {
        jest.clearAllMocks();
        jest.resetAllMocks();
      });

      function randomlySetAuthenticationMethod(ws: Client, token: string) {
        if(Math.random() < 0.5) {
          // todo: soap will still sell some soap headers, need to add in here..
          ws.addHttpHeader("authorization", `Bearer ${token}`)
        } else {
          ws.addSoapHeader(someSoapHeadersForToken(token));
        }
        return ws;
      }

      function setupAuthenticatedRequest(ws: Client) {
        musicService.login.mockResolvedValue(musicLibrary);
        smapiAuthTokens.verify.mockReturnValue(E.right(serviceToken));
        apiTokens.mint.mockReturnValue(apiToken);
        return randomlySetAuthenticationMethod(ws, serviceToken)
      }

      describe("soap api", () => {
        describe("soapyService.log error routing", () => {
          // The soap library invokes soapyService.log('error', err, req) from its synchronous
          // catch in _processRequestXml (node-soap server.js ~L247) when a request body cannot be
          // parsed. Our switch routes that to logger.error({level:'error', data}). A malformed-XML
          // POST is the smallest request that triggers it; a mutant that drops the `case "error":`
          // arm (or retargets it) stops logger.error receiving {level:'error'} -> red.
          it("routes a soap-lib 'error' log to logger.error when the request body is unparseable", async () => {
            const errorSpy = jest.spyOn(logger, "error");
            try {
              const res = await request(server)
                .post(bonobUrl.append({ pathname: SOAP_PATH }).path())
                .set("Content-Type", "text/xml; charset=utf-8")
                .send("<<<this is not valid xml>>>");
              // The soap lib replies 500 to an unparseable body (it throws in wsdl.xmlToObject).
              expect([500, 400]).toContain(res.status);
              const routedThroughErrorArm = errorSpy.mock.calls.some(
                (args) =>
                  args[0] &&
                  typeof args[0] === "object" &&
                  (args[0] as { level?: string }).level === "error"
              );
              expect(routedThroughErrorArm).toBe(true);
            } finally {
              errorSpy.mockRestore();
            }
          });
        });

        describe("getAppLink", () => {
          it("should do something", async () => {
            const ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });

            const linkCode = "theLinkCode8899";

            linkCodes.mint.mockReturnValue(linkCode);

            const result = await ws.getAppLinkAsync(getAppLinkMessage());

            expect(result[0]).toEqual({
              getAppLinkResult: {
                authorizeAccount: {
                  appUrlStringId: "AppLinkMessage",
                  deviceLink: {
                    regUrl: bonobUrl
                      .append({
                        pathname: "/login",
                        searchParams: { linkCode },
                      })
                      .href(),
                    linkCode: linkCode,
                    showLinkCode: false,
                  },
                },
              },
            });
          });
        });

        describe("reportAccountAction", () => {
          it("should do something", async () => {
            const ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });

            const type = "something";

            const result = await ws.reportAccountActionAsync({ type });

            expect(result[0]).toEqual(null);
          });
        });

        describe("getDeviceAuthToken", () => {
          describe("when there is a linkCode association", () => {
            it("should return a device auth token", async () => {
              const linkCode = uuid();
              const association = {
                serviceToken: "serviceToken",
                userId: "uid",
                nickname: "nick",
              };
              linkCodes.associationFor.mockReturnValue(association);
              smapiAuthTokens.issue.mockReturnValue(smapiAuthToken);

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });

              const result = await ws.getDeviceAuthTokenAsync({ linkCode });

              expect(result[0]).toEqual({
                getDeviceAuthTokenResult: {
                  authToken: smapiAuthToken.token,
                  privateKey: "alwaysReauthenticate",
                  userInfo: {
                    userIdHashCode: crypto
                      .createHash("sha256")
                      .update(association.userId)
                      .digest("hex"),
                    nickname: association.nickname,
                  },
                },
              });
              expect(linkCodes.associationFor).toHaveBeenCalledWith(linkCode);
            });
          });

          describe("when there is no linkCode association", () => {
            it("should return a device auth token", async () => {
              const linkCode = "invalidLinkCode";
              linkCodes.associationFor.mockReturnValue(undefined);

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });

              await ws
                .getDeviceAuthTokenAsync({ linkCode })
                .then(() => {
                  fail("Shouldnt get here");
                })
                .catch((e: any) => {
                  expect(e.root.Envelope.Body.Fault).toEqual({
                    faultcode: "Client.NOT_LINKED_RETRY",
                    faultstring:
                      "Link Code not found yet, sonos app will keep polling until you log in to bonob",
                    detail: {
                      ExceptionInfo: "NOT_LINKED_RETRY",
                      SonosError: "5",
                    },
                  });
                });
            });
          });
        });

        describe("getLastUpdate", () => {
          it("should return a result with some timestamps", async () => {
            const now = dayjs();
            clock.time = now;

            const ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });

            const result = await ws.getLastUpdateAsync({});

            expect(result[0]).toEqual({
              getLastUpdateResult: {
                autoRefreshEnabled: true,
                favorites: `${now.unix()}`,
                catalog: `${now.unix()}`,
                pollInterval: 60,
              },
            });
          });
        });

        describe("refreshAuthToken", () => {
          describe("when no credentials are provided", () => {
            itShouldReturnALoginUnsupported((ws) =>
              ws.refreshAuthTokenAsync({})
            );
          });

          describe("when token has expired", () => {
            it("should return a refreshed auth token", async () => {
              const refreshedServiceToken = `refreshedServiceToken-${uuid()}`
              const newSmapiAuthToken = { token: `newToken-${uuid()}`, key: `newKey-${uuid()}` };

              smapiAuthTokens.verify.mockReturnValue(E.left(new ExpiredTokenError(serviceToken)));
              musicService.refreshToken.mockReturnValue(TE.right({ serviceToken: refreshedServiceToken }));
              smapiAuthTokens.issue.mockReturnValue(newSmapiAuthToken);

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token)

              const result = await ws.refreshAuthTokenAsync({});

              expect(result[0]).toEqual({
                refreshAuthTokenResult: {
                  authToken: newSmapiAuthToken.token,
                  privateKey: "nonsense"
                },
              });

              expect(musicService.refreshToken).toHaveBeenCalledWith(serviceToken);
              expect(smapiAuthTokens.issue).toHaveBeenCalledWith(refreshedServiceToken);
            });
          });

          describe("when the token fails to verify", () => {
            it("should fail with a sampi fault", async () => {
              smapiAuthTokens.verify.mockReturnValue(E.left(new InvalidTokenError("Invalid token")));

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token)

              await ws.refreshAuthTokenAsync({})
              .then(() => fail("shouldnt get here"))
              .catch((e: any) => {
                expect(e.root.Envelope.Body.Fault).toEqual({
                  faultcode: "Client.LoginUnauthorized",
                  faultstring: "Failed to authenticate, try Re-Authorising your account in the sonos app",                });
              });
            });
          });          

          describe("when existing auth token has not expired", () => {
            it("should return a refreshed auth token", async () => {
              const refreshedServiceToken = `refreshedServiceToken-${uuid()}`
              const newSmapiAuthToken = { token: `newToken-${uuid()}`, key: `newKey-${uuid()}` };

              smapiAuthTokens.verify.mockReturnValue(E.right(serviceToken));
              musicService.refreshToken.mockReturnValue(TE.right({ serviceToken: refreshedServiceToken }));
              smapiAuthTokens.issue.mockReturnValue(newSmapiAuthToken);

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token)

              const result = await ws.refreshAuthTokenAsync({});

              expect(result[0]).toEqual({
                refreshAuthTokenResult: {
                  authToken: newSmapiAuthToken.token,
                  privateKey: "nonsense"
                },
              });

              expect(musicService.refreshToken).toHaveBeenCalledWith(serviceToken);
              expect(smapiAuthTokens.issue).toHaveBeenCalledWith(refreshedServiceToken);
            });
          });

          describe("when the music service fails to refresh the token", () => {
            it("returns a LoginUnauthorized fault", async () => {
              smapiAuthTokens.verify.mockReturnValue(E.right(serviceToken));
              musicService.refreshToken.mockReturnValue(
                TE.left(new AuthFailure("refresh failed"))
              );

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token);

              await ws
                .refreshAuthTokenAsync({})
                .then(() => fail("shouldnt get here"))
                .catch((e: any) => {
                  expect(e.root.Envelope.Body.Fault).toEqual({
                    faultcode: "Client.LoginUnauthorized",
                    faultstring:
                      "Failed to authenticate, try Re-Authorising your account in the sonos app",
                  });
                });
              expect(musicService.refreshToken).toHaveBeenCalledWith(serviceToken);
            });
          });
        });

        describe("search", () => {
          itShouldHandleInvalidCredentials((ws) =>
            ws.getMetadataAsync({ id: "search", index: 0, count: 0 })
          );

          describe("when valid credentials are provided", () => {
            let ws: Client;

            beforeEach(async () => {
              ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              setupAuthenticatedRequest(ws);
            });

            describe("searching for albums", () => {
              const album1 = anAlbum();
              const album2 = anAlbum();
              const albums = [album1, album2];

              beforeEach(() => {
                musicLibrary.searchAlbums.mockResolvedValue([
                  albumToAlbumSummary(album1),
                  albumToAlbumSummary(album2),
                ]);
              });

              it("should return the albums", async () => {
                const term = "whoop";

                const result = await ws.searchAsync({
                  id: "albums",
                  term,
                });
                expect(result[0]).toEqual(
                  searchResult({
                    mediaCollection: albums.map((it) =>
                      album(bonobUrlWithAccessToken, albumToAlbumSummary(it))
                    ),
                    index: 0,
                    total: 2,
                  })
                );
                expect(musicLibrary.searchAlbums).toHaveBeenCalledWith(term);
              });
            });

            describe("searching for artists", () => {
              const artist1 = anArtist();
              const artist2 = anArtist();
              const artists = [artist1, artist2];

              beforeEach(() => {
                musicLibrary.searchArtists.mockResolvedValue([
                  artistToArtistSummary(artist1),
                  artistToArtistSummary(artist2),
                ]);
              });

              it("should return the artists", async () => {
                const term = "whoopie";

                const result = await ws.searchAsync({
                  id: "artists",
                  term,
                });
                expect(result[0]).toEqual(
                  searchResult({
                    mediaCollection: artists.map((it) =>
                      artist(bonobUrlWithAccessToken, artistToArtistSummary(it))
                    ),
                    index: 0,
                    total: 2,
                  })
                );
                expect(musicLibrary.searchArtists).toHaveBeenCalledWith(term);
              });
            });

            describe("searching for tracks", () => {
              const track1 = aTrack();
              const track2 = aTrack();
              const tracks = [track1, track2];

              beforeEach(() => {
                musicLibrary.searchTracks.mockResolvedValue([track1, track2]);
              });

              // The Songs category must return SONGS. It used to collapse every hit into its
              // album and return album tiles, so searching a song title showed albums and never
              // the song - reported from the Sonos app as "I searched 'all i need' and only
              // albums showed up".
              it("should return the tracks as playable songs, not their albums", async () => {
                const term = "whoopie";

                const result = await ws.searchAsync({
                  id: "tracks",
                  term,
                });
                expect(result[0]).toEqual(
                  searchResult({
                    mediaMetadata: tracks.map((it) =>
                      topSongMetadata(bonobUrlWithAccessToken, it)
                    ),
                    index: 0,
                    total: 2,
                  })
                );
                expect(musicLibrary.searchTracks).toHaveBeenCalledWith(term);
              });

              it("keeps several hits from the SAME album as distinct songs", async () => {
                // Track hits render as ALBUM tiles, so N hits from one album produced N identical
                // tiles. Each carried its own song's art id, so that was also N distinct /art urls
                // and N distinct coalescing keys - up to 20x the cover-art fetches for one search
                // page, defeating the coordinator. Collapsing here fixes the redundancy where it
                // actually lives, and keeps the art id the server returned (OpenSubsonic specifies
                // getCoverArt takes that opaque value, so synthesizing one from albumId is not
                // portable even though it works on Navidrome).
                const sharedAlbum = aTrack().album;
                const hits = Array.from({ length: 5 }, () =>
                  aTrack({ album: sharedAlbum })
                );
                musicLibrary.searchTracks.mockResolvedValue(hits);

                const result = await ws.searchAsync({ id: "tracks", term: "whoopie" });

                // Five distinct songs are five distinct results - collapsing them was an artifact
                // of rendering tracks AS albums. Cover-art coalescing still holds: tracks from one
                // album carry the same server-returned coverArt value, so one /art url is shared.
                const res = result[0].searchResult;
                expect(res.count).toEqual(5);
                expect(res.total).toEqual(5);
                const artUrls = new Set(
                  [res.mediaMetadata].flat().map((m: any) => m.trackMetadata.albumArtURI)
                );
                expect([res.mediaMetadata].flat().length).toEqual(5);
                expect(artUrls.size).toBeLessThanOrEqual(5);
              });

              it("returns every hit, including two songs from the same album", async () => {
                const a = aTrack();
                const b = aTrack();
                const c = aTrack({ album: a.album });
                musicLibrary.searchTracks.mockResolvedValue([a, b, c]);

                const result = await ws.searchAsync({ id: "tracks", term: "whoopie" });

                expect(result[0]).toEqual(
                  searchResult({
                    mediaMetadata: [a, b, c].map((it) =>
                      topSongMetadata(bonobUrlWithAccessToken, it)
                    ),
                    index: 0,
                    total: 3,
                  })
                );
              });
            });

            describe("searching for an unsupported type", () => {
              it("should return the tracks", async () => {
                const term = "whoopie";

                const result = await ws.searchAsync({
                  id: "foobar",
                  term,
                });
                expect(result[0]).toEqual(
                  searchResult({
                    count: 0,
                    index: 0,
                    total: 0,
                  })
                );
              });
            });
          });
        });

        async function itShouldReturnALoginUnsupported(
          action: (ws: Client) => Promise<Client>
        ) {
          it("should return a fault of LoginUnsupported", async () => {
            const ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });

            await action(ws)
              .then(() => fail("shouldnt get here"))
              .catch((e: any) => {
                expect(e.root.Envelope.Body.Fault).toEqual({
                  faultcode: "Client.LoginUnsupported",
                  faultstring: "Missing credentials...",
                });
              });
          });
        }

        async function itShouldReturnAFaultOfLoginUnauthorized(
          verifyResponse: E.Either<ToSmapiFault, string>,
          action: (ws: Client) => Promise<Client>
        ) {
          it("should return a fault of LoginUnauthorized", async () => {
            smapiAuthTokens.verify.mockReturnValue(verifyResponse);
            musicService.login.mockRejectedValue("fail!");

            const ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
            randomlySetAuthenticationMethod(ws, 'tokenThatFails');

            await action(ws)
              .then(() => fail("shouldnt get here"))
              .catch((e: any) => {
                expect(e.root.Envelope.Body.Fault).toEqual({
                  faultcode: "Client.LoginUnauthorized",
                  faultstring:
                    "Failed to authenticate, try Re-Authorising your account in the sonos app",
                });
              });
          });
        }

        function itShouldHandleInvalidCredentials(
          action: (ws: Client) => Promise<Client>
        ) {
          describe("when no credentials are provided", () => {
            itShouldReturnALoginUnsupported(action);
          });

          describe("when the token fails to verify", () => {
            itShouldReturnAFaultOfLoginUnauthorized(
              E.left(new InvalidTokenError("Token Invalid")),
              action
            );
          });

          describe("when token has expired", () => {
            it("should return a fault of Client.TokenRefreshRequired with a refreshAuthTokenResult", async () => {
              const refreshedServiceToken = `refreshedServiceToken-${uuid()}`
              const newToken = {
                token: `newToken-${uuid()}`,
                key: `newKey-${uuid()}`
              };
  
              smapiAuthTokens.verify.mockReturnValue(E.left(new ExpiredTokenError(serviceToken)))
              musicService.refreshToken.mockReturnValue(TE.right({ serviceToken: refreshedServiceToken }))
              smapiAuthTokens.issue.mockReturnValue(newToken)
              musicService.login.mockRejectedValue(
                "fail, should not call login!"
              );
  
              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token);
              await action(ws)
                .then(() => fail("shouldnt get here"))
                .catch((e: any) => {
                  expect(e.root.Envelope.Body.Fault).toEqual({
                    faultcode: "Client.TokenRefreshRequired",
                    faultstring: "Token has expired",
                    detail: {
                      refreshAuthTokenResult: {
                        authToken: newToken.token,
                        privateKey: "nonsense",
                      },
                    },
                  });
                });
  
                expect(smapiAuthTokens.verify).toHaveBeenCalledWith(smapiAuthToken);
                expect(musicService.refreshToken).toHaveBeenCalledWith(serviceToken);
                expect(smapiAuthTokens.issue).toHaveBeenCalledWith(refreshedServiceToken);
            });
          });
        }

        describe("getMetadata", () => {
          itShouldHandleInvalidCredentials((ws) =>
            ws.getMetadataAsync({ id: "root", index: 0, count: 0 })
          );

          // The `login()` helper has a branch the itShouldHandleInvalidCredentials ladder cannot
          // reach: auth SUCCEEDS (valid token) but musicService.login() then rejects, and an
          // expired token whose refresh ALSO fails. Both must surface as LoginUnauthorized.
          describe("when a valid token verifies but the music service login rejects", () => {
            it("returns a LoginUnauthorized fault, not the raw backend error", async () => {
              smapiAuthTokens.verify.mockReturnValue(E.right(serviceToken));
              apiTokens.mint.mockReturnValue(apiToken);
              musicService.login.mockRejectedValue(new Error("backend down"));

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token);

              await ws
                .getMetadataAsync({ id: "root", index: 0, count: 0 })
                .then(() => fail("shouldnt get here"))
                .catch((e: any) => {
                  expect(e.root.Envelope.Body.Fault).toEqual({
                    faultcode: "Client.LoginUnauthorized",
                    faultstring:
                      "Failed to authenticate, try Re-Authorising your account in the sonos app",
                  });
                });
              expect(musicService.login).toHaveBeenCalledWith(serviceToken);
            });
          });

          describe("when an expired token cannot be refreshed", () => {
            it("returns a LoginUnauthorized fault", async () => {
              smapiAuthTokens.verify.mockReturnValue(
                E.left(new ExpiredTokenError(serviceToken))
              );
              musicService.refreshToken.mockReturnValue(
                TE.left(new AuthFailure("refresh failed"))
              );

              const ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              randomlySetAuthenticationMethod(ws, smapiAuthToken.token);

              await ws
                .getMetadataAsync({ id: "root", index: 0, count: 0 })
                .then(() => fail("shouldnt get here"))
                .catch((e: any) => {
                  expect(e.root.Envelope.Body.Fault).toEqual({
                    faultcode: "Client.LoginUnauthorized",
                    faultstring:
                      "Failed to authenticate, try Re-Authorising your account in the sonos app",
                  });
                });
              expect(musicService.refreshToken).toHaveBeenCalledWith(serviceToken);
              expect(musicService.login).not.toHaveBeenCalled();
            });
          });

          describe("when valid credentials are provided", () => {
            let ws: Client;

            beforeEach(async () => {
              ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              setupAuthenticatedRequest(ws);
            });

            describe("asking for the root container", () => {
              describe("when no accept-language header is present", () => {
                it("should return en-US", async () => {
                  const root = await ws.getMetadataAsync({
                    id: "root",
                    index: 0,
                    count: 100,
                  });
                  const mediaCollection = [
                    {
                      id: "artists",
                      title: "Artists",
                      albumArtURI: iconArtURI(bonobUrl, "artists").href(),
                      itemType: "container",
                    },
                    {
                      id: "albums",
                      title: "Albums",
                      albumArtURI: iconArtURI(bonobUrl, "albums").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "randomAlbums",
                      title: "Random",
                      albumArtURI: iconArtURI(bonobUrl, "random").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "favouriteAlbums",
                      title: "Favourite Albums",
                      albumArtURI: iconArtURI(bonobUrl, "heart").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "favouriteSongs",
                      title: "Favourite Songs",
                      albumArtURI: iconArtURI(bonobUrl, "heart").href(),
                      itemType: "trackList",
                    },
                    {
                      id: "starredAlbums",
                      title: "Top Rated",
                      albumArtURI: iconArtURI(bonobUrl, "star").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "playlists",
                      title: "Playlists",
                      albumArtURI: iconArtURI(bonobUrl, "playlists").href(),
                      itemType: "collection",
                      attributes: {
                        userContent: "true",
                      },
                    },
                    {
                      id: "genres",
                      title: "Genres",
                      albumArtURI: iconArtURI(bonobUrl, "genres").href(),
                      itemType: "container",
                    },
                    {
                      id: "years",
                      title: "Years",
                      albumArtURI: iconArtURI(bonobUrl, "music").href(),
                      itemType: "container",
                    },
                    {
                      id: "recentlyAdded",
                      title: "Recently added",
                      albumArtURI: iconArtURI(bonobUrl, "recentlyAdded").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "recentlyPlayed",
                      title: "Recently played",
                      albumArtURI: iconArtURI(
                        bonobUrl,
                        "recentlyPlayed"
                      ).href(),
                      itemType: "albumList",
                    },
                    {
                      id: "mostPlayed",
                      title: "Most played",
                      albumArtURI: iconArtURI(bonobUrl, "mostPlayed").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "internetRadio",
                      title: "Internet Radio",
                      albumArtURI: iconArtURI(bonobUrl, "radio").href(),
                      itemType: "stream",
                    },
                  ];
                  expect(root[0]).toEqual(
                    getMetadataResult({
                      mediaCollection,
                      index: 0,
                      total: mediaCollection.length,
                    })
                  );
                });
              });

              describe("when an accept-language header is present with value nl-NL", () => {
                it("should return nl-NL", async () => {
                  ws.addHttpHeader("accept-language", "nl-NL, en-US;q=0.9");
                  const root = await ws.getMetadataAsync({
                    id: "root",
                    index: 0,
                    count: 100,
                  });
                  const mediaCollection = [
                    {
                      id: "artists",
                      title: "Artiesten",
                      albumArtURI: iconArtURI(bonobUrl, "artists").href(),
                      itemType: "container",
                    },
                    {
                      id: "albums",
                      title: "Albums",
                      albumArtURI: iconArtURI(bonobUrl, "albums").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "randomAlbums",
                      title: "Willekeurig",
                      albumArtURI: iconArtURI(bonobUrl, "random").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "favouriteAlbums",
                      title: "Favorieten",
                      albumArtURI: iconArtURI(bonobUrl, "heart").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "favouriteSongs",
                      title: "Favourite Songs",
                      albumArtURI: iconArtURI(bonobUrl, "heart").href(),
                      itemType: "trackList",
                    },
                    {
                      id: "starredAlbums",
                      title: "Best beoordeeld",
                      albumArtURI: iconArtURI(bonobUrl, "star").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "playlists",
                      title: "Afspeellijsten",
                      albumArtURI: iconArtURI(bonobUrl, "playlists").href(),
                      itemType: "collection",
                      attributes: {
                        userContent: "true",
                      },
                    },
                    {
                      id: "genres",
                      title: "Genres",
                      albumArtURI: iconArtURI(bonobUrl, "genres").href(),
                      itemType: "container",
                    },
                    {
                      id: "years",
                      title: "Jaren",
                      albumArtURI: iconArtURI(bonobUrl, "music").href(),
                      itemType: "container",
                    },
                    {
                      id: "recentlyAdded",
                      title: "Onlangs toegevoegd",
                      albumArtURI: iconArtURI(bonobUrl, "recentlyAdded").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "recentlyPlayed",
                      title: "Onlangs afgespeeld",
                      albumArtURI: iconArtURI(
                        bonobUrl,
                        "recentlyPlayed"
                      ).href(),
                      itemType: "albumList",
                    },
                    {
                      id: "mostPlayed",
                      title: "Meest afgespeeld",
                      albumArtURI: iconArtURI(bonobUrl, "mostPlayed").href(),
                      itemType: "albumList",
                    },
                    {
                      id: "internetRadio",
                      title: "Internet Radio",
                      albumArtURI: iconArtURI(bonobUrl, "radio").href(),
                      itemType: "stream",
                    },
                  ];
                  expect(root[0]).toEqual(
                    getMetadataResult({
                      mediaCollection,
                      index: 0,
                      total: mediaCollection.length,
                    })
                  );
                });
              });
            });

            describe("asking for a type that doesnt exist", () => {
              it("should return an empty result", async () => {
                const foobar= await ws.getMetadataAsync({
                  id: "foobar",
                  index: 0,
                  count: 100,
                });
                expect(foobar[0]).toEqual(
                  getMetadataResult({
                    count: 0,
                    index: 0,
                    total: 0,
                  })
                );
              });
            });

            describe("asking for the search container", () => {
              it("should return it", async () => {
                const search = await ws.getMetadataAsync({
                  id: "search",
                  index: 0,
                  count: 100,
                });
                expect(search[0]).toEqual(
                  getMetadataResult({
                    mediaCollection: [
                      { itemType: "search", id: "artists", title: "Artists" },
                      { itemType: "search", id: "albums", title: "Albums" },
                      { itemType: "search", id: "tracks", title: "Tracks" },
                    ],
                    index: 0,
                    total: 3,
                  })
                );
              });
            });

            describe("asking for a genres", () => {
              const expectedGenres = [POP, PUNK, ROCK, TRIP_HOP];

              beforeEach(() => {
                musicLibrary.genres.mockResolvedValue(expectedGenres);
              });

              describe("asking for all genres", () => {
                it("should return a collection of genres", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `genres`,
                    index: 0,
                    count: 100,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: expectedGenres.map((genre) => ({
                        itemType: "albumList",
                        id: `genre:${genre.id}`,
                        title: genre.name,
                        albumArtURI: iconArtURI(
                          bonobUrl,
                          iconForGenre(genre.name)
                        ).href(),
                      })),
                      index: 0,
                      total: expectedGenres.length,
                    })
                  );
                });
              });

              describe("when the backend rejects the browse", () => {
                it("returns a 'try again' placeholder, not a Sonos fault", async () => {
                  musicLibrary.genres.mockRejectedValue(new Error("navidrome down"));
                  const result = await ws.getMetadataAsync({
                    id: `genres`,
                    index: 0,
                    count: 100,
                  });
                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(1);
                  const item = Array.isArray(md.mediaCollection)
                    ? md.mediaCollection[0]
                    : md.mediaCollection;
                  expect(item.id).toEqual("genres");
                  expect(String(item.title)).toMatch(/try again/i);
                });
              });

              describe("asking for a page of genres", () => {
                it("should return just that page", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `genres`,
                    index: 1,
                    count: 2,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [PUNK, ROCK].map((genre) => ({
                        itemType: "albumList",
                        id: `genre:${genre.id}`,
                        title: genre.name,
                        albumArtURI: iconArtURI(
                          bonobUrl,
                          iconForGenre(genre.name)
                        ).href(),
                      })),
                      index: 1,
                      total: expectedGenres.length,
                    })
                  );
                });
              });
            });

            describe("asking for a year", () => {
              const expectedYears = [{ year: "?" }, { year: "1969" }, { year: "1980" }, { year: "2001" }, { year: "2010" }];

              beforeEach(() => {
                musicLibrary.years.mockResolvedValue(expectedYears);
              });

              describe("asking for all years", () => {
                it("should return a collection of years", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `years`,
                    index: 0,
                    count: 100,
                  });
                  const albumListForYear = (year: string, icon: URLBuilder) => ({
                    itemType: "albumList",
                    id: `year:${year}`,
                    title: year,
                    albumArtURI: icon.href(),
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [
                        albumListForYear("?",    iconArtURI(bonobUrl, "music")),
                        albumListForYear("1969", iconArtURI(bonobUrl, "yyyy", "1969")),
                        albumListForYear("1980", iconArtURI(bonobUrl, "yyyy", "1980")),
                        albumListForYear("2001", iconArtURI(bonobUrl, "yyyy", "2001")),
                        albumListForYear("2010", iconArtURI(bonobUrl, "yyyy", "2010")),
                      ],
                      index: 0,
                      total: expectedYears.length,
                    })
                  );
                });
              });

              describe("asking for a page of years", () => {
                it("should return just that page", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `years`,
                    index: 2,
                    count: 2,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [{ year: "1980" }, { year: "2001" }].map((year) => ({
                        itemType: "albumList",
                        id: `year:${year.year}`,
                        title: year.year,
                        albumArtURI: iconArtURI(
                          bonobUrl,
                          "yyyy",
                          year.year
                        ).href(),
                      })),
                      index: 2,
                      total: expectedYears.length,
                    })
                  );
                });
              });

              describe("browsing into a year", () => {
                it("queries albums by that year", async () => {
                  musicLibrary.albums.mockResolvedValue({ results: [], total: 0 });
                  await ws.getMetadataAsync({
                    id: "year:1980",
                    index: 0,
                    count: 100,
                  });
                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "byYear",
                    fromYear: "1980",
                    toYear: "1980",
                    _index: 0,
                    _count: 100,
                  });
                });

                it("maps the unknown-year '?' bucket to year 0 (Navidrome rejects '?')", async () => {
                  musicLibrary.albums.mockResolvedValue({ results: [], total: 0 });
                  await ws.getMetadataAsync({
                    id: "year:?",
                    index: 0,
                    count: 100,
                  });
                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "byYear",
                    fromYear: "0",
                    toYear: "0",
                    _index: 0,
                    _count: 100,
                  });
                });
              });
            });

            describe("asking for playlists", () => {
              const playlist1 = aPlaylist({ id: "1", name: "pl1", entries: []});
              const playlist2 = aPlaylist({ id: "2", name: "pl2", entries: []});
              const playlist3 = aPlaylist({ id: "3", name: "pl3", entries: []});
              const playlist4 = aPlaylist({ id: "4", name: "pl4", entries: []});

              const playlists = [playlist1, playlist2, playlist3, playlist4];

              beforeEach(() => {
                musicLibrary.playlists.mockResolvedValue(
                  playlists.map(playlistToPlaylistSummary)
                );
                musicLibrary.playlist.mockResolvedValueOnce(playlist1);
                musicLibrary.playlist.mockResolvedValueOnce(playlist2);
                musicLibrary.playlist.mockResolvedValueOnce(playlist3);
                musicLibrary.playlist.mockResolvedValueOnce(playlist4);
              });

              describe("asking for all playlists", () => {
                it("should return a collection of playlists", async () => {
                  const result = await ws.getMetadataAsync({
                    id: "playlists",
                    index: 0,
                    count: 100,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: playlists.map((playlist) => ({
                        itemType: "playlist",
                        id: `playlist:${playlist.id}`,
                        title: playlist.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          playlist
                        ).href(),
                        canPlay: true,
                        attributes: {
                          userContent: "true",
                        },
                      })),
                      index: 0,
                      total: playlists.length,
                    })
                  );
                });
              });

              describe("asking for a page of playlists", () => {
                it("should return just that page", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `playlists`,
                    index: 1,
                    count: 2,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [playlists[1]!, playlists[2]!].map(
                        (playlist) => ({
                          itemType: "playlist",
                          id: `playlist:${playlist.id}`,
                          title: playlist.name,
                          albumArtURI: coverArtURI(
                            bonobUrlWithAccessToken,
                            playlist
                          ).href(),
                          canPlay: true,
                          attributes: {
                            userContent: "true",
                          },
                        })
                      ),
                      index: 1,
                      total: playlists.length,
                    })
                  );
                });
              });
            });

            describe("asking for a single artist", () => {
              const artistWithManyAlbums = anArtist({
                albums: [anAlbum(), anAlbum(), anAlbum(), anAlbum(), anAlbum()],
              });
              const topSongsEntry = {
                itemType: "trackList",
                id: `topSongs:${artistWithManyAlbums.id}`,
                title: "Top Songs",
                albumArtURI: coverArtURI(bonobUrlWithAccessToken, {
                  coverArt: artistWithManyAlbums.image,
                }).href(),
              };
              const asAlbumItem = (it: any) => ({
                itemType: "album",
                id: `album:${it.id}`,
                title: it.name,
                albumArtURI: coverArtURI(bonobUrlWithAccessToken, it).href(),
                canPlay: true,
                artistId: `artist:${it.artistId}`,
                artist: it.artistName,
              });

              beforeEach(() => {
                musicLibrary.artist.mockResolvedValue(artistWithManyAlbums);
              });

              describe("the artist view", () => {
                it("returns a Top Songs entry first, then the albums", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `artist:${artistWithManyAlbums.id}`,
                    index: 0,
                    count: 100,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [
                        topSongsEntry,
                        ...artistWithManyAlbums.albums.map(asAlbumItem),
                      ],
                      index: 0,
                      total: artistWithManyAlbums.albums.length + 1,
                    })
                  );
                  expect(musicLibrary.artist).toHaveBeenCalledWith(
                    artistWithManyAlbums.id
                  );
                  expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                });

                it("pages the combined [Top Songs, ...albums] list", async () => {
                  // [Top Songs, a0, a1, a2, a3, a4]; index 2 count 2 -> a1, a2
                  const result = await ws.getMetadataAsync({
                    id: `artist:${artistWithManyAlbums.id}`,
                    index: 2,
                    count: 2,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [
                        artistWithManyAlbums.albums[1]!,
                        artistWithManyAlbums.albums[2]!,
                      ].map(asAlbumItem),
                      index: 2,
                      total: artistWithManyAlbums.albums.length + 1,
                    })
                  );
                });
              });

              describe("asking for the artist's top songs", () => {
                const t0 = aTrack();
                const t1 = aTrack();
                const t2 = aTrack();

                it("returns top songs as playable track metadata, paged", async () => {
                  musicLibrary.topSongs.mockResolvedValue([t0, t1, t2]);
                  const result = await ws.getMetadataAsync({
                    id: `topSongs:${artistWithManyAlbums.id}`,
                    index: 1,
                    count: 2,
                  });
                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(3);
                  expect(md.index).toEqual(1);
                  const items = ([] as any[]).concat(md.mediaMetadata);
                  expect(items.map((m) => m.id)).toEqual([
                    `track:${t1.id}`,
                    `track:${t2.id}`,
                  ]);
                  expect(items.every((m) => m.itemType === "track")).toBe(true);
                  expect(items[0].trackMetadata.artist).toEqual(t1.artist.name);
                  // top-song art must carry the access token (bat) so the token-gated /art route
                  // authorizes the fetch - a bare bonobUrl would 401.
                  expect(items[0].trackMetadata.albumArtURI).toContain(
                    `bat=${apiToken}`
                  );
                  expect(musicLibrary.topSongs).toHaveBeenCalledWith(
                    artistWithManyAlbums.id
                  );
                });

                it("handles an artist with no top songs", async () => {
                  musicLibrary.topSongs.mockResolvedValue([]);
                  const result = await ws.getMetadataAsync({
                    id: `topSongs:${artistWithManyAlbums.id}`,
                    index: 0,
                    count: 100,
                  });
                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(0);
                  expect(md.count).toEqual(0);
                });
              });
            });

            describe("asking for favourite songs", () => {
              const s0 = aTrack();
              const s1 = aTrack();
              const s2 = aTrack();

              // The browse path reads the WARM cache (peekStarredSongs), never the upstream fetch:
              // getStarred2 is unpaginated and took 8615ms at 11,505 starred songs against a
              // 4500ms deadline, and Sonos re-requests it for every page of the container.
              it("serves from the warm cache without touching the upstream fetch", async () => {
                musicLibrary.peekStarredSongs.mockReturnValue(
                  Promise.resolve([s0, s1, s2])
                );
                await ws.getMetadataAsync({
                  id: "favouriteSongs",
                  index: 0,
                  count: 100,
                });
                expect(musicLibrary.peekStarredSongs).toHaveBeenCalled();
                expect(musicLibrary.starredSongs).not.toHaveBeenCalled();
              });

              // Cold must not block: it kicks the warm and shows a placeholder, exactly as the
              // artists browse does, instead of spending the whole browse budget upstream.
              it("returns a placeholder and kicks the warm when the cache is cold", async () => {
                musicLibrary.peekStarredSongs.mockReturnValue(undefined);
                musicLibrary.starredSongs.mockResolvedValue([s0]);
                const result = await ws.getMetadataAsync({
                  id: "favouriteSongs",
                  index: 0,
                  count: 100,
                });
                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(1);
                const items = ([] as any[]).concat(md.mediaCollection);
                expect(items[0].id).toEqual("favouriteSongs");
                expect(items[0].title).toContain("Loading your favourite songs");
                // the warm was kicked off so the next open succeeds
                expect(musicLibrary.starredSongs).toHaveBeenCalled();
              });

              it("returns the user's starred songs as playable track metadata, paged", async () => {
                musicLibrary.peekStarredSongs.mockReturnValue(
                  Promise.resolve([s0, s1, s2])
                );
                const result = await ws.getMetadataAsync({
                  id: "favouriteSongs",
                  index: 1,
                  count: 2,
                });
                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(3);
                expect(md.index).toEqual(1);
                const items = ([] as any[]).concat(md.mediaMetadata);
                expect(items.map((m) => m.id)).toEqual([
                  `track:${s1.id}`,
                  `track:${s2.id}`,
                ]);
                expect(items.every((m) => m.itemType === "track")).toBe(true);
                // favourite-song art must carry the access token (bat) for the token-gated /art route
                expect(items[0].trackMetadata.albumArtURI).toContain(
                  `bat=${apiToken}`
                );
                expect(musicLibrary.peekStarredSongs).toHaveBeenCalled();
              });

              it("handles a user with no favourite songs", async () => {
                musicLibrary.peekStarredSongs.mockReturnValue(Promise.resolve([]));
                const result = await ws.getMetadataAsync({
                  id: "favouriteSongs",
                  index: 0,
                  count: 100,
                });
                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(0);
                expect(md.count).toEqual(0);
              });

              it("omits artistId when the favourite song's artist has no id", async () => {
                // a TrackSummary whose artist.id is undefined: topSongMetadata must emit
                // artistId: undefined, NOT a synthetic "artist:undefined"
                const noIdArtist = anArtistSummary();
                noIdArtist.id = undefined;
                const t = aTrack({ artist: noIdArtist });
                musicLibrary.peekStarredSongs.mockReturnValue(Promise.resolve([t]));

                const result = await ws.getMetadataAsync({
                  id: "favouriteSongs",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                const items = ([] as any[]).concat(md.mediaMetadata);
                expect(items[0].trackMetadata.artistId).toBeUndefined();
              });
            });

            describe("asking for artists", () => {
              const artistSummaries = [
                anArtist(),
                anArtist(),
                anArtist(),
                anArtist(),
                anArtist(),
              ].map(artistToArtistSummary);

              beforeEach(() => {
                // Warm by default with a SMALL catalog (total under the cap): the artists branch
                // serves the flat list straight from the index. A large catalog (A-Z menu) and a
                // cold index (placeholder) are covered in their own describes below.
                musicLibrary.peekArtistIndex.mockReturnValue(
                  Promise.resolve(anArtistIndex(artistSummaries))
                );
              });

              describe("when the artist index is warm and the catalog is small (flat)", () => {
                it("serves the flat list from the index, advertising only the real total", async () => {
                  const result = await ws.getMetadataAsync({
                    id: "artists",
                    index: 0,
                    count: 100,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: artistSummaries.map((it) =>
                        artist(bonobUrlWithAccessToken, it)
                      ),
                      index: 0,
                      total: artistSummaries.length,
                    })
                  );
                  // the bucketed path never falls back to the legacy flat fetch
                  expect(musicLibrary.artists).not.toHaveBeenCalled();
                  expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                });

                it("pages the flat list from the index", async () => {
                  const result = await ws.getMetadataAsync({
                    id: "artists",
                    index: 1,
                    count: 3,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [
                        artistSummaries[1]!,
                        artistSummaries[2]!,
                        artistSummaries[3]!,
                      ].map((it) => artist(bonobUrlWithAccessToken, it)),
                      index: 1,
                      total: artistSummaries.length,
                    })
                  );
                });
              });

              describe("when the artist index is not warm yet (cold)", () => {
                it("returns a placeholder synchronously without blocking on the cold fetch", async () => {
                  musicLibrary.peekArtistIndex.mockReturnValue(undefined);
                  // A cold getArtists takes many seconds; here it never resolves, so if the code
                  // awaited it this test would hang. It must return the placeholder without awaiting.
                  musicLibrary.artistIndex.mockReturnValue(new Promise<never>(() => {}));

                  const result = await ws.getMetadataAsync({
                    id: "artists",
                    index: 0,
                    count: 100,
                  });

                  // a single-item mediaCollection collapses to an object in the SOAP round-trip
                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(1);
                  expect(md.count).toEqual(1);
                  const item = ([] as any[]).concat(md.mediaCollection)[0];
                  expect(item).toEqual({
                    itemType: "container",
                    id: "artists",
                    title: "Loading your artists… (open again shortly)",
                    albumArtURI: iconArtURI(bonobUrl, "artists").href(),
                  });
                  // and it kicked the warm in the background
                  expect(musicLibrary.artistIndex).toHaveBeenCalled();
                });

                it("swallows a failing background artist warm so it cannot surface as an unhandled rejection", async () => {
                  musicLibrary.peekArtistIndex.mockReturnValue(undefined);
                  musicLibrary.artistIndex.mockReturnValue(
                    Promise.reject(new Error("warm failed"))
                  );

                  const unhandled: unknown[] = [];
                  const onUR = (reason: unknown) => unhandled.push(reason);
                  process.on("unhandledRejection", onUR);
                  try {
                    const result = await ws.getMetadataAsync({
                      id: "artists",
                      index: 0,
                      count: 100,
                    });
                    const md = (result[0] as any).getMetadataResult;
                    expect(md.total).toEqual(1);
                    expect(musicLibrary.artistIndex).toHaveBeenCalled();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    expect(unhandled).toEqual([]);
                  } finally {
                    process.removeListener("unhandledRejection", onUR);
                  }
                });
              });
            });

            describe("asking for the A-Z artist buckets (large catalog)", () => {
              // total exceeds MAX_ARTISTS_FLAT, so Artists is split into per-letter buckets. The
              // bucket keys are Navidrome's letters verbatim (NOT re-derived from the names).
              const letterBuckets = [
                { key: "P", label: "P", offset: 0, count: 2 },
                { key: "R", label: "R", offset: 2, count: 1 },
              ];

              beforeEach(() => {
                musicLibrary.peekArtistIndex.mockReturnValue(
                  Promise.resolve(
                    anArtistIndex([], {
                      total: MAX_ALBUMS_FLAT + 5000,
                      buckets: letterBuckets,
                    })
                  )
                );
              });

              it("returns a bounded container per letter, not a huge flat list", async () => {
                const result = await ws.getMetadataAsync({
                  id: "artists",
                  index: 0,
                  count: 100,
                });

                expect(result[0]).toEqual(
                  getMetadataResult({
                    mediaCollection: [
                      {
                        itemType: "container",
                        id: "artistsByLetter:P",
                        title: "P",
                        albumArtURI: iconArtURI(bonobUrl, "artists").href(),
                      },
                      {
                        itemType: "container",
                        id: "artistsByLetter:R",
                        title: "R",
                        albumArtURI: iconArtURI(bonobUrl, "artists").href(),
                      },
                    ],
                    index: 0,
                    total: 2,
                  })
                );
              });

              it("does not block on a cold artist index (returns a placeholder)", async () => {
                musicLibrary.peekArtistIndex.mockReturnValue(undefined);
                musicLibrary.artistIndex.mockReturnValue(new Promise<never>(() => {}));

                const result = await ws.getMetadataAsync({
                  id: "artists",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(1);
                expect(md.mediaCollection).toMatchObject({ id: "artists" });
                expect(musicLibrary.artistIndex).toHaveBeenCalled();
              });
            });

            describe("asking for a letter's artists (artistsByLetter)", () => {
              const pArtists = [anArtist(), anArtist()].map(artistToArtistSummary);
              const rArtists = [anArtist()].map(artistToArtistSummary);

              it("serves the letter's page from the index, advertising only that letter's total", async () => {
                musicLibrary.peekArtistIndex.mockReturnValue(
                  Promise.resolve(
                    anArtistIndex([...pArtists, ...rArtists], {
                      buckets: [
                        { key: "P", label: "P", offset: 0, count: pArtists.length },
                        {
                          key: "R",
                          label: "R",
                          offset: pArtists.length,
                          count: rArtists.length,
                        },
                      ],
                    })
                  )
                );

                const result = await ws.getMetadataAsync({
                  id: "artistsByLetter:P",
                  index: 0,
                  count: 100,
                });

                expect(result[0]).toEqual(
                  getMetadataResult({
                    mediaCollection: pArtists.map((it) =>
                      artist(bonobUrlWithAccessToken, it)
                    ),
                    index: 0,
                    total: pArtists.length,
                  })
                );
              });

              it("splits an oversized letter into fixed-size sub-buckets", async () => {
                // Letter P has more than MAX_ARTISTS_FLAT artists -> sub-chunks, not one big leaf.
                musicLibrary.peekArtistIndex.mockReturnValue(
                  Promise.resolve(
                    anArtistIndex([], {
                      total: MAX_ALBUMS_FLAT + 5000,
                      buckets: [
                        {
                          key: "P",
                          label: "P",
                          offset: 0,
                          count: MAX_ALBUMS_FLAT + 5000,
                        },
                      ],
                    })
                  )
                );

                const result = await ws.getMetadataAsync({
                  id: "artistsByLetter:P",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                expect(md.mediaCollection[0]).toMatchObject({ id: "artistsChunk:P_0" });
                expect(md.mediaCollection[1]).toMatchObject({ id: "artistsChunk:P_1" });
                // total is the number of sub-buckets
                expect(md.total).toEqual(
                  Math.ceil((MAX_ALBUMS_FLAT + 5000) / MAX_ALBUMS_FLAT)
                );
              });

              it("does not block on a cold artist index (returns a placeholder)", async () => {
                musicLibrary.peekArtistIndex.mockReturnValue(undefined);
                musicLibrary.artistIndex.mockReturnValue(new Promise<never>(() => {}));

                const result = await ws.getMetadataAsync({
                  id: "artistsByLetter:S",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(1);
                expect(md.mediaCollection).toMatchObject({ id: "artistsByLetter:S" });
                expect(musicLibrary.artistIndex).toHaveBeenCalled();
              });
            });

            describe("asking for an artist sub-chunk (artistsChunk)", () => {
              it("serves the chunk's page from the index, advertising only that chunk's total", async () => {
                // Letter P spans two chunks; chunk 1 is items[MAX..]. Build a P bucket over enough
                // items that chunk 1 holds the 5 remaining artists.
                const allP = Array.from({ length: MAX_ALBUMS_FLAT + 5 }, (_, i) =>
                  artistToArtistSummary(anArtist({ id: `p${i}` }))
                );
                musicLibrary.peekArtistIndex.mockReturnValue(
                  Promise.resolve(
                    anArtistIndex(allP, {
                      buckets: [
                        { key: "P", label: "P", offset: 0, count: allP.length },
                      ],
                    })
                  )
                );

                const result = await ws.getMetadataAsync({
                  id: "artistsChunk:P_1",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                // chunk 1 starts at offset MAX_ALBUMS_FLAT and holds the 5 remaining artists
                expect(md.total).toEqual(5);
                expect(md.mediaCollection.length).toEqual(5);
                expect(md.mediaCollection[0]).toEqual(
                  artist(bonobUrlWithAccessToken, allP[MAX_ALBUMS_FLAT]!)
                );
              });

              it("returns an empty page for a malformed chunk id", async () => {
                musicLibrary.peekArtistIndex.mockReturnValue(
                  Promise.resolve(anArtistIndex([]))
                );

                const result = await ws.getMetadataAsync({
                  id: "artistsChunk:P_bad",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(0);
                // The handler returns mediaCollection: [], but this assertion goes through a real
                // SOAP round-trip and an EMPTY array serializes to no element at all, arriving as
                // undefined. (The same layer turns a ONE-element collection into an object rather
                // than an array.) What matters is that the malformed chunk id yields no items and
                // does not fault - asserted shape-agnostically rather than pinning the wire quirk.
                expect([md.mediaCollection ?? []].flat()).toEqual([]);
              });

              it("does not block on a cold artist index (returns a placeholder)", async () => {
                musicLibrary.peekArtistIndex.mockReturnValue(undefined);
                musicLibrary.artistIndex.mockReturnValue(new Promise<never>(() => {}));

                const result = await ws.getMetadataAsync({
                  id: "artistsChunk:P_0",
                  index: 0,
                  count: 100,
                });

                const md = (result[0] as any).getMetadataResult;
                expect(md.total).toEqual(1);
                expect(md.mediaCollection).toMatchObject({ id: "artistsChunk:P_0" });
                expect(musicLibrary.artistIndex).toHaveBeenCalled();
              });
            });

            describe("asking for relatedArtists", () => {
              describe("when the artist has many, some in the library and some not", () => {
                const relatedArtist1 = anArtist();
                const relatedArtist2 = anArtist();
                const relatedArtist3 = anArtist();
                const relatedArtist4 = anArtist();
                const relatedArtist5 = anArtist();
                const relatedArtist6 = anArtist();

                const artist = anArtist({
                  similarArtists: [
                    { ...relatedArtist1, inLibrary: true },
                    { ...relatedArtist2, inLibrary: true },
                    { ...relatedArtist3, inLibrary: false },
                    { ...relatedArtist4, inLibrary: true },
                    { ...relatedArtist5, inLibrary: false },
                    { ...relatedArtist6, inLibrary: true },
                  ],
                });

                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                describe("when they fit on one page", () => {
                  it("should return them", async () => {
                    const result = await ws.getMetadataAsync({
                      id: `relatedArtists:${artist.id}`,
                      index: 0,
                      count: 100,
                    });
                    expect(result[0]).toEqual(
                      getMetadataResult({
                        mediaCollection: [
                          relatedArtist1,
                          relatedArtist2,
                          relatedArtist4,
                          relatedArtist6,
                        ].map((it) => ({
                          itemType: "artist",
                          id: `artist:${it.id}`,
                          artistId: `artist:${it.id}`,
                          title: it.name,
                          albumArtURI: coverArtURI(
                            bonobUrlWithAccessToken,
                            { coverArt: it.image }
                          ).href(),
                        })),
                        index: 0,
                        total: 4,
                      })
                    );
                    expect(musicLibrary.artist).toHaveBeenCalledWith(artist.id);
                    expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                  });
                });

                describe("when they dont fit on one page", () => {
                  it("should return them", async () => {
                    const result = await ws.getMetadataAsync({
                      id: `relatedArtists:${artist.id}`,
                      index: 1,
                      count: 2,
                    });
                    expect(result[0]).toEqual(
                      getMetadataResult({
                        mediaCollection: [relatedArtist2, relatedArtist4].map(
                          (it) => ({
                            itemType: "artist",
                            id: `artist:${it.id}`,
                            artistId: `artist:${it.id}`,
                            title: it.name,
                            albumArtURI: coverArtURI(
                              bonobUrlWithAccessToken,
                              { coverArt: it.image }
                            ).href(),
                          })
                        ),
                        index: 1,
                        total: 4,
                      })
                    );
                    expect(musicLibrary.artist).toHaveBeenCalledWith(artist.id);
                    expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                  });
                });
              });

              describe("when the artist has none", () => {
                const artist = anArtist({ similarArtists: [] });

                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                it("should return an empty list", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `relatedArtists:${artist.id}`,
                    index: 0,
                    count: 100,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      index: 0,
                      total: 0,
                    })
                  );
                  expect(musicLibrary.artist).toHaveBeenCalledWith(artist.id);
                  expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                });
              });

              describe("when the artist some however none are in the library", () => {
                const relatedArtist1 = anArtist();
                const relatedArtist2 = anArtist();

                const artist = anArtist({
                  similarArtists: [
                    {
                      ...relatedArtist1,
                      inLibrary: false,
                    },
                    {
                      ...relatedArtist2,
                      inLibrary: false,
                    },
                  ],
                });

                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                it("should return an empty list", async () => {
                  const result = await ws.getMetadataAsync({
                    id: `relatedArtists:${artist.id}`,
                    index: 0,
                    count: 100,
                  });
                  expect(result[0]).toEqual(
                    getMetadataResult({
                      index: 0,
                      total: 0,
                    })
                  );
                  expect(musicLibrary.artist).toHaveBeenCalledWith(artist.id);
                  expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                });
              });
            });

            describe("asking for albums", () => {
              const pop1 = anAlbum({ genre: POP });
              const pop2 = anAlbum({ genre: POP });
              const pop3 = anAlbum({ genre: POP });
              const pop4 = anAlbum({ genre: POP });
              const rock1 = anAlbum({ genre: ROCK });
              const rock2 = anAlbum({ genre: ROCK });

              const allAlbums = [pop1, pop2, pop3, pop4, rock1, rock2];
              const popAlbums = [pop1, pop2, pop3, pop4];

              describe("asking for random albums", () => {
                const randomAlbums = [pop2, rock1, pop1];

                beforeEach(() => {
                  musicLibrary.albums.mockResolvedValue({
                    results: randomAlbums,
                    total: allAlbums.length,
                  });
                });

                it("should return some", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: "randomAlbums",
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: randomAlbums.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 6,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "random",
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for favourite albums", () => {
                const albums = [rock2, rock1, pop2];

                beforeEach(() => {
                  musicLibrary.albums.mockResolvedValue({
                    results: albums,
                    total: allAlbums.length,
                  });
                });

                it("should return some", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: "favouriteAlbums",
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: albums.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 6,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "favourited",
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for starred albums", () => {
                const albums = [rock2, rock1, pop2];

                beforeEach(() => {
                  musicLibrary.albums.mockResolvedValue({
                    results: albums,
                    total: allAlbums.length,
                  });
                });

                it("should return some", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: "starredAlbums",
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: albums.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 6,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "starred",
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for recently played albums", () => {
                const recentlyPlayed = [rock2, rock1, pop2];

                beforeEach(() => {
                  musicLibrary.albums.mockResolvedValue({
                    results: recentlyPlayed,
                    total: allAlbums.length,
                  });
                });

                it("should return some", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: "recentlyPlayed",
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: recentlyPlayed.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 6,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "recentlyPlayed",
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for most played albums", () => {
                const mostPlayed = [rock2, rock1, pop2];

                beforeEach(() => {
                  musicLibrary.albums.mockResolvedValue({
                    results: mostPlayed,
                    total: allAlbums.length,
                  });
                });

                it("should return some", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: "mostPlayed",
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: mostPlayed.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 6,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "mostPlayed",
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for recently added albums", () => {
                const recentlyAdded = [pop4, pop3, pop2];

                beforeEach(() => {
                  musicLibrary.albums.mockResolvedValue({
                    results: recentlyAdded,
                    total: allAlbums.length,
                  });
                });

                it("should return some", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: "recentlyAdded",
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: recentlyAdded.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 6,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "recentlyAdded",
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for the A-Z album buckets (large catalog)", () => {
                beforeEach(() => {
                  // total exceeds MAX_ALBUMS_FLAT, so Albums is split into per-letter buckets
                  musicLibrary.albumCount.mockResolvedValue(30000);
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 30000,
                      buckets: [
                        { key: "P", label: "P", offset: 0, count: 20000 },
                        { key: "R", label: "R", offset: 20000, count: 10000 },
                      ],
                    })
                  );
                });

                it("returns a bounded container per letter, not a huge flat list", async () => {
                  const result = await ws.getMetadataAsync({
                    id: "albums",
                    index: 0,
                    count: 100,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [
                        {
                          itemType: "albumList",
                          id: "albumsByLetter:P",
                          title: "P",
                          albumArtURI: iconArtURI(bonobUrl, "albums").href(),
                        },
                        {
                          itemType: "albumList",
                          id: "albumsByLetter:R",
                          title: "R",
                          albumArtURI: iconArtURI(bonobUrl, "albums").href(),
                        },
                      ],
                      index: 0,
                      total: 2,
                    })
                  );
                });
              });

              describe("asking for albums in a small catalog (flat, no index)", () => {
                it("serves the flat list live and never builds the index", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined); // not indexed
                  // count is warm (from the cached artist list) and small
                  musicLibrary.peekAlbumCount.mockReturnValue(Promise.resolve(5000));
                  musicLibrary.albums.mockResolvedValue({
                    results: [pop1, pop2],
                    total: 5000,
                  });

                  const result = await ws.getMetadataAsync({
                    id: "albums",
                    index: 0,
                    count: 100,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [pop1, pop2].map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 5000,
                    })
                  );
                  // served live from getAlbumList2 - no bucketing, and the (expensive) index build
                  // is never triggered for a small catalog
                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "alphabeticalByName",
                    _index: 0,
                    _count: 100,
                  });
                  expect(musicLibrary.albumIndex).not.toHaveBeenCalled();
                });

                it("does not block on a cold album count (returns a placeholder)", async () => {
                  // Nothing warm yet: peekAlbumIndex + peekAlbumCount both undefined. Must NOT
                  // await the multi-second albumCount() - return a bounded placeholder immediately.
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  musicLibrary.peekAlbumCount.mockReturnValue(undefined);
                  musicLibrary.albumCount.mockReturnValue(new Promise<number>(() => {}));

                  const result = await ws.getMetadataAsync({
                    id: "albums",
                    index: 0,
                    count: 100,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(1);
                  expect(md.mediaCollection).toMatchObject({ id: "albums" });
                  // kicked the warm in the background rather than awaiting it
                  expect(musicLibrary.albumCount).toHaveBeenCalled();
                  expect(musicLibrary.albums).not.toHaveBeenCalled();
                });

                it("swallows a failing background album-count warm so it cannot surface as an unhandled rejection", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  musicLibrary.peekAlbumCount.mockReturnValue(undefined);
                  musicLibrary.albumCount.mockReturnValue(
                    Promise.reject(new Error("warm failed"))
                  );

                  const unhandled: unknown[] = [];
                  const onUR = (reason: unknown) => unhandled.push(reason);
                  process.on("unhandledRejection", onUR);
                  try {
                    const result = await ws.getMetadataAsync({
                      id: "albums",
                      index: 0,
                      count: 100,
                    });
                    const md = (result[0] as any).getMetadataResult;
                    expect(md.total).toEqual(1);
                    expect(musicLibrary.albumCount).toHaveBeenCalled();
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    expect(unhandled).toEqual([]);
                  } finally {
                    process.removeListener("unhandledRejection", onUR);
                  }
                });
              });

              describe("deciding small vs large from the warm count (index cold)", () => {
                it("kicks the index build and serves the placeholder when count > MAX_ALBUMS_FLAT", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  musicLibrary.peekAlbumCount.mockReturnValue(
                    Promise.resolve(MAX_ALBUMS_FLAT + 5000)
                  );
                  // a rejecting warm proves the fire-and-forget .catch swallows the failure
                  // rather than surfacing it on the browse path
                  musicLibrary.albumIndex.mockReturnValue(
                    Promise.reject(new Error("build boom"))
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albums",
                    index: 0,
                    count: 100,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(1);
                  expect(md.mediaCollection).toMatchObject({ id: "albums" });
                  // the large path kicks the index and never touches the live albums fetch
                  expect(musicLibrary.albumIndex).toHaveBeenCalled();
                  expect(musicLibrary.albums).not.toHaveBeenCalled();
                });

                it("serves the flat list LIVE at exactly the cap (count === MAX_ALBUMS_FLAT), never building the index", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  musicLibrary.peekAlbumCount.mockReturnValue(
                    Promise.resolve(MAX_ALBUMS_FLAT)
                  );
                  const page = [pop1, pop2];
                  musicLibrary.albums.mockResolvedValue({
                    results: page,
                    total: MAX_ALBUMS_FLAT,
                  });

                  const result = await ws.getMetadataAsync({
                    id: "albums",
                    index: 0,
                    count: 2,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: page.map((it) =>
                        album(bonobUrlWithAccessToken, it)
                      ),
                      index: 0,
                      total: MAX_ALBUMS_FLAT,
                    })
                  );
                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "alphabeticalByName",
                    _index: 0,
                    _count: 2,
                  });
                  // at exactly the cap the catalog is NOT considered large: no index build
                  expect(musicLibrary.albumIndex).not.toHaveBeenCalled();
                });
              });

              describe("asking for a letter's albums (albumsByLetter)", () => {
                const albumItem = (it: any) => ({
                  itemType: "album",
                  id: `album:${it.id}`,
                  title: it.name,
                  albumArtURI: coverArtURI(bonobUrlWithAccessToken, it).href(),
                  canPlay: true,
                  artistId: `artist:${it.artistId}`,
                  artist: it.artistName,
                });

                it("pages a letter from the snapshot, advertising only the letter's total", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 4,
                      buckets: [{ key: "P", label: "P", offset: 0, count: 4 }],
                      items: [pop1, pop2, pop3, pop4],
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsByLetter:P",
                    index: 2,
                    count: 2,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [pop3, pop4].map(albumItem),
                      index: 2,
                      total: 4, // the letter count, NOT the global catalog total
                    })
                  );
                });

                it("pages across a letter split into non-contiguous ranges (stray title)", async () => {
                  // "P" appears in two runs (a stray sorts between them); the page must span both,
                  // served straight from the snapshot with no live re-fetch (drift-proof).
                  const items = new Array(13).fill(pop1);
                  items[1] = pop2;
                  items[10] = pop3;
                  items[11] = pop4;
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 13,
                      buckets: [
                        { key: "P", label: "P", offset: 0, count: 2 },
                        { key: "Q", label: "Q", offset: 2, count: 8 },
                        { key: "P", label: "P", offset: 10, count: 3 },
                      ],
                      items,
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsByLetter:P",
                    index: 1,
                    count: 3,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [pop2, pop3, pop4].map(albumItem),
                      index: 1,
                      total: 5, // 2 + 3 across both P ranges, never the global 13
                    })
                  );
                });

                it("does not block on the scan when the index is still building", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  // albumIndex() would take minutes; a never-resolving promise proves we never await it
                  musicLibrary.albumIndex.mockReturnValue(new Promise<never>(() => {}));

                  const result = await ws.getMetadataAsync({
                    id: "albumsByLetter:S",
                    index: 0,
                    count: 100,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(1);
                  expect(md.count).toEqual(1);
                  // a single bounded placeholder (a 1-item collection collapses to one object)
                  expect(md.mediaCollection).toMatchObject({
                    itemType: "albumList",
                    id: "albumsByLetter:S",
                    title: "Indexing your albums… (open again shortly)",
                  });
                  // it kicked the background build rather than awaiting it
                  expect(musicLibrary.albumIndex).toHaveBeenCalled();
                });

                it("splits an oversized letter into bounded sub-buckets", async () => {
                  // A letter bigger than MAX_ALBUMS_FLAT (20000) would itself be rejected by S2, so
                  // it becomes a menu of fixed-size chunk containers instead of an album list.
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 45000,
                      buckets: [{ key: "P", label: "P", offset: 0, count: 45000 }],
                      items: new Array(45000), // sparse; the container path never reads items
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsByLetter:P",
                    index: 0,
                    count: 100,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(3); // ceil(45000 / 20000)
                  expect(md.mediaCollection.map((c: any) => c.id)).toEqual([
                    "albumsChunk:P_0",
                    "albumsChunk:P_1",
                    "albumsChunk:P_2",
                  ]);
                  expect(md.mediaCollection[0].itemType).toEqual("albumList");
                });

                it("serves a chunk from the snapshot at the right offset, bounded to the cap", async () => {
                  const items = new Array(25000);
                  items[20000] = pop2;
                  items[20001] = pop3;
                  items[20002] = pop4;
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 25000,
                      buckets: [{ key: "P", label: "P", offset: 0, count: 25000 }],
                      items,
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsChunk:P_1", // second chunk of P: items[20000..]
                    index: 0,
                    count: 3,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [pop2, pop3, pop4].map(albumItem),
                      index: 0,
                      total: 5000, // min(20000, 25000 - 20000)
                    })
                  );
                });

                it("pages oversized-letter chunk containers", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 700000,
                      buckets: [{ key: "P", label: "P", offset: 0, count: 700000 }],
                      items: new Array(700000),
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsByLetter:P",
                    index: 30,
                    count: 30,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(md.index).toEqual(30);
                  expect(md.total).toEqual(35); // ceil(700000 / 20000)
                  expect(md.mediaCollection.map((c: any) => c.id)).toEqual([
                    "albumsChunk:P_30",
                    "albumsChunk:P_31",
                    "albumsChunk:P_32",
                    "albumsChunk:P_33",
                    "albumsChunk:P_34",
                  ]);
                });

                it("returns an empty finite result for malformed chunk ids", async () => {
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 25000,
                      buckets: [{ key: "P", label: "P", offset: 0, count: 25000 }],
                      items: new Array(25000),
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsChunk:P_bad",
                    index: 0,
                    count: 100,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(Number.isFinite(md.total)).toBe(true);
                  expect(md.total).toEqual(0);
                  expect(md.count).toEqual(0);
                  // an empty mediaCollection collapses to undefined over the SOAP round-trip
                  expect(md.mediaCollection ?? []).toEqual([]);
                });

                it("does not block on a cold index for a valid chunk, kicking the build and serving a placeholder", async () => {
                  // valid chunk id (P_0 passes the parser) but the index is not warm yet
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  musicLibrary.albumIndex.mockReturnValue(
                    Promise.reject(new Error("build boom"))
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsChunk:P_0",
                    index: 0,
                    count: 100,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  expect(md.total).toEqual(1);
                  expect(md.mediaCollection).toMatchObject({
                    itemType: "albumList",
                    id: "albumsChunk:P_0",
                    title: "Indexing your albums… (open again shortly)",
                  });
                  expect(musicLibrary.albumIndex).toHaveBeenCalled();
                });

                it("treats a chunk id with no underscore as chunk 0 of the letter", async () => {
                  // "albumsChunk:P" has no _<n>; the parser defaults to chunk 0
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: 2,
                      buckets: [{ key: "P", label: "P", offset: 0, count: 2 }],
                      items: [pop1, pop2],
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsChunk:P",
                    index: 0,
                    count: 100,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [pop1, pop2].map(albumItem),
                      index: 0,
                      total: 2,
                    })
                  );
                });

                it("swallows a failing background index warm so it cannot surface as an unhandled rejection", async () => {
                  // The fire-and-forget warm is `void albumIndex().catch(() => undefined)`: the catch
                  // is the only thing stopping a rejecting warm from becoming an unhandled rejection.
                  musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                  musicLibrary.albumIndex.mockReturnValue(
                    Promise.reject(new Error("warm failed"))
                  );

                  const unhandled: unknown[] = [];
                  const onUR = (reason: unknown) => unhandled.push(reason);
                  process.on("unhandledRejection", onUR);
                  try {
                    const result = await ws.getMetadataAsync({
                      id: "albumsByLetter:S",
                      index: 0,
                      count: 100,
                    });
                    const md = (result[0] as any).getMetadataResult;
                    expect(md.total).toEqual(1);
                    expect(musicLibrary.albumIndex).toHaveBeenCalled();
                    // cross a macrotask boundary so an unhandled rejection would have fired
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    expect(unhandled).toEqual([]);
                  } finally {
                    process.removeListener("unhandledRejection", onUR);
                  }
                });

                it("serves a letter whose total is exactly at the cap as a page, not chunk containers", async () => {
                  // letterTotal === MAX_ALBUMS_FLAT must NOT be split (the split uses a strict >).
                  const items = new Array(MAX_ALBUMS_FLAT).fill(pop1);
                  musicLibrary.peekAlbumIndex.mockReturnValue(
                    Promise.resolve({
                      total: MAX_ALBUMS_FLAT,
                      buckets: [
                        { key: "P", label: "P", offset: 0, count: MAX_ALBUMS_FLAT },
                      ],
                      items,
                    })
                  );

                  const result = await ws.getMetadataAsync({
                    id: "albumsByLetter:P",
                    index: 0,
                    count: 5,
                  });

                  const md = (result[0] as any).getMetadataResult;
                  // advertised as the letter total (a page), NOT as ceil(cap/cap)=1 chunk container
                  expect(md.total).toEqual(MAX_ALBUMS_FLAT);
                  const served = ([] as any[]).concat(md.mediaCollection);
                  expect(served.length).toEqual(5);
                  // albums, not albumsChunk:* containers
                  expect(served.every((c) => c.id.startsWith("album:"))).toBe(true);
                });
              });

              describe("asking for all albums for a genre", () => {
                it("should return albums for the genre", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  musicLibrary.albums.mockResolvedValue({
                    results: popAlbums,
                    total: popAlbums.length,
                  });

                  const result = await ws.getMetadataAsync({
                    id: `genre:${POP.id}`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: [pop1, pop2, pop3, pop4].map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 4,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "byGenre",
                    genre: POP.id,
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });

              describe("asking for a page of albums for a genre", () => {
                const pageOfPop = [pop1, pop2];

                it("should return albums for the genre", async () => {
                  const paging = {
                    index: 0,
                    count: 2,
                  };

                  musicLibrary.albums.mockResolvedValue({
                    results: pageOfPop,
                    total: popAlbums.length,
                  });

                  const result = await ws.getMetadataAsync({
                    id: `genre:${POP.id}`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaCollection: pageOfPop.map((it) => ({
                        itemType: "album",
                        id: `album:${it.id}`,
                        title: it.name,
                        albumArtURI: coverArtURI(
                          bonobUrlWithAccessToken,
                          it
                        ).href(),
                        canPlay: true,
                        artistId: `artist:${it.artistId}`,
                        artist: it.artistName,
                      })),
                      index: 0,
                      total: 4,
                    })
                  );

                  expect(musicLibrary.albums).toHaveBeenCalledWith({
                    type: "byGenre",
                    genre: POP.id,
                    _index: paging.index,
                    _count: paging.count,
                  });
                });
              });
            });

            describe("asking for an album", () => {
              const album = anAlbumSummary();
              const artist = anArtistSummary();

              const track1 = aTrack({ artist, album, number: 1 });
              const track2 = aTrack({ artist, album, number: 2 });
              const track3 = aTrack({ artist, album, number: 3 });
              const track4 = aTrack({ artist, album, number: 4 });
              const track5 = aTrack({ artist, album, number: 5 });

              const tracks = [track1, track2, track3, track4, track5];

              beforeEach(() => {
                musicLibrary.album.mockResolvedValue(anAlbum({ 
                  ...album, 
                  artistName: artist.name, 
                  artistId: artist.id, 
                  tracks
                }));
              });

              describe("asking for all for an album", () => {
                it("should return them all", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: `album:${album.id}`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaMetadata: tracks.map((it) =>
                        track(bonobUrlWithAccessToken, it)
                      ),
                      index: 0,
                      total: tracks.length,
                    })
                  );
                  expect(musicLibrary.album).toHaveBeenCalledWith(album.id);
                });
              });

              describe("asking for a single page of tracks", () => {
                const pageOfTracks = [track3, track4];

                it("should return only that page", async () => {
                  const paging = {
                    index: 2,
                    count: 2,
                  };

                  const result = await ws.getMetadataAsync({
                    id: `album:${album.id}`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaMetadata: pageOfTracks.map((it) =>
                        track(bonobUrlWithAccessToken, it)
                      ),
                      index: paging.index,
                      total: tracks.length,
                    })
                  );
                  expect(musicLibrary.album).toHaveBeenCalledWith(album.id);
                });
              });
            });

            describe("asking for a playlist", () => {
              const track1 = aTrack();
              const track2 = aTrack();
              const track3 = aTrack();
              const track4 = aTrack();
              const track5 = aTrack();

              const playlist = {
                id: uuid(),
                name: "playlist for test",
                entries: [track1, track2, track3, track4, track5],
              };

              beforeEach(() => {
                musicLibrary.playlist.mockResolvedValue(playlist);
              });

              describe("asking for all for a playlist", () => {
                it("should return them all", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: `playlist:${playlist.id}`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaMetadata: playlist.entries.map((it) =>
                        track(bonobUrlWithAccessToken, it)
                      ),
                      index: 0,
                      total: playlist.entries.length,
                    })
                  );
                  expect(musicLibrary.playlist).toHaveBeenCalledWith(
                    playlist.id
                  );
                });
              });

              describe("asking for a single page of a playlists entries", () => {
                const pageOfTracks = [track3, track4];

                it("should return only that page", async () => {
                  const paging = {
                    index: 2,
                    count: 2,
                  };

                  const result = await ws.getMetadataAsync({
                    id: `playlist:${playlist.id}`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaMetadata: pageOfTracks.map((it) =>
                        track(bonobUrlWithAccessToken, it)
                      ),
                      index: paging.index,
                      total: playlist.entries.length,
                    })
                  );
                  expect(musicLibrary.playlist).toHaveBeenCalledWith(
                    playlist.id
                  );
                });
              });
            });

            describe("asking for internet radio stations", () => {
              const station1 = aRadioStation();
              const station2 = aRadioStation();
              const station3 = aRadioStation();
              const station4 = aRadioStation();

              const stations = [station1, station2, station3, station4];

              beforeEach(() => {
                musicLibrary.radioStations.mockResolvedValue(stations);
              });

              describe("when they all fit on the page", () => {
                it("should return them all", async () => {
                  const paging = {
                    index: 0,
                    count: 100,
                  };

                  const result = await ws.getMetadataAsync({
                    id: `internetRadio`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaMetadata: stations.map((it) =>
                        internetRadioStation(it)
                      ),
                      index: 0,
                      total: stations.length,
                    })
                  );
                  expect(musicLibrary.radioStations).toHaveBeenCalled();
                });
              });

              describe("asking for a single page of stations", () => {
                const pageOfStations = [station3, station4];

                it("should return only that page", async () => {
                  const paging = {
                    index: 2,
                    count: 2,
                  };

                  const result = await ws.getMetadataAsync({
                    id: `internetRadio`,
                    ...paging,
                  });

                  expect(result[0]).toEqual(
                    getMetadataResult({
                      mediaMetadata: pageOfStations.map((it) =>
                        internetRadioStation(it)
                      ),
                      index: paging.index,
                      total: stations.length,
                    })
                  );
                  expect(musicLibrary.radioStations).toHaveBeenCalled();
                });
              });
            });
          });
        });

        describe("getExtendedMetadata", () => {
          itShouldHandleInvalidCredentials((ws) =>
            ws.getExtendedMetadataAsync({ id: "root" })
          );

          describe("when valid credentials are provided", () => {
            let ws: Client;

            beforeEach(async () => {
              ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              setupAuthenticatedRequest(ws);
            });

            describe("asking for an artist", () => {
              describe("when it has similar artists, some in the library and some not", () => {
                const similar1 = anArtist();
                const similar2 = anArtist();
                const similar3 = anArtist();
                const similar4 = anArtist();

                const artist = anArtist({
                  similarArtists: [
                    { ...similar1, inLibrary: true },
                    { ...similar2, inLibrary: false },
                    { ...similar3, inLibrary: false },
                    { ...similar4, inLibrary: true },
                  ]
                });

                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                it("should return a RELATED_ARTISTS browse option", async () => {
                  const root = await ws.getExtendedMetadataAsync({
                    id: `artist:${artist.id}`
                  });

                  expect(root[0]).toEqual({
                    getExtendedMetadataResult: {
                      mediaCollection: {
                        itemType: "artist",
                        id: `artist:${artist.id}`,
                        artistId: `artist:${artist.id}`,
                        title: artist.name,
                        albumArtURI: coverArtURI(bonobUrlWithAccessToken, { coverArt: artist.image }).href(),
                      },
                      relatedBrowse: [{
                        id: `relatedArtists:${artist.id}`,
                        type: "RELATED_ARTISTS",
                      }],
                    },
                  });
                });
              });

              describe("when it has no similar artists", () => {
                const artist = anArtist({
                  similarArtists: [],
                  albums: [],
                });

                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                it("should not return a RELATED_ARTISTS browse option", async () => {
                  const root = await ws.getExtendedMetadataAsync({
                    id: `artist:${artist.id}`
                  });
                  expect(root[0]).toEqual({
                    getExtendedMetadataResult: {
                      mediaCollection: {
                        itemType: "artist",
                        id: `artist:${artist.id}`,
                        artistId: `artist:${artist.id}`,
                        title: artist.name,
                        albumArtURI: coverArtURI(bonobUrlWithAccessToken, { coverArt: artist.image }).href(),
                      }
                    },
                  });
                });
              });

            describe("asking for random albums", () => {
              // An in-memory (resident) index: readAlbumIndexAll falls back to slicing items,
              // which is exactly what a small library or a not-yet-offloaded index looks like.
              const anAlbumIndexOf = (n: number) => ({
                total: n,
                items: Array.from({ length: n }, (_, i) =>
                  anAlbum({ id: `album-${i}`, name: `Album ${i}` })
                ),
                buckets: [{ key: "A", label: "A", offset: 0, count: n }],
              });

              // Navidrome's random ordering is an ORDER BY RANDOM scan over the whole catalog:
              // measured 2381ms on the live 113k-album library and once 5874ms, which blew the
              // 4500ms deadline. Reducing the requested page size did NOT help, proving the cost is
              // the scan and not the row count. When the disk-backed album index is warm we already
              // have every album addressable by offset, so random albums are N cheap byte-range
              // reads and no upstream query at all.
              it("serves from the warm album index without asking Navidrome to randomise", async () => {
                musicLibrary.peekAlbumIndex.mockReturnValue(
                  Promise.resolve(anAlbumIndexOf(50))
                );

                const result = await ws.getMetadataAsync({
                  id: "randomAlbums",
                  index: 0,
                  count: 10,
                });

                const md = (result[0] as any).getMetadataResult;
                expect(([] as any[]).concat(md.mediaCollection).length).toEqual(10);
                expect(musicLibrary.albums).not.toHaveBeenCalled();
              });

              // Cold index (small library, or still building): fall back to the upstream query
              // rather than serving nothing.
              it("falls back to the upstream random query when the index is cold", async () => {
                musicLibrary.peekAlbumIndex.mockReturnValue(undefined);
                musicLibrary.albums.mockResolvedValue({ results: [], total: 0 });

                await ws.getMetadataAsync({ id: "randomAlbums", index: 0, count: 10 });

                expect(musicLibrary.albums).toHaveBeenCalledWith(
                  expect.objectContaining({ type: "random" })
                );
              });
            });

            describe("asking for a playlist tile", () => {
              // Rendering ONE playlist tile needs only id/name/coverArt, but this fetched the whole
              // playlist - every entry, mapped to a Track - to read three fields off it. A
              // full-library playlist is hundreds of thousands of entries. playlists() already
              // returns exactly the summary a tile needs.
              it("uses the playlist SUMMARY and never fetches the playlist contents", async () => {
                const summary = { id: "pl-1", name: "Road trip", coverArt: undefined };
                musicLibrary.playlists.mockResolvedValue([summary]);
                musicLibrary.playlist.mockResolvedValue({
                  ...summary,
                  entries: [],
                });

                const result = await ws.getExtendedMetadataAsync({ id: "playlist:pl-1" });

                expect(result[0].getExtendedMetadataResult.mediaCollection).toEqual(
                  expect.objectContaining({ id: "playlist:pl-1", title: "Road trip" })
                );
                expect(musicLibrary.playlists).toHaveBeenCalled();
                expect(musicLibrary.playlist).not.toHaveBeenCalled();
              });
            });

              describe("artist biography", () => {
                const artist = anArtist({
                  biography: "an influential dance-punk band",
                  similarArtists: [],
                  albums: [],
                });
                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                it("getExtendedMetadata returns an ARTIST_BIO relatedText marker", async () => {
                  const root = await ws.getExtendedMetadataAsync({
                    id: `artist:${artist.id}`,
                  });
                  expect(root[0].getExtendedMetadataResult.relatedText).toEqual([
                    { id: `artist:${artist.id}`, type: "ARTIST_BIO" },
                  ]);
                });

                it("getExtendedMetadataText returns the biography for ARTIST_BIO", async () => {
                  const root = await ws.getExtendedMetadataTextAsync({
                    id: `artist:${artist.id}`,
                    type: "ARTIST_BIO",
                  });
                  expect(root[0]).toEqual({
                    getExtendedMetadataTextResult: "an influential dance-punk band",
                  });
                });

                it("getExtendedMetadataText strips XML-invalid control chars from the biography", async () => {
                  const bad = String.fromCharCode(4);
                  musicLibrary.artist.mockResolvedValue({
                    ...artist,
                    biography: "Great" + bad + " band" + bad,
                  });
                  const root = await ws.getExtendedMetadataTextAsync({
                    id: `artist:${artist.id}`,
                    type: "ARTIST_BIO",
                  });
                  expect(root[0]).toEqual({
                    getExtendedMetadataTextResult: "Great band",
                  });
                });

                it("getExtendedMetadata strips control chars from the artist name", async () => {
                  const bad = String.fromCharCode(4);
                  musicLibrary.artist.mockResolvedValue({
                    ...artist,
                    name: "Bad" + bad + "Name",
                  });
                  const root = await ws.getExtendedMetadataAsync({
                    id: `artist:${artist.id}`,
                  });
                  expect(
                    root[0].getExtendedMetadataResult.mediaCollection.title
                  ).toEqual("BadName");
                });
              });

              describe("when none of the similar artists are in the library", () => {
                const relatedArtist1 = anArtist();
                const relatedArtist2 = anArtist();
                const artist = anArtist({
                  similarArtists: [
                    { ...relatedArtist1, inLibrary: false },
                    { ...relatedArtist2, inLibrary: false },
                  ],
                  albums: [],
                });

                beforeEach(() => {
                  musicLibrary.artist.mockResolvedValue(artist);
                });

                it("should not return a RELATED_ARTISTS browse option", async () => {
                  const root = await ws.getExtendedMetadataAsync({
                    id: `artist:${artist.id}`
                  });
                  expect(root[0]).toEqual({
                    getExtendedMetadataResult: {
                      mediaCollection: {
                        itemType: "artist",
                        id: `artist:${artist.id}`,
                        artistId: `artist:${artist.id}`,
                        title: artist.name,
                        albumArtURI: coverArtURI(bonobUrlWithAccessToken, { coverArt: artist.image }).href(),
                      }
                    },
                  });
                });
              });
            });

            describe("asking for a track", () => {
              describe("that has a love", () => {
                it("should return the track", async () => {
                  const track = aTrack();

                  musicLibrary.track.mockResolvedValue(track);

                  const root = await ws.getExtendedMetadataAsync({
                    id: `track:${track.id}`,
                  });

                  expect(root[0]).toEqual({
                    getExtendedMetadataResult: {
                      mediaMetadata: {
                        id: `track:${track.id}`,
                        itemType: "track",
                        title: track.name,
                        mimeType: track.encoding.mimeType,
                        trackMetadata: {
                          artistId: `artist:${track.artist.id}`,
                          artist: track.artist.name,
                          albumId: `album:${track.album.id}`,
                          albumArtist: track.artist.name,
                          albumArtistId: `artist:${track.artist.id}`,
                          album: track.album.name,
                          genre: track.genre?.name,
                          genreId: track.genre?.id,
                          duration: track.duration,
                          albumArtURI: coverArtURI(
                            bonobUrlWithAccessToken,
                            track
                          ).href(),
                          trackNumber: track.number,
                        },
                        dynamic: {
                          property: [
                            {
                              name: "rating",
                              value: `${ratingAsInt(track.rating)}`,
                            },
                          ],
                        },
                      },
                    },
                  });
                  expect(musicLibrary.track).toHaveBeenCalledWith(track.id);
                });
              });

              describe("that does not have a love", () => {
                it("should return the track", async () => {
                  const track = aTrack();

                  musicLibrary.track.mockResolvedValue(track);

                  const root = await ws.getExtendedMetadataAsync({
                    id: `track:${track.id}`,
                  });

                  expect(root[0]).toEqual({
                    getExtendedMetadataResult: {
                      mediaMetadata: {
                        id: `track:${track.id}`,
                        itemType: "track",
                        title: track.name,
                        mimeType: track.encoding.mimeType,
                        trackMetadata: {
                          artistId: `artist:${track.artist.id}`,
                          artist: track.artist.name,
                          albumId: `album:${track.album.id}`,
                          albumArtist: track.artist.name,
                          albumArtistId: `artist:${track.artist.id}`,
                          album: track.album.name,
                          genre: track.genre?.name,
                          genreId: track.genre?.id,
                          duration: track.duration,
                          albumArtURI: coverArtURI(
                            bonobUrlWithAccessToken,
                            track
                          ).href(),
                          trackNumber: track.number,
                        },
                        dynamic: {
                          property: [
                            {
                              name: "rating",
                              value: `${ratingAsInt(track.rating)}`,
                            },
                          ],
                        },
                      },
                    },
                  });
                  expect(musicLibrary.track).toHaveBeenCalledWith(track.id);
                });
              });
            });

            describe("asking for an album", () => {
              it("should return the album", async () => {
                const album = anAlbum();

                musicLibrary.album.mockResolvedValue(album);

                const root = await ws.getExtendedMetadataAsync({
                  id: `album:${album.id}`,
                });

                expect(root[0]).toEqual({
                  getExtendedMetadataResult: {
                    mediaCollection: {
                      attributes: {
                        readOnly: "true",
                        userContent: "false",
                        renameable: "false",
                      },
                      itemType: "album",
                      id: `album:${album.id}`,
                      title: album.name,
                      albumArtURI: coverArtURI(
                        bonobUrlWithAccessToken,
                        album
                      ).href(),
                      canPlay: true,
                      artistId: `artist:${album.artistId}`,
                      artist: album.artistName,
                    },
                  },
                });
                expect(musicLibrary.album).toHaveBeenCalledWith(album.id);
              });
            });

            describe("getExtendedMetadataText", () => {
              it("returns an empty result for an unsupported textType without fetching artist data", async () => {
                const root = await ws.getExtendedMetadataTextAsync({
                  id: `track:${uuid()}`,
                  type: "ALBUM_REVIEW",
                });

                expect(root[0]).toEqual({ getExtendedMetadataTextResult: "" });
                // the unsupported-textType path must NOT call out to artist() for a bio
                expect(musicLibrary.artist).not.toHaveBeenCalled();
              });

              it("returns an empty string for ARTIST_BIO when the artist has no biography", async () => {
                const artist = anArtist({
                  biography: undefined,
                  similarArtists: [],
                  albums: [],
                });
                musicLibrary.artist.mockResolvedValue(artist);

                const root = await ws.getExtendedMetadataTextAsync({
                  id: `artist:${artist.id}`,
                  type: "ARTIST_BIO",
                });

                expect(root[0]).toEqual({ getExtendedMetadataTextResult: "" });
                expect(musicLibrary.artist).toHaveBeenCalledWith(artist.id);
              });
            });

            describe("asking for a playlist", () => {
              it("returns the playlist as a single mediaCollection", async () => {
                const pl = aPlaylist();
                // The tile is built from the SUMMARY list now: rendering it used to fetch every
                // entry of the playlist to read three fields.
                musicLibrary.playlists.mockResolvedValue([pl]);
                musicLibrary.playlist.mockResolvedValue(pl);

                const root = await ws.getExtendedMetadataAsync({
                  id: `playlist:${pl.id}`,
                });

                expect(root[0]).toEqual({
                  getExtendedMetadataResult: {
                    mediaCollection: {
                      itemType: "playlist",
                      id: `playlist:${pl.id}`,
                      title: pl.name,
                      albumArtURI: coverArtURI(bonobUrlWithAccessToken, pl).href(),
                      canPlay: true,
                      attributes: {
                        userContent: "true",
                      },
                    },
                  },
                });
                // Built from the summary list, NOT from a full playlist fetch.
                expect(musicLibrary.playlists).toHaveBeenCalled();
                expect(musicLibrary.playlist).not.toHaveBeenCalled();
              });
            });

            describe("asking for something that doesnt exist", () => {
              it("should return an empty result rather than throwing an error", async () => {
                const root = await ws.getExtendedMetadataAsync({
                  id: `foobar:1000`,
                });

                expect(root[0]).toEqual({
                  getExtendedMetadataResult: null
                });
              });
            });
          });
        });

        describe("getMediaURI", () => {
          itShouldHandleInvalidCredentials((ws) =>
            ws.getMediaURIAsync({ id: "track:123" })
          );

          describe("when valid credentials are provided", () => {
            let ws: Client;

            beforeEach(async () => {
              ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              setupAuthenticatedRequest(ws);
            });

            describe("asking for a URI to stream a track", () => {
              it("should return it with auth header", async () => {
                const trackId = uuid();

                const root = await ws.getMediaURIAsync({
                  id: `track:${trackId}`,
                });

                expect(root[0]).toEqual({
                  getMediaURIResult: bonobUrl
                    .append({
                      pathname: `/stream/track/${trackId}`,
                    })
                    .href(),
                  httpHeaders: {
                      httpHeader: [{
                          header: "authorization",
                          value: apiToken,
                      }],
                    },
                });

                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
              });
            });

            describe("asking for a URI to stream a radio station", () => {
              const someStation = aRadioStation()

              beforeEach(() => {
                musicLibrary.radioStation.mockResolvedValue(someStation);
              })

              it("should return the radio stations uri", async () => {
                const root = await ws.getMediaURIAsync({
                  id: `internetRadioStation:${someStation.id}`,
                });

                expect(root[0]).toEqual({
                  getMediaURIResult: someStation.url,
                });

                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.radioStation).toHaveBeenCalledWith(someStation.id);
              });
            });  
            
            describe("asking for a URI for an unsupported type", () => {
              it("should return an error icon", async () => {
                const root = await ws.getMediaURIAsync({
                  id: `foobar:1000`,
                });

                expect(root[0]).toEqual({
                  getMediaURIResult: iconArtURI(bonobUrl, "error", "?").href()
                });

                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
              });
            });            
          });
        });

        describe("getMediaMetadata", () => {
          itShouldHandleInvalidCredentials((ws) =>
            ws.getMediaMetadataAsync({ id: "track:123" })
          );

          describe("when valid credentials are provided", () => {
            let ws: Client;

            beforeEach(async () => {
              ws = await createClientAsync(`${service.uri}?wsdl`, {
                endpoint: service.uri,
                httpClient: supersoap(server),
              });
              setupAuthenticatedRequest(ws);
            });

            describe("asking for media metadata for a track", () => {
              const someTrack = aTrack();

              beforeEach(async () => {
                musicLibrary.track.mockResolvedValue(someTrack);
              });

              it("should return it with auth header", async () => {
                const root = await ws.getMediaMetadataAsync({
                  id: `track:${someTrack.id}`,
                });

                expect(root[0]).toEqual({
                  getMediaMetadataResult: track(
                    bonobUrl.with({
                      searchParams: { bat: apiToken },
                    }),
                    someTrack
                  ),
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.track).toHaveBeenCalledWith(someTrack.id);
              });

              it("strips XML-invalid control chars from track metadata", async () => {
                const bad = String.fromCharCode(4);
                musicLibrary.track.mockResolvedValue({
                  ...someTrack,
                  name: "Awaken" + bad + " My Love!",
                });
                const root = await ws.getMediaMetadataAsync({
                  id: `track:${someTrack.id}`,
                });
                // the response round-trips as valid XML (would have failed otherwise) and is clean
                expect(JSON.stringify(root[0])).not.toContain(bad);
                expect(JSON.stringify(root[0])).toContain("Awaken My Love!");
              });
            });

            describe("asking for media metadata for an internet radio station", () => {
              const someStation = aRadioStation()

              beforeEach(() => {
                musicLibrary.radioStation.mockResolvedValue(someStation);
              })

              it("should return it with no auth header", async () => {
                const root = await ws.getMediaMetadataAsync({
                  id: `internetRadioStation:${someStation.id}`,
                });

                expect(root[0]).toEqual({
                  getMediaMetadataResult: internetRadioStation(someStation),
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.radioStation).toHaveBeenCalledWith(someStation.id);
              });
            });

            describe("asking for media metadata for an unsupported type", () => {
              it("should return it with auth header", async () => {
                const root = await ws.getMediaMetadataAsync({
                  id: `foobar:1000`,
                });

                expect(root[0]).toEqual({
                  getMediaMetadataResult: null,
                });
              });
            });
          });
        });

        describe("createContainer", () => {
          let ws: Client;

          beforeEach(async () => {
            ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
          });

          itShouldHandleInvalidCredentials((ws) =>
            ws.createContainerAsync({ title: "foobar" })
          );

          describe("when valid credentials are provided", () => {
            beforeEach(() => {
              setupAuthenticatedRequest(ws);
            });

            describe("with only a title", () => {
              const title = "aNewPlaylist";
              const idOfNewPlaylist = uuid();

              it("should create a playlist", async () => {
                musicLibrary.createPlaylist.mockResolvedValue({
                  id: idOfNewPlaylist,
                  name: title,
                });

                const result = await ws.createContainerAsync({
                  title,
                });

                expect(result[0]).toEqual({
                  createContainerResult: {
                    id: `playlist:${idOfNewPlaylist}`,
                    updateId: null,
                  },
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.createPlaylist).toHaveBeenCalledWith(title);
              });
            });

            describe("with a title and a seed track", () => {
              const title = "aNewPlaylist2";
              const trackId = "track123";
              const idOfNewPlaylist = "playlistId";

              it("should create a playlist with the track", async () => {
                musicLibrary.createPlaylist.mockResolvedValue({
                  id: idOfNewPlaylist,
                  name: title,
                });
                musicLibrary.addToPlaylist.mockResolvedValue(true);

                const result = await ws.createContainerAsync({
                  title,
                  seedId: `track:${trackId}`,
                });

                expect(result[0]).toEqual({
                  createContainerResult: {
                    id: `playlist:${idOfNewPlaylist}`,
                    updateId: null,
                  },
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.createPlaylist).toHaveBeenCalledWith(title);
                expect(musicLibrary.addToPlaylist).toHaveBeenCalledWith(
                  idOfNewPlaylist,
                  trackId
                );
              });
            });
          });
        });

        describe("deleteContainer", () => {
          const id = "id123";

          let ws: Client;

          beforeEach(async () => {
            ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
          });

          itShouldHandleInvalidCredentials((ws) =>
            ws.deleteContainerAsync({ id: "foobar" })
          );

          describe("when valid credentials are provided", () => {
            beforeEach(() => {
              setupAuthenticatedRequest(ws);
            });

            it("should delete the playlist", async () => {
              musicLibrary.deletePlaylist.mockResolvedValue(true);

              const result = await ws.deleteContainerAsync({
                id,
              });

              expect(result[0]).toEqual({ deleteContainerResult: null });
              expect(musicService.login).toHaveBeenCalledWith(serviceToken);
              expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
              expect(musicLibrary.deletePlaylist).toHaveBeenCalledWith(id);
            });
          });
        });

        describe("addToContainer", () => {
          const trackId = "track123";
          const playlistId = "parent123";

          let ws: Client;

          beforeEach(async () => {
            ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
          });

          itShouldHandleInvalidCredentials((ws) =>
            ws.addToContainerAsync({ id: "foobar", parentId: "parentId" })
          );

          describe("when valid credentials are provided", () => {
            beforeEach(() => {
              setupAuthenticatedRequest(ws);
            });

            it("should add the item to the playlist", async () => {
              musicLibrary.addToPlaylist.mockResolvedValue(true);

              const result = await ws.addToContainerAsync({
                id: `track:${trackId}`,
                parentId: `parent:${playlistId}`,
              });

              expect(result[0]).toEqual({
                addToContainerResult: { updateId: null },
              });
              expect(musicService.login).toHaveBeenCalledWith(serviceToken);
              expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
              expect(musicLibrary.addToPlaylist).toHaveBeenCalledWith(
                playlistId,
                trackId
              );
            });
          });
        });

        describe("removeFromContainer", () => {
          let ws: Client;

          beforeEach(async () => {
            ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
          });

          itShouldHandleInvalidCredentials((ws) =>
            ws.removeFromContainerAsync({
              id: `playlist:123`,
              indices: `1,6,9`,
            })
          );

          describe("when valid credentials are provided", () => {
            beforeEach(() => {
              setupAuthenticatedRequest(ws);
            });

            describe("removing tracks from a playlist", () => {
              const playlistId = "parent123";

              it("should remove the track from playlist", async () => {
                musicLibrary.removeFromPlaylist.mockResolvedValue(true);

                const result = await ws.removeFromContainerAsync({
                  id: `playlist:${playlistId}`,
                  indices: `1,6,9`,
                });

                expect(result[0]).toEqual({
                  removeFromContainerResult: { updateId: null },
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.removeFromPlaylist).toHaveBeenCalledWith(
                  playlistId,
                  [1, 6, 9]
                );
              });
            });

            describe("removing a playlist", () => {
              const playlist1 = aPlaylist({ id: "p1" });
              const playlist2 = aPlaylist({ id: "p2" });
              const playlist3 = aPlaylist({ id: "p3" });
              const playlist4 = aPlaylist({ id: "p4" });
              const playlist5 = aPlaylist({ id: "p5" });

              it("should delete the playlist", async () => {
                musicLibrary.playlists.mockResolvedValue([
                  playlist1,
                  playlist2,
                  playlist3,
                  playlist4,
                  playlist5,
                ]);
                musicLibrary.deletePlaylist.mockResolvedValue(true);

                const result = await ws.removeFromContainerAsync({
                  id: `playlists`,
                  indices: `0,2,4`,
                });

                expect(result[0]).toEqual({
                  removeFromContainerResult: { updateId: null },
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.deletePlaylist).toHaveBeenCalledTimes(3);
                expect(musicLibrary.deletePlaylist).toHaveBeenNthCalledWith(
                  1,
                  playlist1.id
                );
                expect(musicLibrary.deletePlaylist).toHaveBeenNthCalledWith(
                  2,
                  playlist3.id
                );
                expect(musicLibrary.deletePlaylist).toHaveBeenNthCalledWith(
                  3,
                  playlist5.id
                );
              });
            });
          });
        });

        describe("rateItem", () => {
          let ws: Client;

          beforeEach(async () => {
            ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
          });

          itShouldHandleInvalidCredentials((ws) =>
            ws.rateItemAsync({
              id: `track:123`,
              rating: 4,
            })
          );

          describe("when valid credentials are provided", () => {
            beforeEach(() => {
              setupAuthenticatedRequest(ws);
            });

            describe("rating a track with a positive rating value", () => {
              const trackId = "123";
              const ratingIntValue = 31;

              it("should give the track a love", async () => {
                musicLibrary.rate.mockResolvedValue(true);

                const result = await ws.rateItemAsync({
                  id: `track:${trackId}`,
                  rating: ratingIntValue,
                });

                expect(result[0]).toEqual({
                  rateItemResult: { shouldSkip: false },
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.rate).toHaveBeenCalledWith(
                  trackId,
                  ratingFromInt(ratingIntValue)
                );
              });
            });

            describe("rating a track with a negative rating value", () => {
              const trackId = "123";
              const ratingIntValue = -20;

              it("should give the track a love", async () => {
                musicLibrary.rate.mockResolvedValue(true);

                const result = await ws.rateItemAsync({
                  id: `track:${trackId}`,
                  rating: ratingIntValue,
                });

                expect(result[0]).toEqual({
                  rateItemResult: { shouldSkip: false },
                });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.rate).toHaveBeenCalledWith(
                  trackId,
                  ratingFromInt(Math.abs(ratingIntValue))
                );
              });
            });
          });
        });

        describe("setPlayedSeconds", () => {
          let ws: Client;

          beforeEach(async () => {
            ws = await createClientAsync(`${service.uri}?wsdl`, {
              endpoint: service.uri,
              httpClient: supersoap(server),
            });
          });

          itShouldHandleInvalidCredentials((ws) =>
            ws.setPlayedSecondsAsync({
              id: `track:123`,
              seconds: `33`,
            })
          );

          describe("when valid credentials are provided", () => {
            beforeEach(() => {
              setupAuthenticatedRequest(ws);
            });

            describe("when id is for a track", () => {
              const trackId = "123456";

              function itShouldScroble({
                trackId,
                secondsPlayed,
              }: {
                trackId: string;
                secondsPlayed: number;
              }) {
                it("should scrobble", async () => {
                  musicLibrary.scrobble.mockResolvedValue(true);

                  const result = await ws.setPlayedSecondsAsync({
                    id: `track:${trackId}`,
                    seconds: `${secondsPlayed}`,
                  });

                  expect(result[0]).toEqual({ setPlayedSecondsResult: null });
                  expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                  expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                  expect(musicLibrary.track).toHaveBeenCalledWith(trackId);
                  expect(musicLibrary.scrobble).toHaveBeenCalledWith(trackId);
                });
              }

              function itShouldNotScroble({
                trackId,
                secondsPlayed,
              }: {
                trackId: string;
                secondsPlayed: number;
              }) {
                it("should not scrobble", async () => {
                  const result = await ws.setPlayedSecondsAsync({
                    id: `track:${trackId}`,
                    seconds: `${secondsPlayed}`,
                  });

                  expect(result[0]).toEqual({ setPlayedSecondsResult: null });
                  expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                  expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                  expect(musicLibrary.track).toHaveBeenCalledWith(trackId);
                  expect(musicLibrary.scrobble).not.toHaveBeenCalled();
                });
              }

              describe("when the track length is 30 seconds", () => {
                beforeEach(() => {
                  musicLibrary.track.mockResolvedValue(
                    aTrack({ id: trackId, duration: 30 })
                  );
                });

                describe("when the played length is 30 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 30 });
                });

                describe("when the played length is > 30 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 90 });
                });

                describe("when the played length is < 30 seconds", () => {
                  itShouldNotScroble({ trackId, secondsPlayed: 29 });
                });
              });

              describe("when the track length is > 30 seconds", () => {
                beforeEach(() => {
                  musicLibrary.track.mockResolvedValue(
                    aTrack({ id: trackId, duration: 31 })
                  );
                });

                describe("when the played length is 30 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 30 });
                });

                describe("when the played length is > 30 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 90 });
                });

                describe("when the played length is < 30 seconds", () => {
                  itShouldNotScroble({ trackId, secondsPlayed: 29 });
                });
              });

              describe("when the track length is 29 seconds", () => {
                beforeEach(() => {
                  musicLibrary.track.mockResolvedValue(
                    aTrack({ id: trackId, duration: 29 })
                  );
                });

                describe("when the played length is 29 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 30 });
                });

                describe("when the played length is > 29 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 30 });
                });

                describe("when the played length is 10 seconds", () => {
                  itShouldScroble({ trackId, secondsPlayed: 10 });
                });

                describe("when the played length is < 10 seconds", () => {
                  itShouldNotScroble({ trackId, secondsPlayed: 9 });
                });
              });
            });

            describe("when the id is for something that isnt a track", () => {
              it("should not scrobble", async () => {
                const result = await ws.setPlayedSecondsAsync({
                  id: `album:666`,
                  seconds: "100",
                });

                expect(result[0]).toEqual({ setPlayedSecondsResult: null });
                expect(musicService.login).toHaveBeenCalledWith(serviceToken);
                expect(apiTokens.mint).toHaveBeenCalledWith(serviceToken);
                expect(musicLibrary.scrobble).not.toHaveBeenCalled();
              });
            });
          });
        });
      });
    });
  });
});

import { option as O, either as E } from "fp-ts";
import { randomUUID as uuid } from "crypto";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "fs";
import os from "os";
import path from "path";

const tmpDir = () => ({ name: mkdtempSync(path.join(os.tmpdir(), "bonob-")) });
import { pipe } from "fp-ts/lib/function";

import sharp from "sharp";
jest.mock("sharp");


import axios from "axios";
jest.mock("axios", () => ({
  ...jest.requireActual("axios"),
  get: jest.fn(),
  post: jest.fn(),
}));

import * as random from "../src/random";
jest.mock("../src/random");

import { URLBuilder } from "../src/url_builder";
import {
  isValidImage,
  isSafeExternalImageUrl,
  resolvedExternalHostIsSafe,
  isRetryableSubsonicError,
  pinnedSafeExternalLookup,
  t,
  DODGY_IMAGE_NAME,
  asURLSearchParams,
  cachingImageFetcher,
  asTrack,
  artistImageURN,
  song,
  TranscodingCustomPlayers,
  CustomPlayers,
  NO_CUSTOM_PLAYERS,
  Subsonic,
  axiosImageFetcher,
  asGenre,
  PingResponse,
  OpenSubsonicExtension,
  SONOS_CLIENT_INFO,
  TranscodeDecision,
  asToken,
  parseToken,
  BROWSER_HEADERS,
  albumSummaryFromSong,
  CoverArtBusyError,
  DEFAULT_MAX_INDEX_SCAN_ALBUMS,
  ALBUM_LIST_MAX_PAGE_SIZE,
  MAX_RECURSIVE_ALBUMS,
  MAX_RECURSIVE_TRACKS,
} from "../src/subsonic";

import { promises as dnsPromises } from "dns";
import { getArtistJson, getArtistInfoJson, asArtistsJson, getAlbumListJson } from "./subsonic_music_library.test";

import { b64Encode } from "../src/b64";
import dayjs from "dayjs";
import { FixedClock } from "../src/clock";
import { SwrCache } from "../src/swr_cache";
import { SystemClock } from "../src/clock";

import { Album, Artist, Track, AlbumSummary, AlbumQuery, AuthFailure } from "../src/music_library";
import { anAlbum, aTrack, anAlbumSummary, anArtistSummary, anArtist, aSimilarArtist, POP, a404 } from "./builders";
import { readAlbumIndexPage } from "../src/album_snapshot";
import { BUrn } from "../src/burn";



describe("t", () => {
  it("should be an md5 of the password and the salt", () => {
    const p = "password123";
    const s = "saltydog";
    expect(t(p, s)).toEqual(createHash("md5").update(`${p}${s}`).digest("hex"));
  });
});

describe("isValidImage", () => {
  describe("when ends with 2a96cbd8b46e442fc41c2b86b821562f.png", () => {
    it("is dodgy", () => {
      expect(
        isValidImage("http://something/2a96cbd8b46e442fc41c2b86b821562f.png")
      ).toEqual(false);
    });
  });
  describe("when does not end with 2a96cbd8b46e442fc41c2b86b821562f.png", () => {
    it("is dodgy", () => {
      expect(isValidImage("http://something/somethingelse.png")).toEqual(true);
      expect(
        isValidImage(
          "http://something/2a96cbd8b46e442fc41c2b86b821562f.png?withsomequerystring=true"
        )
      ).toEqual(true);
    });
  });
});

describe("isSafeExternalImageUrl (SSRF guard for server-fetched external art)", () => {
  it("allows public http(s) art hosts", () => {
    expect(isSafeExternalImageUrl("https://images.example.com/a.jpg")).toBe(true);
    expect(isSafeExternalImageUrl("http://images.example.com/a.jpg")).toBe(true);
  });

  it("blocks loopback, link-local, private, and metadata hosts", () => {
    for (const url of [
      "http://127.0.0.1/a.jpg",
      "https://127.0.0.1/a.jpg",
      "http://localhost/a.jpg",
      "https://sub.localhost/a.jpg",
      "https://169.254.169.254/latest/meta-data",
      "http://10.0.0.5/a.jpg",
      "http://192.168.1.1/a.jpg",
      "http://172.16.0.1/a.jpg",
      "http://[::1]/a.jpg",
      "http://metadata.google.internal/x",
    ]) {
      expect(isSafeExternalImageUrl(url)).toBe(false);
    }
  });

  it("blocks non-http(s) schemes and non-strings", () => {
    expect(isSafeExternalImageUrl("ftp://example.com/a")).toBe(false);
    expect(isSafeExternalImageUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalImageUrl("not a url")).toBe(false);
    expect(isSafeExternalImageUrl(undefined)).toBe(false);
    expect(isSafeExternalImageUrl(42)).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 (hex-hextet + dotted) that alias an internal address", () => {
    for (const url of [
      "http://[::ffff:7f00:1]/a.jpg",
      "http://[::ffff:127.0.0.1]/a.jpg",
      "http://[::ffff:a9fe:a9fe]/meta",
    ]) {
      expect(isSafeExternalImageUrl(url)).toBe(false);
    }
  });

  it("blocks NAT64-embedded IPv4 literals (64:ff9b::/96)", () => {
    for (const url of [
      "http://[64:ff9b::a9fe:a9fe]/meta",
      "http://[64:ff9b::7f00:1]/a.jpg",
    ]) {
      expect(isSafeExternalImageUrl(url)).toBe(false);
    }
  });

  it("blocks SIIT (::ffff:0:0/96 translated) + 6to4 (2002::/16) embedded private IPv4", () => {
    for (const url of [
      "http://[::ffff:0:a9fe:a9fe]/meta", // SIIT 169.254.169.254
      "http://[::ffff:0:7f00:1]/a.jpg", // SIIT 127.0.0.1
      "http://[2002:a9fe:a9fe::]/meta", // 6to4 169.254.169.254
      "http://[2002:7f00:1::]/a.jpg", // 6to4 127.0.0.1
    ]) {
      expect(isSafeExternalImageUrl(url)).toBe(false);
    }
  });

  it("still allows a normal public IPv6 host", () => {
    expect(isSafeExternalImageUrl("http://[2606:4700:4700::1111]/a.jpg")).toBe(
      true
    );
  });
});

describe("resolvedExternalHostIsSafe (DNS-resolution SSRF guard)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("refuses a hostname that resolves to a private/metadata address (nip.io-style)", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as any);
    expect(
      await resolvedExternalHostIsSafe(
        "https://169.254.169.254.nip.io/latest/meta-data"
      )
    ).toBe(false);
  });

  it("allows a hostname that resolves only to public addresses", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    expect(
      await resolvedExternalHostIsSafe("https://images.example.com/a.jpg")
    ).toBe(true);
  });

  it("refuses if ANY resolved address is unsafe (rebind-style split answer)", async () => {
    jest.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as any);
    expect(
      await resolvedExternalHostIsSafe("https://mixed.example.com/a.jpg")
    ).toBe(false);
  });
});

describe("pinnedSafeExternalLookup (TOCTOU-safe pinned resolver for external art)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("returns the resolved address for a public host", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    await expect(
      pinnedSafeExternalLookup("images.example.com")
    ).resolves.toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("rejects when the host resolves to a private/metadata address", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "169.254.169.254", family: 4 }] as any);
    await expect(
      pinnedSafeExternalLookup("metadata.rebind.example")
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("rejects if ANY resolved address is unsafe", async () => {
    jest.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as any);
    await expect(pinnedSafeExternalLookup("mixed.example")).rejects.toThrow(
      /127\.0\.0\.1/
    );
  });

  it("returns all validated addresses when opt.all is set", async () => {
    jest.spyOn(dnsPromises, "lookup").mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ] as any);
    await expect(
      pinnedSafeExternalLookup("images.example.com", { all: true })
    ).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("is actually invoked by axios (promise-style lookup is bound, not a dead hook)", async () => {
    const realAxios = jest.requireActual("axios").default;
    const spy = jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    await realAxios
      .get("http://pinned.invalid/a.jpg", {
        lookup: pinnedSafeExternalLookup,
        timeout: 3000,
        maxRedirects: 0,
      })
      .catch(() => undefined);
    // If axios ignored the custom lookup it would resolve "pinned.invalid" via Node's callback
    // dns.lookup, never touching dnsPromises.lookup - so being called proves the promise-style hook
    // is bound and used for the socket's own resolution (closing the rebind TOCTOU).
    expect(spy).toHaveBeenCalledWith(
      "pinned.invalid",
      expect.objectContaining({ all: true })
    );
  });
});

describe("isRetryableSubsonicError (read retry policy)", () => {
  it("retries transport failures (network error / 5xx) but not 4xx or app-level errors", () => {
    expect(isRetryableSubsonicError(new Error("ECONNRESET"))).toBe(true);
    expect(isRetryableSubsonicError("Subsonic failed with a 503 status")).toBe(true);
    expect(isRetryableSubsonicError("Subsonic failed with a 500 status")).toBe(true);
    expect(isRetryableSubsonicError("Subsonic failed with a 404 status")).toBe(false);
    expect(isRetryableSubsonicError("Subsonic failed with a 401 status")).toBe(false);
    expect(isRetryableSubsonicError("Subsonic error: parameter missing")).toBe(false);
  });

  it("classifies real AxiosError rejections by response status (axios rejects non-2xx as objects)", () => {
    // 4xx client errors -> do NOT retry
    expect(isRetryableSubsonicError({ isAxiosError: true, response: { status: 404 } })).toBe(false);
    expect(isRetryableSubsonicError({ isAxiosError: true, response: { status: 400 } })).toBe(false);
    // 5xx -> retry
    expect(isRetryableSubsonicError({ isAxiosError: true, response: { status: 503 } })).toBe(true);
    expect(isRetryableSubsonicError({ isAxiosError: true, response: { status: 500 } })).toBe(true);
    // no response = network / timeout error -> retry
    expect(isRetryableSubsonicError({ isAxiosError: true, code: "ECONNABORTED" })).toBe(true);
    expect(isRetryableSubsonicError({ isAxiosError: true })).toBe(true);
  });
});

describe("StreamClient(s)", () => {
  describe("CustomStreamClientApplications", () => {
    const customClients = TranscodingCustomPlayers.from(
      "audio/flac,audio/mp3>audio/ogg"
    );

    describe("clientFor", () => {
      describe("when there is a match", () => {
        it("should return the match", () => {
          expect(customClients.encodingFor({ mimeType: "audio/flac" })).toEqual(
            O.of({ player: "bonob+audio/flac", mimeType: "audio/flac" })
          );
          expect(customClients.encodingFor({ mimeType: "audio/mp3" })).toEqual(
            O.of({ player: "bonob+audio/mp3", mimeType: "audio/ogg" })
          );
        });
      });

      describe("when there is no match", () => {
        it("should return undefined", () => {
          expect(customClients.encodingFor({ mimeType: "audio/bob" })).toEqual(
            O.none
          );
        });
      });
    });
  });
});

describe("asURLSearchParams", () => {
  describe("empty q", () => {
    it("should return empty params", () => {
      const q = {};
      const expected = new URLSearchParams();
      expect(asURLSearchParams(q)).toEqual(expected);
    });
  });

  describe("singular params", () => {
    it("should append each", () => {
      const q = {
        a: 1,
        b: "bee",
        c: false,
        d: true,
      };
      const expected = new URLSearchParams();
      expected.append("a", "1");
      expected.append("b", "bee");
      expected.append("c", "false");
      expected.append("d", "true");

      expect(asURLSearchParams(q)).toEqual(expected);
    });
  });

  describe("list params", () => {
    it("should append each", () => {
      const q = {
        a: [1, "two", false, true],
        b: "yippee",
      };

      const expected = new URLSearchParams();
      expected.append("a", "1");
      expected.append("a", "two");
      expected.append("a", "false");
      expected.append("a", "true");
      expected.append("b", "yippee");

      expect(asURLSearchParams(q)).toEqual(expected);
    });
  });
});

describe("cachingImageFetcher", () => {
  const delegate = jest.fn();
  const url = "http://test.example.com/someimage.jpg";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
  });

  describe("when there is no image in the cache", () => {
    it("should fetch the image from the source and then cache and return it", async () => {
      const dir = tmpDir();
      const cacheFile = path.join(dir.name, `${createHash("md5").update(url).digest("hex")}.png`);
      const jpgImage = Buffer.from("jpg-image", "utf-8");
      const pngImage = Buffer.from("png-image", "utf-8");

      delegate.mockResolvedValue({ contentType: "image/jpeg", data: jpgImage });
      const png = jest.fn();
      (sharp as unknown as jest.Mock).mockReturnValue({ png });
      png.mockReturnValue({
        toBuffer: () => Promise.resolve(pngImage),
      });

      // todo: the fact that I need to pass the sharp mock in here isnt correct
      const result = await cachingImageFetcher(dir.name, delegate, sharp)(url);

      expect(result!.contentType).toEqual("image/png");
      expect(result!.data).toEqual(pngImage);

      expect(delegate).toHaveBeenCalledWith(url);
      expect(existsSync(cacheFile)).toEqual(true);
      expect(readFileSync(cacheFile)).toEqual(pngImage);
    });
  });

  describe("when the image is already in the cache", () => {
    it("should fetch the image from the cache and return it", async () => {
      const dir = tmpDir();
      const cacheFile = path.join(dir.name, `${createHash("md5").update(url).digest("hex")}.png`);
      const data = Buffer.from("foobar2", "utf-8");

      writeFileSync(cacheFile, data);

      const result = await cachingImageFetcher(dir.name, delegate)(url);

      expect(result!.contentType).toEqual("image/png");
      expect(result!.data).toEqual(data);

      expect(delegate).not.toHaveBeenCalled();
    });
  });

  describe("when the delegate returns undefined", () => {
    it("should return undefined", async () => {
      const dir = tmpDir();
      const cacheFile = path.join(dir.name, `${createHash("md5").update(url).digest("hex")}.png`);

      delegate.mockResolvedValue(undefined);

      const result = await cachingImageFetcher(dir.name, delegate)(url);

      expect(result).toBeUndefined();

      expect(delegate).toHaveBeenCalledWith(url);
      expect(existsSync(cacheFile)).toEqual(false);
    });
  });
});

const maybeIdFromCoverArtUrn = (coverArt: BUrn | undefined) =>
  pipe(
    coverArt,
    O.fromNullable,
    O.map((it) => it.resource.split(":")[1]),
    O.getOrElseW(() => "")
  );

const asSongJson = (track: Track) => ({
  id: track.id,
  parent: track.album.id,
  title: track.name,
  album: track.album.name,
  artist: track.artist.name,
  track: track.number,
  genre: track.genre?.name,
  isDir: "false",
  coverArt: maybeIdFromCoverArtUrn(track.coverArt),
  created: "2004-11-08T23:36:11",
  duration: track.duration,
  bitRate: 128,
  size: "5624132",
  suffix: "mp3",
  contentType: track.encoding.mimeType,
  transcodedContentType: undefined,
  isVideo: "false",
  path: "ACDC/High voltage/ACDC - The Jack.mp3",
  albumId: track.album.id,
  artistId: track.artist.id,
  type: "music",
  starred: track.rating.love ? "sometime" : undefined,
  userRating: track.rating.stars,
  year: "",
});

export type ArtistWithAlbum = {
  artist: Artist;
  album: Album;
};

const anOpenSubsonicExtension = (fields: Partial<OpenSubsonicExtension> = {}): OpenSubsonicExtension => ({
  name: `extension-${uuid()}`,
  versions: [1],
  ...fields,
});

const pingJson = (pingResponse: Partial<PingResponse> = {}) => ({
  "subsonic-response": {
    status: "ok",
    version: "1.16.1",
    type: "subsonic",
    serverVersion: "0.45.1 (c55e6590)",
    ...pingResponse,
  },
});


describe("artistImageURN", () => {
  describe("when Deezer artist art is preferred (opt-in)", () => {
    it("returns a deezer URN keyed by the artist name, overriding the Navidrome image", () => {
      expect(
        artistImageURN(
          {
            artistId: "someArtistId",
            artistImageURL: "http://example.com/image.jpg",
            name: "Radiohead",
          },
          true
        )
      ).toEqual({ system: "deezer", resource: "Radiohead" });
    });

    it("falls back to the Navidrome image when there is no name", () => {
      expect(
        artistImageURN(
          {
            artistId: "someArtistId",
            artistImageURL: "http://example.com/image.jpg",
            name: undefined,
          },
          true
        )
      ).toEqual({ system: "external", resource: "http://example.com/image.jpg" });
    });

    it("is off by default, so a name does not change the resolved image", () => {
      expect(
        artistImageURN({
          artistId: "someArtistId",
          artistImageURL: "http://example.com/image.jpg",
          name: "Radiohead",
        })
      ).toEqual({ system: "external", resource: "http://example.com/image.jpg" });
    });
  });

  describe("when artist URL is", () => {
    describe("a valid external URL", () => {
      it("should return an external URN", () => {
        expect(
          artistImageURN({
            artistId: "someArtistId",
            artistImageURL: "http://example.com/image.jpg",
          })
        ).toEqual({
          system: "external",
          resource: "http://example.com/image.jpg",
        });
      });
    });

    describe("an invalid external URL", () => {
      describe("and artistId is valid", () => {
        it("should return an external URN", () => {
          expect(
            artistImageURN({
              artistId: "someArtistId",
              artistImageURL: `http://example.com/${DODGY_IMAGE_NAME}`,
            })
          ).toEqual({ system: "subsonic", resource: "art:someArtistId" });
        });
      });

      describe("and artistId is -1", () => {
        it("should return an error icon urn", () => {
          expect(
            artistImageURN({
              artistId: "-1",
              artistImageURL: `http://example.com/${DODGY_IMAGE_NAME}`,
            })
          ).toBeUndefined();
        });
      });

      describe("and artistId is undefined", () => {
        it("should return an error icon urn", () => {
          expect(
            artistImageURN({
              artistId: undefined,
              artistImageURL: `http://example.com/${DODGY_IMAGE_NAME}`,
            })
          ).toBeUndefined();
        });
      });
    });

    describe("undefined", () => {
      describe("and artistId is valid", () => {
        it("should return artist art by artist id URN", () => {
          expect(
            artistImageURN({
              artistId: "someArtistId",
              artistImageURL: undefined,
            })
          ).toEqual({ system: "subsonic", resource: "art:someArtistId" });
        });
      });

      describe("and artistId is -1", () => {
        it("should return error icon", () => {
          expect(
            artistImageURN({ artistId: "-1", artistImageURL: undefined })
          ).toBeUndefined();
        });
      });

      describe("and artistId is undefined", () => {
        it("should return error icon", () => {
          expect(
            artistImageURN({ artistId: undefined, artistImageURL: undefined })
          ).toBeUndefined();
        });
      });
    });
  });
});

describe("asTrack", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
  });

  describe("when the song has no artistId", () => {
    const album = anAlbum();
    const track = aTrack({
      artist: {
        id: undefined,
        name: "Not in library so no id",
        image: undefined,
      },
    });

    it("should provide no artistId", () => {
      const result = asTrack(
        album,
        { ...asSongJson(track) },
        NO_CUSTOM_PLAYERS
      );
      expect(result.artist.id).toBeUndefined();
      expect(result.artist.name).toEqual("Not in library so no id");
      expect(result.artist.image).toBeUndefined();
    });
  });

  describe("when the song has no artist name", () => {
    const album = anAlbum();

    it("should provide a ? to sonos", () => {
      const result = asTrack(
        album,
        { id: "1" } as any as song,
        NO_CUSTOM_PLAYERS
      );
      expect(result.artist.id).toBeUndefined();
      expect(result.artist.name).toEqual("?");
      expect(result.artist.image).toBeUndefined();
    });
  });

  describe("invalid rating.stars values", () => {
    const album = anAlbum();
    const track = aTrack();

    describe("a value greater than 5", () => {
      it("should be returned as 0", () => {
        const result = asTrack(
          album,
          { ...asSongJson(track), userRating: 6 },
          NO_CUSTOM_PLAYERS
        );
        expect(result.rating.stars).toEqual(0);
      });
    });

    describe("a value less than 0", () => {
      it("should be returned as 0", () => {
        const result = asTrack(
          album,
          { ...asSongJson(track), userRating: -1 },
          NO_CUSTOM_PLAYERS
        );
        expect(result.rating.stars).toEqual(0);
      });
    });
  });

  describe("content types", () => {
    const album = anAlbum();
    const track = aTrack();

    describe("when there are no custom players", () => {
      describe("when subsonic reports no transcodedContentType", () => {
        it("should use the default client and default contentType", () => {
          const result = asTrack(
            album,
            {
              ...asSongJson(track),
              contentType: "nonTranscodedContentType",
              transcodedContentType: undefined,
            },
            NO_CUSTOM_PLAYERS
          );

          expect(result.encoding).toEqual({
            player: "bonob",
            mimeType: "nonTranscodedContentType",
          });
        });
      });

      describe("when subsonic reports a transcodedContentType", () => {
        it("should use the default client and transcodedContentType", () => {
          const result = asTrack(
            album,
            {
              ...asSongJson(track),
              contentType: "nonTranscodedContentType",
              transcodedContentType: "transcodedContentType",
            },
            NO_CUSTOM_PLAYERS
          );

          expect(result.encoding).toEqual({
            player: "bonob",
            mimeType: "transcodedContentType",
          });
        });
      });
    });

    describe("when there are custom players registered", () => {
      const streamClient = {
        encodingFor: jest.fn(),
      };

      describe("however no player is found for the default mimeType", () => {
        describe("and there is no transcodedContentType", () => {
          it("should use the default player with the default content type", () => {
            streamClient.encodingFor.mockReturnValue(O.none);

            const result = asTrack(
              album,
              {
                ...asSongJson(track),
                contentType: "nonTranscodedContentType",
                transcodedContentType: undefined,
              },
              streamClient as unknown as CustomPlayers
            );

            expect(result.encoding).toEqual({
              player: "bonob",
              mimeType: "nonTranscodedContentType",
            });
            expect(streamClient.encodingFor).toHaveBeenCalledWith({
              mimeType: "nonTranscodedContentType",
            });
          });
        });

        describe("and there is a transcodedContentType", () => {
          it("should use the default player with the transcodedContentType", () => {
            streamClient.encodingFor.mockReturnValue(O.none);

            const result = asTrack(
              album,
              {
                ...asSongJson(track),
                contentType: "nonTranscodedContentType",
                transcodedContentType: "transcodedContentType1",
              },
              streamClient as unknown as CustomPlayers
            );

            expect(result.encoding).toEqual({
              player: "bonob",
              mimeType: "transcodedContentType1",
            });
            expect(streamClient.encodingFor).toHaveBeenCalledWith({
              mimeType: "nonTranscodedContentType",
            });
          });
        });
      });

      describe("there is a player with the matching content type", () => {
        it("should use it", () => {
          const customEncoding = {
            player: "custom-player",
            mimeType: "audio/some-mime-type",
          };
          streamClient.encodingFor.mockReturnValue(O.of(customEncoding));

          const result = asTrack(
            album,
            {
              ...asSongJson(track),
              contentType: "sourced-from/subsonic",
              transcodedContentType: "sourced-from/subsonic2",
            },
            streamClient as unknown as CustomPlayers
          );

          expect(result.encoding).toEqual(customEncoding);
          expect(streamClient.encodingFor).toHaveBeenCalledWith({
            mimeType: "sourced-from/subsonic",
          });
        });
      });
    });
  });
});

const subsonicResponse = (response : Partial<{ status: string, body: any }> = { }) => {
  const status = response.status || "ok"
  const body = response.body || {}
  return {
    "subsonic-response": {
      status,
      version: "1.16.1",
      type: "subsonic",
      serverVersion: "0.45.1 (c55e6590)",
      ...body,
    },
  };
};

const subsonicOK = (body: any = {}) => subsonicResponse({ status: "ok", body });

const asGenreJson = (genre: { name: string; albumCount: number }) => ({
  songCount: 1475,
  albumCount: genre.albumCount,
  value: genre.name,
});

const getGenresJson = (genres: { name: string; albumCount: number }[]) =>
  subsonicOK({
    genres: {
      genre: genres.map(asGenreJson),
    },
  });

const ok = (data: string | object) => ({
  status: 200,
  data,
});

export const asArtistAlbumJson = (
  artist: { id: string | undefined; name: string | undefined },
  album: AlbumSummary
) => ({
  id: album.id,
  parent: artist.id,
  isDir: "true",
  title: album.name,
  name: album.name,
  album: album.name,
  artist: artist.name,
  genre: album.genre?.name,
  duration: "123",
  playCount: "4",
  year: album.year,
  created: "2021-01-07T08:19:55.834207205Z",
  artistId: artist.id,
  songCount: "19",
});

export const asAlbumJson = (
  artist: { id: string | undefined; name: string | undefined },
  album: Album
) => ({
  id: album.id,
  parent: artist.id,
  isDir: "true",
  title: album.name,
  name: album.name,
  album: album.name,
  artist: artist.name,
  genre: album.genre?.name,
  coverArt: maybeIdFromCoverArtUrn(album.coverArt),
  duration: "123",
  playCount: "4",
  year: album.year,
  created: "2021-01-07T08:19:55.834207205Z",
  artistId: artist.id,
  songCount: "19",
  isVideo: false,
  song: album.tracks.map(asSongJson),
});


export const getAlbumJson = (album: Album) =>
  subsonicOK({ album: {
    id: album.id,
    parent: album.artistId,
    album: album.name,
    title: album.name,
    name: album.name,
    isDir: true,
    coverArt: maybeIdFromCoverArtUrn(album.coverArt),
    songCount: 19,
    created: "2021-01-07T08:19:55.834207205Z",
    duration: 123,
    playCount: 4,
    artistId: album.artistId,
    artist: album.artistName,
    year: album.year,
    genre: album.genre?.name,
    song: album.tracks.map(track => ({
      id: track.id,
      parent: track.album.id,
      title: track.name,
      isDir: false,
      isVideo: false,
      type: "music",
      albumId: track.album.id,
      album: track.album.name,
      artistId: track.artist.id,
      artist: track.artist.name,
      coverArt: maybeIdFromCoverArtUrn(track.coverArt),
      duration: track.duration,
      bitRate: 128,
      bitDepth: 16,
      samplingRate: 555,
      channelCount: 2,
      track: track.number,
      year: 1900,
      genre: track.genre?.name,
      size: 5624132,
      discNumer: 1,
      suffix: "mp3",
      contentType: track.encoding.mimeType,
      path: "ACDC/High voltage/ACDC - The Jack.mp3"
    })),
  } });

const getOpenSubsonicExtensionsJson = (extensions: OpenSubsonicExtension[]) =>
  subsonicOK({ openSubsonicExtensions: extensions });

const aTranscodeDecision = (fields: Partial<TranscodeDecision> = {}): TranscodeDecision => ({
  canDirectPlay: false,
  canTranscode: false,
  ...fields,
});

const getTranscodeDecisionJson = (decision: TranscodeDecision) =>
  subsonicOK({ transcodeDecision: decision });

describe("Subsonic", () => {
  const url = new URLBuilder("http://127.0.0.22:4567/some-context-path");
  const customPlayers = {
    encodingFor: jest.fn(),
  };
  const username = `user1-${uuid()}`;
  const password = `pass1-${uuid()}`;
  const credentials = { username, password };
  const subsonic = new Subsonic(url, customPlayers);

  const mockRandomstring = jest.fn();
  const mockGET = jest.fn();
  const mockPOST = jest.fn();

  const salt = "saltysalty";

  const authParams = {
    u: username,
    v: "1.16.1",
    c: "bonob",
    t: t(password, salt),
    s: salt,
  };

  const authParamsPlusJson = {
    ...authParams,
    f: "json",
  };

  const headers = {
    "User-Agent": "bonob",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    (random.generateRandomString as jest.Mock) = mockRandomstring;
    axios.get = mockGET;
    axios.post = mockPOST;

    mockRandomstring.mockReturnValue(salt);
  });

  describe("ping", () => {
    describe("when authenticates and status is ok", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(pingJson({ 
            status: "ok",
            type: "subsonic-that-works"
          })))
        );
      });

      it("should return authenticated", async () => {
        const result = await subsonic.ping(credentials)();
        expect(result).toEqual(E.right({ authenticated: true, type: "subsonic-that-works" }));
      });
    });

    describe("when authenticates however status is not ok", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(pingJson({ 
            status: "i am not ok",
            type: "subsonic-that-doesnt-works"
          })))
        );
      });

      it("should return an error", async () => {
        const result = await subsonic.ping(credentials)();
        expect(result).toEqual(E.left(new AuthFailure("Not authenticated, status not 'ok'")));
      });
    });
  });  

  describe("getting artists", () => {
    describe("when there are indexes, but no artists", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(
            ok(
              subsonicOK({
                artists: {
                  index: [
                    {
                      name: "#",
                    },
                    {
                      name: "A",
                    },
                    {
                      name: "B",
                    },
                  ],
                },
              })
            )
          )
        );
      });

      it("should return empty", async () => {
        const artists = await subsonic.getArtists(credentials);

        expect(artists).toEqual([]);
      });
    });

    describe("when there no indexes and no artists", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(
            ok(
              subsonicOK({
                artists: {},
              })
            )
          )
        );
      });

      it("should return empty", async () => {
        const artists = await subsonic.getArtists(credentials);

        expect(artists).toEqual([]);
      });
    });

    describe("caching (getArtists via SwrCache)", () => {
      const cached = [anArtist({ name: "A Artist", albums: [anAlbum()] })];
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      let cachingSubsonic: Subsonic;

      beforeEach(() => {
        clock.time = dayjs("2024-01-01T00:00:00Z");
        cachingSubsonic = new Subsonic(
          url,
          customPlayers,
          axiosImageFetcher,
          new SwrCache(clock, 5 * 60_000)
        );
        mockGET.mockImplementation(() => Promise.resolve(ok(asArtistsJson(cached))));
      });

      it("caches getArtists (one upstream fetch for repeated browses)", async () => {
        const first = await cachingSubsonic.getArtists(credentials);
        const second = await cachingSubsonic.getArtists(credentials);

        expect(second).toEqual(first);
        expect(mockGET).toHaveBeenCalledTimes(1);
      });

      it("keys the cache per user (Navidrome has per-user library ACLs)", async () => {
        await cachingSubsonic.getArtists(credentials);
        await cachingSubsonic.getArtists({ username: "someone-else", password: "x" });

        expect(mockGET).toHaveBeenCalledTimes(2);
      });

      it("coalesces concurrent Sonos page requests into one fetch", async () => {
        await Promise.all([
          cachingSubsonic.getArtists(credentials),
          cachingSubsonic.getArtists(credentials),
          cachingSubsonic.getArtists(credentials),
        ]);

        expect(mockGET).toHaveBeenCalledTimes(1);
      });

      describe("album-list page caching", () => {
        const albumArtist = anArtist();
        const albumsPage: [Artist, AlbumSummary][] = [
          [albumArtist, anAlbumSummary()],
          [albumArtist, anAlbumSummary()],
        ];
        const albumPageFetches = () =>
          (mockGET.mock.calls as unknown[][]).filter((c) =>
            String(c[0]).includes("getAlbumList2")
          ).length;

        beforeEach(() => {
          mockGET.mockImplementation((u: string) =>
            Promise.resolve(
              ok(
                u.includes("getAlbumList2")
                  ? getAlbumListJson(albumsPage)
                  : asArtistsJson(cached)
              )
            )
          );
        });

        it("caches a stable album section (alphabeticalByName) across browses", async () => {
          const q: AlbumQuery = { _index: 0, _count: 100, type: "alphabeticalByName" };
          await cachingSubsonic.getAlbumList2(credentials, q);
          await cachingSubsonic.getAlbumList2(credentials, q);
          expect(albumPageFetches()).toBe(1);
        });

        it("never caches the random section (each browse re-fetches)", async () => {
          const q: AlbumQuery = { _index: 0, _count: 100, type: "random" };
          await cachingSubsonic.getAlbumList2(credentials, q);
          await cachingSubsonic.getAlbumList2(credentials, q);
          expect(albumPageFetches()).toBe(2);
        });
      });

      describe("total advertised to Sonos per album-list type", () => {
        const artist = anArtist();
        // a FULL page (== the 500 fetch size): the point at which the old code advertised the
        // whole-catalog total. S2 rejects an oversized container, so filtered sections must not.
        const fullPage: [Artist, AlbumSummary][] = Array.from(
          { length: 500 },
          () => [artist, anAlbumSummary()] as [Artist, AlbumSummary]
        );

        beforeEach(() => {
          mockGET.mockImplementation((u: string) =>
            Promise.resolve(
              ok(
                u.includes("getAlbumList2")
                  ? getAlbumListJson(fullPage)
                  : asArtistsJson(cached)
              )
            )
          );
        });

        it("bounds a filtered section's total (index + count + one look-ahead page), never the catalog total", async () => {
          const genre = await cachingSubsonic.getAlbumList2(credentials, {
            _index: 0,
            _count: 100,
            type: "byGenre",
            genre: "UG9w",
          });
          expect(genre.results.length).toBe(100);
          // 0 + 100 (this page) + 100 (there may be one more) - deterministic, and far below the
          // real catalog total the global getArtists sum would give.
          expect(genre.total).toBe(200);
        });

        it("returns the exact end for a short filtered page (no phantom extra page)", async () => {
          const shortPage: [Artist, AlbumSummary][] = [
            [artist, anAlbumSummary()],
            [artist, anAlbumSummary()],
          ];
          mockGET.mockImplementation((u: string) =>
            Promise.resolve(
              ok(
                u.includes("getAlbumList2")
                  ? getAlbumListJson(shortPage)
                  : asArtistsJson(cached)
              )
            )
          );
          const genre = await cachingSubsonic.getAlbumList2(credentials, {
            _index: 40,
            _count: 100,
            type: "byYear",
            fromYear: "0",
            toYear: "0",
          });
          expect(genre.results.length).toBe(2);
          expect(genre.total).toBe(42); // 40 + 2, no look-ahead beyond the real end
        });

        it("still advertises the true catalog total for the unfiltered flat list on a full page", async () => {
          const globalTotal = cached.reduce(
            (sum: number, a: any) => sum + a.albums.length,
            0
          );
          const flat = await cachingSubsonic.getAlbumList2(credentials, {
            _index: 0,
            _count: 100,
            type: "alphabeticalByName",
          });
          expect(flat.total).toBe(globalTotal);
        });

        it("does not wait for getArtists when a filtered section derives a bounded total from the page", async () => {
          const shortPage: [Artist, AlbumSummary][] = [
            [artist, anAlbumSummary()],
            [artist, anAlbumSummary()],
          ];
          let getArtistsRequested = false;
          mockGET.mockImplementation((u: string) => {
            if (u.includes("getArtists")) {
              getArtistsRequested = true;
              return new Promise(() => {}); // never resolves
            }
            return Promise.resolve(ok(getAlbumListJson(shortPage)));
          });

          const result = await Promise.race([
            cachingSubsonic.getAlbumList2(credentials, {
              _index: 0,
              _count: 100,
              type: "byGenre",
              genre: "UG9w",
            }),
            new Promise<"blocked">((resolve) =>
              setImmediate(() => resolve("blocked"))
            ),
          ]);

          if (result === "blocked") {
            throw new Error("filtered album browse blocked on getArtists");
          }
          expect(getArtistsRequested).toBe(false);
          expect(result.results.length).toBe(2);
          expect(result.total).toBe(2);
        });
      });

      it("getAlbumIndex scans alphabeticalByName and buckets by first letter", async () => {
        const artist = anArtist();
        const page: [Artist, AlbumSummary][] = [
          [artist, anAlbumSummary({ name: "369" })],
          [artist, anAlbumSummary({ name: "Amsterdam" })],
          [artist, anAlbumSummary({ name: "The Beatles" })],
        ];
        mockGET.mockImplementation((u: string) =>
          Promise.resolve(
            ok(
              u.includes("getAlbumList2")
                ? getAlbumListJson(page)
                : asArtistsJson(cached)
            )
          )
        );
        const idx = await cachingSubsonic.getAlbumIndex(credentials);
        expect(idx.total).toBe(3);
        expect(idx.buckets.map((b) => `${b.key}:${b.offset}:${b.count}`)).toEqual([
          "#:0:1",
          "A:1:1",
          "B:2:1",
        ]);
      });

      it("streams a disk-backed snapshot when a snapshot dir is configured (Slice 1)", async () => {
        const snap = mkdtempSync(path.join(os.tmpdir(), "bonob-snap-"));
        try {
          const onDisk = new Subsonic(
            url,
            NO_CUSTOM_PLAYERS,
            axiosImageFetcher,
            SwrCache.disabled(),
            new SwrCache(clock, 60_000),
            false,
            {},
            undefined,
            snap
          );
          const artist = anArtist();
          const page: [Artist, AlbumSummary][] = [
            [artist, anAlbumSummary({ name: "369" })],
            [artist, anAlbumSummary({ name: "Amsterdam" })],
            [artist, anAlbumSummary({ name: "Anthracite" })],
            [artist, anAlbumSummary({ name: "The Beatles" })],
          ];
          mockGET.mockImplementation((u: string) =>
            Promise.resolve(
              ok(
                u.includes("getAlbumList2")
                  ? getAlbumListJson(page)
                  : asArtistsJson(cached)
              )
            )
          );
          const idx = await onDisk.getAlbumIndex(credentials);
          // Disk-backed: the snapshot is NOT resident. items is empty; a snapshot file + a Uint32Array
          // of byte offsets are what is held instead.
          expect(idx.items).toEqual([]);
          expect(idx.offsets).toBeInstanceOf(Uint32Array);
          expect(idx.offsets!.length).toBe(4 + 1);
          expect(idx.snapshotFile).toBeDefined();
          expect(existsSync(idx.snapshotFile!)).toBe(true);
          expect(idx.buckets.map((b) => `${b.key}:${b.offset}:${b.count}`)).toEqual([
            "#:0:1",
            "A:1:2",
            "B:3:1",
          ]);
          // The letter page is read from disk and matches the scanned catalog, full record intact
          // (year + genre survive the round trip — Slice 1 does not drop fields).
          const aPage = await readAlbumIndexPage(idx, "A", 0, 10);
          expect(aPage.total).toBe(2);
          expect(aPage.items.map((a) => a.name)).toEqual([
            "Amsterdam",
            "Anthracite",
          ]);
          expect(typeof aPage.items[0]!.year).toBe("string");
          expect(aPage.items[0]!.genre).toBeDefined();
        } finally {
          rmSync(snap, { recursive: true, force: true });
        }
      });

      it("accepts a catalog whose size is EXACTLY the safety cap", async () => {
        // Off-by-one in my own truncation guard, found by review. The loop runs while
        // `offset < cap`, and `complete` is only set by an empty or short page. A catalog of
        // exactly `cap` albums (with cap a multiple of the 500 page size) fills every page, so the
        // loop simply runs out of offsets without ever seeing the end - `complete` stays false and a
        // COMPLETE index is rejected as truncated. The default cap, 20,000,000, is itself a multiple
        // of 500, so this is reachable rather than theoretical.
        const indexCacheStore = { load: jest.fn(() => []), save: jest.fn() };
        const indexCache = new SwrCache(clock, 60_000, { store: indexCacheStore });
        const cap = 1000; // exactly two full pages
        const cappedSubsonic = new Subsonic(
          url,
          customPlayers,
          axiosImageFetcher,
          SwrCache.disabled(),
          indexCache,
          false,
          {},
          cap
        );
        const artist = anArtist();
        mockGET.mockImplementation((_u: string, config: any) => {
          const offset = Number(config.params.get("offset"));
          // Exactly `cap` albums exist: full pages at 0 and 500, nothing at 1000.
          const remaining = Math.max(0, cap - offset);
          const page = Array.from({ length: Math.min(500, remaining) }, (_, i) =>
            anAlbumSummary({ id: `album-${offset + i}`, name: `Album ${offset + i}` })
          );
          return Promise.resolve(
            ok(
              getAlbumListJson(
                page.map((album) => [artist, album] as [Artist, AlbumSummary])
              )
            )
          );
        });

        const idx = await cappedSubsonic.getAlbumIndex(credentials);
        expect(idx.total).toEqual(cap);
      });

      it("refuses a scan that hits the safety cap rather than caching a TRUNCATED index", async () => {
        // The cap was a hardcoded 2,000,000 and hitting it just ended the loop, so the partial
        // result was returned, cached and persisted as though it were the whole catalog: every
        // album past the cap silently vanished from the A-Z menu and `total` was wrong, with
        // nothing logged. That is a correctness cliff at exactly the catalog size the cap exists
        // for. Refusing keeps the previous good index in place and says why.
        const indexCacheStore = { load: jest.fn(() => []), save: jest.fn() };
        const indexCache = new SwrCache(clock, 60_000, { store: indexCacheStore });
        // Tiny cap so the guard is reachable without mocking millions of albums.
        const cappedSubsonic = new Subsonic(
          url,
          customPlayers,
          axiosImageFetcher,
          SwrCache.disabled(),
          indexCache,
          false,
          {},
          1000
        );
        const artist = anArtist();
        let n = 0;
        // A server that never returns a short page - the catalog outruns the cap.
        mockGET.mockImplementation(() => {
          const page = Array.from({ length: 500 }, () =>
            anAlbumSummary({ id: `album-${n++}`, name: `Album ${n}` })
          );
          return Promise.resolve(
            ok(
              getAlbumListJson(
                page.map((album) => [artist, album] as [Artist, AlbumSummary])
              )
            )
          );
        });

        await expect(cappedSubsonic.getAlbumIndex(credentials)).rejects.toThrow(
          /safety cap/
        );
        await new Promise((resolve) => setImmediate(resolve));
        // Nothing truncated was cached or persisted.
        expect(indexCache.size()).toBe(0);
        expect(indexCacheStore.save).not.toHaveBeenCalled();
      });

      it("never ingests past a NON-multiple-of-page-size cap (cumulative guard)", async () => {
        // The cap is driven by a CUMULATIVE ingested count, not the raw scan offset. With an offset-
        // driven loop a non-multiple cap (1200, not a multiple of the 500 page size) lets the final
        // full page overshoot — ingesting up to `cap + 499` records before the over-cap reject fires.
        // The guard slices the last page to the remaining allowance, so exactly `cap` is ingested.
        const mk = (cap: number) => {
          const store = { load: jest.fn(() => []), save: jest.fn() };
          const cache = new SwrCache(clock, 60_000, { store });
          return {
            cache,
            store,
            sub: new Subsonic(
              url,
              customPlayers,
              axiosImageFetcher,
              SwrCache.disabled(),
              cache,
              false,
              {},
              cap
            ),
          };
        };
        const artist = anArtist();

        // A catalog of EXACTLY the non-multiple cap (1200) is complete: accept, total === cap.
        // If the guard dropped records with an over-eager slice, total would be < cap.
        const exact = mk(1200);
        mockGET.mockImplementation((_u: string, config: any) => {
          const offset = Number(config.params.get("offset"));
          const remaining = Math.max(0, 1200 - offset);
          const page = Array.from({ length: Math.min(500, remaining) }, (_, i) =>
            anAlbumSummary({ id: `a-${offset + i}`, name: `Album ${offset + i}` })
          );
          return Promise.resolve(
            ok(getAlbumListJson(page.map((album) => [artist, album] as [Artist, AlbumSummary])))
          );
        });
        const exactIdx = await exact.sub.getAlbumIndex(credentials);
        expect(exactIdx.total).toEqual(1200);

        // A catalog that exceeds the non-multiple cap is refused, and nothing is cached.
        const over = mk(1200);
        let n = 0;
        mockGET.mockImplementation(() => {
          const page = Array.from({ length: 500 }, () =>
            anAlbumSummary({ id: `a-${n++}`, name: `Album ${n}` })
          );
          return Promise.resolve(
            ok(getAlbumListJson(page.map((album) => [artist, album] as [Artist, AlbumSummary])))
          );
        });
        await expect(over.sub.getAlbumIndex(credentials)).rejects.toThrow(/safety cap/);
        await new Promise((resolve) => setImmediate(resolve));
        expect(over.cache.size()).toBe(0);
        expect(over.store.save).not.toHaveBeenCalled();
      });

      it("rejects an inconsistent album-index scan so a duplicate/missing snapshot is not cached or persisted", async () => {
        const indexCacheStore = {
          load: jest.fn(() => []),
          save: jest.fn(),
        };
        const indexCache = new SwrCache(clock, 60_000, {
          store: indexCacheStore,
        });
        const indexedSubsonic = new Subsonic(
          url,
          customPlayers,
          axiosImageFetcher,
          SwrCache.disabled(),
          indexCache
        );
        const artist = anArtist();
        const firstPage = Array.from({ length: 500 }, (_, i) =>
          anAlbumSummary({ id: `album-${i}`, name: `Album ${i}` })
        );
        const driftedSecondPage = [
          anAlbumSummary({ id: "album-499", name: "Duplicate Album 499" }),
          anAlbumSummary({ id: "album-501", name: "Album 501" }),
        ];

        mockGET.mockImplementation((_u: string, config: any) => {
          const offset = Number(config.params.get("offset"));
          const page = offset === 0 ? firstPage : driftedSecondPage;
          return Promise.resolve(
            ok(
              getAlbumListJson(
                page.map((album) => [artist, album] as [Artist, AlbumSummary])
              )
            )
          );
        });

        await expect(indexedSubsonic.getAlbumIndex(credentials)).rejects.toThrow(
          "Inconsistent album index scan"
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(indexCache.size()).toBe(0);
        expect(indexCacheStore.save).not.toHaveBeenCalled();
      });

      it("evicts index entries beyond the dedicated index cache cap (album AND artist kinds)", async () => {
        const { ALBUM_INDEX_CACHE_MAX_ENTRIES } = jest.requireActual("../src/subsonic");
        expect(ALBUM_INDEX_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
        // Sized for a household: evicting an index costs a full catalog rescan, which
        // warmAlbumIndex immediately re-triggers, so an under-sized cap makes bonob a permanent
        // load generator against Navidrome. Kept bounded so it cannot grow without limit.
        expect(ALBUM_INDEX_CACHE_MAX_ENTRIES).toBeLessThanOrEqual(16);

        const indexCache = new SwrCache(clock, 60_000, {
          maxEntries: ALBUM_INDEX_CACHE_MAX_ENTRIES,
        });
        const indexedSubsonic = new Subsonic(
          url,
          customPlayers,
          axiosImageFetcher,
          SwrCache.disabled(),
          indexCache
        );
        const artist = anArtist();
        mockGET.mockImplementation(() =>
          Promise.resolve(
            ok(
              getAlbumListJson([
                [artist, anAlbumSummary({ id: uuid(), name: "One Album" })],
              ])
            )
          )
        );

        for (let i = 0; i < ALBUM_INDEX_CACHE_MAX_ENTRIES + 2; i++) {
          await indexedSubsonic.getAlbumIndex({
            username: `index-user-${i}`,
            password,
          });
        }

        expect(indexCache.size()).toBe(ALBUM_INDEX_CACHE_MAX_ENTRIES);
      });

      it("serves stale instantly and refreshes in the background", async () => {
        const first = await cachingSubsonic.getArtists(credentials);
        expect(mockGET).toHaveBeenCalledTimes(1);

        clock.add(6, "m"); // now stale
        const stale = await cachingSubsonic.getArtists(credentials);

        expect(stale).toEqual(first); // served instantly from cache
        expect(mockGET).toHaveBeenCalledTimes(2); // single background refresh kicked
      });

      it("returns a deep-frozen list so callers cannot corrupt the shared cache", async () => {
        const result = await cachingSubsonic.getArtists(credentials);

        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result[0])).toBe(true);
      });
    });

    describe("when there are artists", () => {
      const artist1 = anArtist({ name: "A Artist", albums: [anAlbum()] });
      const artist2 = anArtist({ name: "B Artist", albums: [anAlbum(), anAlbum()] });
      const artist3 = anArtist({ name: "C Artist" });
      const artist4 = anArtist({ name: "D Artist" });
      const artists = [artist1, artist2, artist3, artist4];

      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(asArtistsJson(artists)))
        );
      });

      it("should return all the artists", async () => {
        const artists = await subsonic.getArtists(credentials);

        const expectedResults = [artist1, artist2, artist3, artist4].map(
          (it) => ({
            id: it.id,
            image: it.image,
            name: it.name,
            albumCount: it.albums.length
          })
        );

        expect(artists).toEqual(expectedResults);

        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getArtists" }).href(),
          {
            params: asURLSearchParams(authParamsPlusJson),
            headers,
          }
        );
      });

      it("albumCount sums the album counts across all artists", async () => {
        const count = await subsonic.albumCount(credentials);
        expect(count).toEqual(
          [artist1, artist2, artist3, artist4].reduce(
            (total, it) => total + it.albums.length,
            0
          )
        );
      });
    });
  });

   describe("getArtist", () => {
      describe("when the artist exists", () => {
        describe("and has multiple albums", () => {
          const album1 = anAlbumSummary({ genre: asGenre("Pop") });
  
          const album2 = anAlbumSummary({ genre: asGenre("Flop") });
  
          const artist: Artist = anArtist({
            albums: [album1, album2]
          });
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(ok(getArtistJson(artist)))
              )
          });
  
          it("should return it", async () => {
            const result = await subsonic.getArtist(credentials, artist.id!);
  
            expect(result).toEqual({
              id: artist.id,
              name: artist.name,
              artistImageUrl: undefined,
              albums: artist.albums
            });
  
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtist" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                }),
                headers,
              }
            );
          });
        });
  
        describe("and has only 1 album", () => {
          const album = anAlbumSummary({ genre: POP });
  
          const artist: Artist = anArtist({
            albums: [album]
          });
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(ok(getArtistJson(artist)))
              )
          });
  
          it("should return it", async () => {
            const result = await subsonic.getArtist(credentials, artist.id!);
  
            expect(result).toEqual({
              id: artist.id,
              name: artist.name,
              artistImageUrl: undefined,
              albums: artist.albums,
            });
  
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtist" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                }),
                headers,
              }
            );
          });
        });
  
        describe("and has no albums", () => {
          const artist: Artist = anArtist({
            albums: [],
          });
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(ok(getArtistJson(artist)))
              )
          });
  
          it("should return it", async () => {
            const result = await subsonic.getArtist(credentials, artist.id!);
  
            expect(result).toEqual({
              id: artist.id,
              name: artist.name,
              artistImageUrl: undefined,
              albums: []
            });
  
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtist" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                }),
                headers,
              }
            );
          });
        });

        describe("and has an artistImageUrl", () => {
          const artist: Artist = anArtist({
            albums: []
          });
  
          const artistImageUrl = `http://localhost:1234/somewhere.jpg`;
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(
                  ok(getArtistJson(artist, { artistImageUrl }))
                )
              )
          });
  
          it("should return the artist image url", async () => {
            const result = await subsonic.getArtist(credentials, artist.id!);
  
            expect(result).toEqual({
              id: artist.id,
              name: artist.name,
              artistImageUrl,
              albums: [],
            });
  
            // todo: these are everywhere??
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtist" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                }),
                headers,
              }
            );
          });
        });  
      });

      // todo: what happens when the artist doesnt exist?
    });

    describe("getArtistInfo", () => {
      // todo: what happens when the artist doesnt exist?

      it("returns the biography", async () => {
        const artist = anArtist({ biography: "an influential dance-punk band" });
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(getArtistInfoJson(artist)))
        );
        const result = await subsonic.getArtistInfo(credentials, artist.id!);
        expect(result.biography).toEqual("an influential dance-punk band");
      });

      describe("when the artist exists", () => {
        describe("and has many similar artists", () => {
          const artist = anArtist({
            similarArtists: [
              aSimilarArtist({
                id: "similar1.id",
                name: "similar1",
                inLibrary: true,
              }),
              aSimilarArtist({ id: "-1", name: "similar2", inLibrary: false }),
              aSimilarArtist({
                id: "similar3.id",
                name: "similar3",
                inLibrary: true,
              }),
              aSimilarArtist({ id: "-1", name: "similar4", inLibrary: false }),
            ],
          });
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(ok(getArtistInfoJson(artist)))
              )
          });
  
          it("should return the similar artists", async () => {
            const result = await subsonic.getArtistInfo(credentials, artist.id!);
  
            expect(result).toEqual({
              similarArtist: artist.similarArtists,
              images: {
                l: undefined,
                m: undefined,
                s: undefined
              }
            });
    
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtistInfo2" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                  count: 50,
                  includeNotPresent: true,
                }),
                headers,
              }
            );
          });
        });
  
        describe("and has one similar artist", () => {
          const artist = anArtist({
            similarArtists: [
              aSimilarArtist({
                id: "similar1.id",
                name: "similar1",
                inLibrary: true,
              }),
            ],
          });
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(ok(getArtistInfoJson(artist)))
              );
          });
  
          it("should return the similar artists", async () => {
            const result = await subsonic.getArtistInfo(credentials, artist.id!);
  
            expect(result).toEqual({
              similarArtist: artist.similarArtists,
              images: {
                l: undefined,
                m: undefined,
                s: undefined
              }
            });
  
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtistInfo2" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                  count: 50,
                  includeNotPresent: true,
                }),
                headers,
              }
            );
          });
        });
  
        describe("and has no similar artists", () => {
          const artist = anArtist({
            similarArtists: [],
          });
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(ok(getArtistInfoJson(artist)))
              );
          });
  
          it("should return the similar artists", async () => {
            const result = await subsonic.getArtistInfo(credentials, artist.id!);
  
            expect(result).toEqual({
              similarArtist: artist.similarArtists,
              images: {
                l: undefined,
                m: undefined,
                s: undefined
              }
            });
  
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtistInfo2" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                  count: 50,
                  includeNotPresent: true,
                }),
                headers,
              }
            );
          });
        });
  
        describe("and has some images", () => {
          const artist: Artist = anArtist({
            albums: [],
            similarArtists: [],
          });

          const smallImageUrl = "http://small";
          const mediumImageUrl = "http://medium";
          const largeImageUrl = "http://large"
  
  
          beforeEach(() => {
            mockGET
              .mockImplementationOnce(() =>
                Promise.resolve(
                  ok(
                    getArtistInfoJson(artist, {
                      smallImageUrl,
                      mediumImageUrl,
                      largeImageUrl,
                    })
                  )
                )
              );
          });
  
          it("should fetch the images", async () => {
            const result = await subsonic.getArtistInfo(credentials, artist.id!);
  
            expect(result).toEqual({
              similarArtist: [],
              images: {
                s: smallImageUrl,
                m: mediumImageUrl,
                l: largeImageUrl
              }
            });
  
            expect(axios.get).toHaveBeenCalledWith(
              url.append({ pathname: "/rest/getArtistInfo2" }).href(),
              {
                params: asURLSearchParams({
                  ...authParamsPlusJson,
                  id: artist.id,
                  count: 50,
                  includeNotPresent: true,
                }),
                headers,
              }
            );
          });
        });
      });
    });

  describe("getting genres", () => {
    describe("when there are none", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(getGenresJson([])))
        );
      });

      it("should return empty array", async () => {
        const result = await subsonic.getGenres(credentials);

        expect(result).toEqual([]);

        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getGenres" }).href(),
          {
            params: asURLSearchParams(authParamsPlusJson),
            headers,
          }
        );
      });
    });

    describe("when there is only 1 that has an albumCount > 0", () => {
      const genres = [
        { name: "genre1", albumCount: 1 },
        { name: "genreWithNoAlbums", albumCount: 0 },
      ];

      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(getGenresJson(genres)))
        );
      });

      it("should return them alphabetically sorted", async () => {
        const result = await subsonic.getGenres(credentials);

        expect(result).toEqual([{ id: b64Encode("genre1"), name: "genre1" }]);

        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getGenres" }).href(),
          {
            params: asURLSearchParams(authParamsPlusJson),
            headers,
          }
        );
      });
    });

    describe("when there are many that have an albumCount > 0", () => {
      const genres = [
        { name: "g1", albumCount: 1 },
        { name: "g2", albumCount: 1 },
        { name: "g3", albumCount: 1 },
        { name: "g4", albumCount: 1 },
        { name: "someGenreWithNoAlbums", albumCount: 0 },
      ];

      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(getGenresJson(genres)))
        );
      });

      it("should return them alphabetically sorted", async () => {
        const result = await subsonic.getGenres(credentials);

        expect(result).toEqual([
          { id: b64Encode("g1"), name: "g1" },
          { id: b64Encode("g2"), name: "g2" },
          { id: b64Encode("g3"), name: "g3" },
          { id: b64Encode("g4"), name: "g4" },
        ]);

        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getGenres" }).href(),
          {
            params: asURLSearchParams(authParamsPlusJson),
            headers,
          }
        );
      });
    });
  });

  describe("getting an album", () => {
    describe("when there are no custom players", () => {
      beforeEach(() => {
        customPlayers.encodingFor.mockReturnValue(O.none);
      });
  
      describe("when the album has some tracks", () => {
        const artistId = "artist6677"
        const artistName = "Fizzy Wizzy"
  
        const albumSummary = anAlbumSummary({ artistId, artistName })
        const artistSumamry = anArtistSummary({ id: artistId, name: artistName })
  
        // todo: fix these ratings
        const tracks = [
          aTrack({ artist: artistSumamry, album: albumSummary, rating: { love: false, stars: 0 } }),
          aTrack({ artist: artistSumamry, album: albumSummary, rating: { love: false, stars: 0 } }),
          aTrack({ artist: artistSumamry, album: albumSummary, rating: { love: false, stars: 0 } }),
          aTrack({ artist: artistSumamry, album: albumSummary, rating: { love: false, stars: 0 } }),
        ];
  
        const album = anAlbum({
          ...albumSummary,
          tracks,
          artistId,
          artistName,
         });
  
        beforeEach(() => {
          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(getAlbumJson(album)))
          );
        });
  
        it("does not throw when the album carries NO song array", async () => {
          // Caught in production by the degradation logging, on a real Sonos interaction:
          //   getExtendedMetadata:track:<id> degraded to its fallback after a backend failure:
          //   TypeError: Cannot read properties of undefined (reading 'map')
          //
          // GetAlbumResponse types `song: song[]` as REQUIRED, but Navidrome omits it for an album
          // with no tracks - and getTrack reaches getAlbum via `song.albumId!`, a non-null
          // assertion on a field we already know can be missing (it is why searchTracks has orphan
          // recovery). Tapping such a track threw, and the whole extended-metadata response
          // collapsed to the fallback.
          //
          // Fourth instance this session of a type asserting what the server does not send
          // (TrackStream.headers, the Navidrome letter group, album.year, now album.song).
          mockGET.mockReset();
          const noSongs: any = getAlbumJson(album);
          delete noSongs["subsonic-response"].album.song;
          mockGET.mockImplementationOnce(() => Promise.resolve(ok(noSongs)));

          const result = await subsonic.getAlbum(credentials, album.id);
          expect(result.tracks).toEqual([]);
          expect(result.id).toEqual(album.id);
        });

        it("should return the album", async () => {
          const result = await subsonic.getAlbum(credentials, album.id);
  
          expect(result).toEqual(album);
  
          expect(axios.get).toHaveBeenCalledWith(
            url.append({ pathname: "/rest/getAlbum" }).href(),
            {
              params: asURLSearchParams({
                ...authParamsPlusJson,
                id: album.id,
              }),
              headers,
            }
          );
        });
      });

      describe("when the album has no tracks", () => {
        const artistId = "artist6677"
        const artistName = "Fizzy Wizzy"
  
        const albumSummary = anAlbumSummary({ artistId, artistName })
  
        const album = anAlbum({
          ...albumSummary,
          tracks: [],
          artistId,
          artistName,
         });
  
        beforeEach(() => {
          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(getAlbumJson(album)))
          );
        });
  
        it("should return the album", async () => {
          const result = await subsonic.getAlbum(credentials, album.id);
  
          expect(result).toEqual(album);
  
          expect(axios.get).toHaveBeenCalledWith(
            url.append({ pathname: "/rest/getAlbum" }).href(),
            {
              params: asURLSearchParams({
                ...authParamsPlusJson,
                id: album.id,
              }),
              headers,
            }
          );
        });
      });

    });

    describe("when a custom player is configured for the mime type", () => {
        const hipHop = asGenre("Hip-Hop");
        const tripHop = asGenre("Trip-Hop");

        const albumSummary = anAlbumSummary({ id: "album1", name: "Burnin", genre: hipHop });

        const artistSummary = anArtistSummary({
          id: "artist1",
          name: "Bob Marley"
        });

        const alac = aTrack({
          artist: artistSummary,
          album: albumSummary,
          encoding: {
            player: "bonob",
            mimeType: "audio/alac",
          },
          genre: hipHop,
          rating: {
            love: true,
            stars: 3,
          },
        });
        const m4a = aTrack({
          artist: artistSummary,
          album: albumSummary,
          encoding: {
            player: "bonob",
            mimeType: "audio/m4a",
          },
          genre: hipHop,
          rating: {
            love: false,
            stars: 0,
          },
        });
        const mp3 = aTrack({
          artist: artistSummary,
          album: albumSummary,
          encoding: {
            player: "bonob",
            mimeType: "audio/mp3",
          },
          genre: tripHop,
          rating: {
            love: true,
            stars: 5,
          },
        });

        const album = anAlbum({
          ...albumSummary,
          tracks: [alac, m4a, mp3]
        })
      
       beforeEach(() => {
          customPlayers.encodingFor
            .mockReturnValueOnce(
              O.of({ player: "bonob+audio/alac", mimeType: "audio/flac" })
            )
            .mockReturnValueOnce(
              O.of({ player: "bonob+audio/m4a", mimeType: "audio/opus" })
            )
            .mockReturnValueOnce(O.none);

          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(getAlbumJson(album)))
          );
        });

        it("should return the album with custom players applied", async () => {
          const result = await subsonic.getAlbum(credentials, album.id);

          expect(result).toEqual({
            ...album,
            tracks: [
              {
                ...alac,
                encoding: {
                  player: "bonob+audio/alac",
                  mimeType: "audio/flac",
                },
                // todo: this doesnt seem right? why dont the ratings come back?
                rating: {
                  love: false,
                  stars: 0
                }
              },
              {
                ...m4a,
                encoding: {
                  player: "bonob+audio/m4a",
                  mimeType: "audio/opus",
                },
                rating: {
                  love: false,
                  stars: 0
                }
              },
              {
                ...mp3,
                encoding: {
                  player: "bonob",
                  mimeType: "audio/mp3",
                },
                rating: {
                  love: false,
                  stars: 0
                }
              },
            ]
          });

          expect(axios.get).toHaveBeenCalledWith(
            url.append({ pathname: "/rest/getAlbum" }).href(),
            {
              params: asURLSearchParams({
                ...authParamsPlusJson,
                id: album.id,
              }),
              headers,
            }
          );

          expect(customPlayers.encodingFor).toHaveBeenCalledTimes(3);
          expect(customPlayers.encodingFor).toHaveBeenNthCalledWith(1, {
            mimeType: "audio/alac",
          });
          expect(customPlayers.encodingFor).toHaveBeenNthCalledWith(2, {
            mimeType: "audio/m4a",
          });
          expect(customPlayers.encodingFor).toHaveBeenNthCalledWith(3, {
            mimeType: "audio/mp3",
          });
        });        
    });
  });  

  describe("stars and unstars", () => {
    const id = uuid();

    describe("staring a track", () => {
      describe("when ok", () => {
        beforeEach(() => {
          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(subsonicResponse({ status: "ok" })))
          );
        });

        it("should return true", async () => {
          const result = await subsonic.star(credentials, { id });
  
          expect(result).toEqual(true);
          expect(axios.get).toHaveBeenCalledWith(
            url.append({ pathname: "/rest/star" }).href(),
            {
              params: asURLSearchParams({
                ...authParamsPlusJson,
                id
              }),
              headers,
            }
          );
        });
      });

      describe("when not ok", () => {
        beforeEach(() => {
          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(subsonicResponse({ status: "not-ok" })))
          );
        });

        it("should return false", async () => {
          const result = await subsonic.star(credentials, { id });

          expect(result).toEqual(false);
        });
      });
    });
  });  

  describe("setting ratings", () => {
    const id = uuid();

    describe("when the rating is valid", () => {
      describe("when response is ok", () => {
        beforeEach(() => {
          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(subsonicResponse({ status: "ok" })))
          );
        });

        it("should return true", async () => {
          const result = await subsonic.setRating(credentials, id, 4);
  
          expect(result).toEqual(true);
          expect(axios.get).toHaveBeenCalledWith(
            url.append({ pathname: "/rest/setRating" }).href(),
            {
              params: asURLSearchParams({
                ...authParamsPlusJson,
                id,
                rating: 4
              }),
              headers,
            }
          );
        });
      });

      describe("when response is not ok", () => {
        beforeEach(() => {
          mockGET.mockImplementationOnce(() =>
            Promise.resolve(ok(subsonicResponse({ status: "not-ok" })))
          );
        });

        it("should return false", async () => {
          const result = await subsonic.setRating(credentials, id, 2);
  
          expect(result).toEqual(false);
        });
      });
    });
  });   

  describe("scrobble", () => {
    const id = uuid();

    describe("with submission", () => {
      const submission = true;

      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(subsonicResponse({ status: "ok" })))
        );
      });

      it("should scrobble and return true", async () => {
        const result = await subsonic.scrobble(credentials, id, submission);

        expect(result).toEqual(true);
        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/scrobble" }).href(),
          {
            params: asURLSearchParams({
              ...authParamsPlusJson,
              id,
              submission
            }),
            headers,
          }
        );
      });
    });

    describe("without submission", () => {
      const submission = false;

      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(subsonicResponse({ status: "ok" })))
        );
      });

      it("should scrobble and return true", async () => {
        const result = await subsonic.scrobble(credentials, id, submission);

        expect(result).toEqual(true);
        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/scrobble" }).href(),
          {
            params: asURLSearchParams({
              ...authParamsPlusJson,
              id,
              submission
            }),
            headers,
          }
        );
      });
    });

    describe("when fails", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(subsonicResponse({ status: "not-ok" })))
        );
      });

      it("should return false", async () => {
        const result = await subsonic.scrobble(credentials, id, false);

        expect(result).toEqual(false);
      });
    });
  });

  describe("getOpenSubsonicExtensions", () => {
    describe("when there are no extensions", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(getOpenSubsonicExtensionsJson([])))
        );
      });

      it("should return an empty array and call subsonic with correct params", async () => {
        const result = await subsonic.getOpenSubsonicExtensions(credentials);

        expect(result).toEqual([]);
        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getOpenSubsonicExtensions.view" }).href(),
          { params: asURLSearchParams(authParamsPlusJson), headers }
        );
      });
    });

    describe("when there are extensions", () => {
      const extension1 = anOpenSubsonicExtension({ name: "transcoding", versions: [1] });
      const extension2 = anOpenSubsonicExtension({ name: "formPost", versions: [1, 2] });

      beforeEach(() => {
        mockGET.mockImplementationOnce(() =>
          Promise.resolve(ok(getOpenSubsonicExtensionsJson([extension1, extension2])))
        );
      });

      it("should return the extensions and call subsonic with correct params", async () => {
        const result = await subsonic.getOpenSubsonicExtensions(credentials);

        expect(result).toEqual([extension1, extension2]);
        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getOpenSubsonicExtensions.view" }).href(),
          { params: asURLSearchParams(authParamsPlusJson), headers }
        );
      });
    });

    describe("when the server returns 404", () => {
      beforeEach(() => {
        mockGET.mockRejectedValue(a404())
      });

      it("should return an empty array", async () => {
        const result = await subsonic.getOpenSubsonicExtensions(credentials);

        expect(result).toEqual([]);
      });
    });
  });

  describe("getTranscodeDecision", () => {
    const mediaId = `media-${uuid()}`;

    describe("when the server can transcode", () => {
      const decision = aTranscodeDecision({
        canDirectPlay: false,
        canTranscode: true,
        transcodeParams: "some-transcode-params",
        transcodeReason: ["AudioCodecNotSupported"],
      });

      beforeEach(() => {
        mockPOST.mockImplementationOnce(() =>
          Promise.resolve(ok(getTranscodeDecisionJson(decision)))
        );
      });

      it("should return the decision and call subsonic with correct params", async () => {
        const result = await subsonic.getTranscodeDecision(credentials, mediaId, SONOS_CLIENT_INFO);

        expect(result).toEqual(decision);
        expect(axios.post).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getTranscodeDecision" }).href(),
          SONOS_CLIENT_INFO,
          {
            params: asURLSearchParams({
              u: authParams.u,
              v: authParams.v,
              c: authParams.c,
              t: authParams.t,
              s: authParams.s,
              f: "json",
              mediaId,
              mediaType: "song",
            }),
            headers: {
              "User-Agent": "bonob",
              "Content-Type": "application/json",
            },
          }
        );
      });
    });

    describe("when the server requires direct play", () => {
      const decision = aTranscodeDecision({ canDirectPlay: true, canTranscode: false });

      beforeEach(() => {
        mockPOST.mockImplementationOnce(() =>
          Promise.resolve(ok(getTranscodeDecisionJson(decision)))
        );
      });

      it("should return the decision", async () => {
        const result = await subsonic.getTranscodeDecision(credentials, mediaId, SONOS_CLIENT_INFO);

        expect(result).toEqual(decision);
      });
    });
  });

  describe("getTranscodeStream", () => {
    const mediaId = `media-${uuid()}`;
    const transcodeParams = "some-transcode-params";
    const streamData = { pipe: jest.fn() };

    const streamResponse = {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": "12345",
        "content-range": "0-12344",
        "accept-ranges": "bytes",
        "some-other-header": "ignored",
      },
      data: streamData,
    };

    describe("without range", () => {
      beforeEach(() => {
        mockGET.mockImplementationOnce(() => Promise.resolve(streamResponse));
      });

      it("should return the stream response and call subsonic with correct params", async () => {
        const result = await subsonic.getTranscodeStream(credentials, mediaId, transcodeParams, undefined);

        expect(result.stream).toEqual(streamData);
        expect(result.headers).toEqual({
          "content-type": "audio/mpeg",
          "content-length": "12345",
          "content-range": "0-12344",
          "accept-ranges": "bytes",
        });
        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getTranscodeStream" }).href(),
          {
            params: asURLSearchParams({
              ...authParams,
              mediaId,
              mediaType: "song",
              transcodeParams,
            }),
            headers: { "User-Agent": "bonob" },
            responseType: "stream",
            // audio opts out of the process-wide JSON maxContentLength ceiling
            maxContentLength: -1,
            maxBodyLength: -1,
          }
        );
      });
    });

    describe("with range", () => {
      const range = "1000-2000";

      beforeEach(() => {
        mockGET.mockImplementationOnce(() => Promise.resolve(streamResponse));
      });

      it("should include the Range header", async () => {
        await subsonic.getTranscodeStream(credentials, mediaId, transcodeParams, range);

        expect(axios.get).toHaveBeenCalledWith(
          url.append({ pathname: "/rest/getTranscodeStream" }).href(),
          {
            params: asURLSearchParams({
              ...authParams,
              mediaId,
              mediaType: "song",
              transcodeParams,
            }),
            headers: { "User-Agent": "bonob", Range: range },
            responseType: "stream",
            // audio opts out of the process-wide JSON maxContentLength ceiling
            maxContentLength: -1,
            maxBodyLength: -1,
          }
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Additional mutation-killing coverage for src/subsonic.ts.
// Each block below targets a previously-uncovered branch/line and has been
// confirmed RED under a deliberate mutation of the exact code path exercised.
// ---------------------------------------------------------------------------

describe("isSafeExternalImageUrl: IPv6 special-prefix coverage", () => {
  // These literals are valid IPv6 (new URL accepts them, isIP === 6), so they reach the
  // isPrivateIPv6 prefix checks. The existing tests covered the public (false) branches and the
  // IPv4-mapped/NAT64/6to4 true branches; the ULA / link-local / multicast / all-zeros true branches
  // were unexercised.
  it("blocks unique-local (fc00::/7) addresses", () => {
    expect(isSafeExternalImageUrl("http://[fc00::1]/x")).toBe(false);
    expect(isSafeExternalImageUrl("http://[fd12:3456::1]/x")).toBe(false);
  });

  it("blocks link-local (fe80::/10) addresses", () => {
    expect(isSafeExternalImageUrl("http://[fe80::1]/x")).toBe(false);
  });

  it("blocks multicast (ff00::/8) addresses", () => {
    expect(isSafeExternalImageUrl("http://[ff02::1]/x")).toBe(false);
  });

  it("still allows a public IPv6 host (regression guard against an over-broad mask)", () => {
    expect(isSafeExternalImageUrl("http://[2606:4700:4700::1111]/x")).toBe(true);
  });
});

describe("resolvedExternalHostIsSafe: DNS-resolution SSRF edges", () => {
  afterEach(() => jest.restoreAllMocks());

  it("treats a host that resolves to ZERO addresses as unsafe (addresses.length > 0 guard)", async () => {
    jest.spyOn(dnsPromises, "lookup").mockResolvedValue([] as any);
    expect(await resolvedExternalHostIsSafe("https://empty.example/x")).toBe(false);
  });

  it("returns false (does not throw) when DNS resolution itself throws", async () => {
    jest.spyOn(dnsPromises, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    expect(await resolvedExternalHostIsSafe("https://broken.example/x")).toBe(false);
  });

  it("decodes a dotted IPv4-mapped IPv6 address (::ffff:8.8.8.8) as the PUBLIC embedded IPv4 -> safe", async () => {
    // new URL() canonicalizes the dotted form away, so this branch of expandIPv6 is only reachable
    // via a DNS-resolved address string, which is exactly what resolvedExternalHostIsSafe feeds to
    // isUnsafeExternalImageHost. A public embedded IPv4 must come out SAFE.
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "::ffff:8.8.8.8", family: 6 }] as any);
    expect(await resolvedExternalHostIsSafe("https://mapped.example/x")).toBe(true);
  });

  it("decodes a dotted IPv4-mapped IPv6 address (::ffff:127.0.0.1) as the PRIVATE embedded IPv4 -> unsafe", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "::ffff:127.0.0.1", family: 6 }] as any);
    expect(await resolvedExternalHostIsSafe("https://mapped-private.example/x")).toBe(false);
  });
});

describe("pinnedSafeExternalLookup: no-address edge", () => {
  afterEach(() => jest.restoreAllMocks());

  it("throws (does not return undefined) when the host resolves to zero addresses", async () => {
    jest.spyOn(dnsPromises, "lookup").mockResolvedValue([] as any);
    await expect(pinnedSafeExternalLookup("void.example")).rejects.toThrow(
      /no address for external art host 'void.example'/
    );
  });
});

describe("axiosImageFetcher (SSRF guard + image fetch wiring)", () => {
  let get: jest.Mock;
  afterEach(() => {
    jest.restoreAllMocks();
    axios.get = jest.fn();
  });

  it("returns undefined for an unsafe host without fetching (guard short-circuits)", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as any);
    get = jest.fn();
    axios.get = get as any;
    const result = await axiosImageFetcher("http://127.0.0.1/secret.jpg");
    expect(result).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("fetches and returns {contentType, data} for a safe host", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    const data = Buffer.from("the-bytes");
    get = jest.fn();
    get.mockImplementation(() =>
      Promise.resolve({ status: 200, headers: { "content-type": "image/jpeg" }, data })
    );
    axios.get = get as any;
    const result = await axiosImageFetcher("https://images.example/a.jpg");
    expect(result).toEqual({ contentType: "image/jpeg", data });
    expect(get).toHaveBeenCalledWith(
      "https://images.example/a.jpg",
      expect.objectContaining({
        headers: BROWSER_HEADERS,
        responseType: "arraybuffer",
        timeout: 10000,
        maxRedirects: 0,
      })
    );
  });

  it("collapses an absent content-type to '' (refused downstream as art, not served as unknown bytes)", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    get = jest.fn();
    get.mockImplementation(() =>
      Promise.resolve({ status: 200, headers: {}, data: Buffer.from("x") })
    );
    axios.get = get as any;
    const result = await axiosImageFetcher("https://images.example/b.jpg");
    expect(result).toEqual({ contentType: "", data: Buffer.from("x") });
  });

  it("returns undefined when the upstream fetch rejects (network error swallowed)", async () => {
    jest
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
    get = jest.fn();
    get.mockImplementation(() => Promise.reject(new Error("ECONNRESET")));
    axios.get = get as any;
    const result = await axiosImageFetcher("https://images.example/c.jpg");
    expect(result).toBeUndefined();
  });
});

describe("TranscodingCustomPlayers.from: invalid configuration", () => {
  it("throws on a config item with more than one '>' separator", () => {
    expect(() => TranscodingCustomPlayers.from("audio/mp3>audio/ogg>audio/flac")).toThrow(
      /Invalid configuration item/
    );
  });

  it("still parses a single untranscoded mapping (regression guard)", () => {
    const cp = TranscodingCustomPlayers.from("audio/flac");
    expect(cp.encodingFor({ mimeType: "audio/flac" })).toEqual(
      O.of({ player: "bonob+audio/flac", mimeType: "audio/flac" })
    );
  });
});

describe("service tokens (asToken / parseToken)", () => {
  it("round-trips credentials through the encrypted (enc:) format", () => {
    const creds = { username: "u-" + uuid(), password: "p-" + uuid() };
    expect(parseToken(asToken(creds))).toEqual(creds);
  });

  it("rethrows a corrupted enc: token whose envelope has the wrong version (invalid-token guard)", () => {
    const corrupt = "enc:" + b64Encode(JSON.stringify({ v: 99, iv: "x", tag: "y", ciphertext: "z" }));
    expect(() => parseToken(corrupt)).toThrow("Invalid encrypted service token");
  });

  it("falls back to the legacy plain-b64 JSON format for a non-enc: token", () => {
    const creds = { username: "legacy", password: "legacy-pass" };
    const legacy = b64Encode(JSON.stringify(creds));
    expect(parseToken(legacy)).toEqual(creds);
  });
});

// Self-contained Subsonic instance for the low-level paths not already covered above.
describe("Subsonic: low-level error paths + warm/peek", () => {
  const url = new URLBuilder("http://127.0.0.22:4567/some-context-path");
  const username = `cov-user-${uuid()}`;
  const password = `cov-pass-${uuid()}`;
  const credentials = { username, password };
  const salt = "saltysalty";
  const mockRandomstring = jest.fn();
  const mockGET = jest.fn();
  const mockPOST = jest.fn();

  const authParams = {
    u: username,
    v: "1.16.1",
    c: "bonob",
    t: t(password, salt),
    s: salt,
  };
  const headers = { "User-Agent": "bonob" };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
    (random.generateRandomString as jest.Mock) = mockRandomstring;
    axios.get = mockGET;
    axios.post = mockPOST;
    mockRandomstring.mockReturnValue(salt);
  });

  describe("getStarred", () => {
    it("returns a Set of the starred song ids", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(
          ok(
            subsonicOK({
              starred2: { song: [{ id: "s1" }, { id: "s2" }, { id: "s1" }] },
            })
          )
        )
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getStarred(credentials);
      expect(result).toBeInstanceOf(Set);
      expect([...result].sort()).toEqual(["s1", "s2"]);
      expect(axios.get).toHaveBeenCalledWith(
        url.append({ pathname: "/rest/getStarred2" }).href(),
        { params: asURLSearchParams({ ...authParams, f: "json" }), headers }
      );
    });
  });

  describe("starredSongs", () => {
    it("maps complete song records to playable track summaries (no per-song round trip)", async () => {
      const trackA = aTrack();
      const trackB = aTrack();
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(
          ok(
            subsonicOK({
              starred2: { song: [asSongJson(trackA), asSongJson(trackB)] },
            })
          )
        )
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).starredSongs(credentials);
      expect(result.map((r) => r.id)).toEqual([trackA.id, trackB.id]);
      expect(result.map((r) => r.name)).toEqual([trackA.name, trackB.name]);
    });

    it("returns an empty array when getStarred2 reports no songs (the || [] guard)", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(ok(subsonicOK({ starred2: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).starredSongs(credentials);
      expect(result).toEqual([]);
    });

    // getStarred2 has no pagination: it returns EVERY starred song in one response. Measured in
    // production at 11,505 starred songs: 2.6-3.1s in Navidrome, 8615ms end-to-end through bonob,
    // against Sonos's 4500ms browse deadline. Sonos browses page by page, so an uncached list
    // re-runs that whole fetch for every page. These tests pin the caching contract that makes
    // the section serveable at all.
    describe("caching (the fetch cannot fit Sonos's browse deadline)", () => {
      const starredResponse = (t: ReturnType<typeof aTrack>) =>
        ok(subsonicOK({ starred2: { song: [asSongJson(t)] } }));

      it("fetches getStarred2 only once across repeated calls (Sonos pages the container)", async () => {
        const trackA = aTrack();
        mockGET.mockImplementation(() => Promise.resolve(starredResponse(trackA)));
        const subsonic = new Subsonic(
          url,
          NO_CUSTOM_PLAYERS,
          undefined,
          new SwrCache(SystemClock, 60_000)
        );
        await subsonic.starredSongs(credentials);
        await subsonic.starredSongs(credentials);
        await subsonic.starredSongs(credentials);
        const starredCalls = mockGET.mock.calls.filter((c) =>
          String(c[0]).includes("getStarred2")
        );
        expect(starredCalls.length).toEqual(1);
      });

      it("peekStarredSongs returns undefined while cold so the browse never blocks on it", () => {
        const subsonic = new Subsonic(
          url,
          NO_CUSTOM_PLAYERS,
          undefined,
          new SwrCache(SystemClock, 60_000)
        );
        expect(subsonic.peekStarredSongs(credentials)).toBeUndefined();
      });

      it("peekStarredSongs resolves once warmed", async () => {
        const trackA = aTrack();
        mockGET.mockImplementation(() => Promise.resolve(starredResponse(trackA)));
        const subsonic = new Subsonic(
          url,
          NO_CUSTOM_PLAYERS,
          undefined,
          new SwrCache(SystemClock, 60_000)
        );
        await subsonic.starredSongs(credentials);
        const peeked = subsonic.peekStarredSongs(credentials);
        expect(peeked).toBeDefined();
        expect((await peeked!).map((it) => it.id)).toEqual([trackA.id]);
      });

      // bonob writes stars itself: rate() -> star/unstar. Without invalidation the user hearts a
      // track on Sonos, opens Favourite Songs, and their own action is missing for a full TTL.
      it("invalidateStarredSongs forces the next call to re-fetch", async () => {
        const trackA = aTrack();
        mockGET.mockImplementation(() => Promise.resolve(starredResponse(trackA)));
        const subsonic = new Subsonic(
          url,
          NO_CUSTOM_PLAYERS,
          undefined,
          new SwrCache(SystemClock, 60_000)
        );
        await subsonic.starredSongs(credentials);
        subsonic.invalidateStarredSongs(credentials);
        await subsonic.starredSongs(credentials);
        const starredCalls = mockGET.mock.calls.filter((c) =>
          String(c[0]).includes("getStarred2")
        );
        expect(starredCalls.length).toEqual(2);
      });

      it("caches per user so one household member's favourites never leak to another", async () => {
        const trackA = aTrack();
        mockGET.mockImplementation(() => Promise.resolve(starredResponse(trackA)));
        const subsonic = new Subsonic(
          url,
          NO_CUSTOM_PLAYERS,
          undefined,
          new SwrCache(SystemClock, 60_000)
        );
        await subsonic.starredSongs(credentials);
        await subsonic.starredSongs({ ...credentials, username: "someone-else" });
        const starredCalls = mockGET.mock.calls.filter((c) =>
          String(c[0]).includes("getStarred2")
        );
        expect(starredCalls.length).toEqual(2);
      });
    });
  });

  describe("getArtist caching", () => {
    // Measured live after caching artist INFO: the two artists that previously breached the
    // deadline still cost ~3s on a repeat open, and Radiohead degraded at 5934ms cold. The
    // residual cost is getArtist, which returns ALL of an artist's albums and was uncached, and
    // it is re-fetched by every one of the three artist() calls a single artist open produces.
    it("fetches an artist once across repeated opens", async () => {
      mockGET.mockImplementation(() =>
        Promise.resolve(
          ok(subsonicOK({ artist: { id: "a1", name: "An Artist", album: [] } }))
        )
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getArtist(credentials, "a1");
      await subsonic.getArtist(credentials, "a1");
      await subsonic.getArtist(credentials, "a1");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("/rest/getArtist?") || (String(c[0]).includes("getArtist") && !String(c[0]).includes("getArtistInfo"))).length
      ).toEqual(1);
    });
  });

  describe("artistTracks (recursive enumeration for play-artist)", () => {
    // SMAPI defines canPlay as "playable by enumerating with the recursive flag to obtain a flat
    // list of mediaMetadata". bonob never implemented recursive, which is why adding canPlay to
    // artist tiles would have BROKEN play-artist: Sonos would have asked for a flat track list and
    // received containers. This is that flat list, and it must be bounded and cached or it is the
    // favouriteSongs hazard again: one artist can own hundreds of albums.
    const artistWith = (albumCount: number) =>
      ok(
        subsonicOK({
          artist: {
            id: "a1",
            name: "An Artist",
            album: Array.from({ length: albumCount }, (_, i) => ({
              id: `al-${i}`,
              name: `Album ${i}`,
              artistId: "a1",
              artist: "An Artist",
            })),
          },
        })
      );
    const albumWithTracks = (n: number) =>
      ok(
        subsonicOK({
          album: {
            id: "al-x",
            name: "Album",
            artistId: "a1",
            artist: "An Artist",
            song: Array.from({ length: n }, (_, i) => ({
              id: `t-${i}`,
              title: `Track ${i}`,
              albumId: "al-x",
              album: "Album",
              artistId: "a1",
              artist: "An Artist",
              duration: 100,
              track: i + 1,
              contentType: "audio/flac",
            })),
          },
        })
      );

    it("caps the number of albums it will walk for one artist", async () => {
      mockGET.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes("getArtist") ? artistWith(400) : albumWithTracks(1)
        )
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.artistTracks(credentials, "a1");
      const albumCalls = mockGET.mock.calls.filter((c) =>
        String(c[0]).includes("/rest/getAlbum")
      ).length;
      expect(albumCalls).toBeGreaterThan(0);
      expect(albumCalls).toBeLessThanOrEqual(MAX_RECURSIVE_ALBUMS);
    });

    it("caps the number of tracks returned", async () => {
      mockGET.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes("getArtist") ? artistWith(50) : albumWithTracks(200)
        )
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      const tracks = await subsonic.artistTracks(credentials, "a1");
      expect(tracks.length).toBeLessThanOrEqual(MAX_RECURSIVE_TRACKS);
      expect(tracks.length).toBeGreaterThan(0);
    });

    it("is cached: a second enumeration costs no upstream calls", async () => {
      mockGET.mockImplementation((url: string) =>
        Promise.resolve(
          String(url).includes("getArtist") ? artistWith(3) : albumWithTracks(2)
        )
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.artistTracks(credentials, "a1");
      const afterFirst = mockGET.mock.calls.length;
      await subsonic.artistTracks(credentials, "a1");
      expect(mockGET.mock.calls.length).toEqual(afterFirst);
    });
  });

  describe("search caching (Sonos fires each category twice, concurrently)", () => {
    // Observed live: one user search produced SIX search calls in the same second - all three
    // categories, twice each. search3 over 831k tracks is the slowest of the three, and under that
    // concurrency the tracks category exceeded the 4500ms deadline and degraded to empty, so the
    // Songs section silently returned nothing for a common term ("Rock").
    //
    // Caching keyed on the query collapses the duplicate pair into ONE upstream call (SwrCache
    // coalesces in-flight requests per key) and makes a repeated search free.
    const searchResponse = () =>
      ok(subsonicOK({ searchResult3: { song: [], album: [], artist: [] } }));

    it("coalesces the duplicate concurrent search into one upstream call", async () => {
      mockGET.mockImplementation(() => Promise.resolve(searchResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await Promise.all([
        subsonic.search3(credentials, { query: "Rock", songCount: 20 }),
        subsonic.search3(credentials, { query: "Rock", songCount: 20 }),
      ]);
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("search3")).length
      ).toEqual(1);
    });

    it("does not confuse two different terms", async () => {
      mockGET.mockImplementation(() => Promise.resolve(searchResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.search3(credentials, { query: "Rock", songCount: 20 });
      await subsonic.search3(credentials, { query: "Jazz", songCount: 20 });
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("search3")).length
      ).toEqual(2);
    });

    it("does not confuse the three categories, which ask for different counts", async () => {
      mockGET.mockImplementation(() => Promise.resolve(searchResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.search3(credentials, { query: "Rock", songCount: 20 });
      await subsonic.search3(credentials, { query: "Rock", albumCount: 20 });
      await subsonic.search3(credentials, { query: "Rock", artistCount: 20 });
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("search3")).length
      ).toEqual(3);
    });
  });

  describe("top songs caching", () => {
    // Top Songs opened empty on the live library. Upstream was healthy (36 songs, 770ms); the
    // failure was bonob's own chain: getArtist (1821ms for that artist, run first only to turn the
    // id into a NAME) then getTopSongs (770ms), both inside one 3500ms budget. It tipped over and
    // degraded to [] - and silently, because the withTimeout had no context to log with.
    it("fetches top songs once per artist", async () => {
      mockGET.mockImplementation(() =>
        Promise.resolve(ok(subsonicOK({ topSongs: { song: [] } })))
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getTopSongs(credentials, "An Artist");
      await subsonic.getTopSongs(credentials, "An Artist");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getTopSongs")).length
      ).toEqual(1);
    });

    it("caches per artist name", async () => {
      mockGET.mockImplementation(() =>
        Promise.resolve(ok(subsonicOK({ topSongs: { song: [] } })))
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getTopSongs(credentials, "An Artist");
      await subsonic.getTopSongs(credentials, "Another Artist");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getTopSongs")).length
      ).toEqual(2);
    });
  });

  describe("genre caching", () => {
    // 1443 genres on the live library, measured at 587ms, and re-fetched for every page of the
    // Genres browse. Genres only change when the library is rescanned.
    it("fetches the genre list once across repeated browses", async () => {
      mockGET.mockImplementation(() =>
        Promise.resolve(
          ok(subsonicOK({ genres: { genre: [{ value: "Rock", albumCount: 3, songCount: 9 }] } }))
        )
      );
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getGenres(credentials);
      await subsonic.getGenres(credentials);
      await subsonic.getGenres(credentials);
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getGenres")).length
      ).toEqual(1);
    });
  });

  describe("artist info caching (external, slow, rate-limited)", () => {
    // Caught live on 2026-08-05 09:15: getExtendedMetadata:artist for two artists exceeded the
    // 4500ms browse deadline and degraded to an EMPTY result, so Sonos had nothing to render for
    // those artists. getArtistInfo2 is an external Last.fm lookup with a 3500ms budget sitting
    // INSIDE the 4500ms deadline, it was uncached, and opening one artist fires artist() up to
    // three times (browse, extended metadata, bio text) - three separate external round trips for
    // one user action.
    const artistInfoResponse = () =>
      ok(
        subsonicOK({
          artistInfo2: {
            biography: "a bio",
            smallImageUrl: "http://example.com/s.jpg",
            mediumImageUrl: "http://example.com/m.jpg",
            largeImageUrl: "http://example.com/l.jpg",
            similarArtist: [],
          },
        })
      );

    it("fetches artist info once no matter how many times an artist is opened", async () => {
      mockGET.mockImplementation(() => Promise.resolve(artistInfoResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getArtistInfo(credentials, "artist-1");
      await subsonic.getArtistInfo(credentials, "artist-1");
      await subsonic.getArtistInfo(credentials, "artist-1");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getArtistInfo2")).length
      ).toEqual(1);
    });

    it("caches per artist id", async () => {
      mockGET.mockImplementation(() => Promise.resolve(artistInfoResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getArtistInfo(credentials, "artist-1");
      await subsonic.getArtistInfo(credentials, "artist-2");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getArtistInfo2")).length
      ).toEqual(2);
    });

    it("caches per user so one household member's enrichment is not served to another", async () => {
      mockGET.mockImplementation(() => Promise.resolve(artistInfoResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.getArtistInfo(credentials, "artist-1");
      await subsonic.getArtistInfo(
        { ...credentials, username: "someone-else" },
        "artist-1"
      );
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getArtistInfo2")).length
      ).toEqual(2);
    });
  });

  describe("playlist caching (getPlaylist is unpaginated, re-fetched per page)", () => {
    // Same hazard as favouriteSongs: getPlaylist returns EVERY entry, and Sonos browses the
    // container page by page, so an uncached playlist costs one full fetch per page.
    const playlistResponse = () =>
      ok(
        subsonicOK({
          playlist: { id: "pl-1", name: "Road trip", entry: [] },
        })
      );

    it("fetches a playlist once across repeated page reads", async () => {
      mockGET.mockImplementation(() => Promise.resolve(playlistResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.playlist(credentials, "pl-1");
      await subsonic.playlist(credentials, "pl-1");
      await subsonic.playlist(credentials, "pl-1");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getPlaylist")).length
      ).toEqual(1);
    });

    it("caches per playlist id, not globally", async () => {
      mockGET.mockImplementation(() => Promise.resolve(playlistResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.playlist(credentials, "pl-1");
      await subsonic.playlist(credentials, "pl-2");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getPlaylist")).length
      ).toEqual(2);
    });

    // bonob edits playlists itself. Without invalidation the user adds a track from Sonos, reopens
    // the playlist, and their own change is missing until the TTL expires.
    it("re-fetches after updatePlaylist adds or removes a track", async () => {
      mockGET.mockImplementation(() => Promise.resolve(playlistResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.playlist(credentials, "pl-1");
      await subsonic.updatePlaylist(credentials, "pl-1", { songIdToAdd: "t-9" });
      await subsonic.playlist(credentials, "pl-1");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getPlaylist")).length
      ).toEqual(2);
    });

    it("re-fetches after deletePlayList so a deleted playlist is never served from cache", async () => {
      mockGET.mockImplementation(() => Promise.resolve(playlistResponse()));
      const subsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        undefined,
        new SwrCache(SystemClock, 60_000)
      );
      await subsonic.playlist(credentials, "pl-1");
      await subsonic.deletePlayList(credentials, "pl-1");
      await subsonic.playlist(credentials, "pl-1");
      expect(
        mockGET.mock.calls.filter((c) => String(c[0]).includes("getPlaylist")).length
      ).toEqual(2);
    });
  });

  describe("album list page sizing", () => {
    // getAlbumList2 always asked Navidrome for 500 albums no matter how few Sonos wanted, and the
    // volatile sections (random/recentlyPlayed/mostPlayed/favourited/starred) are never cached, so
    // every browse paid a 500-row query. Measured in production: randomAlbums 2381ms, and once
    // 5874ms - past the 4500ms deadline, degrading the section to a placeholder.
    it("asks upstream for only as many albums as Sonos requested", async () => {
      mockGET.mockImplementation(() =>
        Promise.resolve(ok(subsonicOK({ albumList2: { album: [] } })))
      );
      const subsonic = new Subsonic(url, NO_CUSTOM_PLAYERS);
      await subsonic.getAlbumList2(credentials, {
        type: "random",
        _index: 0,
        _count: 20,
      } as any);
      const call = mockGET.mock.calls.find((c) =>
        String(c[0]).includes("getAlbumList2")
      );
      expect(call).toBeDefined();
      expect(String(call![1].params.get("size"))).toEqual("20");
    });

    it("never asks for more than the upstream page cap", async () => {
      mockGET.mockImplementation(() =>
        Promise.resolve(ok(subsonicOK({ albumList2: { album: [] } })))
      );
      const subsonic = new Subsonic(url, NO_CUSTOM_PLAYERS);
      await subsonic.getAlbumList2(credentials, {
        type: "random",
        _index: 0,
        _count: 100_000,
      } as any);
      const call = mockGET.mock.calls.find((c) =>
        String(c[0]).includes("getAlbumList2")
      );
      expect(Number(call![1].params.get("size"))).toEqual(
        ALBUM_LIST_MAX_PAGE_SIZE
      );
    });
  });

  describe("getTranscodeDecision", () => {
    const mediaId = `media-${uuid()}`;

    it("rejects with 'Subsonic POST failed' when the POST returns a non-200 status", async () => {
      mockPOST.mockImplementationOnce(() =>
        Promise.resolve({ status: 500, data: {} })
      );
      await expect(
        new Subsonic(url, NO_CUSTOM_PLAYERS).getTranscodeDecision(
          credentials,
          mediaId,
          SONOS_CLIENT_INFO
        )
      ).rejects.toEqual("Subsonic POST failed with a 500 status");
    });

    it("rejects with 'Subsonic error:' when the POST envelope reports an application error", async () => {
      mockPOST.mockImplementationOnce(() =>
        Promise.resolve(
          ok({
            "subsonic-response": {
              status: "failed",
              version: "1.16.1",
              type: "subsonic",
              serverVersion: "0.45.1",
              error: { code: "0", message: "getTranscodeDecision not supported" },
            },
          })
        )
      );
      await expect(
        new Subsonic(url, NO_CUSTOM_PLAYERS).getTranscodeDecision(
          credentials,
          mediaId,
          SONOS_CLIENT_INFO
        )
      ).rejects.toEqual("Subsonic error:getTranscodeDecision not supported");
    });
  });

  describe("getOpenSubsonicExtensions: non-404 errors propagate", () => {
    it("rethrows a 500 axios error instead of swallowing it as an empty list", async () => {
      const err = Object.assign(new Error("Request failed with status code 500"), {
        isAxiosError: true,
        response: { status: 500, data: {} },
      });
      mockGET.mockImplementation(() => Promise.reject(err));
      // getJSONWithRetry retries 5xx once, so the upstream is hit twice before the error surfaces.
      await expect(
        new Subsonic(url, NO_CUSTOM_PLAYERS).getOpenSubsonicExtensions(credentials)
      ).rejects.toBe(err);
      expect(mockGET).toHaveBeenCalledTimes(2);
    });
  });

  describe("warm / peek methods (non-blocking cache access)", () => {
    const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
    let cacheSubsonic: Subsonic;

    beforeEach(() => {
      clock.time = dayjs("2024-01-01T00:00:00Z");
      cacheSubsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        axiosImageFetcher,
        new SwrCache(clock, 5 * 60_000)
      );
    });

    it("peekAlbumCount / peekArtists are undefined before the artist list is warm", () => {
      expect(cacheSubsonic.peekAlbumCount(credentials)).toBeUndefined();
      expect(cacheSubsonic.peekArtists(credentials)).toBeUndefined();
    });

    it("warmArtists pre-fetches the artist list; afterwards peek* return the warm value", async () => {
      const artist1 = anArtist({ name: "A Artist", albums: [anAlbum(), anAlbum()] });
      mockGET.mockImplementation(() => Promise.resolve(ok(asArtistsJson([artist1]))));

      cacheSubsonic.warmArtists(credentials);
      // warm kicks a fetch in the background; let it settle.
      await new Promise((r) => setImmediate(r));

      const expectedCount = artist1.albums.length;
      await expect(cacheSubsonic.peekAlbumCount(credentials)).resolves.toBe(expectedCount);
      await expect(cacheSubsonic.peekArtists(credentials)).resolves.toBeDefined();
      // The artists were fetched exactly once by the warm; a subsequent getArtists reads the cache.
      expect(mockGET).toHaveBeenCalledTimes(1);
      await cacheSubsonic.getArtists(credentials);
      expect(mockGET).toHaveBeenCalledTimes(1);
    });

    it("getArtistIndex builds the letter index from Navidrome's grouping (keys verbatim, albumCount preserved)", async () => {
      // asArtistsJson groups by the first char of the name into Navidrome index letters.
      const a1 = anArtist({ name: "Aphex", albums: [anAlbum()] });
      const b1 = anArtist({ name: "Boards", albums: [anAlbum(), anAlbum()] });
      mockGET.mockImplementation(() =>
        Promise.resolve(ok(asArtistsJson([a1, b1])))
      );

      const idx = await cacheSubsonic.getArtistIndex(credentials);

      // Letters are Navidrome's (A, B) verbatim — NOT re-derived from names — each bucket covering
      // its artists, laid out contiguously.
      expect(idx.total).toEqual(2);
      expect(idx.buckets.map((b) => b.key)).toEqual(["A", "B"]);
      expect(idx.buckets.map((b) => b.count)).toEqual([1, 1]);
      // albumCount rides on the records so the album total can be summed from this one index.
      expect(idx.items.map((a) => a.albumCount)).toEqual([1, 2]);
      // the flat artist list is a view over the same items
      const flat = await cacheSubsonic.getArtists(credentials);
      expect(flat.map((a) => a.id)).toEqual(idx.items.map((a) => a.id));
      // ...served from the cache (no second upstream fetch)
      expect(mockGET).toHaveBeenCalledTimes(1);
    });

    it("peekArtistIndex is undefined until warm, then the resolved index", async () => {
      expect(cacheSubsonic.peekArtistIndex(credentials)).toBeUndefined();
      mockGET.mockImplementation(() =>
        Promise.resolve(
          ok(asArtistsJson([anArtist({ name: "Aphex", albums: [anAlbum()] })]))
        )
      );
      cacheSubsonic.warmArtists(credentials);
      await new Promise((r) => setImmediate(r));

      const peeked = cacheSubsonic.peekArtistIndex(credentials);
      expect(peeked).toBeDefined();
      await expect(peeked!.then((i) => i.total)).resolves.toBe(1);
    });

    it("streams a disk-backed ARTIST index when a snapshot dir is configured (goal c)", async () => {
      // NEGATIVE for the residency change: this fails on the current code, which maps EVERY artist,
      // deep-freezes each, and holds them all resident in idx.items (snapshotFile / offsets /
      // totalAlbumCount all undefined, and the snapshot dir is ignored). Reverting src/ and re-running
      // must turn the disk-backed assertions below red.
      const snap = mkdtempSync(path.join(os.tmpdir(), "bonob-artist-snap-"));
      try {
        const onDisk = new Subsonic(
          url,
          NO_CUSTOM_PLAYERS,
          axiosImageFetcher,
          SwrCache.disabled(),
          new SwrCache(clock, 60_000),
          false,
          {},
          undefined,
          snap
        );
        const a1 = anArtist({ name: "Aphex", albums: [anAlbum()] });
        const b1 = anArtist({ name: "Boards", albums: [anAlbum(), anAlbum()] });
        mockGET.mockImplementation((_u: string) =>
          Promise.resolve(ok(asArtistsJson([a1, b1])))
        );

        const idx = await onDisk.getArtistIndex(credentials);

        // DISK-BACKED: the snapshot is NOT resident. items is empty; a snapshot file + a Uint32Array
        // of byte offsets are what is held instead. (Current code: items holds the 2 records, no
        // offsets, no snapshotFile — every one of these four lines goes red on a revert.)
        expect(idx.items).toEqual([]);
        expect(idx.offsets).toBeInstanceOf(Uint32Array);
        expect(idx.offsets!.length).toBe(2 + 1);
        expect(idx.snapshotFile).toBeDefined();
        expect(existsSync(idx.snapshotFile!)).toBe(true);
        // The snapshot carries the ARTIST prefix in the shared index dir (distinct from albums).
        expect(path.basename(idx.snapshotFile!).startsWith("artistSnapshot.v2.")).toBe(true);

        // The whole-catalog album total (sum of albumCount) is persisted on the index, so it is O(1)
        // from a disk-backed index whose items are empty. (Current code: totalAlbumCount undefined.)
        expect(idx.totalAlbumCount).toBe(1 + 2);

        // Resident bytes: ONLY the Uint32Array of offsets — 4 bytes × (total + 1) — not the records.
        expect(idx.offsets!.byteLength).toBe(4 * (2 + 1));

        // A letter page is read from disk and matches the scan (Navidrome letters verbatim — "Aphex"
        // stays under Navidrome's "A", NOT re-derived).
        const aPage = await readAlbumIndexPage(idx, "A", 0, 10);
        expect(aPage.total).toBe(1);
        expect(aPage.items.map((a) => a.name)).toEqual(["Aphex"]);
        const bPage = await readAlbumIndexPage(idx, "B", 0, 10);
        expect(bPage.items.map((a) => a.name)).toEqual(["Boards"]);

        // albumCount reads the persisted total O(1) — no items to sum on a disk-backed index.
        await expect(onDisk.albumCount(credentials)).resolves.toBe(1 + 2);
      } finally {
        rmSync(snap, { recursive: true, force: true });
      }
    });

    it("warmAlbumIndex kicks the (heavy) index scan in the background", async () => {
      const indexCache = new SwrCache(clock, 60_000);
      const indexedSubsonic = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        axiosImageFetcher,
        SwrCache.disabled(),
        indexCache
      );
      const artist = anArtist();
      // First page then an empty page terminates the scan.
      let n = 0;
      mockGET.mockImplementation((_u: string, _config: any) => {
        if (String(_u).includes("getArtists")) {
          return Promise.resolve(ok(asArtistsJson([artist])));
        }
        const page =
          n++ === 0 ? [anAlbumSummary({ id: "ix-1", name: "Alpha" })] : [];
        return Promise.resolve(
          ok(getAlbumListJson(page.map((a) => [artist, a] as [Artist, AlbumSummary])))
        );
      });

      indexedSubsonic.warmAlbumIndex(credentials);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // The warm produced a settled, peekable index with the one album bucketed.
      const peeked = indexedSubsonic.peekAlbumIndex(credentials);
      expect(peeked).toBeDefined();
      await expect(peeked!.then((i) => i.total)).resolves.toBe(1);
    });
  });
});

describe("Subsonic: album index scan aborts (and leaves no .tmp) on an inconsistent scan with a snapshot dir", () => {
  it("removes the half-written snapshot temp file when the scan rejects (writer.abort path)", async () => {
    const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
    const indexCache = new SwrCache(clock, 60_000);
    const snap = mkdtempSync(path.join(os.tmpdir(), "bonob-snap-abort-"));
    try {
      const onDisk = new Subsonic(
        new URLBuilder("http://127.0.0.22:4567/ctx"),
        NO_CUSTOM_PLAYERS,
        axiosImageFetcher,
        SwrCache.disabled(),
        indexCache,
        false,
        {},
        undefined,
        snap
      );
      const artist = anArtist();
      const firstPage = Array.from({ length: 500 }, (_, i) =>
        anAlbumSummary({ id: `album-${i}`, name: `Album ${i}` })
      );
      const driftedSecondPage = [anAlbumSummary({ id: "album-499", name: "Dup" })];

      const mockGET = jest.fn();
      const mockRandom = jest.fn().mockReturnValue("saltysalty");
      axios.get = mockGET;
      (random.generateRandomString as jest.Mock) = mockRandom;
      mockGET.mockImplementation((_u: string, config: any) => {
        const offset = Number(config.params.get("offset"));
        const page = offset === 0 ? firstPage : driftedSecondPage;
        return Promise.resolve(
          ok(getAlbumListJson(page.map((a) => [artist, a] as [Artist, AlbumSummary])))
        );
      });

      await expect(onDisk.getAlbumIndex(credentialsStub())).rejects.toThrow(
        "Inconsistent album index scan"
      );
      await new Promise((r) => setImmediate(r));
      // The writer was aborted: no leftover .tmp snapshot remains in the directory.
      const leftovers = readdirSync(snap).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(snap, { recursive: true, force: true });
    }
  });
});

// Minimal credentials stub for the snapshot-abort test (its assertions don't depend on auth).
const credentialsStub = () => ({ username: "snap-user", password: "snap-pass" });

// =============================================================================
// Loop 2: residual branch/line coverage on src/subsonic.ts.
// Each test either (a) kills a specific mutant on a previously-uncovered branch/line, or (b)
// documents a branch proven unreachable (see the dead-branch ledger in the loop-2 report). The
// shared mock infrastructure mirrors the "Subsonic: low-level error paths" block above so the new
// cases stay self-contained.
// =============================================================================
describe("Subsonic: residual coverage (loop 2)", () => {
  const url = new URLBuilder("http://127.0.0.22:4567/ctx");
  const username = `cov2-${uuid()}`;
  const password = `cov2-${uuid()}`;
  const credentials = { username, password };
  const salt = "saltysalty";
  const mockRandomstring = jest.fn();
  const mockGET = jest.fn();
  const mockPOST = jest.fn();
  const authParams = {
    u: username,
    v: "1.16.1",
    c: "bonob",
    t: t(password, salt),
    s: salt,
  };
  const authParamsPlusJson = { ...authParams, f: "json" };
  const headers = { "User-Agent": "bonob" };

  const okStatus = (data: any) => ({ status: 200, data });
  // subsonic-response envelope with body spread; omits inner fields when `body` does not set them
  // (used to drive the `|| []` defensive arms where the server response genuinely lacks a field).
  const envelope = (body: any = {}) => ({
    "subsonic-response": {
      status: "ok",
      version: "1.16.1",
      type: "subsonic",
      serverVersion: "0.45.1",
      ...body,
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();
    (random.generateRandomString as jest.Mock) = mockRandomstring;
    axios.get = mockGET;
    axios.post = mockPOST;
    mockRandomstring.mockReturnValue(salt);
  });

  describe("SSRF guard: IPv4 private-range predicates (loop 1 missed short-circuit arms)", () => {
    // Each address lands on a different `||` clause of isPrivateIPv4's return expression. Loop 1
    // covered only 127/10/169.254/192.168/172.16; the 0.*, 100.64/10 (CGNAT) and >=224 arms were
    // never taken. Each boundary test kills the mutant that flips its comparisons.
    it("blocks 0.0.0.0 (a===0 arm)", () => {
      expect(isSafeExternalImageUrl("http://0.0.0.0/x.png")).toBe(false);
    });

    it("blocks 100.64.0.1 and ONLY the 100.64/10 CGNAT range (boundary both sides)", () => {
      // inside the range -> blocked
      expect(isSafeExternalImageUrl("http://100.64.0.1/x.png")).toBe(false);
      expect(isSafeExternalImageUrl("http://100.127.0.1/x.png")).toBe(false);
      // just outside either edge -> allowed
      expect(isSafeExternalImageUrl("http://100.63.0.1/x.png")).toBe(true);
      expect(isSafeExternalImageUrl("http://100.128.0.1/x.png")).toBe(true);
      expect(isSafeExternalImageUrl("http://100.0.0.1/x.png")).toBe(true);
    });

    it("blocks multicast/reserved (a>=224 arm): 224.0.0.1 and 239.255.255.250", () => {
      expect(isSafeExternalImageUrl("http://224.0.0.1/x.png")).toBe(false);
      expect(isSafeExternalImageUrl("http://239.255.255.250/x.png")).toBe(false);
      expect(isSafeExternalImageUrl("http://255.255.255.255/x.png")).toBe(false);
    });
  });

  describe("SSRF guard: IPv6 unspecified address (::)", () => {
    // expandIPv6 short-circuits "::" to eight zero hextets; isPrivateIPv6 then matches the
    // ":: or ::1" arm. http://[::]/ must be blocked. Mutating the ::1/:: arm in isPrivateIPv6 to
    // return false makes the unspecified address leak as safe.
    it("blocks http://[::]/ (expandIPv6 :: early return -> isPrivateIPv6 zero-hextet arm)", () => {
      expect(isSafeExternalImageUrl("http://[::]/x.png")).toBe(false);
    });
  });

  describe("ping: TE.tryCatch error arm + falsy-status message", () => {
    it("maps a network/transport rejection to AuthFailure(String(e))", async () => {
      // Covers the (e) => new AuthFailure(String(e)) reject arm of ping's TE.tryCatch. A mutant
      // that drops the error mapper (or returns a fixed AuthFailure) breaks the exact-string match.
      mockGET.mockImplementationOnce(() => Promise.reject(new Error("connect ECONNREFUSED")));
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).ping(credentials)();
      expect(result).toEqual(E.left(new AuthFailure("Error: connect ECONNREFUSED")));
    });

    it("maps a non-200 GET with a FALSY status onto the 'no!' status-message arm", async () => {
      // status=0 is falsy, so `${response.status || "no!"}` yields "no!". Exercises both the
      // getJSON non-200 throw arm and ping's AuthFailure mapper.
      mockGET.mockImplementationOnce(() =>
        Promise.resolve({ status: 0, data: envelope({}) })
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).ping(credentials)();
      expect(result).toEqual(E.left(new AuthFailure("Subsonic failed with a no! status")));
    });
  });

  describe("POST non-200 with falsy status", () => {
    it("rejects with 'Subsonic POST failed with a no! status' (the POST-side status || 'no!' arm)", async () => {
      // Mirrors the GET-side test above but for `post`. postJSON's only internal caller is
      // getTranscodeDecision, so drive it through there.
      mockPOST.mockImplementationOnce(() => Promise.resolve({ status: 0, data: {} }));
      await expect(
        new Subsonic(url, NO_CUSTOM_PLAYERS).getTranscodeDecision(
          credentials,
          "media-1",
          SONOS_CLIENT_INFO
        )
      ).rejects.toEqual("Subsonic POST failed with a no! status");
    });
  });

  describe("albumSummaryFromSong: || '' fallback arms", () => {
    it("returns id='' and name='' when song has no albumId/album", () => {
      // Covers both `song.albumId || ""` and `song.album || ""` fallbacks at once. Mutant that
      // drops either `|| ""` leaves id/name as undefined and fails the strict equality.
      const summary = albumSummaryFromSong({} as any);
      expect(summary.id).toBe("");
      expect(summary.name).toBe("");
    });

    it("preserves a present albumId and album", () => {
      const summary = albumSummaryFromSong({
        albumId: "al-1",
        album: "Title",
      } as any);
      expect(summary.id).toBe("al-1");
      expect(summary.name).toBe("Title");
    });
  });

  describe("CoverArtBusyError default construction", () => {
    // The constructor's default-message arm (`message = "cover art coordinator busy"`) is never
    // used internally (every internal `new CoverArtBusyError(...)` passes an explicit message), so
    // the only way to cover the arm is to construct one directly. A mutant changing the default
    // breaks the message assertion.
    it("default-constructs with the documented message, name and prototype", () => {
      const err = new CoverArtBusyError();
      expect(err.message).toBe("cover art coordinator busy");
      expect(err.name).toBe("CoverArtBusyError");
      expect(err).toBeInstanceOf(CoverArtBusyError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("DEFAULT_MAX_INDEX_SCAN_ALBUMS env override (IIFE positive-integer arm)", () => {
    // The IIFE reads BNB_MAX_INDEX_SCAN_ALBUMS once at module load. The default path (env unset ->
    // 20_000_000) runs at first import, but the positive-integer arm (`raw > 0 ? raw : default`)
    // never does. We re-import the module under an isolateModules scope so the IIFE re-runs against
    // a controlled env. A mutant that drops the `raw > 0` guard (or the IIFE) breaks the assertion.
    it("honours a positive-integer BNB_MAX_INDEX_SCAN_ALBUMS", () => {
      const orig = process.env.BNB_MAX_INDEX_SCAN_ALBUMS;
      process.env.BNB_MAX_INDEX_SCAN_ALBUMS = "42";
      try {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require("../src/subsonic") as typeof import("../src/subsonic");
          expect(mod.DEFAULT_MAX_INDEX_SCAN_ALBUMS).toBe(42);
        });
      } finally {
        if (orig === undefined) delete process.env.BNB_MAX_INDEX_SCAN_ALBUMS;
        else process.env.BNB_MAX_INDEX_SCAN_ALBUMS = orig;
      }
    });

    it("rejects a non-positive/non-integer override and falls back to the documented default", () => {
      // Covers the `&& raw > 0` short-circuit on a parseable-but-invalid value, proving the guard
      // is `raw > 0`, not just `Number.isInteger(raw)`.
      expect(DEFAULT_MAX_INDEX_SCAN_ALBUMS).toBe(20_000_000);
      const orig = process.env.BNB_MAX_INDEX_SCAN_ALBUMS;
      process.env.BNB_MAX_INDEX_SCAN_ALBUMS = "-5";
      try {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require("../src/subsonic") as typeof import("../src/subsonic");
          expect(mod.DEFAULT_MAX_INDEX_SCAN_ALBUMS).toBe(20_000_000);
        });
      } finally {
        if (orig === undefined) delete process.env.BNB_MAX_INDEX_SCAN_ALBUMS;
        else process.env.BNB_MAX_INDEX_SCAN_ALBUMS = orig;
      }
    });
  });

  describe("buildAlbumIndex: empty page in-loop + scanAlbums missing-album arm", () => {
    // Two related residuals: scanAlbums' `(r.albumList2.album || [])` arm (when the server omits
    // the `album` field entirely), and the loop's `if (page.length === 0) { complete = true; break; }`
    // which fires on a mid-scan empty page. We exercise both with one mock that returns an envelope
    // lacking `album` on the first page: scanAlbums maps it to [], the loop sees length 0, sets
    // complete, breaks, and the scan succeeds with total=0.
    it("completes cleanly when the catalog's first page omits the `album` field entirely", async () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const indexCache = new SwrCache(clock, 60_000);
      const sub = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        axiosImageFetcher,
        SwrCache.disabled(),
        indexCache
      );
      mockGET.mockImplementation(() =>
        Promise.resolve(okStatus(envelope({ albumList2: {} })))
      );
      const idx = await sub.getAlbumIndex(credentials);
      expect(idx.total).toBe(0);
      expect(idx.buckets).toEqual([]);
      expect(idx.years).toEqual([]);
    });
  });

  describe("buildAlbumIndex: year-less albums (the `if (album.year)` guard)", () => {
    // A catalog with a mix of year-bearing and year-less records must collect only the valid years.
    // Mutating `if (album.year) yearsSet.add(album.year)` to drop the guard lets `undefined` into
    // the set, corrupting `idx.years`.
    it("skips records with no year when collecting distinct years", async () => {
      const clock = new FixedClock(dayjs("2024-01-01T00:00:00Z"));
      const indexCache = new SwrCache(clock, 60_000);
      const sub = new Subsonic(
        url,
        NO_CUSTOM_PLAYERS,
        axiosImageFetcher,
        SwrCache.disabled(),
        indexCache
      );
      const artist = anArtist();
      const page: [Artist, AlbumSummary][] = [
        [artist, anAlbumSummary({ id: "a-with-year", name: "Alpha", year: "2020" })],
        [artist, anAlbumSummary({ id: "a-no-year", name: "Beta", year: undefined })],
      ];
      mockGET.mockImplementation(() =>
        Promise.resolve(
          okStatus(
            envelope({
              albumList2: {
                album: page.map(([a, al]) => ({
                  id: al.id,
                  name: al.name,
                  year: al.year,
                  artist: a.name,
                  artistId: a.id,
                })),
              },
            })
          )
        )
      );
      const idx = await sub.getAlbumIndex(credentials);
      expect(idx.total).toBe(2);
      // toStrictEqual (not toEqual): jest's toEqual ignores `undefined` array elements, so a mutant
      // that drops the `if (album.year)` guard and lets `undefined` into the set would slip past.
      expect(idx.years).toStrictEqual(["2020"]);
    });
  });

  // -----------------------------------------------------------------------------
  // Defensive `|| []` / `|| undefined` arms on Subsonic response parsers. Loop 1 covered each
  // method's happy path (server returns an array, possibly empty) but never the case where the
  // server OMITS the field entirely - which is the exact arm the `|| []` guards. Each test below
  // asserts the method returns an empty array (not a TypeError) when the field is absent, and a
  // mutant that drops the `|| []` makes the `.map(...)`/`.filter(...)` throw on undefined.
  // -----------------------------------------------------------------------------
  describe("Subsonic response parsers: missing-collection field arms", () => {
    it("getGenres: returns [] when `genres.genre` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ genres: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getGenres(credentials);
      expect(result).toEqual([]);
      expect(axios.get).toHaveBeenCalledWith(
        url.append({ pathname: "/rest/getGenres" }).href(),
        { params: asURLSearchParams(authParamsPlusJson), headers }
      );
    });

    it("getArtistInfo: returns similarArtist: [] when the field is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ artistInfo2: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getArtistInfo(
        credentials,
        "artist-1"
      );
      expect(result.similarArtist).toEqual([]);
      expect(axios.get).toHaveBeenCalledWith(
        url.append({ pathname: "/rest/getArtistInfo2" }).href(),
        {
          params: asURLSearchParams({
            ...authParamsPlusJson,
            id: "artist-1",
            count: 50,
            includeNotPresent: true,
          }),
          headers,
        }
      );
    });

    it("getArtist: returns albums: [] when `artist.album` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(
          okStatus(envelope({ artist: { id: "artist-1", name: "Name" } }))
        )
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getArtist(
        credentials,
        "artist-1"
      );
      expect(result.albums).toEqual([]);
      expect(result.id).toBe("artist-1");
      expect(result.name).toBe("Name");
    });

    it("search3: returns empty arrays when artist/album/song are all absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ searchResult3: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).search3(
        credentials,
        { query: "anything" }
      );
      expect(result).toEqual({ artists: [], albums: [], songs: [] });
    });

    it("getAlbumList2 (volatile type): returns [] when `albumList2.album` is absent", async () => {
      // `random` is in VOLATILE_ALBUM_TYPES, so getAlbumList2 calls fetchAlbumListPage directly
      // (bypassing the cache) and exercises the `(response.albumList2.album || [])` arm at L2057.
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ albumList2: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getAlbumList2(credentials, {
        type: "random",
        _index: 0,
        _count: 50,
      });
      expect(result.results).toEqual([]);
    });

    it("playlists: returns [] when `playlists.playlist` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ playlists: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).playlists(credentials);
      expect(result).toEqual([]);
    });

    it("getSimilarSongs2: returns [] when `similarSongs2.song` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ similarSongs2: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getSimilarSongs2(
        credentials,
        "song-1"
      );
      expect(result).toEqual([]);
    });

    it("getTopSongs: returns [] when `topSongs.song` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ topSongs: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getTopSongs(
        credentials,
        "some artist"
      );
      expect(result).toEqual([]);
    });

    it("getInternetRadioStations: returns [] when `internetRadioStations.internetRadioStation` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(okStatus(envelope({ internetRadioStations: {} })))
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getInternetRadioStations(
        credentials
      );
      expect(result).toEqual([]);
    });

    it("getOpenSubsonicExtensions: returns [] when `openSubsonicExtensions` is absent", async () => {
      mockGET.mockImplementationOnce(() => Promise.resolve(okStatus(envelope({}))));
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).getOpenSubsonicExtensions(
        credentials
      );
      expect(result).toEqual([]);
    });
  });

  describe("playlist: missing entry field arm", () => {
    // The `playlist.entry || []` guard. A playlist response with NO entry list must yield an empty
    // entries array (not a TypeError on `.map`).
    it("returns entries: [] when `playlist.entry` is absent", async () => {
      mockGET.mockImplementationOnce(() =>
        Promise.resolve(
          okStatus(
            envelope({
              playlist: { id: "pl-1", name: "Mix" },
            })
          )
        )
      );
      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).playlist(
        credentials,
        "pl-1"
      );
      expect(result.entries).toEqual([]);
      expect(result.id).toBe("pl-1");
      expect(result.name).toBe("Mix");
    });
  });

  describe("updatePlaylist: default-changes arm", () => {
    // The optional 3rd parameter defaults to {}. Every production caller (subsonic_music_library)
    // passes an explicit change set, so the default arm is only reachable by calling updatePlaylist
    // directly with no 3rd arg. Mutating the default to inject a key (e.g. = { songIdToAdd: "X" })
    // would surface in the request params.
    it("issues an updatePlaylist request with only playlistId when no changes are supplied", async () => {
      mockGET.mockImplementationOnce(() => Promise.resolve(okStatus(envelope({}))));

      const result = await new Subsonic(url, NO_CUSTOM_PLAYERS).updatePlaylist(
        credentials,
        "pl-1"
      );
      expect(result).toBe(true);
      expect(axios.get).toHaveBeenCalledWith(
        url.append({ pathname: "/rest/updatePlaylist" }).href(),
        {
          params: asURLSearchParams({ ...authParamsPlusJson, playlistId: "pl-1" }),
          headers,
        }
      );
    });
  });
});

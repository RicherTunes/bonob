import { option as O, either as E } from "fp-ts";
import { randomUUID as uuid } from "crypto";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
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
} from "../src/subsonic";

import { promises as dnsPromises } from "dns";
import { getArtistJson, getArtistInfoJson, asArtistsJson, getAlbumListJson } from "./subsonic_music_library.test";

import { b64Encode } from "../src/b64";
import dayjs from "dayjs";
import { FixedClock } from "../src/clock";
import { SwrCache } from "../src/swr_cache";

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
            customPlayers,
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

      it("evicts album indexes beyond the dedicated album-index cache cap", async () => {
        const { ALBUM_INDEX_CACHE_MAX_ENTRIES } = jest.requireActual("../src/subsonic");
        expect(ALBUM_INDEX_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
        expect(ALBUM_INDEX_CACHE_MAX_ENTRIES).toBeLessThanOrEqual(2);

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
          }
        );
      });
    });
  });
});

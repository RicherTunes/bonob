import axios from "axios";
import { deezerArtistImageUrl, isSafeDeezerImageUrl } from "../src/deezer";

jest.mock("axios");
const mockGet = axios.get as jest.Mock;

const XL = "https://cdn-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg";
const BIG = "https://e-cdns-images.dzcdn.net/images/artist/abc/500x500.jpg";

describe("isSafeDeezerImageUrl (SSRF guard)", () => {
  it("accepts https Deezer CDN urls", () => {
    expect(isSafeDeezerImageUrl(XL)).toBe(true);
    expect(isSafeDeezerImageUrl(BIG)).toBe(true);
  });

  it("rejects non-Deezer hosts, http, look-alikes, internal IPs and junk", () => {
    expect(isSafeDeezerImageUrl("http://cdn-images.dzcdn.net/x.jpg")).toBe(false); // not https
    expect(isSafeDeezerImageUrl("https://evil.com/x.jpg")).toBe(false);
    expect(isSafeDeezerImageUrl("https://dzcdn.net.evil.com/x.jpg")).toBe(false); // look-alike
    expect(isSafeDeezerImageUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafeDeezerImageUrl("https://localhost/x")).toBe(false);
    expect(isSafeDeezerImageUrl("not a url")).toBe(false);
    expect(isSafeDeezerImageUrl(undefined)).toBe(false);
    expect(isSafeDeezerImageUrl("")).toBe(false);
  });
});

describe("deezerArtistImageUrl", () => {
  beforeEach(() => mockGet.mockReset());

  it("queries Deezer by name and returns the largest safe picture", async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ name: "Radiohead", picture_xl: XL, picture_big: BIG }] },
    });
    expect(await deezerArtistImageUrl("Radiohead")).toEqual(XL);
    expect(mockGet).toHaveBeenCalledWith(
      "https://api.deezer.com/search/artist",
      expect.objectContaining({ params: { q: "Radiohead", limit: 1 } })
    );
  });

  it("falls back to a smaller picture when xl is absent", async () => {
    mockGet.mockResolvedValue({ data: { data: [{ name: "x", picture_big: BIG }] } });
    expect(await deezerArtistImageUrl("x")).toEqual(BIG);
  });

  it("returns undefined when no artist matches (a cacheable negative)", async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    expect(await deezerArtistImageUrl("zzz-no-match")).toBeUndefined();
  });

  it("returns undefined for an unsafe (non-CDN) picture url", async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ name: "x", picture_xl: "https://evil.example/x.jpg" }] },
    });
    expect(await deezerArtistImageUrl("x")).toBeUndefined();
  });

  it("PROPAGATES transient errors so they are not cached as a permanent 'no image'", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    await expect(deezerArtistImageUrl("Radiohead")).rejects.toThrow("network down");
  });

  it("returns undefined for a blank name without calling Deezer", async () => {
    expect(await deezerArtistImageUrl("  ")).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty (falsy) name without calling Deezer", async () => {
    // Exercises the `(name || "")` falsy arm: an empty name falls back to "" which trims to "",
    // so the search is skipped. Discriminates from a mutant fallback like `name || "x"`, which
    // would call axios with q="x".
    expect(await deezerArtistImageUrl("")).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});

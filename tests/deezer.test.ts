import axios from "axios";
import { deezerArtistImageUrl } from "../src/deezer";

jest.mock("axios");
const mockGet = axios.get as jest.Mock;

describe("deezerArtistImageUrl", () => {
  beforeEach(() => mockGet.mockReset());

  it("queries Deezer by name and returns the largest available picture", async () => {
    mockGet.mockResolvedValue({
      data: {
        data: [
          {
            name: "Radiohead",
            picture_xl: "https://cdn/xl.jpg",
            picture_big: "https://cdn/big.jpg",
            picture_medium: "https://cdn/med.jpg",
          },
        ],
      },
    });

    const url = await deezerArtistImageUrl("Radiohead");

    expect(url).toEqual("https://cdn/xl.jpg");
    expect(mockGet).toHaveBeenCalledWith(
      "https://api.deezer.com/search/artist",
      expect.objectContaining({ params: { q: "Radiohead", limit: 1 } })
    );
  });

  it("falls back to a smaller picture when xl is absent", async () => {
    mockGet.mockResolvedValue({
      data: { data: [{ name: "x", picture_big: "https://cdn/big.jpg" }] },
    });
    expect(await deezerArtistImageUrl("x")).toEqual("https://cdn/big.jpg");
  });

  it("returns undefined when no artist matches", async () => {
    mockGet.mockResolvedValue({ data: { data: [] } });
    expect(await deezerArtistImageUrl("zzz-no-match")).toBeUndefined();
  });

  it("returns undefined (best-effort) on a network/parse error", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    expect(await deezerArtistImageUrl("Radiohead")).toBeUndefined();
  });

  it("returns undefined for a blank name without calling Deezer", async () => {
    expect(await deezerArtistImageUrl("  ")).toBeUndefined();
    expect(mockGet).not.toHaveBeenCalled();
  });
});

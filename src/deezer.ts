import axios from "axios";
import logger from "./logger";

const DEEZER_SEARCH = "https://api.deezer.com/search/artist";

// Query Deezer's free (no API key) API for an artist photo, returning the largest available
// picture URL or undefined if there's no match / on any error (best-effort - a missing photo must
// never break a browse). This is bonob's artist-image source because Navidrome only serves a
// placeholder star (Spotify was removed in 0.61 and Last.fm's artist images are deprecated).
export async function deezerArtistImageUrl(
  name: string
): Promise<string | undefined> {
  const q = (name || "").trim();
  if (!q) return undefined;
  try {
    const res = await axios.get(DEEZER_SEARCH, {
      params: { q, limit: 1 },
      timeout: 5000,
    });
    const artist = res.data?.data?.[0];
    const url =
      artist?.picture_xl || artist?.picture_big || artist?.picture_medium;
    return typeof url === "string" && url.length > 0 ? url : undefined;
  } catch (e) {
    logger.debug(`Deezer artist-image lookup failed for '${q}': ${e}`);
    return undefined;
  }
}

import axios from "axios";

const DEEZER_SEARCH = "https://api.deezer.com/search/artist";

// Only proxy images from Deezer's own CDN over HTTPS. Deezer's search response is third-party
// data; without this an attacker who can influence it (or a malicious redirect) could make bonob
// fetch an arbitrary/internal URL (SSRF). Deezer artist images live on *.dzcdn.net.
export function isSafeDeezerImageUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname === "dzcdn.net" || u.hostname.endsWith(".dzcdn.net"))
    );
  } catch {
    return false;
  }
}

// Query Deezer's free (no API key) API for an artist photo, returning the largest available
// picture URL, or undefined when there is genuinely no usable match (empty result / non-CDN URL).
//
// Transient failures (network error, timeout, 429/5xx) are allowed to THROW so the caller's cache
// does not memoise a one-off outage as a permanent "no image" for a day. Only a real no-match is a
// cacheable undefined. This is bonob's artist-image source because Navidrome only serves a
// placeholder star (Spotify removed in 0.61, Last.fm's artist images deprecated).
export async function deezerArtistImageUrl(
  name: string
): Promise<string | undefined> {
  const q = (name || "").trim();
  if (!q) return undefined;
  const res = await axios.get(DEEZER_SEARCH, {
    params: { q, limit: 1 },
    timeout: 5000,
  });
  const artist = res.data?.data?.[0];
  const url =
    artist?.picture_xl || artist?.picture_big || artist?.picture_medium;
  return isSafeDeezerImageUrl(url) ? url : undefined;
}

import { taskEither as TE } from "fp-ts";
import { pipe } from "fp-ts/lib/function";
import {
  Credentials,
  MusicService,
  ArtistSummary,
  TrackSummary,
  Result,
  slice2,
  AlbumQuery,
  ArtistQuery,
  MusicLibrary,
  Album,
  AlbumSummary,
  Rating,
  Artist,
  AuthFailure,
  AuthSuccess,
  ArtistRecord,
} from "./music_library";
import {
  Subsonic,
  CustomPlayers,
  NO_CUSTOM_PLAYERS,
  asToken,
  parseToken,
  artistImageURN,
  asYear,
  isValidImage,
  SONOS_CLIENT_INFO,
  classifyCoverArtError,
  CoverArtUnavailableError,
  CoverArtUpstreamError,
  headerString,
  ALBUM_SCAN_PAGE_SIZE,
  song,
} from "./subsonic";
import _ from "underscore";

import logger from "./logger";
import { assertSystem, BUrn } from "./burn";
import { AlbumIndex, MAX_ALBUMS_FLAT } from "./album_index";
import { withTimeout, describeReason } from "./timeout";

// Cap the Last.fm-backed artist enrichment so a slow-but-succeeding getArtistInfo can't stall the
// artist browse past Sonos's ~5s timeout.
// Budget for the external (Last.fm) artist enrichment. This runs INSIDE Sonos's 4500ms browse
// deadline, so at the old 3500ms it left only ~1000ms for login + getArtist + serialization, and
// getExtendedMetadata:artist was measured breaching the deadline on the live library
// (2026-08-05 09:15) and degrading to an empty result Sonos could not render. Trimmed so the worst
// case still fits under the deadline; the lookup is also cached now, so this cap is only ever paid
// on a cold artist rather than on every open.
// How many results to ask Subsonic for per search category.
//
// Measured from the real Sonos app: it requests count=20 for the search SUMMARY screen and
// count=50 when a category is EXPANDED (it never pages - index is always 0). At the old cap of 20
// the expanded view could only ever show 20 of the 50 it asked for, on a 113k-album library where
// far more matched. 50 matches what the client actually wants.
//
// Not larger: the app never asks for more, search3 latency grows with the count (tracks is the
// slowest category over 831k tracks), and every returned row costs a tile plus an art fetch.
export const SEARCH_RESULT_COUNT = 50;

export const ARTIST_INFO_TIMEOUT_MS = 2500;

// Cap the optional Last.fm-backed top-songs lookup: a slow/rejecting getTopSongs must not stall or
// break browsing an artist's Top Songs - degrade to no songs.
export const TOP_SONGS_TIMEOUT_MS = 3500;

export class SubsonicMusicService implements MusicService {
  subsonic: Subsonic;
  customPlayers: CustomPlayers;
  useTranscode: boolean;

  constructor(
    subsonic: Subsonic,
    customPlayers: CustomPlayers = NO_CUSTOM_PLAYERS,
    useTranscode: boolean = true
  ) {
    this.subsonic = subsonic;
    this.customPlayers = customPlayers;
    this.useTranscode = useTranscode;
  }

  generateToken = (
    credentials: Credentials
  ): TE.TaskEither<AuthFailure, AuthSuccess> => 
    pipe(
      this.subsonic.ping(credentials),
      TE.map(() => ({
        serviceToken: asToken(credentials),
        userId: credentials.username,
        nickname: credentials.username,
      }))
    );

  refreshToken = (serviceToken: string) =>
    this.generateToken(parseToken(serviceToken));

  login = async (token: string) => {
    const credentials = parseToken(token);
    // Pre-warm the (slow, cold) artist list AND the album index for this session in the
    // background so the first browse isn't cold. Fire-and-forget; the cache coalesces +
    // refreshes lazily, and the album-index scan (multi-minute) runs off the browse path.
    this.subsonic.warmArtists(credentials);
    // Favourite Songs is unpaginated upstream and cannot be fetched inside Sonos's browse deadline
    // at scale, so it is only ever served from cache. Warm it here or the first browse of every
    // session shows the placeholder.
    this.subsonic.warmStarredSongs(credentials);
    // Only build the (heavy) album index for large catalogs; small libraries serve the flat
    // Albums list live and never scan. Chain off the album count (cheap once artists warm).
    this.subsonic
      .albumCount(credentials)
      .then((count) => {
        if (count > MAX_ALBUMS_FLAT) this.subsonic.warmAlbumIndex(credentials);
      })
      .catch(() => undefined);
    return this.libraryFor(credentials);
  };

  private libraryFor = (
    credentials: Credentials
  ): Promise<SubsonicMusicLibrary> => {
    return Promise.resolve(new SubsonicMusicLibrary(
      this.subsonic,
      credentials,
      this.customPlayers,
      this.useTranscode
    ));
  };
}

export class SubsonicMusicLibrary implements MusicLibrary {
  subsonic: Subsonic;
  credentials: Credentials;
  customPlayers: CustomPlayers;
  useTranscode: boolean;

  constructor(
    subsonic: Subsonic,
    credentials: Credentials,
    customPlayers: CustomPlayers,
    useTranscode: boolean = true
  ) {
    this.subsonic = subsonic;
    this.credentials = credentials;
    this.customPlayers = customPlayers;
    this.useTranscode = useTranscode;
  }

  // todo: q needs to support greater than the max page size supported by subsonic
  // maybe subsonic should error?
  artists = (q: ArtistQuery): Promise<Result<ArtistSummary>> =>
    this.subsonic
      .getArtists(this.credentials)
      .then(slice2(q))
      .then(([page, total]) => ({
        total,
        results: page,
      }));

  artist = async (id: string): Promise<Artist> =>
    Promise.all([
      this.subsonic.getArtist(this.credentials, id),
      // getArtistInfo is external enrichment (Last.fm: bio + similar + extra images) and is flaky
      // and rate-limited. Fast-scrolling into artists fires many of these; a single failure must
      // NOT reject the whole artist browse (Sonos "something went wrong"). Degrade to no bio/
      // similar/images and still serve the artist + its albums.
      withTimeout(
        this.subsonic.getArtistInfo(this.credentials, id),
        ARTIST_INFO_TIMEOUT_MS,
        {
          biography: undefined,
          similarArtist: [],
          images: { s: undefined, m: undefined, l: undefined },
        }
      ).catch(() => ({
        biography: undefined,
        similarArtist: [],
        images: { s: undefined, m: undefined, l: undefined },
      })),
    ]).then(([artist, artistInfo]) => ({
      id: artist.id,
      name: artist.name,
      image: artistImageURN(
        {
          artistId: artist.id,
          name: artist.name,
          artistImageURL: [
            artist.artistImageUrl,
            // todo: subsonic.artistInfo should just return a valid image or undefined, then the music lib just chooses first undefined
            // out of artist.image and artistInfo.image
            artistInfo.images.l,
            artistInfo.images.m,
            artistInfo.images.s,
            // todo: do we still need this isValidImage?
          ].find(isValidImage),
        },
        this.subsonic.preferDeezerArtistArt
      ),
      albums: artist.albums,
      similarArtists: artistInfo.similarArtist,
      biography: artistInfo.biography,
    }));

  albums = async (q: AlbumQuery): Promise<Result<AlbumSummary>> =>
    this.subsonic.getAlbumList2(this.credentials, q);

  albumCount = (): Promise<number> =>
    this.subsonic.albumCount(this.credentials);

  peekAlbumCount = (): Promise<number> | undefined =>
    this.subsonic.peekAlbumCount(this.credentials);

  peekArtists = (): Promise<unknown> | undefined =>
    this.subsonic.peekArtists(this.credentials);

  artistIndex = (): Promise<AlbumIndex<ArtistRecord>> =>
    this.subsonic.getArtistIndex(this.credentials);

  peekArtistIndex = (): Promise<AlbumIndex<ArtistRecord>> | undefined =>
    this.subsonic.peekArtistIndex(this.credentials);

  albumIndex = (): Promise<AlbumIndex<AlbumSummary>> =>
    this.subsonic.getAlbumIndex(this.credentials);

  peekAlbumIndex = (): Promise<AlbumIndex<AlbumSummary>> | undefined =>
    this.subsonic.peekAlbumIndex(this.credentials);

  warmAlbumIndex = (): void => this.subsonic.warmAlbumIndex(this.credentials);

  warmArtistIndex = (): void => this.subsonic.warmArtists(this.credentials);

  album = (id: string): Promise<Album> =>
    this.subsonic.getAlbum(this.credentials, id);

  genres = () => 
    this.subsonic.getGenres(this.credentials);

  track = (trackId: string) =>
    this.subsonic.getTrack(this.credentials, trackId);

  rate = (trackId: string, rating: Rating) => 
    // todo: this is a bit odd
    Promise.resolve(true)
      .then(() => {
        if (rating.stars >= 0 && rating.stars <= 5) {
          return this.subsonic.getTrack(this.credentials, trackId);
        } else {
          throw `Invalid rating.stars value of ${rating.stars}`;
        }
      })
      .then((track) => {
        const thingsToUpdate = [];
        if (track.rating.love != rating.love) {
          // Invalidate AFTER the write settles, not before. Invalidating first leaves a window
          // where a concurrent Favourite Songs browse (Sonos re-polls on getLastUpdate) finds a
          // cold key, kicks a warm, and re-caches the PRE-star list if getStarred2 wins the race
          // against the in-flight star - which is exactly the staleness the invalidation exists
          // to prevent, just harder to reproduce.
          thingsToUpdate.push(
            (rating.love ? this.subsonic.star : this.subsonic.unstar)(this.credentials,{ id: trackId })
              .then((ok) => {
                this.subsonic.invalidateStarredSongs(this.credentials);
                return ok;
              })
          );
        }
        if (track.rating.stars != rating.stars) {
          thingsToUpdate.push(
            this.subsonic.setRating(this.credentials, trackId, rating.stars)
          );
        }
        return Promise.all(thingsToUpdate);
      })
      .then(() => true)
      .catch((e) => {
        // The user taps a heart or sets stars and Sonos reports success regardless (rateItem
        // discards this boolean), so a dropped rating is invisible at BOTH ends. This is the
        // surface a user touches most often, and it was the one degradation in the codebase with
        // no log line at all.
        logger.warn(
          `Rating ${trackId} failed and was silently dropped: ${describeReason(e)}`
        );
        return false;
      });

  stream = async ({
    trackId,
    range,
  }: {
    trackId: string;
    range: string | undefined;
  }) => {
    if (this.useTranscode) {
      const extensions = await this.subsonic.getOpenSubsonicExtensions(this.credentials);
      const hasTranscoding = extensions.some((ext) => ext.name === "transcoding");

      if (hasTranscoding) {
        const decision = await this.subsonic.getTranscodeDecision(
          this.credentials,
          trackId,
          SONOS_CLIENT_INFO
        );
        logger.debug(`Transcoding decision is: ${JSON.stringify(decision)}`)
        if (decision && !decision.canDirectPlay && decision.canTranscode && decision.transcodeParams) {
          return this.subsonic.getTranscodeStream(
            this.credentials,
            trackId,
            decision.transcodeParams,
            range
          );
        }
      }
    }

    const track = await this.subsonic.getTrack(this.credentials, trackId);
    return this.subsonic.stream(this.credentials, trackId, track.encoding.player, range);
  };

  coverArt = async (coverArtURN: BUrn, size?: number) => {
    // A non-Subsonic/invalid URN is not transient: there is no art to fetch here, so return
    // undefined (the HTTP layer answers 404). assertSystem throws on a system mismatch.
    let artId: string;
    try {
      const system = assertSystem(coverArtURN, "subsonic");
      artId = system.resource.split(":")[1]!;
    } catch {
      return undefined;
    }

    try {
      const res = await this.subsonic.getCoverArt(
        this.credentials,
        artId,
        size
      );
      return {
        // Absent content-type collapses to "", which fails the image/* check at the HTTP layer, so
        // a 200 carrying no content type is refused rather than served as art of unknown type.
        contentType: headerString(res.headers["content-type"]) ?? "",
        data: Buffer.from(res.data, "binary"),
      };
    } catch (e) {
      // Classify the upstream outcome. NEVER log `${e}`, the raw URN, username, password/token,
      // upstream URL/query, or response body here (this also removes the prior `[object Object]`
      // defect): a transient throttle is expected and must not leak identifiers. Sanitize every
      // thrown value into a typed error carrying no upstream body/URL/credential, so the HTTP layer
      // can map it without leaking.
      const category = classifyCoverArtError(e);
      if (category === "absent") return undefined; // genuine HTTP 404 -> cacheable absence (404)
      if (category === "transient") {
        // A coordinator busy/timeout is already a CoverArtUnavailableError (a subclass): re-throw
        // as-is so the busy signal survives. An axios 429/5xx/timeout is wrapped in a fresh
        // CoverArtUnavailableError so the upstream body/URL never leak through to the HTTP layer.
        throw e instanceof CoverArtUnavailableError ? e : new CoverArtUnavailableError();
      }
      // "other" (e.g. 400/401/403 / unexpected): never become undefined/404. Wrap in a sanitized
      // typed error carrying only the category - no upstream body, URL, id, or credential.
      throw new CoverArtUpstreamError(category);
    }
  };

  // todo: unit test the difference between scrobble and nowPlaying
  scrobble = async (id: string) =>
    this.subsonic.scrobble(this.credentials, id, true);

  nowPlaying = async (id: string) =>
    this.subsonic.scrobble(this.credentials, id, false);

  searchArtists = async (query: string) =>
    this.subsonic
      .search3(this.credentials, { query, artistCount: SEARCH_RESULT_COUNT })
      .then(({ artists }) =>
        artists.map((artist) => ({
          id: artist.id,
          name: artist.name,
          image: artistImageURN(
            {
              artistId: artist.id,
              name: artist.name,
              artistImageURL: artist.artistImageUrl,
            },
            this.subsonic.preferDeezerArtistArt
          ),
        }))
      );

  searchAlbums = async (query: string) =>
    this.subsonic
      .search3(this.credentials, { query, albumCount: SEARCH_RESULT_COUNT })
      .then(({ albums }) => this.subsonic.toAlbumSummary(albums));

  searchTracks = async (query: string) => {
    const { songs } = await this.subsonic.search3(this.credentials, {
      query,
      songCount: SEARCH_RESULT_COUNT,
    });
    // search3 returns complete song records, so a hit carrying an albumId resolves its album from
    // the song itself — one upstream call total, independent of how many match. This used to run
    // getTrack (getSong + getAlbum) per hit: 20 matches cost 41 round trips against the 4.5s SMAPI
    // deadline, and getAlbum returns the album's WHOLE track list, so it pulled 20 full album
    // payloads to read 20 names. The old allSettled then dropped every failure SILENTLY, so a search
    // that lost all 20 fan-out calls returned [] indistinguishable from "nothing matched" — the
    // reported "songs never come back".
    //
    // A song with no albumId would render as a DEAD album tile (browsable but unresolvable: tapping
    // it asks getMetadata for "album:" and sticks on "Loading, please try again" forever). For those
    // hits ONLY — never all of them — make a bounded best-effort getSong to recover the album. Each
    // that still comes back without an albumId, or whose lookup fails, is dropped INDIVIDUALLY
    // rather than poisoning the result; a missing result beats a dead tile. The common case (every
    // hit carries an albumId) never fires the recovery, so cost stays O(1) in the match count.
    const recovered = await Promise.all(
      songs
        .filter((s) => !s.albumId)
        .map((s) =>
          this.subsonic
            .getSong(this.credentials, s.id)
            .then((full) => (full && full.albumId ? full : undefined))
            .catch(() => undefined)
        )
    );
    const withAlbum = songs.filter((s) => !!s.albumId);
    const rescued: song[] = [];
    for (const full of recovered) if (full) rescued.push(full);
    return this.subsonic.toTracks([...withAlbum, ...rescued]);
  };

  playlists = async () =>
    this.subsonic.playlists(this.credentials);

  playlist = async (id: string) =>
    this.subsonic.playlist(this.credentials, id);

  // Subsonic's updatePlaylist takes a name, so a rename is the same call the add/remove path uses.
  renamePlaylist = async (id: string, name: string) =>
    this.subsonic.updatePlaylist(this.credentials, id, { name });

  createPlaylist = async (name: string) =>
    this.subsonic.createPlayList(this.credentials, name);

  deletePlaylist = async (id: string) =>
    this.subsonic.deletePlayList(this.credentials, id);

  addToPlaylist = async (playlistId: string, trackId: string) =>
    this.subsonic.updatePlaylist(this.credentials, playlistId, { songIdToAdd: trackId });

  removeFromPlaylist = async (playlistId: string, indicies: number[]) =>
    this.subsonic.updatePlaylist(this.credentials, playlistId, { songIndexToRemove: indicies });

  similarSongs = async (id: string) => 
    this.subsonic.getSimilarSongs2(this.credentials, id)

  topSongs = async (artistId: string): Promise<TrackSummary[]> =>
    // Top Songs is Last.fm-backed (getTopSongs) and optional: a slow or failing lookup must not
    // stall or reject the browse - degrade to no songs (an empty, valid Top Songs list).
    //
    // But degrading SILENTLY is how this section sat empty on the live library while upstream was
    // healthy (36 songs, 770ms): the chain is getArtist - which exists only to turn the id into a
    // NAME, and measured 1821ms for that artist - then getTopSongs, both inside one 3500ms budget.
    // An empty Top Songs and a Top Songs that timed out look identical to the user, so both ends
    // are now named in the log.
    withTimeout(
      this.subsonic
        .getArtist(this.credentials, artistId)
        .then(({ name }) => this.subsonic.getTopSongs(this.credentials, name)),
      TOP_SONGS_TIMEOUT_MS,
      [] as TrackSummary[],
      `topSongs:${artistId}`
    ).catch((e) => {
      logger.warn(
        `Top Songs for ${artistId} failed and degraded to an empty list: ${describeReason(e)}`
      );
      return [] as TrackSummary[];
    });

  starredSongs = async () =>
    this.subsonic.starredSongs(this.credentials);

  // Settled starred songs, or undefined when cold/in-flight. The Favourite Songs browse uses this
  // so it never blocks on the unpaginated getStarred2 (8.6s at 11.5k songs, vs a 4500ms deadline).
  peekStarredSongs = () => this.subsonic.peekStarredSongs(this.credentials);

  // Flat track list for Sonos's recursive enumeration when playing an artist. Bounded and cached
  // in the Subsonic layer; see MAX_RECURSIVE_ALBUMS / MAX_RECURSIVE_TRACKS.
  artistTracks = async (artistId: string) =>
    this.subsonic.artistTracks(this.credentials, artistId);

  radioStations = async () =>
    this.subsonic.getInternetRadioStations(this.credentials);

  radioStation = async (id: string) =>
    this.radioStations().then((it) => it.find((station) => station.id === id)!);

  years = async () => {
    // O(1) when the catalog index is warm: the distinct years were collected during the index scan
    // (which touches every album anyway), so serve them straight off it. The index is built only for
    // a catalog large enough to need A-Z bucketing; a small catalog has none and falls through.
    const indexed = this.subsonic.peekAlbumIndex(this.credentials);
    if (indexed) {
      const idx = await indexed;
      if (idx.years && idx.years.length > 0) {
        return idx.years.map((y) => ({ ...asYear(y) })).reverse(); // stored ascending → newest first
      }
    }
    // No index (small catalog, or a large one whose index is not warm yet): page the album list and
    // collect the distinct years. The old code asked getAlbumList2 for _count 100000, but the server
    // caps a page at 500, so it SILENTLY returned only the first page's years as if they were the
    // whole set. This pages until the catalog actually ends. The walk is bounded by MAX_ALBUMS_FLAT
    // (the small-catalog threshold) so a not-yet-warm LARGE catalog degrades bounded rather than
    // paging millions of rows inline; that rare case is logged, never silent.
    const years = new Set<string>();
    let complete = false;
    for (let index = 0; index < MAX_ALBUMS_FLAT; index += ALBUM_SCAN_PAGE_SIZE) {
      const { results } = await this.subsonic.getAlbumList2(this.credentials, {
        _index: index,
        _count: ALBUM_SCAN_PAGE_SIZE,
        type: "alphabeticalByArtist",
      });
      for (const album of results) if (album.year) years.add(album.year);
      if (results.length < ALBUM_SCAN_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      logger.warn(
        `years() had no warm album index and hit the ${MAX_ALBUMS_FLAT}-album paging bound; the ` +
          `year list may be incomplete until the album index finishes building.`
      );
    }
    return [...years].sort().map((y) => ({ ...asYear(y) })).reverse();
  };
}

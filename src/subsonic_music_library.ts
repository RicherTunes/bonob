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
} from "./subsonic";
import _ from "underscore";

import logger from "./logger";
import { assertSystem, BUrn } from "./burn";
import { AlbumIndex, MAX_ALBUMS_FLAT } from "./album_index";
import { withTimeout } from "./timeout";

// Cap the Last.fm-backed artist enrichment so a slow-but-succeeding getArtistInfo can't stall the
// artist browse past Sonos's ~5s timeout.
export const ARTIST_INFO_TIMEOUT_MS = 3500;

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

  albumIndex = (): Promise<AlbumIndex<AlbumSummary>> =>
    this.subsonic.getAlbumIndex(this.credentials);

  peekAlbumIndex = (): Promise<AlbumIndex<AlbumSummary>> | undefined =>
    this.subsonic.peekAlbumIndex(this.credentials);

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
          thingsToUpdate.push(
            (rating.love ? this.subsonic.star : this.subsonic.unstar)(this.credentials,{ id: trackId })
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
      .catch(() => false);

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
      .search3(this.credentials, { query, artistCount: 20 })
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
      .search3(this.credentials, { query, albumCount: 20 })
      .then(({ albums }) => this.subsonic.toAlbumSummary(albums));

  searchTracks = async (query: string) =>
    this.subsonic
      .search3(this.credentials, { query, songCount: 20 })
      // search3 returns complete song records, so the album is resolved from each song rather than
      // re-fetched. This used to run getTrack per hit - itself getSong + getAlbum - so 20 matches
      // cost 41 round trips against the 4.5s SMAPI deadline, and getAlbum returns the album's whole
      // track list, so it also pulled 20 full album payloads to read 20 album names.
      //
      // The old Promise.allSettled was defending the wrong thing: it stopped one slow track
      // rejecting the search, but every failure was dropped SILENTLY, so a search that lost all 20
      // fan-out calls returned an empty result indistinguishable from "nothing matched". That is
      // the reported "songs never come back". With no fan-out there is nothing to partially fail.
      //
      // A song with no albumId is dropped: the SMAPI search renders each hit as an album tile, and
      // a tile with an empty album id is browsable but unresolvable - tapping it asks getMetadata
      // for "album:" and lands on the "Loading, please try again" placeholder forever. The old
      // per-song fan-out dropped these too (getAlbum(undefined) simply failed), so this preserves
      // the previous user-visible behaviour rather than introducing a dead tile.
      .then(({ songs }) => this.subsonic.toTracks(songs.filter((s) => !!s.albumId)));

  playlists = async () =>
    this.subsonic.playlists(this.credentials);

  playlist = async (id: string) =>
    this.subsonic.playlist(this.credentials, id);

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
    withTimeout(
      this.subsonic
        .getArtist(this.credentials, artistId)
        .then(({ name }) => this.subsonic.getTopSongs(this.credentials, name)),
      TOP_SONGS_TIMEOUT_MS,
      [] as TrackSummary[]
    ).catch(() => [] as TrackSummary[]);

  starredSongs = async () =>
    this.subsonic.starredSongs(this.credentials);

  radioStations = async () =>
    this.subsonic.getInternetRadioStations(this.credentials);

  radioStation = async (id: string) =>
    this.radioStations().then((it) => it.find((station) => station.id === id)!);

  years = async () => {
    const q: AlbumQuery = {
      _index: 0,
      _count: 100000, // FIXME: better than this, probably doesnt work anyway as max _count is 500 or something
      type: "alphabeticalByArtist",
    };
    const years = this.subsonic
      .getAlbumList2(this.credentials, q)
      .then(({ results }) =>
        results
          .map((album) => album.year || "?")
          .filter((item, i, ar) => ar.indexOf(item) === i)
          .sort()
          .map((year) => ({
            ...asYear(year),
          }))
          .reverse()
      );
    return years;
  };
}

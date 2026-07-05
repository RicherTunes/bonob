describe("album index max container total config", () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
    jest.resetModules();
  });

  const loadAlbumIndex = () => {
    jest.resetModules();
    return require("../src/album_index") as typeof import("../src/album_index");
  };

  it("defaults to 20000", () => {
    process.env = { ...OLD_ENV };
    delete process.env["BNB_SONOS_MAX_CONTAINER_TOTAL"];

    const { MAX_ALBUMS_FLAT } = loadAlbumIndex();

    expect(MAX_ALBUMS_FLAT).toEqual(20000);
  });

  it("uses BNB_SONOS_MAX_CONTAINER_TOTAL so a small fixture requires bucketing", () => {
    process.env = { ...OLD_ENV, BNB_SONOS_MAX_CONTAINER_TOTAL: "2" };

    const {
      MAX_ALBUMS_FLAT,
      buildAlbumIndexFromPages,
      albumIndexLetters,
    } = loadAlbumIndex();
    const index = buildAlbumIndexFromPages([
      [
        { name: "Alpha" },
        { name: "Beta" },
        { name: "Charlie" },
      ],
    ]);

    expect(MAX_ALBUMS_FLAT).toEqual(2);
    expect(index.total).toBeGreaterThan(MAX_ALBUMS_FLAT);
    expect(albumIndexLetters(index).map((it) => it.key)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

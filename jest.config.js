module.exports = {
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/setup.js"],
  // Every test lives in tests/. `tsc` has rootDir "." and outDir "./build", so a prior `npm run
  // build` leaves COMPILED COPIES of these same tests in build/tests/*.js — jest would then run
  // each suite twice, the second time against stale JS.
  //
  // This must be `roots` (a PATH list, which jest normalizes per-platform) and not
  // test/modulePathIgnorePatterns (REGEXes matched against the absolute path). On Windows
  // "<rootDir>/build" expands to "C:\...\bonob-fork/build", which can never match the actual path
  // "C:\...\bonob-fork\build\tests\x.test.js" — so the ignore silently did nothing here and the
  // stale build/ suites ran anyway. Restricting discovery to tests/ is separator-agnostic and also
  // keeps build/ out of the haste module map.
  roots: ["<rootDir>/tests"],
  transform: {
    "^.+\\.tsx?$": ["@swc/jest", {
      jsc: {
        parser: { syntax: "typescript", tsx: false, decorators: true },
        target: "es2022",
      },
    }],
  },
  testTimeout: Number.parseInt(process.env["JEST_TIMEOUT"] || "5000")
};

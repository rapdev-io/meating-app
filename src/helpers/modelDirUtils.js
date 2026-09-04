const { app } = require("electron");
const os = require("os");
const fs = require("fs");
const path = require("path");

// Same rule as safeTempDir: native whisper/parakeet binaries crash on Windows
// when model paths contain spaces or non-ASCII (CJK / Cyrillic profile dirs).
function pathHasProblematicChars(candidate) {
  return !/^[\x21-\x7E]*$/.test(candidate);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// App rebrand (OpenWhispr -> Protein): every cache root candidate below is
// renamed in place from its old "openwhispr"/"OpenWhispr" folder to the new
// name the first time it's resolved, so existing installs keep their
// downloaded models and Qdrant/embedding data instead of re-downloading.
const CACHE_DIR_NAME = "protein";
const LEGACY_CACHE_DIR_NAME = "openwhispr";
const CACHE_DIR_DISPLAY_NAME = "Protein";
const LEGACY_CACHE_DIR_DISPLAY_NAME = "OpenWhispr";

function migrateCacheDirRename(legacyRoot, newRoot) {
  if (legacyRoot === newRoot || !fs.existsSync(legacyRoot) || fs.existsSync(newRoot)) return;

  try {
    fs.renameSync(legacyRoot, newRoot);
  } catch {
    // Cross-volume rename: copy then remove, so an interrupted copy can
    // never be mistaken for a fully migrated cache.
    try {
      fs.cpSync(legacyRoot, newRoot, { recursive: true });
      fs.rmSync(legacyRoot, { recursive: true, force: true });
    } catch {}
  }
}

function getAsciiSafeFallbackRoot() {
  const candidates = [
    {
      root: path.join(process.env.ProgramData || "C:\\ProgramData", CACHE_DIR_DISPLAY_NAME, "cache"),
      legacy: path.join(
        process.env.ProgramData || "C:\\ProgramData",
        LEGACY_CACHE_DIR_DISPLAY_NAME,
        "cache"
      ),
    },
    {
      root: path.join(process.env.SystemDrive || "C:", CACHE_DIR_DISPLAY_NAME, "cache"),
      legacy: path.join(process.env.SystemDrive || "C:", LEGACY_CACHE_DIR_DISPLAY_NAME, "cache"),
    },
  ];

  for (const { root, legacy } of candidates) {
    if (pathHasProblematicChars(root)) continue;
    migrateCacheDirRename(legacy, root);
    try {
      return ensureDir(root);
    } catch {}
  }

  return null;
}

function getPreferredCacheRoot(homeCache) {
  if (process.env.PROTEIN_CACHE_ROOT) {
    return process.env.PROTEIN_CACHE_ROOT;
  }

  if (process.platform === "win32") {
    const redirectedProfile = process.env.USERPROFILE;
    if (redirectedProfile && path.isAbsolute(redirectedProfile)) {
      const root = path.join(redirectedProfile, ".cache", CACHE_DIR_NAME);
      migrateCacheDirRename(path.join(redirectedProfile, ".cache", LEGACY_CACHE_DIR_NAME), root);
      return root;
    }
  }

  if (process.platform === "linux") {
    const xdgCacheHome = process.env.XDG_CACHE_HOME;
    if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) {
      const root = path.join(xdgCacheHome, CACHE_DIR_NAME);
      migrateCacheDirRename(path.join(xdgCacheHome, LEGACY_CACHE_DIR_NAME), root);
      return root;
    }
  }

  return homeCache;
}

// Only these subdirs resolve through getCacheRoot(). qdrant-data,
// embedding-models, and yt-dlp are read from the home cache directly by their
// managers (and tolerate non-ASCII paths), so they must stay put.
const RELOCATED_SUBDIRS = ["whisper-models", "parakeet-models", "diarization-models", "models"];

let migratedRootPair = null;

function rollbackMigration(completedMoves) {
  for (const move of completedMoves.reverse()) {
    try {
      if (!fs.existsSync(move.to)) continue;

      if (move.copied) {
        fs.cpSync(move.to, move.from, { recursive: true });
        fs.rmSync(move.to, { recursive: true, force: true });
      } else if (!fs.existsSync(move.from)) {
        fs.renameSync(move.to, move.from);
      }
    } catch {}
  }
}

function migrateLegacyModelDirs(legacyRoot, targetRoot) {
  const rootPair = `${legacyRoot}\0${targetRoot}`;
  if (migratedRootPair === rootPair) return true;

  const completedMoves = [];
  let staging = null;
  try {
    ensureDir(targetRoot);

    for (const subdir of RELOCATED_SUBDIRS) {
      const from = path.join(legacyRoot, subdir);
      const to = path.join(targetRoot, subdir);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;

      try {
        fs.renameSync(from, to);
        completedMoves.push({ from, to, copied: false });
      } catch {
        // Cross-volume move: copy to a staging dir first so an interrupted
        // copy can never be mistaken for a complete model dir.
        staging = `${to}.migrating`;
        fs.rmSync(staging, { recursive: true, force: true });
        fs.cpSync(from, staging, { recursive: true });
        fs.renameSync(staging, to);
        staging = null;
        completedMoves.push({ from, to, copied: true });
      }
    }

    for (const move of completedMoves) {
      if (move.copied) fs.rmSync(move.from, { recursive: true, force: true });
    }

    migratedRootPair = rootPair;
    return true;
  } catch {
    if (staging) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {}
    }
    rollbackMigration(completedMoves);
    return false;
  }
}

function getCacheRoot() {
  const homeDir = app?.getPath?.("home") || os.homedir();
  const homeCache = path.join(homeDir, ".cache", CACHE_DIR_NAME);
  migrateCacheDirRename(path.join(homeDir, ".cache", LEGACY_CACHE_DIR_NAME), homeCache);
  let targetRoot = getPreferredCacheRoot(homeCache);

  if (process.platform === "win32" && pathHasProblematicChars(targetRoot)) {
    targetRoot = getAsciiSafeFallbackRoot() || homeCache;
  }

  if (targetRoot === homeCache) return homeCache;
  return migrateLegacyModelDirs(homeCache, targetRoot) ? targetRoot : homeCache;
}

function getModelsDirForService(service) {
  return path.join(getCacheRoot(), `${service}-models`);
}

module.exports = {
  getCacheRoot,
  getModelsDirForService,
  pathHasProblematicChars,
  migrateCacheDirRename,
  CACHE_DIR_NAME,
  LEGACY_CACHE_DIR_NAME,
};

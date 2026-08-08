#!/usr/bin/env node
// Build the pinned sfizz CLI used by Aria's isolated SFZ runtime sidecar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(ROOT, "engines", "sfizz.json");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const short = manifest.commit.slice(0, 12);
const engineHome = process.env.ARIA_SFIZZ_ENGINE_HOME
  ? path.resolve(process.env.ARIA_SFIZZ_ENGINE_HOME)
  : path.join(os.homedir(), ".aria", "engines", "sfizz");
const target = path.join(engineHome, short);
const binary = path.join(target, manifest.binaryRelativePath);
const metadataFile = path.join(target, "install.json");
const jobs = Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 8));

const sha256 = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (program, args, cwd = ROOT) =>
  execFileSync(program, args, { cwd, stdio: "inherit" });
const capture = (program, args, cwd = ROOT) =>
  execFileSync(program, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function assertSafeRelativePath(label, value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value))
    throw new Error(`${label} must be a non-empty relative path`);
  const parts = value.split(/[\\/]+/);
  if (parts.includes("..") || parts.includes("."))
    throw new Error(`${label} must not contain '.' or '..': ${value}`);
}

function assertSha256(label, value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${label} must be a lowercase SHA-256 hash`);
}

if (!/^[a-f0-9]{40}$/.test(manifest.commit))
  throw new Error("sfizz manifest commit must be a full 40-character Git hash");
assertSafeRelativePath("binaryRelativePath", manifest.binaryRelativePath);

const submodules = manifest.submodules.map((submodulePath, index) => {
  assertSafeRelativePath(`submodules[${index}]`, submodulePath);
  return submodulePath;
});
if (new Set(submodules).size !== submodules.length)
  throw new Error("sfizz manifest contains duplicate submodule paths");

const patchSpecs = manifest.patches.map((spec, index) => {
  assertSafeRelativePath(`patches[${index}].file`, spec.file);
  assertSha256(`patches[${index}].sha256`, spec.sha256);
  const absoluteFile = path.join(ROOT, spec.file);
  if (!fs.existsSync(absoluteFile)) throw new Error(`sfizz patch is missing: ${absoluteFile}`);
  if (sha256(absoluteFile) !== spec.sha256)
    throw new Error(`sfizz patch checksum mismatch: ${absoluteFile}`);
  return { file: spec.file, sha256: spec.sha256, absoluteFile };
});

const licenseTargets = new Set();
const licenseSpecs = manifest.licenseFiles.map((spec, index) => {
  assertSafeRelativePath(`licenseFiles[${index}].source`, spec.source);
  if (typeof spec.component !== "string" || spec.component.length === 0)
    throw new Error(`licenseFiles[${index}].component must be a non-empty string`);
  if (typeof spec.target !== "string" || spec.target.length === 0 ||
      spec.target === "." || spec.target === ".." || path.basename(spec.target) !== spec.target)
    throw new Error(`licenseFiles[${index}].target must be one collision-safe file name`);
  const collisionKey = spec.target.toLocaleLowerCase("en-US");
  if (licenseTargets.has(collisionKey))
    throw new Error(`duplicate sfizz license target: ${spec.target}`);
  licenseTargets.add(collisionKey);
  return { component: spec.component, source: spec.source, target: spec.target };
});

const expectedPatches = patchSpecs.map(({ file, sha256: hash }) => ({ file, sha256: hash }));
const expectedManifestSha256 = sha256(manifestFile);

function smokeBinary(binaryFile) {
  const stat = fs.lstatSync(binaryFile);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`sfizz binary is not a regular file: ${binaryFile}`);
  if ((stat.mode & 0o111) === 0)
    throw new Error(`sfizz binary is not executable: ${binaryFile}`);
  const output = execFileSync(binaryFile, ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000
  });
  if (!output.includes("Render a midi file through an SFZ file") || !output.includes("Usage:"))
    throw new Error(`sfizz binary returned unexpected help output: ${binaryFile}`);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateInstalled() {
  try {
    if (!fs.existsSync(binary) || !fs.existsSync(metadataFile)) return false;
    const installed = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    if (installed.engine !== manifest.id ||
        installed.integrationStatus !== "cli-build-verified-runtime-sidecar" ||
        installed.source !== manifest.source ||
        installed.commit !== manifest.commit ||
        installed.license !== manifest.license ||
        installed.manifestSha256 !== expectedManifestSha256 ||
        installed.platform !== process.platform || installed.arch !== process.arch ||
        installed.binaryRelativePath !== manifest.binaryRelativePath ||
        !sameJson(installed.patches, expectedPatches) ||
        installed.binarySha256 !== sha256(binary)) return false;

    if (!Array.isArray(installed.licenses) || installed.licenses.length !== licenseSpecs.length)
      return false;
    for (let index = 0; index < licenseSpecs.length; index++) {
      const expected = licenseSpecs[index];
      const recorded = installed.licenses[index];
      if (recorded.component !== expected.component || recorded.source !== expected.source ||
          recorded.target !== expected.target || typeof recorded.sha256 !== "string") return false;
      const licenseFile = path.join(target, "licenses", expected.target);
      if (!fs.existsSync(licenseFile) || recorded.sha256 !== sha256(licenseFile)) return false;
    }

    if (!Array.isArray(installed.submodules) || installed.submodules.length !== submodules.length)
      return false;
    for (let index = 0; index < submodules.length; index++) {
      const recorded = installed.submodules[index];
      if (recorded.path !== submodules[index] ||
          typeof recorded.commit !== "string" || !/^[a-f0-9]{40}$/.test(recorded.commit)) return false;
    }

    smokeBinary(binary);
    return true;
  } catch (error) {
    console.warn(`Existing sfizz install failed validation: ${error.message}`);
    return false;
  }
}

fs.mkdirSync(engineHome, { recursive: true });
if (validateInstalled()) {
  console.log(`sfizz CLI is already installed and verified: ${binary}`);
  process.exit(0);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "aria-sfizz-build-"));
const source = path.join(workspace, "source");
const build = path.join(workspace, "build");
const stage = fs.mkdtempSync(path.join(engineHome, `.${short}.stage-`));
const stageBinary = path.join(stage, manifest.binaryRelativePath);
let published = false;

try {
  // Fetch exactly the reviewed commit with a one-commit shallow history.
  run("git", ["init", "--quiet", source]);
  run("git", ["remote", "add", "origin", manifest.source], source);
  run("git", ["fetch", "--depth", "1", "--no-tags", "origin", manifest.commit], source);
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
  const checkedOutCommit = capture("git", ["rev-parse", "HEAD"], source);
  if (checkedOutCommit !== manifest.commit)
    throw new Error(`sfizz checkout mismatch: expected ${manifest.commit}, got ${checkedOutCommit}`);
  if (capture("git", ["rev-parse", "--is-shallow-repository"], source) !== "true")
    throw new Error("sfizz source checkout is not shallow");

  // These are the direct build dependencies only. Nested test submodules stay uninitialized.
  run("git", ["submodule", "update", "--init", "--depth", "1", "--jobs", String(jobs), "--", ...submodules], source);
  const installedSubmodules = submodules.map(submodulePath => ({
    path: submodulePath,
    commit: capture("git", ["rev-parse", "HEAD"], path.join(source, submodulePath))
  }));

  for (const patch of patchSpecs) {
    run("git", ["apply", "--check", patch.absoluteFile], source);
    run("git", ["apply", patch.absoluteFile], source);
  }

  run("cmake", [
    "-S", source, "-B", build,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DBUILD_TESTING=OFF",
    "-DSFIZZ_TESTS=OFF",
    "-DSFIZZ_BENCHMARKS=OFF",
    "-DSFIZZ_DEMOS=OFF",
    "-DSFIZZ_DEVTOOLS=OFF",
    "-DSFIZZ_JACK=OFF",
    "-DSFIZZ_RENDER=ON",
    "-DSFIZZ_SHARED=OFF",
    "-DSFIZZ_USE_SNDFILE=OFF",
    // We initialize the exact direct build dependencies above. Upstream's
    // default check recursively downloads nested test-only submodules.
    "-DSFIZZ_GIT_SUBMODULE_CHECK=OFF"
  ]);
  run("cmake", ["--build", build, "--target", "sfizz_render", "--config", "Release", "--parallel", String(jobs)]);

  const built = path.join(build, "library", "bin", "sfizz_render");
  if (!fs.existsSync(built)) throw new Error(`sfizz_render was not produced: ${built}`);
  fs.mkdirSync(path.dirname(stageBinary), { recursive: true });
  fs.copyFileSync(built, stageBinary);
  fs.chmodSync(stageBinary, 0o755);

  const stageLicenseDir = path.join(stage, "licenses");
  fs.mkdirSync(stageLicenseDir, { recursive: true });
  const installedLicenses = licenseSpecs.map(spec => {
    const sourceLicense = path.join(source, spec.source);
    if (!fs.existsSync(sourceLicense))
      throw new Error(`required sfizz dependency license is missing: ${spec.source}`);
    const installedLicense = path.join(stageLicenseDir, spec.target);
    fs.copyFileSync(sourceLicense, installedLicense);
    fs.chmodSync(installedLicense, 0o644);
    return { ...spec, sha256: sha256(installedLicense) };
  });

  // Nothing is published until the staged binary has executed successfully.
  smokeBinary(stageBinary);
  const installed = {
    engine: manifest.id,
    integrationStatus: "cli-build-verified-runtime-sidecar",
    source: manifest.source,
    commit: manifest.commit,
    license: manifest.license,
    manifestSha256: expectedManifestSha256,
    patches: expectedPatches,
    submodules: installedSubmodules,
    licenses: installedLicenses,
    binaryRelativePath: manifest.binaryRelativePath,
    binarySha256: sha256(stageBinary),
    platform: process.platform,
    arch: process.arch,
    toolchain: {
      node: process.version,
      git: capture("git", ["--version"]),
      cmake: capture("cmake", ["--version"]).split("\n")[0]
    },
    installedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(stage, "install.json"), `${JSON.stringify(installed, null, 2)}\n`, { mode: 0o600 });

  // Rename the fully verified directory on the same filesystem. Preserve an invalid
  // previous install until the new directory has been published successfully.
  let previous;
  if (fs.existsSync(target)) {
    previous = path.join(engineHome, `.${short}.previous-${process.pid}-${Date.now()}`);
    fs.renameSync(target, previous);
  }
  try {
    fs.renameSync(stage, target);
    published = true;
  } catch (error) {
    if (previous && !fs.existsSync(target)) fs.renameSync(previous, target);
    throw error;
  }
  if (previous) {
    try {
      fs.rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      console.warn(`New sfizz install is active, but the previous directory could not be removed: ${error.message}`);
    }
  }

  console.log(`Installed and verified sfizz CLI: ${binary}`);
  console.log("Aria runtime sidecar integration is active.");
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
  if (!published && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
}

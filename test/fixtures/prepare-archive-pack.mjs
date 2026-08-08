#!/usr/bin/env node
// Deterministic tiny prepared-pack fixture used by test/prepared-pack-installer.js.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--archive") options.archive = argv[++index];
    else if (argv[index] === "--output") options.output = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!options.archive || !options.output) throw new Error("--archive and --output are required");
  return options;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { flag: "wx", mode: 0o644 });
}

const options = parse(process.argv.slice(2));
const archive = path.resolve(options.archive);
const output = path.resolve(options.output);
if (fs.existsSync(output)) throw new Error(`output exists: ${output}`);
const stage = `${output}.fixture-stage-${process.pid}`;
fs.mkdirSync(stage, { recursive: false, mode: 0o755 });
try {
  const payload = new Map([
    ["LICENSE", "Fixture redistribution terms\n"],
    ["samples/tone.wav", fs.readFileSync(archive)],
    ["sfz/Instrument.sfz", "<region> sample=../samples/tone.wav key=60\n"]
  ]);
  for (const [file, value] of payload) write(path.join(stage, ...file.split("/")), value);
  const checksums = [...payload.keys()].sort().map(file => {
    const data = fs.readFileSync(path.join(stage, ...file.split("/")));
    return { file, bytes: data.length, sha256: sha256(data) };
  });
  const checksumText = `${JSON.stringify(checksums, null, 2)}\n`;
  write(path.join(stage, "catalog", "checksums.json"), checksumText);
  write(path.join(stage, "pack.json"), `${JSON.stringify({
    format: 1,
    id: "prepared-fixture",
    name: "Prepared Fixture Pack",
    source: {
      url: "https://example.invalid/prepared-fixture",
      archive: path.basename(archive),
      sha256: sha256(fs.readFileSync(archive))
    },
    checksums: {
      file: "catalog/checksums.json",
      sha256: sha256(Buffer.from(checksumText))
    }
  }, null, 2)}\n`);
  fs.renameSync(stage, output);
} catch (error) {
  fs.rmSync(stage, { recursive: true, force: true });
  throw error;
}

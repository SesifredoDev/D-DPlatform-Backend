import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { once } from 'node:events';

const ASTRAL_MAGIC = Buffer.from([65, 83, 84, 82, 65, 76, 49, 0]);
const MEDIA_EXTENSIONS = ['.webm', '.webp', '.mp4', '.m4v', '.mov', '.ogg', '.opus', '.mp3', '.wav', '.png', '.jpg', '.jpeg', '.gif'];

const args = parseArgs(process.argv.slice(2));
const recordingsRoot = args.recordingsRoot ?? path.join(process.env.APPDATA ?? '', 'com.ddplatform.desktop', 'recordings');
const sessionDir = path.resolve(args.sessionDir ?? findLatestRawSessionDir(recordingsRoot));
const sessionId = path.basename(sessionDir);
const outputPath = uniquePath(path.resolve(args.output ?? path.join(os.homedir(), 'Downloads', `${sessionId}-recovered.astral`)));
const manifestPath = path.join(sessionDir, 'manifest.json');

if (!fs.existsSync(sessionDir) || !fs.statSync(sessionDir).isDirectory()) {
  throw new Error(`Session directory not found: ${sessionDir}`);
}

const manifest = buildRecoveryManifest(sessionDir);
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Recovery manifest written: ${manifestPath}`);
console.log(`Recovered participant media entries: ${manifest.recording.participantMedia.length}`);
console.log(`Recovered duration: ${formatDuration(manifest.recording.durationMs)}`);

await writeAstralPackage(sessionDir, outputPath);
const outputSize = fs.statSync(outputPath).size;
console.log(`Recovered Astral package written: ${outputPath}`);
console.log(`Package size: ${formatBytes(outputSize)}`);

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) {
      continue;
    }

    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

function findLatestRawSessionDir(root) {
  if (!root || !fs.existsSync(root)) {
    throw new Error(`Recordings root not found: ${root}`);
  }

  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('astral-') && !entry.name.startsWith('astral-import-') && entry.name !== 'optimization')
    .map(entry => path.join(root, entry.name))
    .filter(candidate => fs.existsSync(path.join(candidate, 'participants')))
    .sort((first, second) => fs.statSync(second).mtimeMs - fs.statSync(first).mtimeMs);

  if (!candidates.length) {
    throw new Error(`No raw Astral recording directories found under ${root}`);
  }

  return candidates[0];
}

function buildRecoveryManifest(root) {
  const startedAtMs = inferSessionStartedAtMs(path.basename(root));
  const participantsRoot = path.join(root, 'participants');
  const mediaEntries = collectSegmentEntries(participantsRoot, root, startedAtMs);
  if (!mediaEntries.length) {
    throw new Error(`No participant media segments found under ${participantsRoot}`);
  }

  const grouped = groupBy(mediaEntries, entry => entry.participantId);
  const participantMedia = [];
  let durationMs = 0;

  for (const entries of grouped.values()) {
    entries.sort((first, second) => first.startedAtMs - second.startedAtMs || first.segmentIndex - second.segmentIndex);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const next = entries[index + 1] ?? null;
      const endedAtMs = inferSegmentEndedAtMs(entry, next);
      durationMs = Math.max(durationMs, endedAtMs);
      participantMedia.push({
        participantId: entry.participantId,
        isLocal: false,
        userData: null,
        participantMeta: null,
        volumePercent: 100,
        startedAtMs: entry.startedAtMs,
        endedAtMs,
        media: {
          storage: 'astral',
          mimeType: entry.mimeType,
          durationMs: Math.max(0, endedAtMs - entry.startedAtMs),
          size: entry.size,
          path: entry.relativePath
        }
      });
    }
  }

  participantMedia.sort((first, second) => first.startedAtMs - second.startedAtMs || first.participantId.localeCompare(second.participantId));

  const startedAt = new Date(startedAtMs).toISOString();
  return {
    format: 'astral-session-recording',
    formatVersion: 1,
    packagedAt: new Date().toISOString(),
    recovery: {
      generatedFrom: 'raw-segment-metadata',
      sourceSessionDir: root,
      note: 'Recovered after the original Tauri build did not write a package manifest. VTT and call-environment timelines are not recoverable from raw media chunks alone.'
    },
    recording: {
      id: `${path.basename(root)}-recovered`,
      callRoomId: null,
      startedAt,
      endedAt: new Date(startedAtMs + durationMs).toISOString(),
      durationMs,
      media: null,
      participantMedia,
      vtt: {
        roomId: null,
        initialState: null,
        actions: []
      },
      callEnvironment: {
        initialState: null,
        events: []
      }
    }
  };
}

function inferSessionStartedAtMs(sessionId) {
  const match = /^astral-(\d+)-/.exec(sessionId);
  if (!match) {
    return Date.now();
  }

  return Number(BigInt(match[1]) / 1000000n);
}

function collectSegmentEntries(participantsRoot, root, sessionStartedAtMs) {
  if (!fs.existsSync(participantsRoot)) {
    throw new Error(`Participants directory not found: ${participantsRoot}`);
  }

  const entries = [];
  for (const participantDir of fs.readdirSync(participantsRoot, { withFileTypes: true })) {
    if (!participantDir.isDirectory()) {
      continue;
    }

    const participantPath = path.join(participantsRoot, participantDir.name);
    for (const metadataFile of fs.readdirSync(participantPath, { withFileTypes: true })) {
      if (!metadataFile.isFile() || path.extname(metadataFile.name).toLowerCase() !== '.json') {
        continue;
      }

      const metadataPath = path.join(participantPath, metadataFile.name);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const mediaPath = findMediaForMetadata(participantPath, metadataFile.name);
      if (!mediaPath) {
        continue;
      }

      const stat = fs.statSync(mediaPath);
      const startedAtMs = finiteNumber(metadata.startedAtMs, 0);
      entries.push({
        participantId: String(metadata.participantId ?? participantDir.name),
        segmentIndex: finiteNumber(metadata.segmentIndex, entries.length),
        mimeType: String(metadata.mimeType || guessMimeType(mediaPath)),
        startedAtMs,
        fileEndedAtMs: Math.max(startedAtMs, Math.round(stat.mtimeMs - sessionStartedAtMs)),
        size: stat.size,
        absolutePath: mediaPath,
        relativePath: normalizeRelativePath(path.relative(root, mediaPath))
      });
    }
  }

  return entries;
}

function findMediaForMetadata(directory, metadataName) {
  const stem = path.basename(metadataName, path.extname(metadataName));
  for (const extension of MEDIA_EXTENSIONS) {
    const candidate = path.join(directory, `${stem}${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function inferSegmentEndedAtMs(entry, next) {
  if (next) {
    return Math.max(entry.startedAtMs + 250, next.startedAtMs);
  }

  return Math.max(entry.startedAtMs + 250, entry.fileEndedAtMs);
}

function groupBy(values, getKey) {
  const grouped = new Map();
  for (const value of values) {
    const key = getKey(value);
    const group = grouped.get(key);
    if (group) {
      group.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }

  return grouped;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function guessMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.webp') return 'image/webp';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4';
  return 'video/webm';
}

async function writeAstralPackage(root, output) {
  const files = listFiles(root)
    .map(filePath => ({
      absolutePath: filePath,
      relativePath: normalizeRelativePath(path.relative(root, filePath)),
      size: fs.statSync(filePath).size
    }))
    .sort((first, second) => first.relativePath.localeCompare(second.relativePath));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const outputStream = fs.createWriteStream(output, { flags: 'wx' });
  outputStream.write(ASTRAL_MAGIC);
  const gzip = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
  gzip.pipe(outputStream);

  let writtenBytes = 0;
  let lastLogAt = 0;
  for (const file of files) {
    await writeEntryHeader(gzip, file.relativePath, file.size);
    await writeEntryBody(gzip, file.absolutePath, chunkLength => {
      writtenBytes += chunkLength;
      const now = Date.now();
      if (now - lastLogAt >= 5000) {
        lastLogAt = now;
        console.log(`Packaging ${formatBytes(writtenBytes)} / ${formatBytes(totalBytes)} (${Math.floor((writtenBytes / Math.max(1, totalBytes)) * 100)}%)`);
      }
    });
  }

  await writeBuffer(gzip, Buffer.alloc(4));
  gzip.end();
  await once(outputStream, 'finish');
}

function listFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...listFiles(absolutePath));
    } else if (entry.isFile()) {
      output.push(absolutePath);
    }
  }

  return output;
}

async function writeEntryHeader(stream, relativePath, size) {
  const pathBytes = Buffer.from(relativePath, 'utf8');
  const pathLength = Buffer.alloc(4);
  pathLength.writeUInt32LE(pathBytes.length, 0);
  const fileSize = Buffer.alloc(8);
  fileSize.writeBigUInt64LE(BigInt(size), 0);
  await writeBuffer(stream, pathLength);
  await writeBuffer(stream, fileSize);
  await writeBuffer(stream, pathBytes);
}

async function writeEntryBody(stream, filePath, onChunk) {
  const fileStream = fs.createReadStream(filePath);
  for await (const chunk of fileStream) {
    onChunk(chunk.length);
    await writeBuffer(stream, chunk);
  }
}

async function writeBuffer(stream, buffer) {
  if (!stream.write(buffer)) {
    await once(stream, 'drain');
  }
}

function uniquePath(candidate) {
  if (!fs.existsSync(candidate)) {
    return candidate;
  }

  const directory = path.dirname(candidate);
  const extension = path.extname(candidate);
  const stem = path.basename(candidate, extension);
  let index = 1;
  while (true) {
    const next = path.join(directory, `${stem}-${index}${extension}`);
    if (!fs.existsSync(next)) {
      return next;
    }
    index += 1;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) {
    return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / (1024 ** 2)).toFixed(2)} MB`;
  }
  return `${bytes} bytes`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

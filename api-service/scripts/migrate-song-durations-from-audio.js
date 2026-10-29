const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mongoose = require('mongoose');

require('dotenv').config();
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const Song = require('../models/Song');
const { getObjectStream, normalizeStoredFileValue } = require('../services/s3.service');

const execFileAsync = promisify(execFile);
const APPLY_CHANGES = process.argv.includes('--apply');
const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db';

function toDurationSeconds(rawDuration) {
    const numericValue = Number(rawDuration);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return null;
    }
    return Math.round(numericValue);
}

async function probeDurationSeconds(tempFilePath) {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'json',
        tempFilePath
    ]);

    const parsed = JSON.parse(stdout || '{}');
    return toDurationSeconds(parsed?.format?.duration);
}

async function resolveSongDurationSeconds(song) {
    const normalizedAudioKey = normalizeStoredFileValue(song.audioUrl);
    if (!normalizedAudioKey || typeof normalizedAudioKey !== 'string') {
        return null;
    }

    const objectResponse = await getObjectStream(normalizedAudioKey);
    if (!objectResponse?.stream) {
        return null;
    }

    const tempFilePath = path.join(os.tmpdir(), `song-duration-${song._id}-${Date.now()}`);
    try {
        const writeStream = fs.createWriteStream(tempFilePath);
        await pipeline(objectResponse.stream, writeStream);
        return await probeDurationSeconds(tempFilePath);
    } finally {
        await fsp.unlink(tempFilePath).catch(() => undefined);
    }
}

async function run() {
    await mongoose.connect(dbUri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        family: 4
    });

    const projection = { _id: 1, audioUrl: 1, durationSeconds: 1 };
    const stats = {
        scanned: 0,
        updated: 0,
        skipped: 0,
        failed: 0
    };
    const bulkOps = [];
    const cursor = Song.find({}, projection).lean().cursor();

    for await (const song of cursor) {
        stats.scanned += 1;

        try {
            const durationSeconds = await resolveSongDurationSeconds(song);
            if (durationSeconds === null) {
                stats.skipped += 1;
                continue;
            }

            if (durationSeconds === song.durationSeconds) {
                stats.skipped += 1;
                continue;
            }

            stats.updated += 1;
            if (APPLY_CHANGES) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: song._id },
                        update: { $set: { durationSeconds } }
                    }
                });
            }

            if (APPLY_CHANGES && bulkOps.length >= 100) {
                await Song.bulkWrite(bulkOps, { ordered: false });
                bulkOps.length = 0;
            }
        } catch (error) {
            stats.failed += 1;
            console.warn(`Failed to resolve duration for song ${song._id}: ${error.message}`);
        }
    }

    if (APPLY_CHANGES && bulkOps.length) {
        await Song.bulkWrite(bulkOps, { ordered: false });
    }

    const modeLabel = APPLY_CHANGES ? 'APPLY' : 'DRY RUN';
    console.log(`\nSong duration probe migration summary (${modeLabel})`);
    console.log(
        `- scanned=${stats.scanned}, updated=${stats.updated}, skipped=${stats.skipped}, failed=${stats.failed}\n`
    );

    if (!APPLY_CHANGES) {
        console.log('No writes were made. Re-run with --apply to persist these changes.');
    }
}

run()
    .catch(error => {
        console.error('Migration failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => undefined);
    });

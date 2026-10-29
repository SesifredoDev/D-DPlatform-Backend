const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config();
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const Song = require('../models/Song');

const APPLY_CHANGES = process.argv.includes('--apply');
const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db';

function normalizeDurationSeconds(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return 0;
    }
    return numericValue;
}

async function run() {
    await mongoose.connect(dbUri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        family: 4
    });

    const projection = { _id: 1, durationSeconds: 1 };
    const stats = {
        scanned: 0,
        changedDocs: 0
    };
    const bulkOps = [];
    const cursor = Song.find({}, projection).lean().cursor();

    for await (const song of cursor) {
        stats.scanned += 1;
        const normalizedDuration = normalizeDurationSeconds(song.durationSeconds);
        if (normalizedDuration === song.durationSeconds) {
            continue;
        }

        stats.changedDocs += 1;
        if (APPLY_CHANGES) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: song._id },
                    update: { $set: { durationSeconds: normalizedDuration } }
                }
            });

            if (bulkOps.length >= 500) {
                await Song.bulkWrite(bulkOps, { ordered: false });
                bulkOps.length = 0;
            }
        }
    }

    if (APPLY_CHANGES && bulkOps.length) {
        await Song.bulkWrite(bulkOps, { ordered: false });
    }

    const modeLabel = APPLY_CHANGES ? 'APPLY' : 'DRY RUN';
    console.log(`\nSong duration migration summary (${modeLabel})`);
    console.log(`- scanned=${stats.scanned}, changedDocs=${stats.changedDocs}\n`);

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

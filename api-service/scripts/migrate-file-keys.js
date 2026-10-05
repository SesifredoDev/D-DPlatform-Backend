const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config();
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
require('dotenv').config({ path: path.resolve(process.cwd(), envFile) });

const Song = require('../models/Song');
const MoodTag = require('../models/MoodTag');
const AtmosphereTag = require('../models/AtmosphereTag');
const Character = require('../models/Character');
const Server = require('../models/Server');
const User = require('../models/User');
const { normalizeStoredFileValue } = require('../services/s3.service');

const APPLY_CHANGES = process.argv.includes('--apply');
const dbUri = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db';

function getPathValue(source, dotPath) {
    return dotPath.split('.').reduce((acc, segment) => (acc == null ? undefined : acc[segment]), source);
}

function normalizeDbFileValue(value) {
    if (typeof value !== 'string') {
        return value;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return trimmed;
    }

    return normalizeStoredFileValue(trimmed);
}

async function migrateModel({ label, Model, fields }) {
    const projection = fields.reduce((acc, fieldPath) => {
        acc[fieldPath] = 1;
        return acc;
    }, { _id: 1 });

    const stats = {
        model: label,
        scanned: 0,
        changedDocs: 0,
        changedFields: 0
    };

    const bulkOps = [];
    const cursor = Model.find({}, projection).lean().cursor();

    for await (const doc of cursor) {
        stats.scanned += 1;
        const setPayload = {};
        let docChangedFields = 0;

        for (const fieldPath of fields) {
            const currentValue = getPathValue(doc, fieldPath);
            const nextValue = normalizeDbFileValue(currentValue);
            if (nextValue !== currentValue) {
                setPayload[fieldPath] = nextValue;
                docChangedFields += 1;
            }
        }

        if (!docChangedFields) {
            continue;
        }

        stats.changedDocs += 1;
        stats.changedFields += docChangedFields;

        if (APPLY_CHANGES) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: doc._id },
                    update: { $set: setPayload }
                }
            });

            if (bulkOps.length >= 500) {
                await Model.bulkWrite(bulkOps, { ordered: false });
                bulkOps.length = 0;
            }
        }
    }

    if (APPLY_CHANGES && bulkOps.length) {
        await Model.bulkWrite(bulkOps, { ordered: false });
    }

    return stats;
}

async function run() {
    await mongoose.connect(dbUri, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 45000,
        family: 4
    });

    const plans = [
        { label: 'Song', Model: Song, fields: ['cover', 'audioUrl'] },
        { label: 'MoodTag', Model: MoodTag, fields: ['cover'] },
        { label: 'AtmosphereTag', Model: AtmosphereTag, fields: ['cover'] },
        { label: 'Character', Model: Character, fields: ['icon', 'pdfLink', 'ddbPdfLink'] },
        { label: 'Server', Model: Server, fields: ['icon', 'defaultTheme.backgroundImage'] },
        { label: 'User', Model: User, fields: ['profileIcon'] }
    ];

    const results = [];
    for (const plan of plans) {
        // eslint-disable-next-line no-await-in-loop
        const modelStats = await migrateModel(plan);
        results.push(modelStats);
    }

    const totals = results.reduce((acc, row) => {
        acc.scanned += row.scanned;
        acc.changedDocs += row.changedDocs;
        acc.changedFields += row.changedFields;
        return acc;
    }, { scanned: 0, changedDocs: 0, changedFields: 0 });

    const modeLabel = APPLY_CHANGES ? 'APPLY' : 'DRY RUN';
    console.log(`\nFile-key migration summary (${modeLabel})`);
    for (const row of results) {
        console.log(
            `- ${row.model}: scanned=${row.scanned}, changedDocs=${row.changedDocs}, changedFields=${row.changedFields}`
        );
    }
    console.log(
        `Total: scanned=${totals.scanned}, changedDocs=${totals.changedDocs}, changedFields=${totals.changedFields}\n`
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

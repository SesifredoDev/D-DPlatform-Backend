const express = require('express');
const mongoose = require('mongoose');

const MoodTag = require('../models/MoodTag');
const AtmosphereTag = require('../models/AtmosphereTag');
const Song = require('../models/Song');
const { buildFileUrl } = require('../utils/serverHelpers');

const router = express.Router();

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function normalizeTagPayload(payload) {
    return {
        name: String(payload.name || '').trim(),
        description: String(payload.description || '').trim(),
        cover: normalizeStoredFileKey(payload.cover)
    };
}

function toObjectIdList(values) {
    const list = Array.isArray(values) ? values : [];
    return list.filter(value => mongoose.Types.ObjectId.isValid(value));
}

function decodeRouteFileName(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_error) {
        return String(value || '');
    }
}

function normalizeStoredFileKey(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    if (raw.startsWith('/api/files/')) {
        return raw.slice('/api/files/'.length);
    }

    if (raw.startsWith('http://') || raw.startsWith('https://')) {
        try {
            const parsed = new URL(raw);
            if (parsed.pathname.startsWith('/api/files/')) {
                return parsed.pathname.slice('/api/files/'.length);
            }
        } catch (_error) {
            return raw;
        }
    }

    return raw;
}

router.get('/moods', async (_req, res) => {
    try {
        const moods = await MoodTag.find().sort({ name: 1 }).lean();
        res.json({ items: moods });
    } catch (error) {
        console.error('Failed to fetch mood tags:', error);
        res.status(500).json({ message: 'Failed to fetch mood tags' });
    }
});

router.post('/moods', async (req, res) => {
    const payload = normalizeTagPayload(req.body || {});
    if (!isNonEmptyString(payload.name) || !isNonEmptyString(payload.description) || !isNonEmptyString(payload.cover)) {
        return res.status(400).json({ message: 'name, description, and cover are required' });
    }

    try {
        const mood = await MoodTag.create(payload);
        res.status(201).json({ item: mood });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'Mood tag name already exists' });
        }
        console.error('Failed to create mood tag:', error);
        res.status(500).json({ message: 'Failed to create mood tag' });
    }
});

router.get('/atmospheres', async (_req, res) => {
    try {
        const atmospheres = await AtmosphereTag.find().sort({ name: 1 }).lean();
        res.json({ items: atmospheres });
    } catch (error) {
        console.error('Failed to fetch atmosphere tags:', error);
        res.status(500).json({ message: 'Failed to fetch atmosphere tags' });
    }
});

router.post('/atmospheres', async (req, res) => {
    const payload = normalizeTagPayload(req.body || {});
    if (!isNonEmptyString(payload.name) || !isNonEmptyString(payload.description) || !isNonEmptyString(payload.cover)) {
        return res.status(400).json({ message: 'name, description, and cover are required' });
    }

    try {
        const atmosphere = await AtmosphereTag.create(payload);
        res.status(201).json({ item: atmosphere });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'Atmosphere tag name already exists' });
        }
        console.error('Failed to create atmosphere tag:', error);
        res.status(500).json({ message: 'Failed to create atmosphere tag' });
    }
});

router.get('/songs', async (_req, res) => {
    try {
        const songs = await Song.find()
            .populate('moods')
            .populate('atmosphere')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ items: songs });
    } catch (error) {
        console.error('Failed to fetch songs:', error);
        res.status(500).json({ message: 'Failed to fetch songs' });
    }
});

router.post('/songs', async (req, res) => {
    const cover = normalizeStoredFileKey(req.body?.cover);
    const fileName = String(req.body?.fileName || '').trim();
    const audioUrl = normalizeStoredFileKey(req.body?.audioUrl);
    const attribution = String(req.body?.attribution || '').trim();
    const moodIds = toObjectIdList(req.body?.moods);
    const atmosphereIds = toObjectIdList(req.body?.atmosphere);

    if (!isNonEmptyString(fileName) || !isNonEmptyString(audioUrl)) {
        return res.status(400).json({ message: 'fileName and audioUrl are required' });
    }

    try {
        const [moodTags, atmosphereTags] = await Promise.all([
            MoodTag.find({ _id: { $in: moodIds } }).select('_id').lean(),
            AtmosphereTag.find({ _id: { $in: atmosphereIds } }).select('_id').lean()
        ]);

        if (moodTags.length !== moodIds.length) {
            return res.status(400).json({ message: 'One or more mood IDs are invalid' });
        }
        if (atmosphereTags.length !== atmosphereIds.length) {
            return res.status(400).json({ message: 'One or more atmosphere IDs are invalid' });
        }

        const createdSong = await Song.create({
            cover,
            fileName,
            audioUrl,
            attribution,
            moods: moodIds,
            atmosphere: atmosphereIds
        });

        const song = await Song.findById(createdSong._id)
            .populate('moods')
            .populate('atmosphere')
            .lean();

        res.status(201).json({ item: song });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: 'Song fileName already exists' });
        }
        console.error('Failed to create song:', error);
        res.status(500).json({ message: 'Failed to create song' });
    }
});

router.get('/stream/:fileName', async (req, res) => {
    const requestedFileName = decodeRouteFileName(req.params.fileName).trim();
    if (!isNonEmptyString(requestedFileName)) {
        return res.status(400).json({ message: 'fileName is required' });
    }

    try {
        const requestedFileKey = normalizeStoredFileKey(requestedFileName);
        const song = await Song.findOne({
            $or: [
                { fileName: requestedFileName },
                { fileName: requestedFileKey },
                { audioUrl: requestedFileName },
                { audioUrl: requestedFileKey }
            ]
        }).select('audioUrl fileName').lean();

        const streamTarget = normalizeStoredFileKey(song?.audioUrl || requestedFileKey);
        if (!isNonEmptyString(streamTarget)) {
            return res.status(404).json({ message: 'Song stream not found' });
        }

        return res.redirect(buildFileUrl(req, streamTarget));
    } catch (error) {
        console.error('Failed to stream song:', error);
        return res.status(500).json({ message: 'Failed to stream song' });
    }
});

router.delete('/songs/:id', async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid song id' });
    }

    try {
        const deletedSong = await Song.findByIdAndDelete(id).lean();
        if (!deletedSong) {
            return res.status(404).json({ message: 'Song not found' });
        }

        res.json({ item: deletedSong });
    } catch (error) {
        console.error('Failed to delete song:', error);
        res.status(500).json({ message: 'Failed to delete song' });
    }
});

router.delete('/moods/:id', async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid mood id' });
    }

    try {
        const deletedMood = await MoodTag.findByIdAndDelete(id).lean();
        if (!deletedMood) {
            return res.status(404).json({ message: 'Mood not found' });
        }

        await Song.updateMany(
            { moods: deletedMood._id },
            { $pull: { moods: deletedMood._id } }
        );

        res.json({ item: deletedMood });
    } catch (error) {
        console.error('Failed to delete mood tag:', error);
        res.status(500).json({ message: 'Failed to delete mood tag' });
    }
});

router.delete('/atmospheres/:id', async (req, res) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid atmosphere id' });
    }

    try {
        const deletedAtmosphere = await AtmosphereTag.findByIdAndDelete(id).lean();
        if (!deletedAtmosphere) {
            return res.status(404).json({ message: 'Atmosphere not found' });
        }

        await Song.updateMany(
            { atmosphere: deletedAtmosphere._id },
            { $pull: { atmosphere: deletedAtmosphere._id } }
        );

        res.json({ item: deletedAtmosphere });
    } catch (error) {
        console.error('Failed to delete atmosphere tag:', error);
        res.status(500).json({ message: 'Failed to delete atmosphere tag' });
    }
});

module.exports = router;

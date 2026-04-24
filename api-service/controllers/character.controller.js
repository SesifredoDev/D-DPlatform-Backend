const Character = require('../models/Character');
const mongoose = require("mongoose");
const s3Service = require('../services/s3.service');
const sharp = require('sharp');
const redis = require('redis');

const SHARP_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB limit for Sharp processing

const publisher = redis.createClient({ 
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) {
                console.error('Redis Publisher: Max retries reached, giving up.');
                return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000);
        }
    }
});

publisher.on('error', (err) => console.error('Redis Publisher Error:', err));
publisher.connect().catch(err => console.error('Redis Publisher initial connect failed:', err));

function getFileFullUrl(req, key) {
    if (!key) return null;
    if (key.startsWith('http')) return key;
    if (key.startsWith('/api/files/')) {
        return `${req.protocol}://${req.get('host')}${key}`;
    }
    return `${req.protocol}://${req.get('host')}/api/files/${key}`;
}

function normalizeStoredFileValue(value) {
    if (!value || typeof value !== 'string') return value;
    return s3Service.normalizeStoredFileValue(value);
}

function processCharacterUrls(req, character) {
    if (character.icon) {
        const storedIcon = normalizeStoredFileValue(character.icon);
        character.iconKey = storedIcon;
        character.icon = getFileFullUrl(req, storedIcon);
        character.iconUrl = getFileFullUrl(req, storedIcon);
    }
    if (character.pdfLink) {
        const storedPdf = normalizeStoredFileValue(character.pdfLink);
        character.pdfKey = storedPdf;
        character.pdfLink = getFileFullUrl(req, storedPdf);
        character.pdfLinkUrl = getFileFullUrl(req, storedPdf);
    }
}

async function notifyCharacterUpdate(req, serverId, character) {
    if (!publisher.isOpen || !serverId) return;
    
    try {
        const charObj = character.toObject ? character.toObject() : character;
        processCharacterUrls(req, charObj);

        await publisher.publish('SERVER_UPDATES', JSON.stringify({
            type: 'CHARACTER_UPDATE',
            serverId: serverId,
            data: charObj
        }));
    } catch (err) {
        console.error("Error notifying character update:", err);
    }
}

async function handleFileUpload(file) {
    let fileBuffer = file.buffer;
    let contentType = file.mimetype;
    let filename = file.originalname;

    if (contentType.startsWith('image/') && file.size <= SHARP_SIZE_LIMIT) {
        try {
            const sharpInstance = sharp(fileBuffer);
            const metadata = await sharpInstance.metadata();
            if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
                fileBuffer = await sharpInstance.jpeg({ quality: 100, progressive: true, mozjpeg: true }).toBuffer();
                contentType = 'image/jpeg';
            } else if (metadata.format === 'png') {
                fileBuffer = await sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
                contentType = 'image/png';
            } else if (metadata.format === 'webp') {
                fileBuffer = await sharpInstance.webp({ lossless: true }).toBuffer();
                contentType = 'image/webp';
            }
        } catch (sharpError) {
            console.warn(`[CharacterController] Sharp processing failed for: ${filename}`, sharpError);
        }
    }

    const uploadedAsset = await s3Service.uploadToS3(fileBuffer, filename, contentType);
    return uploadedAsset.key;
}

exports.createCharacter = async (req, res) => {
    try {
        const charData = req.body;
        const userId = req.user.id;
        let iconKey = normalizeStoredFileValue(charData.icon);
        let pdfKey = normalizeStoredFileValue(charData.pdfLink);

        if (req.files) {
            if (req.files.icon) {
                iconKey = await handleFileUpload(req.files.icon[0]);
            }
            if (req.files.pdf) {
                pdfKey = await handleFileUpload(req.files.pdf[0]);
            }
        }

        const filter = {
            _id: charData._id || new mongoose.Types.ObjectId(),
            ownerId: userId
        };

        const update = {
            ownerId: userId,
            name: charData.name,
            race: charData.race,
            icon: iconKey || null,
            ddbId: charData.ddbId || null,
            ddbUsername: charData.ddbUsername || null,
            pdfLink: pdfKey || null,
            baseStats: typeof charData.baseStats === 'string'
                ? JSON.parse(charData.baseStats) : charData.baseStats,
            classes: typeof charData.classes === 'string'
                ? JSON.parse(charData.classes) : charData.classes,
            ac: charData.ac,
            lastUpdated: Date.now()
        };

        if (charData.serverId) {
            update.$addToSet = {servers: charData.serverId};
        }

        const character = await Character.findOneAndUpdate(filter, update, {
            new: true,
            upsert: true,
            runValidators: true
        });

        if (charData.serverId) {
            await notifyCharacterUpdate(req, charData.serverId, character);
        }

        const charObj = character.toObject();
        processCharacterUrls(req, charObj);

        res.status(201).json(charObj);
    } catch (error) {
        console.error("Error saving character:", error);
        res.status(500).json({error: error.message});
    }
};


exports.updateCharacter = async (req, res) => {
    try {
        const { id } = req.params; 
        const userId = req.user.id;
        const charData = req.body;
        let updateFields = {};
        const character = await Character.findOne({ _id: id, ownerId: userId });
        if (!character) {
            return res.status(404).json({ message: "Character not found or unauthorized." });
        }

        const fields = ['name', 'race', 'ddbId', 'ddbUsername', 'ac'];
        fields.forEach(field => {
            if (charData[field] !== undefined) updateFields[field] = charData[field];
        });

        if (charData.baseStats) {
            updateFields.baseStats = typeof charData.baseStats === 'string'
                ? JSON.parse(charData.baseStats) : charData.baseStats;
        }
        if (charData.classes) {
            updateFields.classes = typeof charData.classes === 'string'
                ? JSON.parse(charData.classes) : charData.classes;
        }
        if (charData.icon !== undefined) {
            updateFields.icon = normalizeStoredFileValue(charData.icon) || null;
        }
        if (charData.pdfLink !== undefined) {
            updateFields.pdfLink = normalizeStoredFileValue(charData.pdfLink) || null;
        }
        
        let serversChanged = false;
        let oldServers = [...character.servers];

        if (charData.servers) {
            updateFields.servers = typeof charData.servers === 'string'
                ? JSON.parse(charData.servers) : charData.servers;
            serversChanged = true;
        }


        if (req.files) {
            if (req.files.icon) {
                updateFields.icon = await handleFileUpload(req.files.icon[0]);
            }
            if (req.files.pdf) {
                updateFields.pdfLink = await handleFileUpload(req.files.pdf[0]);
            }
        }

        if (charData.serverId) {
            if (!updateFields.$addToSet) updateFields.$addToSet = {};
            updateFields.$addToSet.servers = charData.serverId;
            serversChanged = true;
        }

        updateFields.lastUpdated = Date.now();
        const updatedCharacter = await Character.findByIdAndUpdate(
            id,
            updateFields,
            { new: true, runValidators: true }
        );

        if (updatedCharacter.servers && updatedCharacter.servers.length > 0) {
            for (const serverId of updatedCharacter.servers) {
                await notifyCharacterUpdate(req, serverId, updatedCharacter);
            }
        }

        if (serversChanged) {
            const newServerIds = updatedCharacter.servers.map(s => s.toString());
            for (const oldServerId of oldServers) {
                if (!newServerIds.includes(oldServerId.toString())) {
                    if (publisher.isOpen) {
                        await publisher.publish('SERVER_UPDATES', JSON.stringify({
                            type: 'CHARACTER_UPDATE',
                            serverId: oldServerId,
                            data: { _id: id, deleted: true, ownerId: userId }
                        }));
                    }
                }
            }
        }

        const charObj = updatedCharacter.toObject();
        processCharacterUrls(req, charObj);

        res.status(200).json(charObj);
    } catch (error) {
        console.error("Error updating character:", error);
        res.status(500).json({ error: error.message });
    }
};

exports.getMyCharacters = async (req, res) => {
    try {
        const characters = await Character.find({ ownerId: req.user.id })
            .sort({ lastUpdated: -1 }).lean();
        
        characters.forEach(char => processCharacterUrls(req, char));

        res.status(200).json(characters);
    } catch (error) {
        res.status(500).json({ message: "Error fetching characters." });
    }
};

exports.deleteCharacter = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const character = await Character.findOne({ _id: id, ownerId: userId });
        if (!character) {
            return res.status(404).json({ message: "Character not found or unauthorized." });
        }

        const servers = character.servers;
        await character.deleteOne();

        if (servers && servers.length > 0) {
            for (const serverId of servers) {
                 if (publisher.isOpen) {
                     await publisher.publish('SERVER_UPDATES', JSON.stringify({
                         type: 'CHARACTER_UPDATE',
                         serverId: serverId,
                         data: { _id: id, deleted: true, ownerId: userId }
                     }));
                 }
            }
        }

        res.status(200).json({ message: "Character deleted successfully." });
    } catch (error) {
        console.error("Error deleting character:", error);
        res.status(500).json({ error: error.message });
    }
};

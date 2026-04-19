const Character = require('../models/Character');
const mongoose = require("mongoose");
const {uploadToGridFS} = require("../utils/fileManagement");
const redis = require('redis');

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

async function notifyCharacterUpdate(serverId, character) {
    if (!publisher.isOpen || !serverId) return;
    
    try {
        await publisher.publish('SERVER_UPDATES', JSON.stringify({
            type: 'CHARACTER_UPDATE',
            serverId: serverId,
            data: character
        }));
    } catch (err) {
        console.error("Error notifying character update:", err);
    }
}

exports.createCharacter = async (req, res) => {
    let iconUrl;
    try {
        const charData = req.body;
        const userId = req.user.id;
        let pdfUrl = charData.pdfLink;

        if (req.files) {
            if (req.files.icon) {
                iconUrl = await uploadToGridFS(req.files.icon[0], req);
            }else{
                iconUrl = charData.icon;
            }
            if (req.files.pdf) {
                pdfUrl = await uploadToGridFS(req.files.pdf[0],  req);
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
            icon: iconUrl,
            ddbId: charData.ddbId || null,
            pdfLink: pdfUrl || null,
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
            await notifyCharacterUpdate(charData.serverId, character);
        }

        res.status(201).json(character);
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

        const fields = ['name', 'race', 'ddbId', "ddbUsername", 'ac'];
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
        
        let serversChanged = false;
        let oldServers = [...character.servers];

        if (charData.servers) {
            updateFields.servers = typeof charData.servers === 'string'
                ? JSON.parse(charData.servers) : charData.servers;
            serversChanged = true;
        }


        if (req.files) {
            if (req.files.icon) {
                updateFields.icon = await uploadToGridFS(req.files.icon[0], req);
            }
            if (req.files.pdf) {
                updateFields.pdfLink = await uploadToGridFS(req.files.pdf[0], req);
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

        // Notify current servers
        if (updatedCharacter.servers && updatedCharacter.servers.length > 0) {
            for (const serverId of updatedCharacter.servers) {
                await notifyCharacterUpdate(serverId, updatedCharacter);
            }
        }

        // Notify removed servers
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

        res.status(200).json(updatedCharacter);
    } catch (error) {
        console.error("Error updating character:", error);
        res.status(500).json({ error: error.message });
    }
};

exports.getMyCharacters = async (req, res) => {
    try {

        const characters = await Character.find({ ownerId: req.user.id })
            .sort({ lastUpdated: -1 });
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
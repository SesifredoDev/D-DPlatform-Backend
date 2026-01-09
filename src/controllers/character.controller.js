const Character = require('../models/Character');
const mongoose = require("mongoose");
const {uploadToGridFS} = require("../utils/fileManagement");


exports.createCharacter = async (req, res) => {
    let iconUrl;
    try {
        const charData = req.body;
        const userId = req.user.id;
        let pdfUrl = charData.pdfLink;

        if (req.files) {
            if (req.files.icon) {
                iconUrl = await uploadToGridFS(req.files.icon[0], req);
            }
            if (req.files.pdf) {
                pdfUrl = await uploadToGridFS(req.files.pdf[0], req);
            }
        }

        const filter = charData.ddbId
            ? {ddbId: charData.ddbId, ownerId: userId}
            : {_id: charData._id || new mongoose.Types.ObjectId(), ownerId: userId};

        const update = {
            ownerId: userId,
            name: charData.name,
            race: charData.race,
            icon: iconUrl,
            ddbId: charData.ddbId || null,
            pdfLink: pdfUrl || null,
            // Parse stats and classes if sent as strings via FormData
            baseStats: typeof charData.baseStats === 'string'
                ? JSON.parse(charData.baseStats) : charData.baseStats,
            classes: typeof charData.classes === 'string'
                ? JSON.parse(charData.classes) : charData.classes,
            ac: charData.ac,
            lastUpdated: Date.now()
        };

        // 3. Add to servers if provided
        if (charData.serverId) {
            update.$addToSet = {servers: charData.serverId};
        }

        const character = await Character.findOneAndUpdate(filter, update, {
            new: true,
            upsert: true,
            runValidators: true
        });

        res.status(201).json(character);
    } catch (error) {
        console.error("Error saving character:", error);
        res.status(500).json({error: error.message});
    }
};

exports.getMyCharacters = async (req, res) => {
    try {
        // Find all characters where the owner matches the logged-in user
        const characters = await Character.find({ ownerId: req.user.id })
            .sort({ lastUpdated: -1 });
        res.status(200).json(characters);
    } catch (error) {
        res.status(500).json({ message: "Error fetching characters." });
    }
};
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


exports.updateCharacter = async (req, res) => {
    try {
        const { id } = req.params; // The MongoDB UUID from /characters/:id
        const userId = req.user.id;
        const charData = req.body;
        console.log(charData);
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
        if (charData.servers) {
            updateFields.servers = typeof charData.servers === 'string'
                ? JSON.parse(charData.servers) : charData.servers;
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
            updateFields.$addToSet = { servers: charData.serverId };
        }

        updateFields.lastUpdated = Date.now();
        const updatedCharacter = await Character.findByIdAndUpdate(
            id,
            updateFields,
            { new: true, runValidators: true }
        );

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

        const character = await Character.findOneAndDelete({ _id: id, ownerId: userId });

        if (!character) {
            return res.status(404).json({ message: "Character not found or unauthorized." });
        }

        res.status(200).json({ message: "Character deleted successfully." });
    } catch (error) {
        console.error("Error deleting character:", error);
        res.status(500).json({ error: error.message });
    }
};
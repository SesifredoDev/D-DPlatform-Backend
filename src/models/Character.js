const mongoose = require('mongoose');

const CharacterSchema = new mongoose.Schema({
    // Meta Information
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    servers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Server'
    }],
    ddbId: {
        type: Number, // Optional D&D Beyond ID (e.g., 94599937)
        default: null
    },
    pdfLink: {
        type: String, // Optional PDF Link
        default: null
    },

    // Character Surface Data (The structure you requested)
    name: { type: String, required: true },
    race: { type: String },
    icon: { type: String },
    baseStats: {
        strength: Number,
        dexterity: Number,
        constitution: Number,
        intelligence: Number,
        wisdom: Number,
        charisma: Number
    },
    classes: [{
        className: String,
        subclassName: String,
        level: Number
    }],
    ac: { type: Number },

    // Automation
    lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Character', CharacterSchema);
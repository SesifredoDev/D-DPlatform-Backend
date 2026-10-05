const mongoose = require('mongoose');

const songSchema = new mongoose.Schema(
    {
        cover: {
            type: String,
            trim: true,
            default: ''
        },
        fileName: {
            type: String,
            required: true,
            trim: true,
            unique: true
        },
        audioUrl: {
            type: String,
            trim: true,
            default: ''
        },
        attribution: {
            type: String,
            trim: true,
            default: ''
        },
        moods: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'MoodTag'
            }
        ],
        atmosphere: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'AtmosphereTag'
            }
        ]
    },
    { timestamps: true }
);

module.exports = mongoose.models.Song || mongoose.model('Song', songSchema);

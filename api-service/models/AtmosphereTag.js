const mongoose = require('mongoose');

const atmosphereTagSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            unique: true
        },
        description: {
            type: String,
            required: true,
            trim: true
        },
        cover: {
            type: String,
            required: true,
            trim: true
        }
    },
    { timestamps: true }
);

module.exports = mongoose.models.AtmosphereTag || mongoose.model('AtmosphereTag', atmosphereTagSchema);

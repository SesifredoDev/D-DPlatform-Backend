const mongoose = require('mongoose');

const ChannelSchema = new mongoose.Schema({
    server: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Server",
        index: true
    },

    name: { type: String, required: true },

    icon: { type: String, required: true },
    type: {
        type: String,
        enum: ["text", "call", "map", "whisper"], // whisper is a private channel between a user and the DM
        required: true
    },

    // For whisper channels, this is the user who is NOT the owner
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null
    },

    permissionOverwrites: [
        {
            role: { type: mongoose.Schema.Types.ObjectId, ref: "Role" },
            allow: [String], // e.g., ["READ_MESSAGE_HISTORY"]
            deny: [String]   // e.g., ["SEND_MESSAGES"]
        }
    ],

    position:{type:Number, required:false},
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Channel', ChannelSchema);
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', required: true },
    server: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // The Alias: If present, the UI should show the character name/icon instead of the user
    character: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Character',
        default: null
    },

    content: { type: String, required: true },
    attachments: [{
        url: String,
        name: String,
        contentType: String
    }],
    reactions: [{
        emoji: String,
        users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
    }],
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', MessageSchema);
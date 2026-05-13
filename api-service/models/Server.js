const mongoose = require('mongoose');
const ServerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    icon: {
        type: String,
        default: null
    },

    joinCode: {
        type: String,
        index: true
    },
    roles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Role" }],
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    members: [
        {
            user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            roles: [{ type: mongoose.Schema.Types.ObjectId, ref: "Role" }],
            temporaryDm: {
                enabled: { type: Boolean, default: false },
                expiresAt: { type: Date, default: null },
                grantedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
                grantedAt: { type: Date, default: null }
            },
            joinedAt: { type: Date, default: Date.now }
        }
    ],

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Server', ServerSchema);

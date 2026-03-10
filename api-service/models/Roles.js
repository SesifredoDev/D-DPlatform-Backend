const mongoose = require('mongoose');

const RoleSchema = new mongoose.Schema({
    server: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Server",
        required: true,
        index: true
    },
    name: { type: String, required: true },
    color: { type: String, default: "#99AAB5" },
    hoist: { type: Boolean, default: false }, // Display role members separately
    position: { type: Number, default: 0 },

    // Detailed permissions bitfield or boolean flags
    permissions: {
        ADMINISTRATOR: { type: Boolean, default: false },
        MANAGE_SERVER: { type: Boolean, default: false },
        MANAGE_CHANNELS: { type: Boolean, default: false },
        MANAGE_ROLES: { type: Boolean, default: false },
        SEND_MESSAGES: { type: Boolean, default: true },
        READ_MESSAGE_HISTORY: { type: Boolean, default: true },
        CONNECT: { type: Boolean, default: true }, // For voice
    }
});

module.exports = mongoose.model('Role', RoleSchema);
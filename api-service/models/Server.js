const mongoose = require('mongoose');

const SERVER_THEME_FONT_FAMILIES = [
    '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'Roboto, "Helvetica Neue", Arial, sans-serif',
    '"Segoe UI", Arial, sans-serif',
    'Georgia, "Times New Roman", serif',
    '"Roboto Mono", "Courier New", monospace'
];

const DEFAULT_SERVER_THEME = Object.freeze({
    backgroundColor: '#121212',
    textColor: '#eef0f6',
    fontFamily: SERVER_THEME_FONT_FAMILIES[0],
    backgroundImage: null,
    backgroundImageBlur: false
});

const ServerThemeSchema = new mongoose.Schema({
    backgroundColor: {
        type: String,
        default: DEFAULT_SERVER_THEME.backgroundColor,
        match: /^#[0-9a-fA-F]{6}$/
    },
    textColor: {
        type: String,
        default: DEFAULT_SERVER_THEME.textColor,
        match: /^#[0-9a-fA-F]{6}$/
    },
    fontFamily: {
        type: String,
        default: DEFAULT_SERVER_THEME.fontFamily,
        enum: SERVER_THEME_FONT_FAMILIES
    },
    backgroundImage: {
        type: String,
        default: DEFAULT_SERVER_THEME.backgroundImage
    },
    backgroundImageBlur: {
        type: Boolean,
        default: DEFAULT_SERVER_THEME.backgroundImageBlur
    }
}, { _id: false });

const ServerSchema = new mongoose.Schema({
    name: { type: String, required: true },
    icon: {
        type: String,
        default: null
    },
    defaultTheme: {
        type: ServerThemeSchema,
        default: () => ({ ...DEFAULT_SERVER_THEME })
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

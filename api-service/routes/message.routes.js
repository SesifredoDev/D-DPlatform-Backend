const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const {
    sendMessage,
    getMessages
} = require("../controllers/message.controller.js");

/**
 * @route   GET /api-service/messages/:channelId
 * @desc    Get message history for a specific channel
 * @access  Private (Requires READ_MESSAGE_HISTORY permission)
 */
router.get("/:channelId", auth, getMessages);

/**
 * @route   POST /api-service/messages/:channelId
 * @desc    Send a message (optionally as a character alias)
 * @access  Private (Requires SEND_MESSAGES permission)
 */
router.post("/:channelId", auth, sendMessage);

module.exports = router;
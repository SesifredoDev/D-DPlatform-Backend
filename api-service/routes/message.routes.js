const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth.middleware');
const {
    sendMessage,
    getMessages,
    addReaction,
    removeReaction
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

/**
 * @route   POST /api-service/messages/reaction/:messageId
 * @desc    Add a reaction to a message
 */
router.post("/reaction/:messageId", auth, addReaction);

/**
 * @route   DELETE /api-service/messages/reaction/:messageId
 * @desc    Remove a reaction from a message
 */
router.delete("/reaction/:messageId", auth, removeReaction);

module.exports = router;
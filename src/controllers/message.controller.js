const Message = require("../models/Message.js"); // Assuming you have a Message model
const Server = require("../models/Server.js");
const Channel = require("../models/Channel.js");
const Role = require("../models/Roles.js");
const Character = require("../models/Character.js");
const {hasPermission} = require("../utils/permissions");
const {populate} = require("dotenv");


/**
 * Helper to resolve if a user can perform an action in a channel
 */
const canPerformAction = async (serverId, userId, channel, permissionName) => {
    const server = await Server.findById(serverId);
    if (!server) return false;

    // 1. Owner bypass
    if (server.owner.toString() === userId) return true;

    const member = server.members.find(m => m.user.toString() === userId);
    if (!member) return false;

    // 2. Resolve roles
    const memberRoles = await Role.find({ _id: { $in: member.roles } });

    // 3. Administrator bypass
    if (memberRoles.some(r => r.permissions.ADMINISTRATOR)) return true;

    // 4. Check Channel Overwrites
    const roleIds = member.roles.map(id => id.toString());
    const overwrites = channel.permissionOverwrites.filter(ow =>
        roleIds.includes(ow.role.toString())
    );

    // Deny takes precedence
    if (overwrites.some(ow => ow.deny.includes(permissionName))) return false;
    // Then check Allow
    if (overwrites.some(ow => ow.allow.includes(permissionName))) return true;

    // 5. Fallback to Global Role Permissions
    return memberRoles.some(r => r.permissions[permissionName] === true);
};

/**
 * SEND MESSAGE
 */
exports.sendMessage = async (req, res) => {
    const userId = req.user.id;
    const { channelId } = req.params;
    const { content, characterId } = req.body; // characterId is optional

    const channel = await Channel.findById(channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });


    const canSend = await canPerformAction(channel.server, userId, channel, "SEND_MESSAGES");
    if (!canSend) return res.status(403).json({ message: "You cannot send messages here" });


    let alias = null;
    if (characterId) {
        // Ensure the character exists and is owned by the user
        alias = await Character.findOne({ _id: characterId, ownerId: userId });
        if (!alias) {
            return res.status(403).json({ message: "You do not own this character" });
        }
    }


    const message = await Message.create({
        channel: channelId,
        server: channel.server,
        author: userId,
        character: characterId || null, // Stores the alias if used
        content
    });


    await message.populate([
        { path: 'author', select: 'username avatar profileIcon' },
        { path: 'character', select: 'name icon' }
    ]);
    console.log(message)
    res.status(201).json(message);
};

/**
 * GET CHANNEL MESSAGES
 */
exports.getMessages = async (req, res) => {
    const userId = req.user.id;
    const { channelId } = req.params;
    const { limit = 50, before } = req.query;

    const channel = await Channel.findById(channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });

    // Check Read Permissions
    const canRead = await canPerformAction(channel.server, userId, channel, "READ_MESSAGE_HISTORY");
    if (!canRead) {
        return res.status(403).json({ message: "Access denied: Cannot read history" });
    }

    const query = { channel: channelId };
    if (before) query._id = { $lt: before };

    const messages = await Message.find({ channel: channelId })
        .sort({ createdAt: -1 })
        .limit(50)
        .populate('author', 'username profileIcon ')
        .populate('character', 'name icon')
        .select( "-server -channel")

    res.json(messages);
};
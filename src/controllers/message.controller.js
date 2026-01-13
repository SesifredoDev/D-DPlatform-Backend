const Message = require("../models/Message.js");
const Server = require("../models/Server.js");
const Channel = require("../models/Channel.js");
const Role = require("../models/Roles.js");
const Character = require("../models/Character.js");

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
    if (overwrites.some(ow => ow.allow.includes(permissionName))) true;

    // 5. Fallback to Global Role Permissions
    return memberRoles.some(r => r.permissions[permissionName] === true);
};

/**
 * SEND MESSAGE (HTTP POST)
 * After saving to DB, it emits the message via Socket.io
 */
exports.sendMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { channelId } = req.params;
        const { content, characterId } = req.body;

        const channel = await Channel.findById(channelId);
        if (!channel) return res.status(404).json({ message: "Channel not found" });

        const canSend = await canPerformAction(channel.server, userId, channel, "SEND_MESSAGES");
        if (!canSend) return res.status(403).json({ message: "You cannot send messages here" });

        let alias = null;
        if (characterId) {
            alias = await Character.findOne({ _id: characterId, ownerId: userId });
            if (!alias) {
                return res.status(403).json({ message: "You do not own this character" });
            }
        }

        // Create the message in MongoDB
        const message = await Message.create({
            channel: channelId,
            server: channel.server,
            author: userId,
            character: characterId || null,
            content
        });

        // Populate for the UI
        await message.populate([
            { path: 'author', select: 'username avatar profileIcon' },
            { path: 'character', select: 'name icon' }
        ]);

        const io = req.app.get('socketio');
        if (io) {
            io.to(channelId).emit('new_message', message);
        }

        res.status(201).json(message);
    } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};

/**
 * GET CHANNEL MESSAGES (HTTP GET)
 */
exports.getMessages = async (req, res) => {
    try {
        const userId = req.user.id;
        const { channelId } = req.params;
        const { limit = 50, before } = req.query;

        const channel = await Channel.findById(channelId);
        if (!channel) return res.status(404).json({ message: "Channel not found" });

        const canRead = await canPerformAction(channel.server, userId, channel, "READ_MESSAGE_HISTORY");
        if (!canRead) {
            return res.status(403).json({ message: "Access denied: Cannot read history" });
        }

        const query = { channel: channelId };
        if (before) query._id = { $lt: before };

        const messages = await Message.find(query)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .populate('author', 'username profileIcon')
            .populate('character', 'name icon')
            .select("-server -channel");

        res.json(messages);
    } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).json({ message: "Internal server error" });
    }
};
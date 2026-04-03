const Message = require("../models/Message");
const Channel = require("../models/Channel");
const Server = require("../models/Server");
const Role = require("../models/Roles");
const Character = require("../models/Character");
const redis = require('redis');

const publisher = redis.createClient({ 
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 20) {
                console.error('Redis Publisher: Max retries reached, giving up.');
                return new Error('Redis connection failed');
            }
            return Math.min(retries * 100, 3000);
        }
    }
});

publisher.on('error', (err) => console.error('Redis Publisher Error:', err));
publisher.connect().catch(err => console.error('Redis Publisher initial connect failed:', err));

/* ===== PERMISSIONS ===== */

const canPerformAction = async (serverId, userId, channel, permissionName) => {
    const server = await Server.findById(serverId);
    if (!server) return false;

    if (server.owner.toString() === userId) return true;

    const member = server.members.find(m => m.user.toString() === userId);
    if (!member) return false;

    const memberRoles = await Role.find({ _id: { $in: member.roles } });

    if (memberRoles.some(r => r.permissions.ADMINISTRATOR)) return true;

    const roleIds = member.roles.map(id => id.toString());
    const overwrites = channel.permissionOverwrites.filter(ow =>
        roleIds.includes(ow.role.toString())
    );

    if (overwrites.some(ow => ow.deny.includes(permissionName))) return false;
    if (overwrites.some(ow => ow.allow.includes(permissionName))) return true;

    return memberRoles.some(r => r.permissions[permissionName] === true);
};

/* ===== SEND MESSAGE ===== */
exports.sendMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { channelId } = req.params;
        const { content, characterId } = req.body;

        const channel = await Channel.findById(channelId);
        if (!channel) return res.status(404).json({ message: "Channel not found" });

        // Permission check remains in the API service
        const canSend = await canPerformAction(
            channel.server,
            userId,
            channel,
            "SEND_MESSAGES"
        );
        if (!canSend) return res.status(403).json({ message: "Permission denied" });

        if (characterId) {
            const character = await Character.findOne({
                _id: characterId,
                ownerId: userId
            });
            if (!character) return res.status(403).json({ message: "Invalid character" });
        }

        // 1. Persist to MongoDB
        const message = await Message.create({
            channel: channelId,
            server: channel.server,
            author: userId,
            character: characterId || null,
            content
        });

        await message.populate([
            { path: "author", select: "username avatar profileIcon" },
            { path: "character", select: "name icon" }
        ]);

        const payload = {
            ...message.toObject(),
            channelId
        };

        // 2. Publish to Redis instead of using local socket
        // This triggers the independent Messaging Service to broadcast the event
        if (publisher.isOpen) {
            await publisher.publish('CHAT_MESSAGES', JSON.stringify(payload));
        } else {
            console.error('Redis Publisher not connected, message broadcast failed');
        }

        res.status(201).json(payload);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
};
/* ===== GET HISTORY ===== */

exports.getMessages = async (req, res) => {
    try {
        const userId = req.user.id;
        const { channelId } = req.params;

        const channel = await Channel.findById(channelId);
        if (!channel) return res.status(404).json({ message: "Channel not found" });

        const canRead = await canPerformAction(
            channel.server,
            userId,
            channel,
            "READ_MESSAGE_HISTORY"
        );
        if (!canRead)
            return res.status(403).json({ message: "Access denied" });

        const messages = await Message.find({ channel: channelId })
            .sort({ createdAt: -1 })
            .limit(50)
            .populate("author", "username profileIcon")
            .populate("character", "name icon");

        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

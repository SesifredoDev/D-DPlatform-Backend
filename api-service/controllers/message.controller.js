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

function getFileFullUrl(req, key) {
    if (!key) return null;
    if (key.startsWith('http')) return key;
    return `${req.protocol}://${req.get('host')}/api/files/${key}`;
}

function replaceTrailingAttachmentId(url, attachmentId, fileKey) {
    if (!url || !attachmentId || !fileKey) return url;

    try {
        const parsedUrl = new URL(url, 'http://localhost');
        const segments = (parsedUrl.pathname || '').split('/').filter(Boolean);
        if (segments[segments.length - 1] === attachmentId) {
            segments[segments.length - 1] = fileKey;
            parsedUrl.pathname = `/${segments.join('/')}`;
            return parsedUrl.origin === 'http://localhost'
                ? `${parsedUrl.pathname}${parsedUrl.search}`
                : `${parsedUrl.toString()}`;
        }
    } catch {
        if (url.endsWith(`/${attachmentId}`)) {
            return `${url.slice(0, -attachmentId.length)}${fileKey}`;
        }
    }

    return url;
}

function buildAttachmentKey(attachment) {
    if (!attachment) return null;

    if (attachment.key) {
        return attachment.key;
    }

    if (attachment.id && attachment.filename) {
        return `${attachment.id}-${attachment.filename}`;
    }

    if (attachment.id && attachment.name) {
        return `${attachment.id}-${attachment.name}`;
    }

    return attachment.id || null;
}

function extractFilenameFromUrl(url) {
    if (!url) return null;

    try {
        const parsedUrl = new URL(url, 'http://localhost');
        const pathname = parsedUrl.pathname || '';
        const lastSegment = pathname.split('/').filter(Boolean).pop();
        return lastSegment || null;
    } catch {
        const lastSegment = url.split('/').filter(Boolean).pop();
        return lastSegment || null;
    }
}

function normalizeAttachment(req, attachment) {
    if (!attachment) return null;

    const filename = attachment.filename || attachment.name || extractFilenameFromUrl(attachment.url) || 'attachment';
    const fileKey = buildAttachmentKey({ ...attachment, filename });
    const normalizedUrl = replaceTrailingAttachmentId(attachment.url, attachment.id, fileKey);
    const url = normalizedUrl || getFileFullUrl(req, fileKey);
    if (!url) return null;

    return {
        id: attachment.id || null,
        key: fileKey,
        url,
        name: attachment.name || filename,
        filename,
        contentType: attachment.contentType || 'application/octet-stream'
    };
}

function normalizeAttachments(req, attachments) {
    if (!Array.isArray(attachments)) {
        return [];
    }

    return attachments
        .map(attachment => normalizeAttachment(req, attachment))
        .filter(Boolean);
}

function processIconUrls(req, message) {
    if (message.author && message.author.profileIcon) {
        message.author.profileIconUrl = getFileFullUrl(req, message.author.profileIcon);
    }
    if (message.recipient && message.recipient.profileIcon) {
        message.recipient.profileIconUrl = getFileFullUrl(req, message.recipient.profileIcon);
    }
    if (message.character && message.character.icon) {
        message.character.iconUrl = getFileFullUrl(req, message.character.icon);
    }
    if (message.replyTo) {
        if (message.replyTo.author && message.replyTo.author.profileIcon) {
            message.replyTo.author.profileIconUrl = getFileFullUrl(req, message.replyTo.author.profileIcon);
        }
        if (message.replyTo.character && message.replyTo.character.icon) {
            message.replyTo.character.iconUrl = getFileFullUrl(req, message.replyTo.character.icon);
        }
    }
}

function normalizeMessagePayload(req, message, options = {}) {
    const payload = typeof message.toObject === 'function' ? message.toObject() : { ...message };
    const resolvedChannelId = payload.channelId ?? payload.channel ?? options.channelId;

    if (resolvedChannelId != null) {
        payload.channelId = String(resolvedChannelId);
    }

    if (payload.channel != null) {
        payload.channel = String(payload.channel);
    }

    if (payload.server != null) {
        payload.server = String(payload.server);
    }

    if (Array.isArray(payload.attachments)) {
        payload.attachments = normalizeAttachments(req, payload.attachments);
    }

    if (Array.isArray(payload.reactions)) {
        payload.reactions = payload.reactions;
    }

    processIconUrls(req, payload);

    if (payload.replyTo && Array.isArray(payload.replyTo.attachments)) {
        payload.replyTo.attachments = normalizeAttachments(req, payload.replyTo.attachments);
    }

    return payload;
}

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
        const { content, characterId, attachments, replyTo, isWhisper, recipientId } = req.body;

        const channel = await Channel.findById(channelId);
        if (!channel) return res.status(404).json({ message: "Channel not found" });

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

        const normalizedAttachments = normalizeAttachments(req, attachments);
        const normalizedContent = typeof content === 'string' ? content : '';
        if (!normalizedContent.trim() && normalizedAttachments.length === 0) {
            return res.status(400).json({ message: "Message content or attachments are required" });
        }

        const messageData = {
            channel: channelId,
            server: channel.server,
            author: userId,
            character: characterId || null,
            content: normalizedContent,
            attachments: normalizedAttachments,
            replyTo: replyTo || null,
            isWhisper: Boolean(isWhisper),
            recipient: recipientId || null
        };

        const message = await Message.create(messageData);

        await message.populate([
            { path: "author", select: "username avatar profileIcon" },
            { path: "character", select: "name icon" },
            { 
                path: "replyTo", 
                populate: [
                    { path: "author", select: "username avatar profileIcon" },
                    { path: "character", select: "name icon" }
                ]
            },
            { path: "recipient", select: "username avatar profileIcon" }
        ]);

        const payload = normalizeMessagePayload(req, message, { channelId });

        if (publisher.isOpen) {
            await publisher.publish('CHAT_MESSAGES', JSON.stringify({ type: 'NEW_MESSAGE', data: payload }));
        }

        res.status(201).json(payload);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Internal server error" });
    }
};

/* ===== REACTIONS ===== */
exports.addReaction = async (req, res) => {
    try {
        const userId = req.user.id;
        const { messageId } = req.params;
        const { emoji } = req.body;

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: "Message not found" });

        let reaction = message.reactions.find(r => r.emoji === emoji);
        if (reaction) {
            if (!reaction.users.includes(userId)) {
                reaction.users.push(userId);
            }
        } else {
            message.reactions.push({ emoji, users: [userId] });
        }

        await message.save();

        if (publisher.isOpen) {
            await publisher.publish('CHAT_MESSAGES', JSON.stringify({ 
                type: 'REACTION_UPDATE', 
                data: { messageId, reactions: message.reactions, channelId: String(message.channel) } 
            }));
        }

        res.json(message.reactions);
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.removeReaction = async (req, res) => {
    try {
        const userId = req.user.id;
        const { messageId } = req.params;
        const { emoji } = req.body;

        const message = await Message.findById(messageId);
        if (!message) return res.status(404).json({ message: "Message not found" });

        let reaction = message.reactions.find(r => r.emoji === emoji);
        if (reaction) {
            reaction.users = reaction.users.filter(id => id.toString() !== userId);
            if (reaction.users.length === 0) {
                message.reactions = message.reactions.filter(r => r.emoji !== emoji);
            }
            await message.save();
        }

        if (publisher.isOpen) {
            await publisher.publish('CHAT_MESSAGES', JSON.stringify({ 
                type: 'REACTION_UPDATE', 
                data: { messageId, reactions: message.reactions, channelId: String(message.channel) } 
            }));
        }

        res.json(message.reactions);
    } catch (err) {
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

        const server = await Server.findById(channel.server);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const canRead = await canPerformAction(
            channel.server,
            userId,
            channel,
            "READ_MESSAGE_HISTORY"
        );
        if (!canRead)
            return res.status(403).json({ message: "Access denied" });

        let query;
        if (channel.type === 'whisper') {
            const isServerOwner = server.owner.toString() === userId;
            const isChannelRecipient = channel.recipient?.toString() === userId;

            if (!isServerOwner && !isChannelRecipient) {
                return res.status(403).json({ message: "Access denied" });
            }

            query = { channel: channelId };
        } else {
            query = {
                channel: channelId,
                $or: [
                    { isWhisper: { $ne: true } },
                    { author: userId },
                    { recipient: userId }
                ]
            };

            if (server.owner.toString() === userId) {
                delete query.$or;
            }
        }

        const messages = await Message.find(query)
            .sort({ createdAt: -1 })
            .limit(50)
            .populate("author", "username profileIcon")
            .populate("character", "name icon")
            .populate("recipient", "username profileIcon")
            .populate({
                path: "replyTo",
                populate: [
                    { path: "author", select: "username avatar profileIcon" },
                    { path: "character", select: "name icon" }
                ]
            })
            .lean();

        res.json(messages.map(message => normalizeMessagePayload(req, message)));
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};


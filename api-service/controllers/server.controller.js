const crypto = require("crypto");
const Server = require("../models/Server.js");
const Channel = require("../models/Channel.js");
const Character = require("../models/Character.js");
const Role = require("../models/Roles.js"); 
const s3Service = require("../services/s3.service");
const sharp = require('sharp');
const { hasPermission } = require("../utils/permissions");
const { checkChannelPermission } = require("./channel.controller");
const redis = require('redis');

const SHARP_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB limit for Sharp processing

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
    if (key.startsWith('/api/files/')) {
        return `${req.protocol}://${req.get('host')}${key}`;
    }
    return `${req.protocol}://${req.get('host')}/api/files/${key}`;
}

function normalizeStoredFileValue(value) {
    if (!value || typeof value !== 'string') return value;
    return s3Service.normalizeStoredFileValue(value);
}

function toServerResponse(req, server) {
    const serverObj = typeof server.toObject === 'function' ? server.toObject() : { ...server };
    const storedIcon = normalizeStoredFileValue(serverObj.icon);

    return {
        ...serverObj,
        icon: getFileFullUrl(req, storedIcon),
        iconKey: storedIcon,
        iconUrl: getFileFullUrl(req, storedIcon)
    };
}

function processUserIcon(req, user) {
    if (user && user.profileIcon) {
        const storedIcon = normalizeStoredFileValue(user.profileIcon);
        user.profileIcon = getFileFullUrl(req, storedIcon);
        user.profileIconUrl = getFileFullUrl(req, storedIcon);
    }
}

async function notifyMemberUpdate(req, serverId) {
    if (!publisher.isOpen) return;
    
    try {
        const server = await Server.findById(serverId)
            .populate({
                path: 'members.user',
                select: 'username email profileIcon'
            })
            .populate({
                path: 'members.roles',
                model: 'Role'
            })
            .lean();

        if (server) {
             const characters = await Character.find({ servers: serverId }).lean();
             const charactersByOwner = {};
             for (const char of characters) {
                 const ownerId = char.ownerId.toString();
                 if (!charactersByOwner[ownerId]) charactersByOwner[ownerId] = [];
                 charactersByOwner[ownerId].push(char);
                 if (char.icon) {
                     const storedIcon = normalizeStoredFileValue(char.icon);
                     char.icon = getFileFullUrl(req, storedIcon);
                     char.iconUrl = getFileFullUrl(req, storedIcon);
                 }
             }

             const members = server.members.map(member => {
                 processUserIcon(req, member.user);
                 return {
                     ...member,
                     characters: charactersByOwner[member.user._id.toString()] || []
                 }
             });

             await publisher.publish('SERVER_UPDATES', JSON.stringify({
                 type: 'MEMBER_UPDATE',
                 serverId: serverId,
                 data: members
             }));
        }
    } catch (err) {
        console.error("Error notifying member update:", err);
    }
}

function generateJoinCode() {
    return crypto.randomBytes(4).toString("hex");
}

async function handleIconUpload(file) {
    let fileBuffer = file.buffer;
    let contentType = file.mimetype;
    let filename = file.originalname;

    if (contentType.startsWith('image/') && file.size <= SHARP_SIZE_LIMIT) {
        try {
            const sharpInstance = sharp(fileBuffer);
            const metadata = await sharpInstance.metadata();
            if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
                fileBuffer = await sharpInstance.jpeg({ quality: 100, progressive: true, mozjpeg: true }).toBuffer();
                contentType = 'image/jpeg';
            } else if (metadata.format === 'png') {
                fileBuffer = await sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
                contentType = 'image/png';
            } else if (metadata.format === 'webp') {
                fileBuffer = await sharpInstance.webp({ lossless: true }).toBuffer();
                contentType = 'image/webp';
            }
        } catch (sharpError) {
            console.warn(`[ServerController] Sharp processing failed for: ${filename}`, sharpError);
        }
    }

    const uploadedAsset = await s3Service.uploadToS3(fileBuffer, filename, contentType);
    return uploadedAsset.key;
}

/**
 * CREATE SERVER
 */
exports.createServer = async (req, res) => {
    const userId = req.user.id;
    const { name, icon } = req.body;
    let iconKey = normalizeStoredFileValue(icon);

    if (req.files && req.files.icon) {
        iconKey = await handleIconUpload(req.files.icon[0]);
    }

    const server = await Server.create({
        name,
        icon: iconKey,
        owner: userId,
        joinCode: generateJoinCode(),
    });

    const defaultRole = await Role.create({
        server: server._id,
        name: "Everyone",
        permissions: {
            SEND_MESSAGES: true,
            CONNECT: true,
            READ_MESSAGE_HISTORY: true
        },
        position: 0
    });

    server.roles.push(defaultRole._id);
    server.members.push({
        user: userId,
        roles: [defaultRole._id]
    });

    await server.save();
    
    res.status(201).json(toServerResponse(req, server));
};

/**
 * JOIN SERVER
 */
exports.joinServer = async (req, res) => {
    const userId = req.user.id;
    const { code } = req.body;

    const server = await Server.findOne({ joinCode: code });
    if (!server) {
        return res.status(404).json({ message: "Invalid or expired code" });
    }

    const alreadyMember = server.members.some(m => m.user.toString() === userId);
    if (alreadyMember) {
        return res.status(400).json({ message: "Already a member" });
    }

    const everyoneRole = await Role.findOne({ server: server._id, name: "Everyone" });

    server.members.push({
        user: userId,
        roles: everyoneRole ? [everyoneRole._id] : []
    });

    await server.save();

    await notifyMemberUpdate(req, server._id);

    res.json({ message: "Joined server", serverId: server._id });
};

/**
 * REFRESH JOIN CODE
 */
exports.refreshJoinCode = async (req, res) => {
    const userId = req.user.id;
    const { serverId } = req.params;

    try {
        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => m.user.toString() === userId);

        if (!member || !(await hasPermission(server, member, "MANAGE_SERVER"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        server.joinCode = generateJoinCode();
        await server.save();

        res.json({ joinCode: server.joinCode });
    } catch (error) {
        res.status(500).json({ message: "Error refreshing join code", error: error.message });
    }
};

/**
 * CREATE NEW ROLE (Admin only)
 */
exports.createRole = async (req, res) => {
    const userId = req.user.id;
    const { serverId } = req.params;
    const { name, permissions, color } = req.body;

    const server = await Server.findById(serverId);
    const member = server.members.find(m => m.user.toString() === userId);

    if (!member || !(await hasPermission(server, member, "MANAGE_ROLES"))) {
        return res.status(403).json({ message: "Insufficient permissions" });
    }

    const roleCount = await Role.countDocuments({ server: serverId });

    const newRole = await Role.create({
        server: serverId,
        name,
        permissions,
        color,
        position: roleCount
    });

    server.roles.push(newRole._id);
    await server.save();

    res.status(201).json(newRole);
};

exports.updateRole = async (req, res) => {
    const userId = req.user.id;
    const { serverId, roleId } = req.params;
    const { name, color, hoist, position, permissions } = req.body;

    try {
        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => m.user.toString() === userId);

        if (!member || !(await hasPermission(server, member, "MANAGE_ROLES"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        const updatedRole = await Role.findOneAndUpdate(
            { _id: roleId, server: serverId },
            {
                $set: {
                    ...(name && { name }),
                    ...(color && { color }),
                    ...(hoist !== undefined && { hoist }),
                    ...(position !== undefined && { position }),
                    ...(permissions && { permissions })
                }
            },
            { new: true }
        );

        if (!updatedRole) {
            return res.status(404).json({ message: "Role not found" });
        }

        await notifyMemberUpdate(req, serverId);

        res.json(updatedRole);
    } catch (error) {
        res.status(500).json({ message: "Error updating role", error: error.message });
    }
};

exports.deleteRole = async (req, res) => {
    const userId = req.user.id;
    const { serverId, roleId } = req.params;

    try {
        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => m.user.toString() === userId);

        if (!member || !(await hasPermission(server, member, "MANAGE_ROLES"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        const roleToDelete = await Role.findById(roleId);
        if (!roleToDelete) return res.status(404).json({ message: "Role not found" });

        if (roleToDelete.name === "Everyone") {
            return res.status(400).json({ message: "Cannot delete the Everyone role" });
        }

        await Role.deleteOne({ _id: roleId, server: serverId });

        server.roles = server.roles.filter(id => id.toString() !== roleId);

        server.members.forEach(m => {
            m.roles = m.roles.filter(r => r.toString() !== roleId);
        });

        await server.save();
        await notifyMemberUpdate(req, serverId);

        res.json({ message: "Role deleted and removed from all members" });
    } catch (error) {
        res.status(500).json({ message: "Error deleting role", error: error.message });
    }
};

/**
 * UPDATE SERVER
 */
exports.updateServer = async (req, res) => {
    const userId = req.user.id;
    const { serverId } = req.params;
    const { name, icon } = req.body;

    const server = await Server.findById(serverId);
    if (!server) return res.status(404).json({ message: "Server not found" });

    const member = server.members.find(m => m.user.toString() === userId);

    if (!member || !(await hasPermission(server, member, "MANAGE_SERVER"))) {
        return res.status(403).json({ message: "Insufficient permissions" });
    }

    if (req.files && req.files.icon) {
        server.icon = await handleIconUpload(req.files.icon[0]);
    } else if (icon !== undefined) {
        server.icon = normalizeStoredFileValue(icon);
    }

    if (name) server.name = name;

    await server.save();
    
    res.json(toServerResponse(req, server));
};

exports.updateMemberRoles = async (req, res) => {
    const userId = req.user.id; 
    const { serverId, memberId } = req.params; 
    const { roles } = req.body; 

    try {
        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const requestMember = server.members.find(m => m.user.toString() === userId);

        if (!requestMember || !(await hasPermission(server, requestMember, "MANAGE_ROLES"))) {
            return res.status(403).json({ message: "Insufficient permissions to manage roles" });
        }

        const targetMember = server.members.find(m => m.user.toString() === memberId);
        if (!targetMember) {
            return res.status(404).json({ message: "Member not found in this server" });
        }

        const validRoles = await Role.find({
            _id: { $in: roles },
            server: serverId
        });

        if (validRoles.length !== roles.length) {
            return res.status(400).json({ message: "One or more provided roles are invalid for this server" });
        }

        targetMember.roles = roles;

        await server.save();
        await notifyMemberUpdate(req, serverId);

        res.json({
            message: "Member roles updated successfully",
            roles: targetMember.roles
        });
    } catch (error) {
        res.status(500).json({ message: "Error updating member roles", error: error.message });
    }
};
/**
 * DELETE SERVER (STRICT OWNER ONLY)
 */
exports.deleteServer = async (req, res) => {
    const userId = req.user.id;
    const { serverId } = req.params;

    const server = await Server.findById(serverId);
    if (!server) return res.status(404).json({ message: "Server not found" });

    if (server.owner.toString() !== userId) {
        return res.status(403).json({ message: "Only the owner can delete the server" });
    }

    await Role.deleteMany({ server: serverId });
    await Channel.deleteMany({ server: serverId });
    await Character.deleteMany({ server: serverId });
    await server.deleteOne();

    res.json({ message: "Server and all associated data deleted" });
};

exports.getUserServers= async (req, res) => {
    const userId = req.user.id;

    const servers = await Server.find({
        "members.user": userId
    }).lean();

    const result = servers.map(server => {
        const response = toServerResponse(req, server);
        return {
            _id: response._id,
            name: response.name,
            icon: response.icon,
            iconKey: response.iconKey,
            iconUrl: response.iconUrl
        };
    });

    res.json(result);
}

/**
 * LEAVE SERVER
 */
exports.leaveServer = async (req, res) =>{
    const userId = req.user.id;
    const { serverId } = req.params;

    const server = await Server.findById(serverId);
    if (!server) {
        return res.status(404).json({ message: "Server not found" });
    }

    if (server.owner.toString() === userId) {
        return res.status(400).json({
            message: "Owner must transfer ownership before leaving"
        });
    }

    server.members = server.members.filter(
        m => m.user.toString() !== userId
    );

    await Character.deleteMany({ servers: serverId, ownerId: userId });
    await server.save();
    
    await notifyMemberUpdate(req, serverId);

    res.json({ message: "Left server" });
}


exports.getServerDetails = async (req, res) => {
    const { serverId } = req.params;
    const userId = req.user.id;

    try {
        const server = await Server.findById(serverId)
            .populate({
                path: 'members.user',
                select: 'username profileIcon'
            })
            .populate({
                path: 'members.roles',
                model: 'Role'
            })
            .populate({
                path: 'roles',
                options: { sort: { position: -1 } }
            })
            .lean();

        if (!server) {
            return res.status(404).json({ message: "Server not found" });
        }

        const member = server.members.find(
            m => m.user._id.toString() === userId
        );

        if (!member) {
            return res.status(403).json({ message: "Access denied. Not a member." });
        }


        const characters = await Character.find({
            servers: serverId
        }).lean();

        const charactersByOwner = {};

        for (const char of characters) {
            const ownerId = char.ownerId.toString();

            if (!charactersByOwner[ownerId]) {
                charactersByOwner[ownerId] = [];
            }
            
            if (char.icon) {
                const storedIcon = normalizeStoredFileValue(char.icon);
                char.icon = getFileFullUrl(req, storedIcon);
                char.iconUrl = getFileFullUrl(req, storedIcon);
            }

            charactersByOwner[ownerId].push(char);
        }

        server.members = server.members.map(member => {
            processUserIcon(req, member.user);
            return {
                ...member,
                characters: charactersByOwner[member.user._id.toString()] || []
            }
        });

        const responseServer = toServerResponse(req, server);

        const allChannels = await Channel.find({ server: serverId }).sort({ position: 1 });

        const visibleChannels = [];
        for (const channel of allChannels) {
            if (channel.type === 'whisper') {
                if (server.owner.toString() === userId || channel.recipient.toString() === userId) {
                    if (channel.recipient.toString() === userId && server.owner.toString() !== userId) {
                         channel.name = "DM Whisper";
                    }
                    visibleChannels.push(channel);
                }
            } else {
                const canView = await checkChannelPermission(server, member, channel, "READ_MESSAGE_HISTORY");
                if (canView) {
                    visibleChannels.push(channel);
                }
            }
        }

        res.json({
            ...responseServer,
            channels: visibleChannels
        });

    } catch (error) {
        res.status(500).json({ message: "Error fetching server details", error: error.message });
    }
};

exports.getOrCreateWhisperChannel = async (req, res) => {
    const userId = req.user.id;
    const { serverId, recipientId } = req.body;

    try {
        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const isOwner = server.owner.toString() === userId;
        const targetId = isOwner ? recipientId : server.owner.toString();
        
        if (!targetId) return res.status(400).json({ message: "Recipient required" });

        const otherUser = isOwner ? recipientId : userId;
        
        let channel = await Channel.findOne({
            server: serverId,
            type: 'whisper',
            recipient: otherUser
        });

        if (!channel) {
            const recipientUser = await require("../models/User").findById(otherUser);
            channel = await Channel.create({
                server: serverId,
                name: recipientUser.username,
                type: 'whisper',
                icon: 'visibility_off',
                recipient: otherUser,
                permissionOverwrites: []
            });
        }

        res.json(channel);
    } catch (error) {
        res.status(500).json({ message: "Error", error: error.message });
    }
};

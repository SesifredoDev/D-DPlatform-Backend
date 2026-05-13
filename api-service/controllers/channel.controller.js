const Server = require("../models/Server.js");
const Channel = require("../models/Channel.js");
const Role = require("../models/Roles.js");
const {
    getMemberRoleIds,
    getMemberRoles,
    hasPermission,
    resolveId: resolvePermissionId
} = require("../utils/permissions.js");

function resolveId(value) {
    const sharedResolved = typeof resolvePermissionId === "function" ? resolvePermissionId(value) : "";
    if (sharedResolved) return sharedResolved;
    if (!value) return "";
    if (typeof value === "string") return value;
    if (value._id) return value._id.toString();
    if (typeof value.toString === "function") return value.toString();
    return "";
}

const CHANNEL_PERMISSION_KEYS = new Set([
    "READ_MESSAGE_HISTORY",
    "SEND_MESSAGES",
    "CONNECT"
]);

const EDITABLE_CHANNEL_TYPES = new Set(["text", "call", "map"]);

async function normalizePermissionOverwrites(serverId, permissionOverwrites) {
    if (!Array.isArray(permissionOverwrites)) return [];

    const requestedRoleIds = [
        ...new Set(
            permissionOverwrites
                .map(overwrite => resolveId(overwrite?.role))
                .filter(Boolean)
        )
    ];

    if (!requestedRoleIds.length) return [];

    const roles = await Role.find({
        _id: { $in: requestedRoleIds },
        server: serverId
    }).select("_id");
    const validRoleIds = new Set(roles.map(role => role._id.toString()));
    const normalizedByRole = new Map();

    for (const overwrite of permissionOverwrites) {
        const roleId = resolveId(overwrite?.role);
        if (!validRoleIds.has(roleId)) continue;

        const deny = [...new Set(overwrite?.deny || [])]
            .filter(permission => CHANNEL_PERMISSION_KEYS.has(permission));
        const allow = [...new Set(overwrite?.allow || [])]
            .filter(permission => CHANNEL_PERMISSION_KEYS.has(permission) && !deny.includes(permission));

        if (!allow.length && !deny.length) {
            normalizedByRole.delete(roleId);
            continue;
        }

        normalizedByRole.set(roleId, { role: roleId, allow, deny });
    }

    return Array.from(normalizedByRole.values());
}

async function checkChannelPermission(server, member, channel, permissionName) {
    if (!server || !member || !channel) return false;
    if (resolveId(server.owner) === resolveId(member.user)) return true;

    const memberRoles = await getMemberRoles(member, server);

    if (memberRoles.some(role => role.permissions?.ADMINISTRATOR)) return true;

    const roleIds = new Set(getMemberRoleIds(member));
    const overwrites = (channel.permissionOverwrites || []).filter(overwrite =>
        roleIds.has(resolveId(overwrite.role))
    );

    // If any role denies this permission at channel level, it's denied
    if (overwrites.some(ow => (ow.deny || []).includes(permissionName))) return false;
    // If any role explicitly allows it at channel level, it's allowed
    if (overwrites.some(ow => (ow.allow || []).includes(permissionName))) return true;


    return memberRoles.some(role => role.permissions?.[permissionName] === true);
}

exports.checkChannelPermission = checkChannelPermission;
exports.normalizePermissionOverwrites = normalizePermissionOverwrites;

/**
 * CREATE CHANNEL
 */
exports.createChannel = async (req, res) => {
    try {
        const userId = req.user.id;
        const { serverId } = req.params;
        const { name, icon, type, permissionOverwrites } = req.body;

        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => resolveId(m.user) === userId);

        // Use MANAGE_CHANNELS permission
        if (!member || !(await hasPermission(server, member, "MANAGE_CHANNELS"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        const trimmedName = String(name || "").trim();
        if (!trimmedName) {
            return res.status(400).json({ message: "Channel name is required" });
        }

        const channelType = EDITABLE_CHANNEL_TYPES.has(type) ? type : "text";
        const position = await Channel.countDocuments({ server: serverId });
        const normalizedOverwrites = await normalizePermissionOverwrites(serverId, permissionOverwrites);

        const channel = await Channel.create({
            server: serverId,
            name: trimmedName,
            icon: String(icon || "tag").trim() || "tag",
            type: channelType,
            position,
            permissionOverwrites: normalizedOverwrites
        });

        res.status(201).json(channel);
    } catch (error) {
        res.status(500).json({ message: "Channel create failed", error: error.message });
    }
};

/**
 * LIST CHANNELS (Filtered by View Permission)
 */
exports.listChannels = async (req, res) => {
    try {
        const { serverId } = req.params;
        const userId = req.user.id;

        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => resolveId(m.user) === userId);
        if (!member) return res.status(403).json({ message: "Not a member" });

        const channels = await Channel.find({ server: serverId }).sort({ position: 1 });

        // Filter list so users only see channels they have permission to VIEW
        const filteredChannels = [];
        for (const channel of channels) {
            if (channel.type === "whisper") {
                const isServerOwner = resolveId(server.owner) === userId;
                const isChannelRecipient = resolveId(channel.recipient) === userId;
                if (isServerOwner || isChannelRecipient) filteredChannels.push(channel);
                continue;
            }

            const canView = await checkChannelPermission(server, member, channel, "READ_MESSAGE_HISTORY");
            if (canView) filteredChannels.push(channel);
        }

        res.json(filteredChannels);
    } catch (error) {
        res.status(500).json({ message: "Channel list failed", error: error.message });
    }
};

/**
 * UPDATE CHANNEL (Including Overwrites)
 */
exports.updateChannel = async (req, res) => {
    try {
        const userId = req.user.id;
        const { serverId, channelId } = req.params;
        const { name, icon, position, type, permissionOverwrites } = req.body;

        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => resolveId(m.user) === userId);

        if (!member || !(await hasPermission(server, member, "MANAGE_CHANNELS"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        const update = {};
        if (name !== undefined) {
            const trimmedName = String(name || "").trim();
            if (!trimmedName) {
                return res.status(400).json({ message: "Channel name is required" });
            }
            update.name = trimmedName;
        }
        if (icon !== undefined) update.icon = String(icon || "").trim() || "tag";
        if (type !== undefined && EDITABLE_CHANNEL_TYPES.has(type)) update.type = type;
        if (position !== undefined) update.position = Number(position);
        if (permissionOverwrites !== undefined) {
            update.permissionOverwrites = await normalizePermissionOverwrites(serverId, permissionOverwrites);
        }

        const channel = await Channel.findOneAndUpdate(
            { _id: channelId, server: serverId },
            { $set: update },
            { new: true }
        );

        if (!channel) return res.status(404).json({ message: "Channel not found" });
        res.json(channel);
    } catch (error) {
        res.status(500).json({ message: "Channel update failed", error: error.message });
    }
};

/**
 * DELETE CHANNEL
 */
exports.deleteChannel = async (req, res) => {
    try {
        const userId = req.user.id;
        const { serverId, channelId } = req.params;

        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => resolveId(m.user) === userId);

        if (!member || !(await hasPermission(server, member, "MANAGE_CHANNELS"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        const result = await Channel.deleteOne({ _id: channelId, server: serverId });
        if (result.deletedCount === 0) return res.status(404).json({ message: "Channel not found" });

        res.json({ message: "Channel deleted" });
    } catch (error) {
        res.status(500).json({ message: "Channel delete failed", error: error.message });
    }
};


// New internal helper to check ownership for the Video Service
exports.getVideoRoomMetadata = async (req, res) => {
    const { channelId } = req.params;
    try {
        const channel = await Channel.findById(channelId);
        if (!channel) {
            return res.status(404).json({ message: "Channel or Server not found" });
        }

        const server = await Server.findById(channel.server);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const member = server.members.find(m => resolveId(m.user) === req.user.id);
        if (!member || !(await checkChannelPermission(server, member, channel, "CONNECT"))) {
            return res.status(403).json({ message: "Permission denied" });
        }

        res.json({
            ownerId: server.owner,
            serverId: server._id,
            channelName: channel.name
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

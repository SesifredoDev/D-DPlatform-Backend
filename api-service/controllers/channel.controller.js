const Server = require("../models/Server.js");
const Channel = require("../models/Channel.js");
const Role = require("../models/Roles.js");
const { hasPermission } = require("../utils/permissions.js");

exports.checkChannelPermission = async (server, member, channel, permissionName) => {
    if (server.owner.toString() === member.user.toString()) return true;

    const memberRoles = await Role.find({ _id: { $in: member.roles } });

    if (memberRoles.some(r => r.permissions.ADMINISTRATOR)) return true;

    const roleIds = member.roles.map(id => id.toString());
    const overwrites = channel.permissionOverwrites.filter(ow =>
        roleIds.includes(ow.role.toString())
    );

    // If any role denies this permission at channel level, it's denied
    if (overwrites.some(ow => ow.deny.includes(permissionName))) return false;
    // If any role explicitly allows it at channel level, it's allowed
    if (overwrites.some(ow => ow.allow.includes(permissionName))) return true;


    return memberRoles.some(r => r.permissions[permissionName] === true);
};

/**
 * CREATE CHANNEL
 */
exports.createChannel = async (req, res) => {
    const userId = req.user.id;
    const { serverId } = req.params;
    const { name, icon, type, permissionOverwrites } = req.body;

    const server = await Server.findById(serverId);
    if (!server) return res.status(404).json({ message: "Server not found" });

    const member = server.members.find(m => m.user.toString() === userId);

    // Use MANAGE_CHANNELS permission
    if (!member || !(await hasPermission(server, member, "MANAGE_CHANNELS"))) {
        return res.status(403).json({ message: "Insufficient permissions" });
    }

    const position = await Channel.countDocuments({ server: serverId });

    const channel = await Channel.create({
        server: serverId,
        name,
        icon,
        type,
        position,
        permissionOverwrites: permissionOverwrites || [] //
    });

    res.status(201).json(channel);
};

/**
 * LIST CHANNELS (Filtered by View Permission)
 */
exports.listChannels = async (req, res) => {
    const { serverId } = req.params;
    const userId = req.user.id;

    const server = await Server.findById(serverId);
    if (!server) return res.status(404).json({ message: "Server not found" });

    const member = server.members.find(m => m.user.toString() === userId);
    if (!member) return res.status(403).json({ message: "Not a member" });

    const channels = await Channel.find({ server: serverId }).sort({ position: 1 });

    // Filter list so users only see channels they have permission to VIEW
    const filteredChannels = [];
    for (const channel of channels) {
        // We use "READ_MESSAGE_HISTORY" or a custom "VIEW_CHANNEL" string in overwrites
        const canView = await checkChannelPermission(server, member, channel, "READ_MESSAGE_HISTORY");
        if (canView) filteredChannels.push(channel);
    }

    res.json(filteredChannels);
};

/**
 * UPDATE CHANNEL (Including Overwrites)
 */
exports.updateChannel = async (req, res) => {
    const userId = req.user.id;
    const { serverId, channelId } = req.params;
    const { name, icon, position, type, permissionOverwrites } = req.body;

    const server = await Server.findById(serverId);
    const member = server.members.find(m => m.user.toString() === userId);

    if (!member || !(await hasPermission(server, member, "MANAGE_CHANNELS"))) {
        return res.status(403).json({ message: "Insufficient permissions" });
    }

    const channel = await Channel.findOneAndUpdate(
        { _id: channelId, server: serverId },
        {
            name,
            icon,
            type,
            position,
            permissionOverwrites // Update role-specific overrides
        },
        { new: true }
    );

    if (!channel) return res.status(404).json({ message: "Channel not found" });
    res.json(channel);
};

/**
 * DELETE CHANNEL
 */
exports.deleteChannel = async (req, res) => {
    const userId = req.user.id;
    const { serverId, channelId } = req.params;

    const server = await Server.findById(serverId);
    const member = server.members.find(m => m.user.toString() === userId);

    if (!member || !(await hasPermission(server, member, "MANAGE_CHANNELS"))) {
        return res.status(403).json({ message: "Insufficient permissions" });
    }

    const result = await Channel.deleteOne({ _id: channelId, server: serverId });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Channel not found" });

    res.json({ message: "Channel deleted" });
};


// New internal helper to check ownership for the Video Service
exports.getVideoRoomMetadata = async (req, res) => {
    const { channelId } = req.params;
    try {
        const channel = await Channel.findById(channelId).populate('server');
        if (!channel || !channel.server) {
            return res.status(404).json({ message: "Channel or Server not found" });
        }

        res.json({
            ownerId: channel.server.owner,
            serverId: channel.server._id,
            channelName: channel.name
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
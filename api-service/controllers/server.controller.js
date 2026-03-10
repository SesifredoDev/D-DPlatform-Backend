const crypto = require("crypto");
const Server = require("../models/Server.js");
const Channel = require("../models/Channel.js");
const Character = require("../models/Character.js");
const Role = require("../models/Roles.js"); // Added Role model
const { uploadToGridFS } = require("../utils/fileManagement");
const { hasPermission } = require("../utils/permissions");
const {checkChannelPermission} = require("./channel.controller");

function generateJoinCode() {
    return crypto.randomBytes(4).toString("hex");
}

/**
 * CREATE SERVER
 */
exports.createServer = async (req, res) => {
    const userId = req.user.id;
    const { name } = req.body;
    let iconUrl;

    if (req.files && req.files.icon) {
        iconUrl = await uploadToGridFS(req.files.icon[0], req);
    }

    // 1. Create the Server first
    const server = await Server.create({
        name,
        icon: iconUrl,
        owner: userId,
        joinCode: generateJoinCode(),
    });

    // 2. Create the default '@everyone' role for this server
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

    // 3. Update server with the role and add the owner as a member with that role
    server.roles.push(defaultRole._id);
    server.members.push({
        user: userId,
        roles: [defaultRole._id]
    });

    await server.save();
    res.status(201).json(server);
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

    // Find the @everyone role (usually the one at position 0)
    const everyoneRole = await Role.findOne({ server: server._id, name: "@everyone" });

    server.members.push({
        user: userId,
        roles: everyoneRole ? [everyoneRole._id] : []
    });

    server.joinCode = generateJoinCode();
    await server.save();

    res.json({ message: "Joined server", serverId: server._id });
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

        // Verify the user has the 'MANAGE_ROLES' permission
        if (!member || !(await hasPermission(server, member, "MANAGE_ROLES"))) {
            return res.status(403).json({ message: "Insufficient permissions" });
        }

        // Update the role document
        const updatedRole = await Role.findOneAndUpdate(
            { _id: roleId, server: serverId },
            {
                $set: {
                    ...(name && { name }),
                    ...(color && { color }),
                    ...(hoist !== undefined && { hoist }),
                    ...(position !== undefined && { position }),
                    ...(permissions && { permissions }) // Updates the permissions object
                }
            },
            { new: true }
        );

        if (!updatedRole) {
            return res.status(404).json({ message: "Role not found" });
        }

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

        if (roleToDelete.name === "@everyone") {
            return res.status(400).json({ message: "Cannot delete the @everyone role" });
        }

        await Role.deleteOne({ _id: roleId, server: serverId });

        server.roles = server.roles.filter(id => id.toString() !== roleId);

        server.members.forEach(m => {
            m.roles = m.roles.filter(r => r.toString() !== roleId);
        });

        await server.save();

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
    const { name } = req.body;

    const server = await Server.findById(serverId);
    if (!server) return res.status(404).json({ message: "Server not found" });

    const member = server.members.find(m => m.user.toString() === userId);

    // Use permission check instead of strict owner-only for name updates
    if (!member || !(await hasPermission(server, member, "MANAGE_SERVER"))) {
        return res.status(403).json({ message: "Insufficient permissions" });
    }

    if (req.files && req.files.icon) {
        console.log(req.files.icon);

        server.icon = await uploadToGridFS(req.files.icon[0], req);

    }
    if (name) server.name = name;

    await server.save();
    res.json(server);
};

exports.updateMemberRoles = async (req, res) => {
    const userId = req.user.id; // The user making the request
    const { serverId, memberId } = req.params; // memberId is the User ID of the target member
    const { roles } = req.body; // Array of Role IDs to be assigned

    try {
        const server = await Server.findById(serverId);
        if (!server) return res.status(404).json({ message: "Server not found" });

        const requestMember = server.members.find(m => m.user.toString() === userId);

        // 1. Permission Check: Must have MANAGE_ROLES or be Admin/Owner
        if (!requestMember || !(await hasPermission(server, requestMember, "MANAGE_ROLES"))) {
            return res.status(403).json({ message: "Insufficient permissions to manage roles" });
        }

        // 2. Find the target member in the server
        const targetMember = server.members.find(m => m.user.toString() === memberId);
        if (!targetMember) {
            return res.status(404).json({ message: "Member not found in this server" });
        }

        // 3. Validation: Ensure all provided Role IDs actually belong to this server
        const validRoles = await Role.find({
            _id: { $in: roles },
            server: serverId
        });

        if (validRoles.length !== roles.length) {
            return res.status(400).json({ message: "One or more provided roles are invalid for this server" });
        }

        // 4. Update the member's roles
        targetMember.roles = roles;

        await server.save();

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

    // Cleanup all associated data
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
        const member = server.members.find(
            m => m.user.toString() === userId
        );

        return {
            _id: server._id,
            name: server.name,
            icon: server.icon,
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

    await Character.deleteMany({ server: serverId, owner: userId });
    await server.save();

    res.json({ message: "Left server" });
}


exports.getServerDetails = async (req, res) => {
    const { serverId } = req.params;
    const userId = req.user.id;

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

            charactersByOwner[ownerId].push(char);
        }

        // Attach characters to members
        server.members = server.members.map(member => ({
            ...member,
            characters: charactersByOwner[member.user._id.toString()] || []
        }));


        const allChannels = await Channel.find({ server: serverId }).sort({ position: 1 });

        const visibleChannels = [];
        for (const channel of allChannels) {
            const canView = await checkChannelPermission(server, member, channel, "READ_MESSAGE_HISTORY");
            if (canView) {
                visibleChannels.push(channel);
            }
        }

        // 4. Combine and return the data
        res.json({
            ...server,
            channels: visibleChannels
        });

    } catch (error) {
        res.status(500).json({ message: "Error fetching server details", error: error.message });
    }
};



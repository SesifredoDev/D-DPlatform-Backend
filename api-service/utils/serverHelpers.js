const Server = require("../models/Server");

exports.getServerAndMember = async (serverId, userId) => {
    const server = await Server.findById(serverId);

    if (!server) {
        return { error: { status: 404, message: "Server not found" } };
    }

    const member = server.members.find(
        m => m.user.toString() === userId
    );

    if (!member) {
        return { error: { status: 403, message: "Not a member of this server" } };
    }

    return { server, member };
};

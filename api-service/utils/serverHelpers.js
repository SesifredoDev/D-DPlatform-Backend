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

function getRequestOrigin(req) {
    const host = req.get('host');
    if (!host) {
        return null;
    }

    return `${req.protocol}://${host}`;
}

function getPublicOrigin(req) {
    const configuredOrigin = process.env.PUBLIC_API_ORIGIN?.trim();
    if (configuredOrigin) {
        return configuredOrigin.replace(/\/+$/, '');
    }

    return getRequestOrigin(req);
}

exports.buildFileUrl = (req, key) => {
    if (!key) return null;

    const origin = getPublicOrigin(req);
    if (!origin) return key;

    if (key.startsWith('http')) {
        try {
            const parsed = new URL(key);
            const pathname = parsed.pathname || '';

            if (pathname.startsWith('/api/files/')) {
                return `${origin}${pathname}${parsed.search || ''}`;
            }

            const normalizedPath = pathname.replace(/^\/+/, '');
            return `${origin}/api/files/${normalizedPath}${parsed.search || ''}`;
        } catch {
            return key;
        }
    }

    if (key.startsWith('/api/files/')) {
        return `${origin}${key}`;
    }

    return `${origin}/api/files/${key}`;
};

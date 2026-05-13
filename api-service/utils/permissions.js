const Role = require("../models/Roles");

function resolveId(value) {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (value._id) return value._id.toString();
    if (typeof value.toString === "function") return value.toString();
    return "";
}

function getMemberRoleIds(member) {
    return (member?.roles || [])
        .map(resolveId)
        .filter(Boolean);
}

exports.resolveId = resolveId;
exports.getMemberRoleIds = getMemberRoleIds;

exports.isAdmin = (member)=> {
    return (
        member.roles.includes("owner") ||
        member.roles.includes("admin")
    );
}

exports.getMemberRoles = async (member, server) => {
    const roleValues = member?.roles || [];
    const populatedRoles = roleValues.filter(role =>
        role && typeof role === "object" && role.permissions
    );
    const populatedRoleIds = new Set(populatedRoles.map(resolveId));
    const missingRoleIds = getMemberRoleIds(member)
        .filter(roleId => !populatedRoleIds.has(roleId));

    if (!roleValues.length && server) {
        return Role.find({
            server: resolveId(server),
            name: { $in: ["Everyone", "@everyone"] }
        });
    }

    if (!missingRoleIds.length) {
        return populatedRoles;
    }

    const fetchedRoles = await Role.find({ _id: { $in: missingRoleIds } });
    return [...populatedRoles, ...fetchedRoles];
};


exports.hasPermission = async (server, member, permissionName) => {
    if (!server || !member) return false;
    if (resolveId(server.owner) === resolveId(member.user)) return true;

    const roles = await exports.getMemberRoles(member, server);

    return roles.some(role =>
        role.permissions?.ADMINISTRATOR === true ||
        role.permissions?.[permissionName] === true
    );
};

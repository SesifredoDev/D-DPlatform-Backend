const Role = require("../models/Roles");

exports.isAdmin = (member)=> {
    return (
        member.roles.includes("owner") ||
        member.roles.includes("admin")
    );
}



exports.hasPermission = async (server, member, permissionName) => {
    if (server.owner.toString() === member.user.toString()) return true;

    const roles = await Role.find({ _id: { $in: member.roles } });

    return roles.some(role =>
        role.permissions.ADMINISTRATOR === true ||
        role.permissions[permissionName] === true
    );
};
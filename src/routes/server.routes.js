
const express = require('express');
const router = express.Router();
const upload = require("../middleware/upload.middleware");
const auth = require('../middleware/auth.middleware');
const {
    createServer,
    joinServer,
    leaveServer,
    deleteServer,
    updateServer,
    getUserServers,
    getServerDetails,
    createRole,
    updateRole,
    deleteRole,
    updateMemberRoles,
} = require( "../controllers/server.controller.js");
const {
    createChannel,
    updateChannel,
    deleteChannel,
    listChannels,
    m
} = require("../controllers/channel.controller.js");


router.post("/", auth, upload.fields([{ name: 'icon', maxCount: 1 }]), createServer);
router.post("/join", auth, joinServer);
router.post("/:serverId/update/", auth, upload.fields([{ name: 'icon', maxCount: 1 }]),updateServer )
router.get("/list", auth, getUserServers)
router.post("/:serverId/leave", auth, leaveServer);
router.delete("/:serverId", auth, deleteServer);
router.get("/:serverId", auth, getServerDetails )

router.post("/:serverId/role", auth, createRole);
router.patch("/:serverId/role/:roleId", auth, updateRole)
router.delete("/:serverId/role/:roleId", auth, deleteRole)
router.post("/:serverId/role/member/:memberId", auth, updateMemberRoles)


router.get("/:serverId/channels", auth, listChannels);
router.post("/:serverId/channels", auth, createChannel);
router.patch("/:serverId/channels/:channelId", auth, updateChannel);
router.delete("/:serverId/channels/:channelId", auth, deleteChannel);

module.exports = router;
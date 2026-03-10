const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth.middleware');
const userController = require('../controllers/user.controller');
const upload = require("../middleware/upload.middleware");

router.get('/me', authenticate, userController.getMe);

router.post(
    "/profile-icon",
    authenticate,
    upload.single("icon"), // 👈 field name = "icon"
    userController.uploadProfileIcon
);


module.exports = router;

const express = require('express');
const { getLatestDesktopUpdate } = require('../controllers/desktop-update.controller');

const router = express.Router();

router.get('/latest', getLatestDesktopUpdate);

module.exports = router;

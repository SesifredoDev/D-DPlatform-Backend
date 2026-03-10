const express = require('express');
const router = express.Router();
const fileController = require('../controllers/files.controller')


router.get("/:id", fileController.getFile);

module.exports = router;
const express = require('express');
const router = express.Router();
const fileController = require('../controllers/files.controller');
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.get("/:id", fileController.getFile);
router.post("/upload", upload.single('file'), fileController.uploadFile);

module.exports = router;
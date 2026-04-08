const express = require('express');
const router = express.Router();
const fileController = require('../controllers/files.controller');
const upload = require('../middleware/upload.middleware');

router.get("/:id", fileController.getFile);
router.post("/upload", upload.single('file'), fileController.uploadFile);

// New endpoints for chunked uploads
router.post("/upload-chunk", upload.single('chunk'), fileController.uploadChunk);
router.post("/finalize-upload", fileController.finalizeUpload);

module.exports = router;

const express = require('express');
const router = express.Router();
const fileController = require('../controllers/files.controller');
const upload = require('../middleware/upload.middleware');
const auth = require('../middleware/auth.middleware');

router.get("/:id/astral-manifest", fileController.getAstralManifest);
router.get("/:id/astral-file", fileController.getAstralFile);
router.get("/:id", fileController.getFile);
router.post("/upload", auth, upload.single('file'), fileController.uploadFile);

// New endpoints for chunked uploads
router.post("/upload-chunk", auth, upload.single('chunk'), fileController.uploadChunk);
router.post("/finalize-upload", auth, fileController.finalizeUpload);

module.exports = router;

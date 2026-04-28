const s3Service = require('../services/s3.service');
const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { buildFileUrl } = require('../utils/fileUrl');

const TEMP_DIR = path.join(os.tmpdir(), 'd-dplatform-uploads');
const SHARP_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB limit for Sharp processing

/**
 * Proxy S3 file through API:
 * GET /api/files/:id
 * (Here :id is the full S3 key, e.g. uuid-filename.ext)
 */
exports.getFile = async (req, res) => {
    try {
        const key = req.params.id; 
        
        console.log(`[FilesController] Proxying request for S3 key: ${key}`);
        const { stream, contentType, contentLength } = await s3Service.getObjectStream(key);

        if (!stream) {
            return res.status(404).json({ message: "File not found in S3" });
        }

        res.set('Content-Type', contentType);
        if (contentLength) res.set('Content-Length', contentLength);
        
        // Use Content-Disposition inline for viewing in browser, with filename if possible
        const filename = key.split('-').slice(1).join('-') || 'file';
        res.set('Content-Disposition', `inline; filename="${filename}"`);

        // Stream the S3 object body directly to the Express response
        stream.pipe(res);
    } catch (error) {
        console.error(`[FilesController] Error proxying S3 file:`, error);
        res.status(404).json({ message: "File not found or access denied" });
    }
};

/**
 * Direct Upload to S3
 */
exports.uploadFile = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file provided" });
    }

    try {
        let fileBuffer = req.file.buffer;
        let contentType = req.file.mimetype;
        let filename = req.file.originalname;

        if (contentType.startsWith('image/') && req.file.size <= SHARP_SIZE_LIMIT) {
            try {
                const sharpInstance = sharp(fileBuffer);
                const metadata = await sharpInstance.metadata();
                if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
                    fileBuffer = await sharpInstance.jpeg({ quality: 100, progressive: true, mozjpeg: true }).toBuffer();
                    contentType = 'image/jpeg';
                } else if (metadata.format === 'png') {
                    fileBuffer = await sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
                    contentType = 'image/png';
                } else if (metadata.format === 'webp') {
                    fileBuffer = await sharpInstance.webp({ lossless: true }).toBuffer();
                    contentType = 'image/webp';
                }
            } catch (sharpError) {
                console.warn(`[FilesController] Sharp processing failed for: ${filename}`, sharpError);
            }
        }

        const uploadedAsset = await s3Service.uploadToS3(fileBuffer, filename, contentType);
        const fullUrl = buildFileUrl(req, uploadedAsset.key);

        res.status(201).json({
            id: uploadedAsset.id,
            filename: uploadedAsset.filename,
            contentType: uploadedAsset.contentType,
            url: fullUrl 
        });
    } catch (error) {
        console.error("[FilesController] Upload error:", error);
        if (!res.headersSent) res.status(500).json({ message: "S3 upload failed processing" });
    }
};

/**
 * Chunked Upload: Receives chunks
 */
exports.uploadChunk = async (req, res) => {
    const { fileId, chunkIndex } = req.body;
    if (!fileId || chunkIndex === undefined || !req.file) {
        return res.status(400).json({ message: "Missing required chunk data" });
    }

    try {
        const chunkDir = path.join(TEMP_DIR, fileId);
        await fs.ensureDir(chunkDir);
        const chunkPath = path.join(chunkDir, `chunk-${chunkIndex}`);
        await fs.writeFile(chunkPath, req.file.buffer);
        res.status(200).json({ message: "Chunk uploaded successfully" });
    } catch (error) {
        console.error(`[FilesController] Chunk upload error for fileId ${fileId}:`, error);
        res.status(500).json({ message: "Failed to store chunk" });
    }
};

/**
 * Finalize Chunked Upload: Stream to S3
 */
exports.finalizeUpload = async (req, res) => {
    const { fileId, fileName, fileType } = req.body;

    if (!fileId || !fileName) {
        return res.status(400).json({ message: "Incomplete data for finalization" });
    }

    const chunkDir = path.join(TEMP_DIR, fileId);

    try {
        const chunkFiles = await fs.readdir(chunkDir);
        chunkFiles.sort((a, b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]));

        const chunkBuffers = await Promise.all(
            chunkFiles.map(file => fs.readFile(path.join(chunkDir, file)))
        );
        let finalBuffer = Buffer.concat(chunkBuffers);

        let contentType = fileType;
        if (contentType.startsWith('image/') && finalBuffer.length <= SHARP_SIZE_LIMIT) {
            try {
                const sharpInstance = sharp(finalBuffer);
                const metadata = await sharpInstance.metadata();
                if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
                    finalBuffer = await sharpInstance.jpeg({ quality: 100, progressive: true, mozjpeg: true }).toBuffer();
                    contentType = 'image/jpeg';
                } else if (metadata.format === 'png') {
                    finalBuffer = await sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
                    contentType = 'image/png';
                } else if (metadata.format === 'webp') {
                    finalBuffer = await sharpInstance.webp({ lossless: true }).toBuffer();
                    contentType = 'image/webp';
                }
            } catch (err) {
                console.warn(`[FilesController] Compression failed for reassembled: ${fileName}`, err);
            }
        }

        const uploadedAsset = await s3Service.uploadToS3(finalBuffer, fileName, contentType);
        const fullUrl = buildFileUrl(req, uploadedAsset.key);

        // Cleanup
        await fs.remove(chunkDir).catch(e => console.error("[FilesController] Failed to cleanup chunks:", e));

        res.status(201).json({
            id: uploadedAsset.id,
            filename: uploadedAsset.filename,
            contentType: uploadedAsset.contentType,
            url: fullUrl
        });

    } catch (error) {
        console.error(`[FilesController] Finalization error for fileId ${fileId}:`, error);
        if (!res.headersSent) res.status(500).json({ message: "Failed to finalize upload to S3" });
    }
};

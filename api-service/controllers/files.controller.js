const s3Service = require('../services/s3.service');
const sharp = require('sharp');
const fs = require('fs-extra');
const nodeFs = require('fs');
const path = require('path');
const os = require('os');
const { buildFileUrl } = require('../utils/serverHelpers');

const TEMP_DIR = path.join(os.tmpdir(), 'd-dplatform-uploads');
const SHARP_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB limit for Sharp processing
const ASTRAL_CONTENT_TYPE = 'application/vnd.ddplatform.astral';

function isAstralFilename(filename) {
    return String(filename || '').toLowerCase().endsWith('.astral');
}

function getUploadContentType(filename, contentType) {
    if (isAstralFilename(filename)) {
        return ASTRAL_CONTENT_TYPE;
    }

    return contentType || 'application/octet-stream';
}

function getSafeDispositionFilename(filename) {
    return String(filename || 'file').replace(/["\r\n]/g, '_');
}

function getFilenameFromKey(key) {
    return String(key || '').replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '') || 'file';
}

function getContentDisposition(req, filename) {
    const disposition = req.query?.download === '1' || req.query?.download === 'true'
        ? 'attachment'
        : 'inline';

    return `${disposition}; filename="${getSafeDispositionFilename(filename)}"`;
}

function validateUploadSessionId(fileId) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(fileId || ''))) {
        throw new Error('Invalid upload session id');
    }
}

function parseChunkIndex(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error('Invalid chunk index');
    }

    return parsed;
}

async function getSortedChunkFiles(chunkDir) {
    const chunkFiles = (await fs.readdir(chunkDir))
        .filter(file => /^chunk-\d+$/.test(file))
        .sort((a, b) => parseChunkIndex(a.split('-')[1]) - parseChunkIndex(b.split('-')[1]));

    if (!chunkFiles.length) {
        throw new Error('No chunks found for upload');
    }

    return chunkFiles;
}

async function getChunkedUploadSize(chunkDir, chunkFiles) {
    let size = 0;
    for (const chunkFile of chunkFiles) {
        const stat = await fs.stat(path.join(chunkDir, chunkFile));
        size += stat.size;
    }

    return size;
}

async function assembleChunksToFile(chunkDir, chunkFiles, outputPath) {
    await fs.remove(outputPath);
    for (const chunkFile of chunkFiles) {
        const chunkBuffer = await fs.readFile(path.join(chunkDir, chunkFile));
        await fs.appendFile(outputPath, chunkBuffer);
    }
}

async function uploadSmallImageBufferIfUseful(buffer, filename, contentType) {
    if (!contentType.startsWith('image/') || buffer.length > SHARP_SIZE_LIMIT) {
        return { buffer, contentType };
    }

    try {
        const sharpInstance = sharp(buffer);
        const metadata = await sharpInstance.metadata();
        if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
            return {
                buffer: await sharpInstance.jpeg({ quality: 100, progressive: true, mozjpeg: true }).toBuffer(),
                contentType: 'image/jpeg'
            };
        }

        if (metadata.format === 'png') {
            return {
                buffer: await sharpInstance.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
                contentType: 'image/png'
            };
        }

        if (metadata.format === 'webp') {
            return {
                buffer: await sharpInstance.webp({ lossless: true }).toBuffer(),
                contentType: 'image/webp'
            };
        }
    } catch (sharpError) {
        console.warn(`[FilesController] Sharp processing failed for: ${filename}`, sharpError);
    }

    return { buffer, contentType };
}

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

        const filename = getFilenameFromKey(key);
        res.set('Content-Type', contentType || getUploadContentType(filename));
        if (contentLength) res.set('Content-Length', contentLength);
        res.set('Content-Disposition', getContentDisposition(req, filename));

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
        const filename = req.file.originalname;
        const sourceContentType = getUploadContentType(filename, req.file.mimetype);
        const processed = await uploadSmallImageBufferIfUseful(req.file.buffer, filename, sourceContentType);
        const uploadedAsset = await s3Service.uploadToS3(processed.buffer, filename, processed.contentType);
        const fullUrl = buildFileUrl(req, uploadedAsset.key);

        res.status(201).json({
            id: uploadedAsset.id,
            filename: uploadedAsset.filename,
            contentType: uploadedAsset.contentType,
            size: processed.buffer.length,
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
        validateUploadSessionId(fileId);
        const normalizedChunkIndex = parseChunkIndex(chunkIndex);
        const chunkDir = path.join(TEMP_DIR, fileId);
        await fs.ensureDir(chunkDir);
        const chunkPath = path.join(chunkDir, `chunk-${normalizedChunkIndex}`);
        await fs.writeFile(chunkPath, req.file.buffer);
        res.status(200).json({ message: "Chunk uploaded successfully" });
    } catch (error) {
        console.error(`[FilesController] Chunk upload error for fileId ${fileId}:`, error);
        res.status(500).json({ message: "Failed to store chunk" });
    }
};

/**
 * Finalize Chunked Upload: stream large files to S3 without building one large Buffer
 */
exports.finalizeUpload = async (req, res) => {
    const { fileId, fileName, fileType } = req.body;

    if (!fileId || !fileName) {
        return res.status(400).json({ message: "Incomplete data for finalization" });
    }

    try {
        validateUploadSessionId(fileId);
    } catch {
        return res.status(400).json({ message: "Invalid upload session id" });
    }

    const chunkDir = path.join(TEMP_DIR, fileId);
    const assembledPath = path.join(chunkDir, 'assembled-upload');

    try {
        const chunkFiles = await getSortedChunkFiles(chunkDir);
        const uploadSize = await getChunkedUploadSize(chunkDir, chunkFiles);
        let contentType = getUploadContentType(fileName, fileType);
        let uploadedAsset;
        let responseSize = uploadSize;

        if (contentType.startsWith('image/') && uploadSize <= SHARP_SIZE_LIMIT) {
            const chunkBuffers = await Promise.all(
                chunkFiles.map(file => fs.readFile(path.join(chunkDir, file)))
            );
            const processed = await uploadSmallImageBufferIfUseful(Buffer.concat(chunkBuffers), fileName, contentType);
            contentType = processed.contentType;
            responseSize = processed.buffer.length;
            uploadedAsset = await s3Service.uploadToS3(processed.buffer, fileName, contentType);
        } else {
            await assembleChunksToFile(chunkDir, chunkFiles, assembledPath);
            uploadedAsset = await s3Service.uploadToS3(nodeFs.createReadStream(assembledPath), fileName, contentType);
        }

        const fullUrl = buildFileUrl(req, uploadedAsset.key);

        await fs.remove(chunkDir).catch(e => console.error("[FilesController] Failed to cleanup chunks:", e));

        res.status(201).json({
            id: uploadedAsset.id,
            filename: uploadedAsset.filename,
            contentType: uploadedAsset.contentType,
            size: responseSize,
            url: fullUrl
        });
    } catch (error) {
        console.error(`[FilesController] Finalization error for fileId ${fileId}:`, error);
        await fs.remove(assembledPath).catch(() => undefined);
        if (!res.headersSent) res.status(500).json({ message: "Failed to finalize upload to S3" });
    }
};


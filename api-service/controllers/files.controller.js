const s3Service = require('../services/s3.service');
const sharp = require('sharp');
const fs = require('fs-extra');
const nodeFs = require('fs');
const path = require('path');
const os = require('os');
const { Transform } = require('stream');
const zlib = require('zlib');
const { buildFileUrl } = require('../utils/serverHelpers');

const TEMP_DIR = path.join(os.tmpdir(), 'd-dplatform-uploads');
const SHARP_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB limit for Sharp processing
const ASTRAL_CONTENT_TYPE = 'application/vnd.ddplatform.astral';
const ASTRAL_MAGIC = Buffer.from([65, 83, 84, 82, 65, 76, 49, 0]);
const ASTRAL_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const ASTRAL_ARCHIVE_PATH_MAX_BYTES = 4096;

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

function normalizeArchiveRelativePath(value) {
    const normalized = String(value || '').replace(/\\/g, '/').trim();
    if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
        throw new Error('Invalid Astral archive path');
    }

    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
        throw new Error('Invalid Astral archive path');
    }

    return parts.join('/');
}

function guessAstralEntryContentType(relativePath) {
    const extension = String(relativePath || '').split(/[?#]/)[0].toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    if (extension === 'webm') return 'video/webm';
    if (extension === 'mp4' || extension === 'm4v') return 'video/mp4';
    if (extension === 'mov') return 'video/quicktime';
    if (extension === 'ogg' || extension === 'oga') return 'audio/ogg';
    if (extension === 'opus') return 'audio/ogg; codecs=opus';
    if (extension === 'mp3') return 'audio/mpeg';
    if (extension === 'wav') return 'audio/wav';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'png') return 'image/png';
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'gif') return 'image/gif';
    if (extension === 'json') return 'application/json';
    return 'application/octet-stream';
}

function createAstralMagicStripper() {
    let header = Buffer.alloc(0);
    let checked = false;

    return new Transform({
        transform(chunk, encoding, callback) {
            if (checked) {
                callback(null, chunk);
                return;
            }

            header = Buffer.concat([header, chunk]);
            if (header.length < ASTRAL_MAGIC.length) {
                callback();
                return;
            }

            const magic = header.subarray(0, ASTRAL_MAGIC.length);
            if (!magic.equals(ASTRAL_MAGIC)) {
                callback(new Error('Invalid .astral recording package'));
                return;
            }

            checked = true;
            callback(null, header.subarray(ASTRAL_MAGIC.length));
        },
        flush(callback) {
            if (!checked) {
                callback(new Error('Invalid .astral recording package'));
                return;
            }

            callback();
        }
    });
}

class AstralArchiveReader {
    constructor(stream) {
        this.iterator = stream[Symbol.asyncIterator]();
        this.buffer = Buffer.alloc(0);
        this.done = false;
    }

    async readExact(length) {
        while (this.buffer.length < length) {
            if (this.done) {
                throw new Error('Astral archive ended unexpectedly');
            }

            const next = await this.iterator.next();
            if (next.done) {
                this.done = true;
                continue;
            }

            const chunk = Buffer.isBuffer(next.value)
                ? next.value
                : Buffer.from(next.value);
            if (chunk.length) {
                this.buffer = this.buffer.length
                    ? Buffer.concat([this.buffer, chunk])
                    : chunk;
            }
        }

        const output = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        return output;
    }

    async skip(length) {
        let remaining = length;
        while (remaining > 0) {
            const take = Math.min(remaining, Math.max(1, this.buffer.length || 64 * 1024));
            await this.readExact(take);
            remaining -= take;
        }
    }

    async pipeBytes(response, length) {
        let remaining = length;
        while (remaining > 0) {
            const take = Math.min(remaining, Math.max(1, this.buffer.length || 64 * 1024));
            const chunk = await this.readExact(take);
            remaining -= chunk.length;

            if (!response.write(chunk)) {
                await new Promise(resolve => response.once('drain', resolve));
            }
        }

        response.end();
    }

    async readEntryHeader() {
        const pathLengthBytes = await this.readExact(4);
        const pathLength = pathLengthBytes.readUInt32LE(0);
        if (pathLength === 0) {
            return null;
        }

        if (pathLength > ASTRAL_ARCHIVE_PATH_MAX_BYTES) {
            throw new Error('Astral archive path is too long');
        }

        const fileSizeBytes = await this.readExact(8);
        const fileSize = Number(fileSizeBytes.readBigUInt64LE(0));
        if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
            throw new Error('Astral archive file is too large');
        }

        const relativePath = normalizeArchiveRelativePath((await this.readExact(pathLength)).toString('utf8'));
        return {
            relativePath,
            fileSize
        };
    }
}

async function createAstralArchiveReader(key) {
    const { stream, contentLength } = await s3Service.getObjectStream(key);
    const magicStripper = createAstralMagicStripper();
    const gunzip = zlib.createGunzip();
    const archiveStream = stream.pipe(magicStripper).pipe(gunzip);
    return {
        reader: new AstralArchiveReader(archiveStream),
        sourceStream: stream,
        archiveStream,
        contentLength
    };
}

function destroyAstralStreams(sourceStream, archiveStream) {
    sourceStream?.destroy?.();
    archiveStream?.destroy?.();
}

async function readAstralManifest(key) {
    const { reader, sourceStream, archiveStream, contentLength } = await createAstralArchiveReader(key);
    try {
        const header = await reader.readEntryHeader();
        if (!header || header.relativePath !== 'manifest.json') {
            throw new Error('Astral package is missing manifest.json');
        }

        if (header.fileSize > ASTRAL_MANIFEST_MAX_BYTES) {
            throw new Error('Astral manifest is too large');
        }

        const manifest = JSON.parse((await reader.readExact(header.fileSize)).toString('utf8'));
        return {
            manifest,
            packageSize: contentLength || 0
        };
    } finally {
        destroyAstralStreams(sourceStream, archiveStream);
    }
}

function parseRangeHeader(rangeHeader, fileSize) {
    if (!rangeHeader) {
        return null;
    }

    const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
        return { invalid: true };
    }

    let start;
    let end;
    if (match[1] === '') {
        const suffixLength = Number.parseInt(match[2], 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return { invalid: true };
        }

        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
    } else {
        start = Number.parseInt(match[1], 10);
        end = match[2] === '' ? fileSize - 1 : Number.parseInt(match[2], 10);
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
        return { invalid: true };
    }

    return {
        start,
        end: Math.min(end, fileSize - 1)
    };
}

function buildAstralAttachmentUrl(req, key, routeName) {
    const fileUrl = buildFileUrl(req, key);
    if (!fileUrl) return null;

    try {
        const parsed = new URL(fileUrl);
        const filesMarker = '/files/';
        const markerIndex = parsed.pathname.lastIndexOf(filesMarker);
        const apiPrefix = markerIndex >= 0 ? parsed.pathname.slice(0, markerIndex + filesMarker.length) : '/api/files/';
        parsed.pathname = `${apiPrefix}${encodeURIComponent(key)}/${routeName}`;
        parsed.search = '';
        return parsed.toString();
    } catch {
        return null;
    }
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
 * Fast Astral manifest access:
 * GET /api/files/:id/astral-manifest
 */
exports.getAstralManifest = async (req, res) => {
    const key = req.params.id;

    try {
        if (!isAstralFilename(key)) {
            return res.status(400).json({ message: 'This file is not an .astral recording' });
        }

        const { manifest, packageSize } = await readAstralManifest(key);
        const mediaUrl = buildAstralAttachmentUrl(req, key, 'astral-file');
        const packageUrl = buildFileUrl(req, key);
        res.json({
            sessionId: `remote-${String(key).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100)}`,
            sessionDir: `remote:${key}`,
            packagePath: packageUrl,
            packageSize,
            manifest,
            remoteMediaUrlTemplate: mediaUrl ? `${mediaUrl}?path={path}` : null
        });
    } catch (error) {
        console.error('[FilesController] Failed to read Astral manifest:', error);
        res.status(422).json({ message: error.message || 'Could not read Astral recording manifest' });
    }
};

/**
 * Streams one file from inside an Astral package:
 * GET /api/files/:id/astral-file?path=participants/...
 */
exports.getAstralFile = async (req, res) => {
    const key = req.params.id;
    let targetPath;

    try {
        if (!isAstralFilename(key)) {
            return res.status(400).json({ message: 'This file is not an .astral recording' });
        }

        targetPath = normalizeArchiveRelativePath(req.query?.path);
    } catch (error) {
        return res.status(400).json({ message: error.message || 'Invalid Astral file path' });
    }

    let sourceStream;
    let archiveStream;
    try {
        const archive = await createAstralArchiveReader(key);
        sourceStream = archive.sourceStream;
        archiveStream = archive.archiveStream;
        const reader = archive.reader;

        while (true) {
            const header = await reader.readEntryHeader();
            if (!header) {
                break;
            }

            if (header.relativePath !== targetPath) {
                await reader.skip(header.fileSize);
                continue;
            }

            const range = parseRangeHeader(req.headers.range, header.fileSize);
            if (range?.invalid) {
                res.set('Content-Range', `bytes */${header.fileSize}`);
                return res.status(416).end();
            }

            const start = range ? range.start : 0;
            const end = range ? range.end : Math.max(0, header.fileSize - 1);
            const contentLength = header.fileSize === 0 ? 0 : end - start + 1;
            if (start > 0) {
                await reader.skip(start);
            }

            res.status(range ? 206 : 200);
            res.set('Content-Type', guessAstralEntryContentType(targetPath));
            res.set('Accept-Ranges', 'bytes');
            res.set('Content-Length', String(contentLength));
            res.set('Content-Disposition', `inline; filename="${getSafeDispositionFilename(path.basename(targetPath))}"`);
            if (range) {
                res.set('Content-Range', `bytes ${start}-${end}/${header.fileSize}`);
            }

            if (contentLength === 0) {
                return res.end();
            }

            await reader.pipeBytes(res, contentLength);
            return;
        }

        res.status(404).json({ message: 'File not found in Astral recording' });
    } catch (error) {
        console.error('[FilesController] Failed to stream Astral file:', error);
        if (!res.headersSent) {
            res.status(422).json({ message: error.message || 'Could not stream Astral recording file' });
        } else {
            res.destroy(error);
        }
    } finally {
        destroyAstralStreams(sourceStream, archiveStream);
    }
};

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


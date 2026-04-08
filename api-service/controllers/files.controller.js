const mongoose = require('mongoose');
const getBucket = require('../services/gridfs.service');
const sharp = require('sharp');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const TEMP_DIR = path.join(os.tmpdir(), 'd-dplatform-uploads');

exports.getFile = async (req, res) => {
    const bucket = getBucket();
    if (!bucket) {
        return res.status(500).json({ message: "GridFS not ready" });
    }

    try {
        const fileId = new mongoose.Types.ObjectId(req.params.id);

        const files = await bucket.find({ _id: fileId }).toArray();
        if (!files || files.length === 0) {
            return res.status(404).json({ message: "File not found" });
        }

        const file = files[0];

        res.set('Content-Type', file.contentType);
        res.set('Content-Disposition', `inline; filename="${file.filename}"`);

        const downloadStream = bucket.openDownloadStream(fileId);

        downloadStream.on('error', (err) => {
            res.status(404).json({ message: "Could not download file" });
        });

        downloadStream.pipe(res);
    } catch (error) {
        res.status(400).json({ message: "Invalid file ID" });
    }
};

exports.uploadFile = async (req, res) => {
    const bucket = getBucket();
    if (!bucket || !req.file) {
        return res.status(400).json({ message: "No file provided" });
    }

    try {
        let fileBuffer = req.file.buffer;
        let contentType = req.file.mimetype;
        let filename = req.file.originalname;

        // Perform lossless image compression if the file is an image
        if (contentType.startsWith('image/')) {
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
        }

        const uploadStream = bucket.openUploadStream(filename, {
            contentType: contentType
        });

        uploadStream.end(fileBuffer);

        uploadStream.on('finish', () => {
            res.status(201).json({
                id: uploadStream.id,
                filename: filename,
                contentType: contentType,
                url: `/api/files/${uploadStream.id}`
            });
        });

        uploadStream.on('error', (err) => {
            res.status(500).json({ message: "Upload failed during stream" });
        });
    } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ message: "Upload failed processing" });
    }
};

exports.uploadChunk = async (req, res) => {
    const { fileId, chunkIndex } = req.body;
    if (!fileId || chunkIndex === undefined || !req.file) {
        return res.status(400).json({ message: "Missing required chunk data" });
    }

    const chunkDir = path.join(TEMP_DIR, fileId);
    await fs.ensureDir(chunkDir);

    const chunkPath = path.join(chunkDir, `chunk-${chunkIndex}`);
    await fs.writeFile(chunkPath, req.file.buffer);

    res.status(200).json({ message: "Chunk uploaded successfully" });
};

exports.finalizeUpload = async (req, res) => {
    const { fileId, fileName, fileType } = req.body;
    const bucket = getBucket();

    if (!bucket || !fileId || !fileName) {
        return res.status(400).json({ message: "Incomplete data for finalization" });
    }

    const chunkDir = path.join(TEMP_DIR, fileId);

    try {
        const chunkFiles = await fs.readdir(chunkDir);
        // Sort chunks by index
        chunkFiles.sort((a, b) => {
            const indexA = parseInt(a.split('-')[1]);
            const indexB = parseInt(b.split('-')[1]);
            return indexA - indexB;
        });

        // Combine chunks into a single buffer
        const chunkBuffers = await Promise.all(
            chunkFiles.map(file => fs.readFile(path.join(chunkDir, file)))
        );
        let finalBuffer = Buffer.concat(chunkBuffers);

        // Perform lossless image compression if the file is an image
        let contentType = fileType;
        if (contentType.startsWith('image/')) {
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
                console.warn("Compression failed during finalization, using original buffer:", err);
            }
        }

        const uploadStream = bucket.openUploadStream(fileName, {
            contentType: contentType
        });

        uploadStream.end(finalBuffer);

        uploadStream.on('finish', async () => {
            // Clean up temporary chunks
            await fs.remove(chunkDir);

            res.status(201).json({
                id: uploadStream.id,
                filename: fileName,
                contentType: contentType,
                url: `/api/files/${uploadStream.id}`
            });
        });

        uploadStream.on('error', (err) => {
            res.status(500).json({ message: "GridFS upload failed during finalization" });
        });

    } catch (error) {
        console.error("Finalization error:", error);
        res.status(500).json({ message: "Failed to finalize upload" });
    }
};

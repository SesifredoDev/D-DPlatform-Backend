const User = require('../models/User');
const s3Service = require('../services/s3.service');
const sharp = require('sharp');

const SHARP_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB limit for Sharp processing

exports.uploadProfileIcon = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
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
                console.warn(`[UserController] Sharp processing failed for: ${filename}`, sharpError);
            }
        }

        const uploadedAsset = await s3Service.uploadToS3(fileBuffer, filename, contentType);
        const fileUrl = `${req.protocol}://${req.get('host')}/api/files/${uploadedAsset.key}`;

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { profileIcon: fileUrl },
            { new: true }
        ).select("-password");

        res.json({ message: "Profile icon updated", user });
    } catch (error) {
        console.error("[UserController] Upload error:", error);
        res.status(500).json({ message: "S3 upload failed processing" });
    }
};

exports.getMe = async (req, res) => {
    const user = await User.findById(req.user.id).select('-password');

    if (!user) return res.sendStatus(404);

    res.json(user);
};

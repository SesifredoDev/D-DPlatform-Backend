const User = require('../models/User');

const getBucket = require("../services/gridfs.service");
const mongoose = require("mongoose");

exports.uploadProfileIcon = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
    }

    const bucket = getBucket();
    if (!bucket) {
        return res.status(500).json({ message: "GridFS not ready" });
    }

    const fileId = new mongoose.Types.ObjectId();

    const uploadStream = bucket.openUploadStreamWithId(
        fileId,
        req.file.originalname,
        { contentType: req.file.mimetype }
    );

    uploadStream.end(req.file.buffer);

    uploadStream.on("finish", async () => {
        const fileUrl = `${req.protocol}://${req.get("host")}/api/files/${fileId}`;

        const user = await User.findByIdAndUpdate(
            req.user.id,
            { profileIcon: fileUrl },
            { new: true }
        ).select("-password");

        res.json({ message: "Profile icon updated", user });
    });

    uploadStream.on("error", (err) => {
        res.status(500).json({ error: err.message });
    });
};

exports.getMe = async (req, res) => {
    const user = await User.findById(req.user.id).select('-password');

    if (!user) return res.sendStatus(404);

    res.json(user);
};

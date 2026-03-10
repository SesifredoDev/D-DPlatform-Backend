const getBucket = require("../services/gridfs.service");
const {Types} = require("mongoose");

exports.uploadToGridFS = (file, req) => {
    return new Promise((resolve, reject) => {
        const bucket = getBucket();
        if (!bucket) return reject(new Error("GridFS not ready"));

        const fileId = new Types.ObjectId();
        const uploadStream = bucket.openUploadStreamWithId(
            fileId,
            file.originalname,
            { contentType: file.mimetype }
        );

        uploadStream.end(file.buffer);

        uploadStream.on("finish", () => {
            const fileUrl = `${req.protocol}://${req.get("host")}/api/files/${fileId}`;
            resolve(fileUrl);
        });

        uploadStream.on("error", (err) => reject(err));
    });
};

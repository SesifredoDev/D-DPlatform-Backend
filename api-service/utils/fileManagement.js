const getBucket = require("../services/gridfs.service");
const {Types} = require("mongoose");
const { buildFileUrl } = require("./fileUrl");

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
            const fileUrl = buildFileUrl(req, fileId.toString());
            resolve(fileUrl);
        });

        uploadStream.on("error", (err) => reject(err));
    });
};

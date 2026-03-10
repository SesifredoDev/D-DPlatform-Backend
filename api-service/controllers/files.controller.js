const mongoose = require('mongoose');
const getBucket = require('../services/gridfs.service');

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

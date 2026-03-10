const { GridFSBucket } = require("mongodb");
const mongoose = require("mongoose");

let bucket;

mongoose.connection.once("open", () => {
    bucket = new GridFSBucket(mongoose.connection.db, {
        bucketName: "uploads",
    });
});

module.exports = () => bucket;
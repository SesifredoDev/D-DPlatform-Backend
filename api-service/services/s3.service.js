const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const crypto = require("crypto");

const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

/**
 * Uploads a buffer or stream to S3.
 */
exports.uploadToS3 = async (buffer, filename, contentType) => {
    const fileId = crypto.randomUUID();
    const key = `${fileId}-${filename}`;

    console.log(`[S3Service] Uploading to S3: ${key} (${contentType})`);

    const parallelUploads3 = new Upload({
        client: s3Client,
        params: {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType
        },
    });

    await parallelUploads3.done();

    return {
        id: fileId,
        key: key,
        filename: filename,
        contentType: contentType
    };
};

/**
 * Fetches an object stream from S3.
 */
exports.getObjectStream = async (key) => {
    const command = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
    });

    const response = await s3Client.send(command);
    return {
        stream: response.Body,
        contentType: response.ContentType,
        contentLength: response.ContentLength
    };
};

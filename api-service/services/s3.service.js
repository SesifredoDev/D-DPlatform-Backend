const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const crypto = require("crypto");
const path = require("path");

let s3Client;

function getS3Client() {
    if (!s3Client) {
        s3Client = new S3Client({
            region: process.env.AWS_REGION,
            credentials: {
                accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
        });
    }

    return s3Client;
}

function sanitizeFilename(filename) {
    const fallbackName = 'file';
    const baseName = path.basename(filename || fallbackName).trim();
    const sanitizedName = baseName
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();

    return sanitizedName || fallbackName;
}

function normalizeStoredFileValue(value) {
    if (!value || typeof value !== 'string') {
        return value;
    }

    if (value.startsWith('/api/files/')) {
        return value.slice('/api/files/'.length);
    }

    if (/^https?:\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            if (parsed.pathname.startsWith('/api/files/')) {
                return parsed.pathname.slice('/api/files/'.length);
            }
        } catch {
            return value;
        }
    }

    return value;
}

function resetS3ClientForTests() {
    s3Client = undefined;
}

exports.sanitizeFilename = sanitizeFilename;
exports.normalizeStoredFileValue = normalizeStoredFileValue;
exports.__resetS3ClientForTests = resetS3ClientForTests;

/**
 * Uploads a buffer or stream to S3.
 */
exports.uploadToS3 = async (buffer, filename, contentType) => {
    const fileId = crypto.randomUUID();
    const safeFilename = sanitizeFilename(filename);
    const key = `${fileId}-${safeFilename}`;

    console.log(`[S3Service] Uploading to S3: ${key} (${contentType || 'application/octet-stream'})`);

    const parallelUploads3 = new Upload({
        client: getS3Client(),
        params: {
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType || 'application/octet-stream'
        },
    });

    await parallelUploads3.done();

    return {
        id: fileId,
        key,
        filename: safeFilename,
        name: safeFilename,
        contentType: contentType || 'application/octet-stream'
    };
};

/**
 * Fetches an object stream from S3.
 */
exports.getObjectStream = async (key) => {
    const normalizedKey = normalizeStoredFileValue(key);
    const command = new GetObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: normalizedKey,
    });

    const response = await getS3Client().send(command);
    return {
        stream: response.Body,
        contentType: response.ContentType,
        contentLength: response.ContentLength
    };
};

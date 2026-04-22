const s3Service = require('../../services/s3.service');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const crypto = require("crypto");

jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/lib-storage");
jest.mock("crypto", () => ({
    ...jest.requireActual("crypto"),
    randomUUID: jest.fn().mockReturnValue('mock-uuid'),
}));

describe('S3 Service', () => {
    const mockBucketName = 'test-bucket';
    const mockRegion = 'us-east-1';

    beforeAll(() => {
        process.env.AWS_BUCKET_NAME = mockBucketName;
        process.env.AWS_REGION = mockRegion;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('uploadToS3', () => {
        it('should upload a file and return its metadata', async () => {
            const mockBuffer = Buffer.from('test');
            const mockFilename = 'test.jpg';
            const mockContentType = 'image/jpeg';
            const mockUploadDone = jest.fn().mockResolvedValue({});
            
            Upload.mockImplementation(() => ({
                done: mockUploadDone
            }));

            const result = await s3Service.uploadToS3(mockBuffer, mockFilename, mockContentType);

            expect(Upload).toHaveBeenCalledWith(expect.objectContaining({
                params: expect.objectContaining({
                    Bucket: mockBucketName,
                    Key: `mock-uuid-${mockFilename}`,
                    Body: mockBuffer,
                    ContentType: mockContentType,
                })
            }));
            expect(mockUploadDone).toHaveBeenCalled();
            expect(result).toEqual({
                id: 'mock-uuid',
                key: `mock-uuid-${mockFilename}`,
                filename: mockFilename,
                contentType: mockContentType,
            });
        });
    });

    describe('getObjectStream', () => {
        it('should return a stream for a given key', async () => {
            const mockKey = 'some-key';
            const mockStream = { pipe: jest.fn() };
            const mockResponse = {
                Body: mockStream,
                ContentType: 'image/jpeg',
                ContentLength: 1024,
            };

            const mockSend = jest.fn().mockResolvedValue(mockResponse);
            S3Client.prototype.send = mockSend;

            const result = await s3Service.getObjectStream(mockKey);

            expect(GetObjectCommand).toHaveBeenCalledWith({
                Bucket: mockBucketName,
                Key: mockKey,
            });
            expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand));
            expect(result).toEqual({
                stream: mockStream,
                contentType: 'image/jpeg',
                contentLength: 1024,
            });
        });
    });
});

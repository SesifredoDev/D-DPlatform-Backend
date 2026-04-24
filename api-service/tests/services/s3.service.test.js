const s3Service = require('../../services/s3.service');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

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
        jest.spyOn(console, 'log').mockImplementation(() => {});
        S3Client.mockImplementation(() => ({
            send: jest.fn()
        }));
        s3Service.__resetS3ClientForTests();
    });

    afterEach(() => {
        console.log.mockRestore();
    });

    describe('sanitizeFilename', () => {
        it('sanitizes invalid path characters', () => {
            expect(s3Service.sanitizeFilename('folder\\bad:name?.png')).toBe('bad_name_.png');
        });
    });

    describe('normalizeStoredFileValue', () => {
        it('extracts the key from relative api file paths', () => {
            expect(s3Service.normalizeStoredFileValue('/api/files/test-key.png')).toBe('test-key.png');
        });

        it('extracts the key from absolute api file URLs', () => {
            expect(s3Service.normalizeStoredFileValue('http://localhost/api/files/test-key.png')).toBe('test-key.png');
        });

        it('preserves non-platform URLs', () => {
            expect(s3Service.normalizeStoredFileValue('https://cdn.example.com/icon.png')).toBe('https://cdn.example.com/icon.png');
        });
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
                contentType: mockContentType,
                filename: mockFilename,
                name: mockFilename,
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
            S3Client.mockImplementation(() => ({ send: mockSend }));
            s3Service.__resetS3ClientForTests();

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

        it('normalizes legacy api file URLs before fetching', async () => {
            const mockStream = { pipe: jest.fn() };
            const mockResponse = {
                Body: mockStream,
                ContentType: 'image/jpeg',
                ContentLength: 1024,
            };

            const mockSend = jest.fn().mockResolvedValue(mockResponse);
            S3Client.mockImplementation(() => ({ send: mockSend }));
            s3Service.__resetS3ClientForTests();

            await s3Service.getObjectStream('http://localhost/api/files/legacy-key.jpg');

            expect(GetObjectCommand).toHaveBeenCalledWith({
                Bucket: mockBucketName,
                Key: 'legacy-key.jpg',
            });
        });
    });
});

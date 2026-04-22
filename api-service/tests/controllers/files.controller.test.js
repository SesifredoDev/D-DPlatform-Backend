const filesController = require('../../controllers/files.controller');
const s3Service = require('../../services/s3.service');
const fs = require('fs-extra');

jest.mock('../../services/s3.service');
jest.mock('fs-extra');
jest.mock('sharp', () => jest.fn().mockReturnValue({
    metadata: jest.fn().mockResolvedValue({ format: 'jpeg' }),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('mock-buffer'))
}));

describe('Files Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            params: { id: 'file-key' },
            body: {},
            protocol: 'http',
            get: jest.fn().mockReturnValue('localhost')
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis()
        };
        jest.clearAllMocks();
    });

    describe('getFile', () => {
        it('should stream the file from S3', async () => {
            const mockStream = { pipe: jest.fn() };
            s3Service.getObjectStream.mockResolvedValue({
                stream: mockStream,
                contentType: 'image/jpeg',
                contentLength: 1024
            });

            await filesController.getFile(req, res);

            expect(res.set).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
            expect(mockStream.pipe).toHaveBeenCalledWith(res);
        });

        it('should return 404 if file not found in S3', async () => {
            s3Service.getObjectStream.mockResolvedValue({ stream: null });
            await filesController.getFile(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('uploadFile', () => {
        it('should upload a file to S3', async () => {
            req.file = {
                buffer: Buffer.from('test'),
                mimetype: 'image/jpeg',
                originalname: 'test.jpg',
                size: 1000
            };
            s3Service.uploadToS3.mockResolvedValue({
                key: 's3-key',
                id: '123',
                filename: 'test.jpg',
                contentType: 'image/jpeg'
            });

            await filesController.uploadFile(req, res);

            expect(s3Service.uploadToS3).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://localhost/api/files/s3-key' }));
        });
    });
});

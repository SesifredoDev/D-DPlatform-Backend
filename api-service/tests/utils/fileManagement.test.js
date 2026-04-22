const { uploadToGridFS } = require('../../utils/fileManagement');
const getBucket = require('../../services/gridfs.service');
const { EventEmitter } = require('events');

jest.mock('../../services/gridfs.service');

describe('File Management Utility', () => {
    describe('uploadToGridFS', () => {
        let mockBucket, mockUploadStream;

        beforeEach(() => {
            mockUploadStream = new EventEmitter();
            mockUploadStream.end = jest.fn();
            mockBucket = {
                openUploadStreamWithId: jest.fn().mockReturnValue(mockUploadStream)
            };
            getBucket.mockReturnValue(mockBucket);
        });

        it('should resolve with file URL on successful upload', async () => {
            const mockFile = {
                originalname: 'test.txt',
                mimetype: 'text/plain',
                buffer: Buffer.from('test data')
            };
            const mockReq = { protocol: 'http', get: jest.fn().mockReturnValue('localhost') };

            const uploadPromise = uploadToGridFS(mockFile, mockReq);
            
            // Simulate finish event
            mockUploadStream.emit('finish');

            const result = await uploadPromise;
            expect(result).toContain('http://localhost/api/files/');
            expect(mockUploadStream.end).toHaveBeenCalledWith(mockFile.buffer);
        });

        it('should reject if bucket is not ready', async () => {
            getBucket.mockReturnValue(null);
            await expect(uploadToGridFS({}, {})).rejects.toThrow("GridFS not ready");
        });

        it('should reject on upload stream error', async () => {
            const mockFile = { originalname: 'test.txt', buffer: Buffer.from('data') };
            const uploadPromise = uploadToGridFS(mockFile, {});
            
            mockUploadStream.emit('error', new Error('Upload failed'));

            await expect(uploadPromise).rejects.toThrow('Upload failed');
        });
    });
});

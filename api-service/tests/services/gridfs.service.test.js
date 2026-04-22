const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

// Mocking the entire mongoose connection to trigger the 'once' event
jest.mock("mongoose", () => {
    const originalMongoose = jest.requireActual("mongoose");
    return {
        ...originalMongoose,
        connection: {
            once: jest.fn(),
            db: { some: 'db' }
        }
    };
});
jest.mock("mongodb");

describe('GridFS Service', () => {
    let gridfsService;

    beforeEach(() => {
        jest.resetModules(); // This is crucial to reload the service for each test
        gridfsService = require('../../services/gridfs.service');
    });

    it('should initialize bucket when mongoose connection opens', () => {
        const mockOnce = mongoose.connection.once;
        expect(mockOnce).toHaveBeenCalledWith('open', expect.any(Function));

        const openCallback = mockOnce.mock.calls[0][1];
        const mockBucketInstance = { name: 'mockBucket' };
        GridFSBucket.mockImplementation(() => mockBucketInstance);

        openCallback(); // Manually trigger the callback

        expect(GridFSBucket).toHaveBeenCalledWith(mongoose.connection.db, {
            bucketName: "uploads",
        });
        expect(gridfsService()).toBe(mockBucketInstance);
    });

    it('should return undefined if bucket is not yet initialized', () => {
        expect(gridfsService()).toBeUndefined();
    });
});

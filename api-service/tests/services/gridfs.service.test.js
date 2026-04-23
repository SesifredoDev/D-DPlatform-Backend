const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

// Mock mongoose connection
jest.mock("mongoose", () => ({
    connection: {
        once: jest.fn(),
        db: { some: 'db' }
    }
}));

// Mock mongodb
jest.mock("mongodb", () => ({
    GridFSBucket: jest.fn()
}));

describe('GridFS Service', () => {
    let gridfsService;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('should initialize bucket when mongoose connection opens', () => {
        const mongooseMock = require('mongoose');
        
        // Require the service AFTER the mock setup
        gridfsService = require('../../services/gridfs.service');

        // Find the callback passed to mongoose.connection.once('open', ...)
        const openCall = mongooseMock.connection.once.mock.calls.find(call => call[0] === 'open');
        if (!openCall) {
            throw new Error("open callback not found. Service might not be calling mongoose.connection.once('open', ...)");
        }
        const openCallback = openCall[1];

        const mockBucketInstance = { name: 'mockBucket' };
        GridFSBucket.mockImplementation(() => mockBucketInstance);

        // Manually trigger the captured callback
        openCallback();

        expect(GridFSBucket).toHaveBeenCalledWith(mongooseMock.connection.db, {
            bucketName: "uploads",
        });
        expect(gridfsService()).toBe(mockBucketInstance);
    });

    it('should return undefined if bucket is not yet initialized', () => {
        gridfsService = require('../../services/gridfs.service');
        expect(gridfsService()).toBeUndefined();
    });
});

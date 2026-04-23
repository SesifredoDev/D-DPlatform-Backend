// Mock mongoose
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
    let mongoose;
    let mongodb;

    beforeEach(() => {
        jest.resetModules();
        mongoose = require("mongoose");
        mongodb = require("mongodb");
        jest.clearAllMocks();
    });

    it('should initialize bucket when mongoose connection opens', () => {
        // Require the service
        gridfsService = require('../../services/gridfs.service');

        // Find the callback passed to mongoose.connection.once('open', ...)
        const openCall = mongoose.connection.once.mock.calls.find(call => call[0] === 'open');
        if (!openCall) {
            throw new Error("open callback not found. Service might not be calling mongoose.connection.once('open', ...)");
        }
        const openCallback = openCall[1];

        const mockBucketInstance = { name: 'mockBucket' };
        mongodb.GridFSBucket.mockImplementation(() => mockBucketInstance);

        // Manually trigger the captured callback
        openCallback();

        expect(mongodb.GridFSBucket).toHaveBeenCalledWith(mongoose.connection.db, {
            bucketName: "uploads",
        });
        expect(gridfsService()).toBe(mockBucketInstance);
    });

    it('should return undefined if bucket is not yet initialized', () => {
        gridfsService = require('../../services/gridfs.service');
        expect(gridfsService()).toBeUndefined();
    });
});

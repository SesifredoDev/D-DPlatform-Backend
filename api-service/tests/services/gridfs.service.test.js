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
        // Capture the callback passed to once('open', ...)
        let openCallback;
        mongoose.connection.once.mockImplementation((event, cb) => {
            if (event === 'open') openCallback = cb;
        });

        // Require the service to trigger the once() call
        gridfsService = require('../../services/gridfs.service');

        const mockBucketInstance = { name: 'mockBucket' };
        GridFSBucket.mockImplementation(() => mockBucketInstance);

        // Manually trigger the callback
        if (openCallback) {
            openCallback();
        } else {
            throw new Error("open callback not found. Service might not be calling mongoose.connection.once('open', ...)");
        }

        expect(GridFSBucket).toHaveBeenCalledWith(mongoose.connection.db, {
            bucketName: "uploads",
        });
        expect(gridfsService()).toBe(mockBucketInstance);
    });

    it('should return undefined if bucket is not yet initialized', () => {
        gridfsService = require('../../services/gridfs.service');
        expect(gridfsService()).toBeUndefined();
    });
});

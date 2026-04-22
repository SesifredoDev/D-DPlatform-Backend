const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

// Mock mongoose connection
jest.mock("mongoose", () => ({
    connection: {
        once: jest.fn(),
        db: { some: 'db' } // Mock the db object as well
    }
}));

// Mock mongodb
jest.mock("mongodb", () => ({
    GridFSBucket: jest.fn()
}));

describe('GridFS Service', () => {
    let gridfsService;
    let openCallback;

    beforeEach(() => {
        jest.resetModules(); // Clear module cache for clean slate
        jest.clearAllMocks();

        // Set up the mockImplementation for mongoose.connection.once BEFORE requiring the service
        mongoose.connection.once.mockImplementation((event, cb) => {
            if (event === 'open') {
                openCallback = cb; // Capture the callback
            }
        });
    });

    it('should initialize bucket when mongoose connection opens', () => {
        // Require the service AFTER the mock for mongoose.connection.once is set up
        gridfsService = require('../../services/gridfs.service');

        const mockBucketInstance = { name: 'mockBucket' };
        GridFSBucket.mockImplementation(() => mockBucketInstance);

        // Manually trigger the captured callback
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
        // Require the service, but don't trigger the 'open' callback
        gridfsService = require('../../services/gridfs.service');
        expect(gridfsService()).toBeUndefined();
    });
});

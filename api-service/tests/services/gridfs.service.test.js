const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

// Mocking the entire mongoose connection to trigger the 'once' event
jest.mock("mongoose", () => {
    const EventEmitter = require('events');
    const mockConn = new EventEmitter();
    mockConn.db = { some: 'db' };
    return {
        connection: mockConn
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
        const mockBucketInstance = { name: 'mockBucket' };
        GridFSBucket.mockImplementation(() => mockBucketInstance);

        // Simulate the 'open' event on the mocked connection
        mongoose.connection.emit('open');

        expect(GridFSBucket).toHaveBeenCalledWith(mongoose.connection.db, {
            bucketName: "uploads",
        });
        expect(gridfsService()).toBe(mockBucketInstance);
    });

    it('should return undefined if bucket is not yet initialized', () => {
        expect(gridfsService()).toBeUndefined();
    });
});

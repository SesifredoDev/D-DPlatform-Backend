const serverController = require('../../controllers/server.controller');
const Server = require('../../models/Server');
const Role = require('../../models/Roles');
const Character = require('../../models/Character');
const { hasPermission } = require('../../utils/permissions');

jest.mock('../../models/Server');
jest.mock('../../models/Channel');
jest.mock('../../models/Roles');
jest.mock('../../models/Character');
jest.mock('../../services/s3.service');
jest.mock('../../utils/permissions');
jest.mock('redis', () => ({
    createClient: jest.fn().mockReturnValue({
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        publish: jest.fn().mockResolvedValue(),
        isOpen: true
    })
}));

describe('Server Controller', () => {
    let req, res;

    // Helper to mock Mongoose query chain
    const mockQuery = (val) => {
        const query = {
            populate: jest.fn().mockReturnThis(),
            lean: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            exec: jest.fn().mockResolvedValue(val),
            // Make it thenable so 'await' works directly on the query object
            then: jest.fn((resolve, reject) => {
                return Promise.resolve(val).then(resolve, reject);
            }),
            catch: jest.fn((reject) => {
                return Promise.resolve(val).catch(reject);
            })
        };
        return query;
    };

    beforeEach(() => {
        req = {
            user: { id: 'user123' },
            params: { serverId: 'server123' },
            body: { name: 'New Server' },
            protocol: 'http',
            get: jest.fn().mockReturnValue('localhost')
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        jest.clearAllMocks();

        // Default chainable mocks to prevent "Cannot read properties of undefined (reading 'populate')"
        Server.findById.mockReturnValue(mockQuery(null));
        Server.findOne.mockReturnValue(mockQuery(null));
        Server.find.mockReturnValue(mockQuery([]));
        Character.find.mockReturnValue(mockQuery([]));
        Role.find.mockReturnValue(mockQuery([]));
        Role.findOne.mockReturnValue(mockQuery(null));
    });

    describe('createServer', () => {
        it('should create a server and default role', async () => {
            const mockServer = {
                _id: 'server123',
                roles: [],
                members: [],
                save: jest.fn().mockResolvedValue(),
                toObject: jest.fn().mockReturnValue({ _id: 'server123', name: 'New Server' })
            };
            Server.create.mockResolvedValue(mockServer);
            Role.create.mockResolvedValue({ _id: 'roleEveryone' });

            await serverController.createServer(req, res);

            expect(Server.create).toHaveBeenCalled();
            expect(Role.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Everyone' }));
            expect(res.status).toHaveBeenCalledWith(201);
        });
    });

    describe('joinServer', () => {
        it('should allow a user to join with valid code', async () => {
            const mockServer = {
                _id: 'server123',
                joinCode: 'code123',
                members: [],
                save: jest.fn().mockResolvedValue()
            };
            req.body = { code: 'code123' };
            Server.findOne.mockReturnValue(mockQuery(mockServer));
            Role.findOne.mockReturnValue(mockQuery({ _id: 'everyoneRole' }));
            
            // Mock notifyMemberUpdate's database calls
            Server.findById.mockReturnValue(mockQuery({
                ...mockServer,
                members: [{ user: { _id: 'user123', username: 'testuser' }, roles: [] }]
            }));

            await serverController.joinServer(req, res);

            expect(mockServer.members).toHaveLength(1);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Joined server" }));
        });

        it('should return 404 for invalid code', async () => {
            req.body = { code: 'wrong' };
            Server.findOne.mockReturnValue(mockQuery(null));

            await serverController.joinServer(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('deleteServer', () => {
        it('should allow owner to delete server', async () => {
            const mockServer = {
                _id: 'server123',
                owner: 'user123',
                deleteOne: jest.fn().mockResolvedValue()
            };
            Server.findById.mockReturnValue(mockQuery(mockServer));

            await serverController.deleteServer(req, res);

            expect(mockServer.deleteOne).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({ message: "Server and all associated data deleted" });
        });

        it('should prevent non-owner from deleting', async () => {
            const mockServer = {
                _id: 'server123',
                owner: 'otherUser'
            };
            Server.findById.mockReturnValue(mockQuery(mockServer));

            await serverController.deleteServer(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
        });
    });
});

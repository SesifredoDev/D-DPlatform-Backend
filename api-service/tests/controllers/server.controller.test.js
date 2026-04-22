const serverController = require('../../controllers/server.controller');
const Server = require('../../models/Server');
const Role = require('../../models/Roles');
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
            Server.findOne.mockResolvedValue(mockServer);
            Role.findOne.mockResolvedValue({ _id: 'everyoneRole' });

            await serverController.joinServer(req, res);

            expect(mockServer.members).toHaveLength(1);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Joined server" }));
        });

        it('should return 404 for invalid code', async () => {
            req.body = { code: 'wrong' };
            Server.findOne.mockResolvedValue(null);

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
            Server.findById.mockResolvedValue(mockServer);

            await serverController.deleteServer(req, res);

            expect(mockServer.deleteOne).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith({ message: "Server and all associated data deleted" });
        });

        it('should prevent non-owner from deleting', async () => {
            const mockServer = {
                _id: 'server123',
                owner: 'otherUser'
            };
            Server.findById.mockResolvedValue(mockServer);

            await serverController.deleteServer(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
        });
    });
});

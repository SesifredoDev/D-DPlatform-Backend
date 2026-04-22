const { getServerAndMember } = require('../../utils/serverHelpers');
const Server = require('../../models/Server');

jest.mock('../../models/Server');

describe('Server Helpers Utility', () => {
    describe('getServerAndMember', () => {
        it('should return server and member if found', async () => {
            const mockServer = {
                _id: 'server123',
                members: [{ user: 'user123' }]
            };
            Server.findById.mockResolvedValue(mockServer);

            const result = await getServerAndMember('server123', 'user123');

            expect(result.server).toBeDefined();
            expect(result.member).toBeDefined();
            expect(result.error).toBeUndefined();
        });

        it('should return 404 error if server not found', async () => {
            Server.findById.mockResolvedValue(null);

            const result = await getServerAndMember('wrong-id', 'user123');

            expect(result.error.status).toBe(404);
            expect(result.error.message).toBe("Server not found");
        });

        it('should return 403 error if user is not a member', async () => {
            const mockServer = {
                _id: 'server123',
                members: [{ user: 'otherUser' }]
            };
            Server.findById.mockResolvedValue(mockServer);

            const result = await getServerAndMember('server123', 'user123');

            expect(result.error.status).toBe(403);
            expect(result.error.message).toBe("Not a member of this server");
        });
    });
});

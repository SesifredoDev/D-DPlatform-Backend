const { isAdmin, hasPermission } = require('../../utils/permissions');
const Role = require('../../models/Roles');

jest.mock('../../models/Roles');

describe('Permissions Utility', () => {
    describe('isAdmin', () => {
        it('should return true if user has owner or admin roles', () => {
            expect(isAdmin({ roles: ['owner'] })).toBe(true);
            expect(isAdmin({ roles: ['admin'] })).toBe(true);
        });

        it('should return false for other roles', () => {
            expect(isAdmin({ roles: ['player'] })).toBe(false);
        });
    });

    describe('hasPermission', () => {
        let mockServer, mockMember;

        beforeEach(() => {
            mockServer = { owner: 'user123' };
            mockMember = { user: 'user123', roles: ['role1'] };
            jest.clearAllMocks();
        });

        it('should return true if user is the server owner', async () => {
            const result = await hasPermission(mockServer, mockMember, 'MANAGE_SERVER');
            expect(result).toBe(true);
        });

        it('should return true if user has a role with ADMINISTRATOR permission', async () => {
            mockServer.owner = 'otherUser';
            Role.find.mockResolvedValue([{ permissions: { ADMINISTRATOR: true } }]);

            const result = await hasPermission(mockServer, mockMember, 'MANAGE_SERVER');
            expect(result).toBe(true);
        });

        it('should return true if user has specific permission', async () => {
            mockServer.owner = 'otherUser';
            Role.find.mockResolvedValue([{ permissions: { MANAGE_CHANNELS: true } }]);

            const result = await hasPermission(mockServer, mockMember, 'MANAGE_CHANNELS');
            expect(result).toBe(true);
        });

        it('should return false if user lacks permission', async () => {
            mockServer.owner = 'otherUser';
            Role.find.mockResolvedValue([{ permissions: { MANAGE_CHANNELS: false } }]);

            const result = await hasPermission(mockServer, mockMember, 'MANAGE_ROLES');
            expect(result).toBe(false);
        });
    });
});

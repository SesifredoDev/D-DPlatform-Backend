const { isAdmin } = require('../utils/permissions');

describe('Permissions Utility', () => {
    describe('isAdmin', () => {
        it('should return true if user has owner role', () => {
            const member = { roles: ['owner', 'player'] };
            expect(isAdmin(member)).toBe(true);
        });

        it('should return true if user has admin role', () => {
            const member = { roles: ['admin'] };
            expect(isAdmin(member)).toBe(true);
        });

        it('should return false if user has neither owner nor admin role', () => {
            const member = { roles: ['player', 'moderator'] };
            expect(isAdmin(member)).toBe(false);
        });

        it('should return false if user has no roles', () => {
            const member = { roles: [] };
            expect(isAdmin(member)).toBe(false);
        });
    });
});

const tokenService = require('../../services/token.service');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const RefreshToken = require('../../models/RefreshToken');

jest.mock('jsonwebtoken');
jest.mock('crypto', () => ({
    ...jest.requireActual('crypto'),
    randomBytes: jest.fn(),
    createHash: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    digest: jest.fn(),
}));
jest.mock('../../models/RefreshToken');

describe('Token Service', () => {
    const mockUser = { _id: 'user123', email: 'test@example.com', username: 'testuser' };
    const mockAccessTokenSecret = 'accessSecret';
    const mockRefreshTokenTtlDays = 7;

    beforeAll(() => {
        process.env.JWT_ACCESS_SECRET = mockAccessTokenSecret;
        process.env.ACCESS_TOKEN_EXPIRY = '1h';
        process.env.REFRESH_TOKEN_TTL_DAYS = mockRefreshTokenTtlDays;
    });

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('generateAccessToken', () => {
        it('should generate an access token', () => {
            jwt.sign.mockReturnValue('mockAccessToken');
            const token = tokenService.generateAccessToken(mockUser);
            expect(jwt.sign).toHaveBeenCalledWith(
                { sub: mockUser._id, email: mockUser.email, username: mockUser.username },
                mockAccessTokenSecret,
                { expiresIn: '1h' }
            );
            expect(token).toBe('mockAccessToken');
        });
    });

    describe('generateRefreshToken', () => {
        it('should generate a random refresh token', () => {
            crypto.randomBytes.mockReturnValue(Buffer.from('mockRandomBytes'));
            crypto.createHash.mockReturnThis();
            crypto.update.mockReturnThis();
            crypto.digest.mockReturnValue('mockRefreshTokenHash');

            const token = tokenService.generateRefreshToken();
            expect(crypto.randomBytes).toHaveBeenCalledWith(64);
            expect(token).toBe('6d6f636b52616e646f6d4279746573'); // 'mockRandomBytes' in hex
        });
    });

    describe('createRefreshToken', () => {
        it('should create and save a refresh token', async () => {
            const mockToken = 'mockRefreshToken';
            const mockTokenHash = 'mockRefreshTokenHash';
            tokenService.generateRefreshToken = jest.fn().mockReturnValue(mockToken);
            crypto.createHash.mockReturnThis();
            crypto.update.mockReturnThis();
            crypto.digest.mockReturnValue(mockTokenHash);
            RefreshToken.create.mockResolvedValue({});

            const result = await tokenService.createRefreshToken(mockUser._id);

            expect(tokenService.generateRefreshToken).toHaveBeenCalled();
            expect(crypto.createHash).toHaveBeenCalledWith('sha256');
            expect(crypto.update).toHaveBeenCalledWith(mockToken);
            expect(crypto.digest).toHaveBeenCalledWith('hex');
            expect(RefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
                user: mockUser._id,
                tokenHash: mockTokenHash,
            }));
            expect(result).toBe(mockToken);
        });
    });

    describe('rotateRefreshToken', () => {
        it('should invalidate old token and create a new one', async () => {
            const oldToken = 'oldRefreshToken';
            const oldTokenHash = 'oldRefreshTokenHash';
            const newToken = 'newRefreshToken';
            const newTokenHash = 'newRefreshTokenHash';

            crypto.createHash
                .mockReturnValueOnce({ update: jest.fn().mockReturnThis(), digest: jest.fn().mockReturnValue(oldTokenHash) })
                .mockReturnValueOnce({ update: jest.fn().mockReturnThis(), digest: jest.fn().mockReturnValue(newTokenHash) });
            
            RefreshToken.deleteOne.mockResolvedValue({ deletedCount: 1 });
            tokenService.generateRefreshToken = jest.fn().mockReturnValue(newToken);
            RefreshToken.create.mockResolvedValue({});

            const result = await tokenService.rotateRefreshToken(oldToken, mockUser._id);

            expect(RefreshToken.deleteOne).toHaveBeenCalledWith({ tokenHash: oldTokenHash });
            expect(tokenService.generateRefreshToken).toHaveBeenCalled();
            expect(RefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
                user: mockUser._id,
                tokenHash: newTokenHash,
            }));
            expect(result).toBe(newToken);
        });
    });
});

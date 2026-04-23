const userController = require('../../controllers/user.controller');
const User = require('../../models/User');
const s3Service = require('../../services/s3.service');

jest.mock('../../models/User');
jest.mock('../../services/s3.service');

describe('User Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            user: { id: 'user123' },
            protocol: 'http',
            get: jest.fn().mockReturnValue('localhost')
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
            sendStatus: jest.fn().mockReturnThis()
        };
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        console.warn.mockRestore();
    });

    describe('getMe', () => {
        it('should return user data without password', async () => {
            const mockUser = {
                _id: 'user123',
                username: 'testuser',
                profileIcon: 'icon.png',
                toObject: jest.fn().mockReturnThis()
            };
            
            User.findById.mockReturnValue({
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(mockUser)
            });

            await userController.getMe(req, res);

            expect(User.findById).toHaveBeenCalledWith('user123');
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                username: 'testuser',
                profileIconUrl: 'http://localhost/api/files/icon.png'
            }));
        });

        it('should return 404 if user not found', async () => {
            User.findById.mockReturnValue({
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(null)
            });

            await userController.getMe(req, res);

            expect(res.sendStatus).toHaveBeenCalledWith(404);
        });
    });

    describe('uploadProfileIcon', () => {
        it('should return 400 if no file uploaded', async () => {
            req.file = null;
            await userController.uploadProfileIcon(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ message: "No file uploaded" });
        });

        it('should upload to S3 and update user', async () => {
            req.file = {
                buffer: Buffer.from('test'),
                mimetype: 'image/jpeg',
                originalname: 'test.jpg',
                size: 1000
            };

            s3Service.uploadToS3.mockResolvedValue({ key: 's3-key' });
            
            const mockUser = {
                _id: 'user123',
                profileIcon: 's3-key',
                toObject: jest.fn().mockReturnValue({ profileIcon: 's3-key' })
            };

            User.findByIdAndUpdate.mockReturnValue({
                select: jest.fn().mockResolvedValue(mockUser)
            });

            await userController.uploadProfileIcon(req, res);

            expect(s3Service.uploadToS3).toHaveBeenCalled();
            expect(User.findByIdAndUpdate).toHaveBeenCalled();
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: "Profile icon updated"
            }));
        });
    });
});

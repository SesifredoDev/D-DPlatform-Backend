const characterController = require('../../controllers/character.controller');
const Character = require('../../models/Character');
const s3Service = require('../../services/s3.service');

jest.mock('../../models/Character');
jest.mock('../../services/s3.service');
jest.mock('redis', () => ({
    createClient: jest.fn().mockReturnValue({
        on: jest.fn(),
        connect: jest.fn().mockResolvedValue(),
        publish: jest.fn().mockResolvedValue(),
        isOpen: true
    })
}));

describe('Character Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            user: { id: 'user123' },
            params: { id: 'char123' },
            body: { name: 'Gimli', race: 'Dwarf', baseStats: '{}', classes: '[]' },
            protocol: 'http',
            get: jest.fn().mockReturnValue('localhost')
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        jest.clearAllMocks();
    });

    describe('getMyCharacters', () => {
        it('should return user characters', async () => {
            const mockCharacters = [{ name: 'Gimli', ownerId: 'user123' }];
            Character.find.mockReturnValue({
                sort: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(mockCharacters)
            });

            await characterController.getMyCharacters(req, res);

            expect(Character.find).toHaveBeenCalledWith({ ownerId: 'user123' });
            expect(res.json).toHaveBeenCalledWith(mockCharacters);
        });
    });

    describe('deleteCharacter', () => {
        it('should delete character if user is owner', async () => {
            const mockCharacter = {
                _id: 'char123',
                ownerId: 'user123',
                servers: [],
                deleteOne: jest.fn().mockResolvedValue()
            };
            Character.findOne.mockResolvedValue(mockCharacter);

            await characterController.deleteCharacter(req, res);

            expect(mockCharacter.deleteOne).toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('should return 404 if character not found or unauthorized', async () => {
            Character.findOne.mockResolvedValue(null);

            await characterController.deleteCharacter(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});

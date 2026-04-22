const ddbController = require('../../controllers/ddb.controller');
const axios = require('axios');

jest.mock('axios');

describe('DDB Controller', () => {
    let req, res;

    beforeEach(() => {
        req = {
            params: { query: '12345' }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        jest.clearAllMocks();
    });

    describe('getCharacter', () => {
        it('should return processed character data on success', async () => {
            const mockDdbResponse = {
                data: {
                    success: true,
                    data: {
                        id: 12345,
                        name: 'Test Hero',
                        race: { fullName: 'Human' },
                        stats: [{ id: 1, value: 10 }, { id: 2, value: 10 }, { id: 3, value: 10 }, { id: 4, value: 10 }, { id: 5, value: 10 }, { id: 6, value: 10 }],
                        bonusStats: [],
                        overrideStats: [],
                        classes: [{ definition: { name: 'Fighter' }, level: 1 }],
                        baseArmorClass: 10
                    }
                }
            };
            axios.get.mockResolvedValue(mockDdbResponse);

            await ddbController.getCharacter(req, res);

            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                name: 'Test Hero',
                race: 'Human'
            }));
        });

        it('should return 400 for invalid character ID', async () => {
            req.params.query = 'abc';
            await ddbController.getCharacter(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        it('should return 404 if character not found', async () => {
            axios.get.mockRejectedValue(new Error('Not Found'));
            await ddbController.getCharacter(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});

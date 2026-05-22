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
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        console.warn.mockRestore();
        console.log.mockRestore();
    });

    describe('getCharacter', () => {
        it('should return processed character data on success', async () => {
            const mockDdbResponse = {
                data: {
                    success: true,
                    data: {
                        id: 12345,
                        username: 'test-user',
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
                race: 'Human',
                ddbPdfLink: 'https://www.dndbeyond.com/sheet-pdfs/test-user_12345.pdf',
                pdfLink: 'https://www.dndbeyond.com/sheet-pdfs/test-user_12345.pdf'
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

    describe('proxySheetPdf', () => {
        beforeEach(() => {
            req.query = { url: 'https://www.dndbeyond.com/sheet-pdfs/test-user_12345.pdf' };
            req.headers = {};
            res.set = jest.fn().mockReturnThis();
        });

        it('should reject non-DDB PDF URLs', async () => {
            req.query.url = 'https://example.com/file.pdf';

            await ddbController.proxySheetPdf(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(axios.get).not.toHaveBeenCalled();
        });

        it('should stream allowed DDB PDFs with browser-friendly headers', async () => {
            const stream = {
                on: jest.fn().mockReturnThis(),
                pipe: jest.fn()
            };
            axios.get.mockResolvedValue({
                status: 200,
                headers: {
                    'content-type': 'application/pdf',
                    'content-length': '123'
                },
                data: stream
            });

            await ddbController.proxySheetPdf(req, res);

            expect(axios.get).toHaveBeenCalledWith(
                req.query.url,
                expect.objectContaining({
                    responseType: 'stream',
                    headers: expect.objectContaining({
                        Accept: 'application/pdf',
                        Referer: 'https://www.dndbeyond.com/'
                    })
                })
            );
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/pdf');
            expect(stream.pipe).toHaveBeenCalledWith(res);
        });
    });
});

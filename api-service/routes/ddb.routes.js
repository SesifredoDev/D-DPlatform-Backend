const express = require('express');
const router = express.Router();
const ddbController = require('../controllers/ddb.controller');

router.get('/pdf', ddbController.proxySheetPdf);
router.get('/:query', ddbController.getCharacter);

module.exports = router;

const express = require('express');
const router = express.Router();
const ddbController = require('../controllers/ddb.controller');

router.get('/:query', ddbController.getCharacter);

module.exports = router;

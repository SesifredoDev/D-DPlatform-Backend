const express = require('express');
const router = express.Router();
const characterController = require('../controllers/character.controller');
const upload = require('../middleware/upload.middleware');
const auth = require('../middleware/auth.middleware');

router.post('/',
    auth,
    upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]),
    characterController.createCharacter
);

router.get('/', auth, characterController.getMyCharacters);

module.exports = router;
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
router.put('/:id',auth, upload.fields([{ name: 'icon', maxCount: 1 }, { name: 'pdf', maxCount: 1 }]),
    characterController.updateCharacter )

router.get('/', auth, characterController.getMyCharacters);

router.delete('/:id', auth, characterController.deleteCharacter);

module.exports = router;
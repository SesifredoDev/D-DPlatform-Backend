const axios = require('axios');

const getCharacter = async (req, res) => {
    const query = req.params.query;
    const charId = query.includes('characters/') ? query.split('/').pop() : query;

    if (!charId || isNaN(charId)) {
        return res.status(400).json({ error: "Invalid Character ID or URL" });
    }

    let characterData = null;

    for (let v = 5; v >= 1; v--) {
        try {
            const url = `https://character-service.dndbeyond.com/character/v${v}/character/${charId}`;
            const response = await axios.get(url);

            if (response.data && response.data.success) {
                characterData = response.data.data;
                break;
            }
        } catch (error) {
            console.warn(`DDB v${v} fetch failed for ${charId}, trying next...`);
        }
    }

    if (!characterData) {
        return res.status(404).json({ error: "Character not found or set to Private." });
    }

    // 3. Parse and Return Surface Info
    try {
        const processedData = parseSurfaceInfo(characterData);
        res.json(processedData);
    } catch (err) {
        res.status(500).json({ error: "Error parsing character data." });
    }
};

/**
 * Helper to calculate final stats and map surface info
 * Based on MORTE.json structure
 */
function parseSurfaceInfo(data) {
    const getStatValue = (id) => {
        const base = data.stats.find(s => s.id === id)?.value || 0;
        const bonus = data.bonusStats.find(s => s.id === id)?.value || 0;
        const override = data.overrideStats.find(s => s.id === id)?.value;
        return override || (base + bonus);
    };

    const stats = {
        strength: getStatValue(1),
        dexterity: getStatValue(2),
        constitution: getStatValue(3),
        intelligence: getStatValue(4),
        wisdom: getStatValue(5),
        charisma: getStatValue(6)
    };

    const dexMod = Math.floor((stats.dexterity - 10) / 2);

    return {
        id: data.id,
        name: data.name,
        race: data.race.fullName, // e.g. "Eladrin (Variant)"
        icon: data.decorations?.avatarUrl || data.avatarUrl,
        baseStats: stats,
        // Classes and Subclasses mapping
        classes: data.classes.map(c => ({
            className: c.definition.name,
            subclassName: c.subclassDefinition?.name || null,
            level: c.level
        })),
        // AC Logic: Check for override, then base + dex
        ac: data.overrideArmorClass || (data.baseArmorClass || 10) + dexMod
    };
}

module.exports = { getCharacter };
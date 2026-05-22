const axios = require('axios');

function isAllowedDdbSheetPdfUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(rawUrl);
        const hostname = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        return parsed.protocol === 'https:' &&
            (hostname === 'www.dndbeyond.com' || hostname === 'dndbeyond.com') &&
            pathname.startsWith('/sheet-pdfs/') &&
            pathname.endsWith('.pdf');
    } catch {
        return false;
    }
}

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
    const ddbPdfLink = getDdbPdfLink(data);
    console.log(data.username)
    return {
        id: data.id,
        name: data.name,
        race: data.race.fullName, // e.g. "Eladrin (Variant)"
        icon: data.decorations?.avatarUrl || data.avatarUrl,
        baseStats: stats,
        username: data.username,
        ddbPdfLink,
        pdfLink: ddbPdfLink,
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

function getDdbPdfLink(data) {
    if (!data?.id || !data?.username) return null;

    const username = encodeURIComponent(data.username);
    return `https://www.dndbeyond.com/sheet-pdfs/${username}_${data.id}.pdf`;
}

const proxySheetPdf = async (req, res) => {
    const pdfUrl = req.query.url;
    if (!isAllowedDdbSheetPdfUrl(pdfUrl)) {
        return res.status(400).json({ error: "Invalid D&D Beyond PDF URL" });
    }

    try {
        const headers = {
            Accept: 'application/pdf',
            Referer: 'https://www.dndbeyond.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        };

        if (req.headers.range) {
            headers.Range = req.headers.range;
        }

        const response = await axios.get(pdfUrl, {
            responseType: 'stream',
            headers,
            validateStatus: status => status >= 200 && status < 300
        });

        res.status(response.status);
        res.set('Content-Type', response.headers['content-type'] || 'application/pdf');
        res.set('Content-Disposition', 'inline; filename="dndbeyond-character-sheet.pdf"');
        if (response.headers['content-length']) res.set('Content-Length', response.headers['content-length']);
        if (response.headers['accept-ranges']) res.set('Accept-Ranges', response.headers['accept-ranges']);
        if (response.headers['content-range']) res.set('Content-Range', response.headers['content-range']);
        res.set('Cache-Control', 'private, max-age=300');

        response.data.on('error', error => {
            console.error('DDB PDF stream error:', error);
            if (!res.headersSent) {
                res.status(502).json({ error: "Failed to stream D&D Beyond PDF" });
            }
        });
        response.data.pipe(res);
    } catch (error) {
        const status = error.response?.status;
        console.error('Failed to proxy DDB PDF:', error.message);
        if (!res.headersSent) {
            res.status(status === 404 ? 404 : 502).json({ error: "Could not fetch D&D Beyond PDF" });
        }
    }
};

module.exports = { getCharacter, proxySheetPdf, isAllowedDdbSheetPdfUrl };

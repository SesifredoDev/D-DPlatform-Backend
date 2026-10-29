const {
    DesktopUpdateError,
    getDesktopUpdatePayload
} = require('../services/desktop-update.service');

async function getLatestDesktopUpdate(req, res) {
    const target = String(req.query.target || '').toLowerCase();
    const arch = String(req.query.arch || '').toLowerCase();
    const currentVersion = req.query.current_version ? String(req.query.current_version) : null;

    try {
        const payload = await getDesktopUpdatePayload({ target, arch, currentVersion });
        console.log(payload);
        if (!payload) {
            return res.status(204).send();
        }
        return res.status(200).json(payload);
    } catch (error) {
        if (error instanceof DesktopUpdateError) {
            return res.status(error.statusCode).json({ error: error.message });
        }

        console.error('Unexpected desktop update lookup error:', error);
        return res.status(500).json({ error: 'Unable to resolve desktop update' });
    }
}

module.exports = {
    getLatestDesktopUpdate
};

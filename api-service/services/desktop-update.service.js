const axios = require('axios');

const GITHUB_API_BASE_URL = (process.env.DESKTOP_UPDATES_GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
const GITHUB_REPOSITORY = process.env.DESKTOP_UPDATES_GITHUB_REPOSITORY || 'SesifredoDev/D-DPlatform';
const GITHUB_RELEASE_TAG = process.env.DESKTOP_UPDATES_GITHUB_RELEASE_TAG;
const GITHUB_TOKEN = process.env.DESKTOP_UPDATES_GITHUB_TOKEN;

const SUPPORTED_TARGETS = new Set(['windows', 'linux', 'darwin']);
const SUPPORTED_ARCHES = new Set(['x86_64', 'aarch64', 'i686', 'armv7']);

const ARCH_ALIASES = {
    x86_64: ['x86_64', 'x64', 'amd64'],
    aarch64: ['aarch64', 'arm64'],
    i686: ['i686', 'x86'],
    armv7: ['armv7', 'armhf']
};

class DesktopUpdateError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.name = 'DesktopUpdateError';
        this.statusCode = statusCode;
    }
}

function normalizeVersion(version) {
    if (!version || typeof version !== 'string') return null;
    return version.trim().replace(/^v/i, '');
}

function parseSemver(version) {
    const normalized = normalizeVersion(version);
    if (!normalized) return null;

    const [core] = normalized.split('-', 1);
    const [major, minor, patch] = core.split('.');
    if ([major, minor, patch].some((value) => value === undefined)) return null;

    const asNumbers = [major, minor, patch].map((value) => Number.parseInt(value, 10));
    if (asNumbers.some((value) => Number.isNaN(value))) return null;

    return asNumbers;
}

function compareVersions(a, b) {
    const parsedA = parseSemver(a);
    const parsedB = parseSemver(b);
    if (!parsedA || !parsedB) return null;

    for (let index = 0; index < 3; index += 1) {
        if (parsedA[index] > parsedB[index]) return 1;
        if (parsedA[index] < parsedB[index]) return -1;
    }
    return 0;
}

function hasArchToken(fileName, arch) {
    const lowered = fileName.toLowerCase();
    const aliases = ARCH_ALIASES[arch] || [arch];
    return aliases.some((token) => lowered.includes(token.toLowerCase()));
}

function findAssetWithSignature(assets, matcher) {
    const asset = assets.find(matcher);
    if (!asset) return null;

    const signatureName = `${asset.name}.sig`;
    const signatureAsset = assets.find((entry) => entry.name === signatureName);
    if (!signatureAsset) return null;

    return { asset, signatureAsset };
}

function selectWindowsAsset(assets, arch) {
    const preferredCandidates = assets.filter((entry) => /setup\.exe$/i.test(entry.name));
    const fallbackCandidates = assets.filter((entry) => /\.msi$/i.test(entry.name));

    const select = (candidates) => {
        const archMatched = candidates.find((entry) => hasArchToken(entry.name, arch));
        if (archMatched) return findAssetWithSignature(assets, (entry) => entry.id === archMatched.id);
        return findAssetWithSignature(assets, (entry) => candidates.some((candidate) => candidate.id === entry.id));
    };

    return select(preferredCandidates) || select(fallbackCandidates);
}

function selectLinuxAsset(assets, arch) {
    const candidates = assets.filter((entry) => /\.AppImage$/i.test(entry.name));
    const archMatched = candidates.find((entry) => hasArchToken(entry.name, arch));
    if (archMatched) return findAssetWithSignature(assets, (entry) => entry.id === archMatched.id);
    return findAssetWithSignature(assets, (entry) => candidates.some((candidate) => candidate.id === entry.id));
}

function selectMacOsAsset(assets, arch) {
    const candidates = assets.filter((entry) => /\.app\.tar\.gz$/i.test(entry.name));
    const archMatched = candidates.find((entry) => hasArchToken(entry.name, arch));
    if (archMatched) return findAssetWithSignature(assets, (entry) => entry.id === archMatched.id);
    return findAssetWithSignature(assets, (entry) => candidates.some((candidate) => candidate.id === entry.id));
}

function selectAssetForTarget(assets, target, arch) {
    if (target === 'windows') return selectWindowsAsset(assets, arch);
    if (target === 'linux') return selectLinuxAsset(assets, arch);
    if (target === 'darwin') return selectMacOsAsset(assets, arch);
    return null;
}

async function fetchRelease() {
    const requestPath = GITHUB_RELEASE_TAG
        ? `/repos/${GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(GITHUB_RELEASE_TAG)}`
        : `/repos/${GITHUB_REPOSITORY}/releases/latest`;

    try {
        const response = await axios.get(`${GITHUB_API_BASE_URL}${requestPath}`, {
            headers: {
                Accept: 'application/vnd.github+json',
                ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
            },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        if (error.response?.status === 404) {
            throw new DesktopUpdateError('No GitHub release found for desktop updates', 404);
        }
        throw new DesktopUpdateError('Failed to fetch desktop release metadata', 502);
    }
}

async function fetchSignature(asset) {
    try {
        const response = await axios.get(asset.browser_download_url, {
            headers: {
                ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
            },
            responseType: 'text',
            timeout: 15000
        });
        return String(response.data).trim();
    } catch (error) {
        throw new DesktopUpdateError(`Failed to fetch signature file: ${asset.name}`, 502);
    }
}

async function getDesktopUpdatePayload({ target, arch, currentVersion }) {
    if (!SUPPORTED_TARGETS.has(target)) {
        throw new DesktopUpdateError('Invalid target. Supported values: windows, linux, darwin', 400);
    }
    if (!SUPPORTED_ARCHES.has(arch)) {
        throw new DesktopUpdateError('Invalid arch. Supported values: x86_64, aarch64, i686, armv7', 400);
    }

    const release = await fetchRelease();
    const releaseVersion = normalizeVersion(release.tag_name || release.name);
    if (!releaseVersion) {
        throw new DesktopUpdateError('Release version is missing or invalid', 502);
    }

    const versionComparison = currentVersion ? compareVersions(releaseVersion, currentVersion) : 1;
    if (versionComparison !== null && versionComparison <= 0) {
        return null;
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const selected = selectAssetForTarget(assets, target, arch);
    if (!selected) {
        throw new DesktopUpdateError(`No update bundle found for ${target}-${arch}`, 404);
    }

    const signature = await fetchSignature(selected.signatureAsset);

    return {
        version: releaseVersion,
        notes: release.body || '',
        pub_date: release.published_at || new Date().toISOString(),
        url: selected.asset.browser_download_url,
        signature
    };
}

module.exports = {
    DesktopUpdateError,
    getDesktopUpdatePayload
};

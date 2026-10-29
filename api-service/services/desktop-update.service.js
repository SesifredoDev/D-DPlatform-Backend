const axios = require('axios');

const GITHUB_API_BASE_URL = (process.env.DESKTOP_UPDATES_GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
const GITHUB_REPOSITORY = process.env.DESKTOP_UPDATES_GITHUB_REPOSITORY || 'SesifredoDev/D-DPlatform';
const GITHUB_RELEASE_TAG = process.env.DESKTOP_UPDATES_GITHUB_RELEASE_TAG;
const GITHUB_TOKEN = process.env.DESKTOP_UPDATES_GITHUB_TOKEN;

// Set DESKTOP_UPDATES_DEBUG=1 (or true/yes/on) to enable debug logging.
const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(process.env.DESKTOP_UPDATES_DEBUG || '');



const SUPPORTED_TARGETS = new Set(['windows', 'linux', 'darwin']);
const SUPPORTED_ARCHES = new Set(['x86_64', 'aarch64', 'i686', 'armv7']);

const ARCH_ALIASES = {
    x86_64: ['x86_64', 'x64', 'amd64'],
    aarch64: ['aarch64', 'arm64'],
    i686: ['i686', 'x86'],
    armv7: ['armv7', 'armhf']
};

console.log('Module loaded', {
    apiBaseUrl: GITHUB_API_BASE_URL,
    repository: GITHUB_REPOSITORY,
    releaseTag: GITHUB_RELEASE_TAG || '(latest)',
    hasToken: Boolean(GITHUB_TOKEN)
});

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
    if (!normalized) {
        console.log('parseSemver: empty or invalid version', { version });
        return null;
    }

    const [core] = normalized.split('-', 1);
    const [major, minor, patch] = core.split('.');
    if ([major, minor, patch].some((value) => value === undefined)) {
        console.log('parseSemver: missing version segment', { version, core });
        return null;
    }

    const asNumbers = [major, minor, patch].map((value) => Number.parseInt(value, 10));
    if (asNumbers.some((value) => Number.isNaN(value))) {
        console.log('parseSemver: non-numeric version segment', { version, core });
        return null;
    }

    return asNumbers;
}

function compareVersions(a, b) {
    const parsedA = parseSemver(a);
    const parsedB = parseSemver(b);
    if (!parsedA || !parsedB) {
        console.log('compareVersions: could not compare', { a, b, parsedA, parsedB });
        return null;
    }

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
    if (!asset) {
        console.log('findAssetWithSignature: no asset matched');
        return null;
    }

    const signatureName = `${asset.name}.sig`;
    const signatureAsset = assets.find((entry) => entry.name === signatureName);
    if (!signatureAsset) {
        console.log('findAssetWithSignature: asset matched but signature file is missing', {
            asset: asset.name,
            expectedSignature: signatureName
        });
        return null;
    }

    console.log('findAssetWithSignature: found asset and signature', {
        asset: asset.name,
        signature: signatureAsset.name
    });
    return { asset, signatureAsset };
}

function selectWindowsAsset(assets, arch) {
    const preferredCandidates = assets.filter((entry) => /setup\.exe$/i.test(entry.name));
    const fallbackCandidates = assets.filter((entry) => /\.msi$/i.test(entry.name));

    console.log('selectWindowsAsset: candidates', {
        arch,
        preferred: preferredCandidates.map((entry) => entry.name),
        fallback: fallbackCandidates.map((entry) => entry.name)
    });

    const select = (candidates) => {
        const archMatched = candidates.find((entry) => hasArchToken(entry.name, arch));
        if (archMatched) {
            console.log('selectWindowsAsset: arch-matched candidate', { name: archMatched.name });
            return findAssetWithSignature(assets, (entry) => entry.id === archMatched.id);
        }
        if (candidates.length > 0) {
            console.log('selectWindowsAsset: no arch match, falling back to first candidate', {
                name: candidates[0].name
            });
        }
        return findAssetWithSignature(assets, (entry) => candidates.some((candidate) => candidate.id === entry.id));
    };

    const preferred = select(preferredCandidates);
    if (preferred) return preferred;

    console.log('selectWindowsAsset: no usable setup.exe, trying .msi fallback');
    return select(fallbackCandidates);
}

function selectLinuxAsset(assets, arch) {
    const candidates = assets.filter((entry) => /\.AppImage$/i.test(entry.name));
    console.log('selectLinuxAsset: candidates', { arch, candidates: candidates.map((entry) => entry.name) });

    const archMatched = candidates.find((entry) => hasArchToken(entry.name, arch));
    if (archMatched) {
        console.log('selectLinuxAsset: arch-matched candidate', { name: archMatched.name });
        return findAssetWithSignature(assets, (entry) => entry.id === archMatched.id);
    }
    if (candidates.length > 0) {
        console.log('selectLinuxAsset: no arch match, falling back to first candidate', { name: candidates[0].name });
    }
    return findAssetWithSignature(assets, (entry) => candidates.some((candidate) => candidate.id === entry.id));
}

function selectMacOsAsset(assets, arch) {
    const candidates = assets.filter((entry) => /\.app\.tar\.gz$/i.test(entry.name));
    console.log('selectMacOsAsset: candidates', { arch, candidates: candidates.map((entry) => entry.name) });

    const archMatched = candidates.find((entry) => hasArchToken(entry.name, arch));
    if (archMatched) {
        console.log('selectMacOsAsset: arch-matched candidate', { name: archMatched.name });
        return findAssetWithSignature(assets, (entry) => entry.id === archMatched.id);
    }
    if (candidates.length > 0) {
        console.log('selectMacOsAsset: no arch match, falling back to first candidate', { name: candidates[0].name });
    }
    return findAssetWithSignature(assets, (entry) => candidates.some((candidate) => candidate.id === entry.id));
}

function selectAssetForTarget(assets, target, arch) {
    console.log('selectAssetForTarget', { target, arch, assetCount: assets.length });
    if (target === 'windows') return selectWindowsAsset(assets, arch);
    if (target === 'linux') return selectLinuxAsset(assets, arch);
    if (target === 'darwin') return selectMacOsAsset(assets, arch);
    return null;
}

async function fetchRelease() {
    const requestPath = GITHUB_RELEASE_TAG
        ? `/repos/${GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(GITHUB_RELEASE_TAG)}`
        : `/repos/${GITHUB_REPOSITORY}/releases/latest`;
    const url = `${GITHUB_API_BASE_URL}${requestPath}`;
    const startedAt = Date.now();

    console.log('fetchRelease: requesting', { url, authenticated: Boolean(GITHUB_TOKEN) });

    try {
        const response = await axios.get(url, {
            headers: {
                Accept: 'application/vnd.github+json',
                ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
            },
            timeout: 15000
        });
        console.log('fetchRelease: success', {
            status: response.status,
            durationMs: Date.now() - startedAt,
            tag: response.data?.tag_name,
            name: response.data?.name,
            publishedAt: response.data?.published_at,
            assetCount: Array.isArray(response.data?.assets) ? response.data.assets.length : 0,
            rateLimitRemaining: response.headers?.['x-ratelimit-remaining']
        });
        return response.data;
    } catch (error) {
        console.log('fetchRelease: failed', {
            url,
            durationMs: Date.now() - startedAt,
            status: error.response?.status,
            code: error.code,
            message: error.message,
            rateLimitRemaining: error.response?.headers?.['x-ratelimit-remaining']
        });
        if (error.response?.status === 404) {
            throw new DesktopUpdateError('No GitHub release found for desktop updates', 404);
        }
        throw new DesktopUpdateError('Failed to fetch desktop release metadata', 502);
    }
}

async function fetchSignature(asset) {
    const startedAt = Date.now();
    console.log('fetchSignature: requesting', { name: asset.name, url: asset.browser_download_url });

    try {
        const response = await axios.get(asset.browser_download_url, {
            headers: {
                ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
            },
            responseType: 'text',
            timeout: 15000
        });
        const signature = String(response.data).trim();
        console.log('fetchSignature: success', {
            name: asset.name,
            status: response.status,
            durationMs: Date.now() - startedAt,
            signatureLength: signature.length
        });
        return signature;
    } catch (error) {
        console.log('fetchSignature: failed', {
            name: asset.name,
            durationMs: Date.now() - startedAt,
            status: error.response?.status,
            code: error.code,
            message: error.message
        });
        throw new DesktopUpdateError(`Failed to fetch signature file: ${asset.name}`, 502);
    }
}

async function getDesktopUpdatePayload({ target, arch, currentVersion }) {
    console.log('getDesktopUpdatePayload: start', { target, arch, currentVersion });

    if (!SUPPORTED_TARGETS.has(target)) {
        console.log('getDesktopUpdatePayload: rejected invalid target', { target });
        throw new DesktopUpdateError('Invalid target. Supported values: windows, linux, darwin', 400);
    }
    if (!SUPPORTED_ARCHES.has(arch)) {
        console.log('getDesktopUpdatePayload: rejected invalid arch', { arch });
        throw new DesktopUpdateError('Invalid arch. Supported values: x86_64, aarch64, i686, armv7', 400);
    }

    const release = await fetchRelease();
    const releaseVersion = normalizeVersion(release.tag_name || release.name);
    if (!releaseVersion) {
        console.log('getDesktopUpdatePayload: release version missing', {
            tag_name: release.tag_name,
            name: release.name
        });
        throw new DesktopUpdateError('Release version is missing or invalid', 502);
    }

    const versionComparison = currentVersion ? compareVersions(releaseVersion, currentVersion) : 1;
    console.log('getDesktopUpdatePayload: version comparison', {
        releaseVersion,
        currentVersion,
        result: versionComparison,
        meaning:
            versionComparison === null
                ? 'unparseable (treated as update available)'
                : versionComparison > 0
                    ? 'release is newer'
                    : versionComparison === 0
                        ? 'same version'
                        : 'release is older'
    });
    if (versionComparison !== null && versionComparison <= 0) {
        console.log('getDesktopUpdatePayload: no update available');
        return null;
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    console.log('getDesktopUpdatePayload: release assets', assets.map((entry) => entry.name));

    const selected = selectAssetForTarget(assets, target, arch);
    if (!selected) {
        console.log('getDesktopUpdatePayload: no matching bundle', { target, arch });
        throw new DesktopUpdateError(`No update bundle found for ${target}-${arch}`, 404);
    }

    const signature = await fetchSignature(selected.signatureAsset);

    console.log('getDesktopUpdatePayload: update available', {
        version: releaseVersion,
        asset: selected.asset.name,
        url: selected.asset.browser_download_url
    });

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
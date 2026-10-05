const fs = require('fs/promises');
const path = require('path');

const DEFAULT_ATMOSPHERE_DIR = 'C:/Users/Paolo/OneDrive/Documents/Pictures/Astral-music-icons/atmosphere';
const API_BASE = (process.env.API_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const ATMOSPHERE_DIR = process.env.ATMOSPHERE_DIR || DEFAULT_ATMOSPHERE_DIR;

function toTitleCase(value) {
    return value
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(' ');
}

function atmosphereNameFromFile(filename) {
    const stem = filename.replace(/\.[^.]+$/, '');
    return toTitleCase(stem.replace(/^atmosphere[-_\s]*/i, ''));
}

function buildDescription(name) {
    return `${name} atmosphere`;
}

async function requestJson(pathname, init = {}) {
    const response = await fetch(`${API_BASE}${pathname}`, init);
    const raw = await response.text();
    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch (_error) {
        json = null;
    }

    if (!response.ok) {
        const message = json?.message || json?.error || raw || `${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    return json;
}

async function uploadCover(filePath) {
    const buffer = await fs.readFile(filePath);
    const formData = new FormData();
    const filename = path.basename(filePath);
    formData.append('file', new Blob([buffer]), filename);

    const response = await fetch(`${API_BASE}/files/upload`, {
        method: 'POST',
        body: formData
    });
    const raw = await response.text();

    let json = null;
    try {
        json = raw ? JSON.parse(raw) : null;
    } catch (_error) {
        json = null;
    }

    if (!response.ok) {
        const message = json?.message || json?.error || raw || `${response.status} ${response.statusText}`;
        throw new Error(message);
    }

    const url = json?.url;
    if (!url) {
        throw new Error(`Upload succeeded but no URL returned for ${filename}`);
    }

    return url;
}

async function main() {
    const files = (await fs.readdir(ATMOSPHERE_DIR))
        .filter(file => /^atmosphere-.*\.(png|jpg|jpeg|webp)$/i.test(file))
        .sort((a, b) => a.localeCompare(b));

    if (!files.length) {
        throw new Error(`No atmosphere image files found in: ${ATMOSPHERE_DIR}`);
    }

    const existingRes = await requestJson('/music/atmospheres');
    const existingByName = new Set(
        (existingRes?.items || []).map(item => String(item.name || '').trim().toLowerCase())
    );

    let created = 0;
    let skipped = 0;

    for (const file of files) {
        const name = atmosphereNameFromFile(file);
        const key = name.toLowerCase();
        const filePath = path.join(ATMOSPHERE_DIR, file);

        if (existingByName.has(key)) {
            skipped += 1;
            console.log(`SKIP  ${name} (already exists)`);
            continue;
        }

        console.log(`UPLOAD ${file}`);
        const coverUrl = await uploadCover(filePath);

        await requestJson('/music/atmospheres', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                name,
                description: buildDescription(name),
                cover: coverUrl
            })
        });

        existingByName.add(key);
        created += 1;
        console.log(`ADD   ${name}`);
    }

    console.log(`\nDone. Created: ${created}, Skipped: ${skipped}, Total scanned: ${files.length}`);
}

main().catch(error => {
    console.error('Import failed:', error.message);
    process.exit(1);
});
